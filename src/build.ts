import type { Artifact } from "./artifact"
import { Emitter } from "./emitter"
import type { Prefix } from "./prefix"
import { Task, isArtifact, isPrefix, type Context, type Ref } from "./task"
import type { Stamp, Store, TaskState } from "./store"
import { Outcome, Result } from "./result"

export type ArtifactEvent =
  | { kind: "promised"; output: Ref; taskId: string }
  | { kind: "produced"; artifact: Artifact; taskId: string }
  | { kind: "deleted"; artifact: Artifact; taskId: string }
  | { kind: "withdrawn"; output: Ref; taskId: string }

type Phase = "pending" | "running" | "completed"

type WaitResult = "ok" | "failed" | "cancelled" | "deadlock"

class Slot {
  generation = 1
  launched = 0
  phase: Phase = "pending"
  abort: AbortController | null = null
  // The ids that this run reported with ctx.produced or ctx.deleted.
  reported = new Set<string>()
  outcome: Outcome | null = null
  // The first listener error from a send that this task caused. The task fails with it.
  listenerError: Error | null = null

  constructor(
    public task: Task,
    // The owner that gave the task: `add:<task id>` for build.add.
    public owner: string,
  ) {}
}

export class Build extends Emitter<ArtifactEvent> {
  private readonly store: Store | undefined
  private readonly slots = new Map<string, Slot>()
  // For each owner, the ids of the tasks that it gave. Slot.owner is the reverse.
  private readonly owners = new Map<string, Set<string>>()
  private readonly exactOutputs = new Map<string, { artifact: Artifact; taskId: string }>()
  private readonly prefixOutputs: { prefix: Prefix; taskId: string }[] = []
  private readonly outcomes = new Map<Task, Outcome>()
  private readonly errors: Error[] = []
  // For each task id, the outputs that subscribers were last told about, by refKey.
  // After a top-level add, remove, setTasks, or run() returns, each entry equals the
  // current outputs of that task id, or is gone when no task has that id.
  private readonly told = new Map<string, Map<string, Ref>>()

  private started = false
  private runningCount = 0
  private workCount = 0
  // The running task that is inside ctx.add, ctx.remove, ctx.produced, ctx.deleted, or the
  // send of its declared outputs. A listener error then goes to that task.
  // When it is null, a listener error goes to `errors`.
  private caller: Slot | null = null
  private waiters: Array<() => void> = []
  private idleWaiters: Array<() => void> = []

  constructor(opts?: { store?: Store }) {
    super()
    this.store = opts?.store
  }

  add(task: Task): void {
    this.setTasks(`add:${task.id}`, [task])
  }

  /** Removes the task from its owner. The owner's other tasks stay. */
  remove(id: string): void {
    const slot = this.slots.get(id)
    if (!slot) return
    this.change(slot.owner, [], [slot])
  }

  /**
   * Makes `tasks` the tasks of `owner`. Adds each new id, replaces each known id,
   * and removes each id that the owner gave before and does not give now.
   * Rules call it. Throws, with no change, if another owner has one of the ids.
   */
  protected setTasks(owner: string, tasks: readonly Task[]): void {
    this.assertSettable(owner, tasks)
    const given = new Set<string>()
    for (const task of tasks) {
      given.add(task.id)
    }
    const dropped: Slot[] = []
    const before = this.owners.get(owner) ?? new Set<string>()
    for (const id of before) {
      if (given.has(id)) continue
      dropped.push(this.slots.get(id)!)
    }
    this.change(owner, tasks, dropped)
  }

  /**
   * Adds or replaces each task in `tasks` and removes each slot in `dropped`.
   * It changes all state first, and then sends the events.
   */
  private change(owner: string, tasks: readonly Task[], dropped: readonly Slot[]): void {
    const replaced: Slot[] = []
    // In both loops below, a stopped task sees the new generation, so its later
    // ctx.produced and ctx.deleted do nothing.
    for (const slot of dropped) {
      slot.generation += 1
      this.unindex(slot.task)
      this.slots.delete(slot.task.id)
    }
    for (const task of tasks) {
      const existing = this.slots.get(task.id)
      if (existing) {
        existing.generation += 1
        this.unindex(existing.task)
        replaced.push(existing)
      }
      this.slots.set(task.id, new Slot(task, owner))
      this.index(task)
    }

    const ids = new Set(this.owners.get(owner))
    for (const slot of dropped) {
      ids.delete(slot.task.id)
    }
    for (const task of tasks) {
      ids.add(task.id)
    }
    if (ids.size === 0) {
      this.owners.delete(owner)
    } else {
      this.owners.set(owner, ids)
    }

    // finish wakes the waiting tasks, and abort() runs the task's abort listeners
    // at once, so the state must be whole first.
    const running: Slot[] = []
    for (const slot of dropped) {
      if (slot.phase === "running") running.push(slot)
      if (this.store) {
        void this.store.delete(slot.task.id)
      }
      if (slot.phase !== "completed") {
        this.finish(slot, { type: "cancelled", reason: "removed" })
      }
    }
    for (const slot of replaced) {
      if (slot.phase === "running") running.push(slot)
      // A replaced running task ends as cancelled "replaced" when its run returns (endIfStopped).
      // A dropped running task got cancelled "removed" at once, in the loop above.
      if (slot.phase === "pending") {
        this.finish(slot, { type: "cancelled", reason: "replaced" })
      }
    }
    for (const slot of running) {
      if (slot.abort) slot.abort.abort()
    }

    this.wake()
    const changedIds: string[] = []
    for (const slot of dropped) {
      changedIds.push(slot.task.id)
    }
    for (const task of tasks) {
      changedIds.push(task.id)
    }
    this.tell(changedIds)
  }

  async run(): Promise<Result> {
    if (!this.started) {
      this.started = true
      // Tells subscribers about the tasks that were added before the first run().
      this.tell([...this.slots.keys()])
    }
    for (const slot of this.slots.values()) {
      this.kick(slot)
    }
    await this.idle()
    return new Result(this.outcomes, this.errors)
  }

  /**
   * Sends withdrawn and promised events until the subscribers know the current
   * outputs of each task id in `ids`. Before the first run(), it sends nothing.
   */
  private tell(ids: readonly string[]): void {
    if (!this.started) return
    this.sendAll(this.outputChanges(ids))
  }

  /**
   * Yields one event at a time. Each event comes from the state at the time
   * that sendAll asks for it, so a subscriber that changes a task during a
   * send never gets a stale event.
   */
  private *outputChanges(ids: readonly string[]): Generator<ArtifactEvent> {
    // The first pass sends only withdrawn events. Thus an output that moves from one
    // task to another in one call is withdrawn before it is promised again.
    for (const id of ids) {
      let event = this.nextOutputChange(id, true)
      while (event !== null) {
        yield event
        event = this.nextOutputChange(id, true)
      }
    }
    for (const id of ids) {
      let event = this.nextOutputChange(id, false)
      while (event !== null) {
        yield event
        event = this.nextOutputChange(id, false)
      }
    }
  }

  /** Updates `told` by one output, and returns the event for it. Withdrawn comes first. */
  private nextOutputChange(id: string, withdrawnOnly: boolean): ArtifactEvent | null {
    let told = this.told.get(id)
    if (told === undefined) {
      told = new Map<string, Ref>()
      this.told.set(id, told)
    }
    const current = new Map<string, Ref>()
    const slot = this.slots.get(id)
    if (slot !== undefined) {
      for (const output of slot.task.outputs) {
        current.set(refKey(output), output)
      }
    }

    for (const [key, output] of told) {
      if (current.has(key)) continue
      told.delete(key)
      return { kind: "withdrawn", output, taskId: id }
    }
    if (withdrawnOnly) return null
    for (const [key, output] of current) {
      if (told.has(key)) continue
      told.set(key, output)
      return { kind: "promised", output, taskId: id }
    }
    if (told.size === 0) {
      this.told.delete(id)
    }
    return null
  }

  /** Throws if `setTasks(owner, tasks)` would break a rule of the build. */
  private assertSettable(owner: string, tasks: readonly Task[]): void {
    const ids = new Set<string>()
    // Each exact output id in `tasks`, and the task that declares it.
    const claims = new Map<string, string>()
    for (const task of tasks) {
      if (ids.has(task.id)) {
        throw new Error(`owner '${owner}' gives task '${task.id}' twice`)
      }
      ids.add(task.id)
      const existing = this.slots.get(task.id)
      if (existing && existing.owner !== owner) {
        throw new Error(
          `task '${task.id}' has two owners: '${existing.owner}' and '${owner}'`,
        )
      }
      for (const output of task.outputs) {
        if (!isArtifact(output)) continue
        const claimedBy = claims.get(output.id)
        if (claimedBy === task.id) {
          throw new Error(`task '${task.id}' declares output '${output.id}' twice`)
        }
        if (claimedBy !== undefined) {
          throw new Error(
            `duplicate output '${output.id}': claimed by '${claimedBy}' and '${task.id}'`,
          )
        }
        claims.set(output.id, task.id)
        // The tasks of this owner are all replaced or removed, so their outputs are free.
        const claimer = this.exactOutputs.get(output.id)
        if (claimer && this.slots.get(claimer.taskId)!.owner !== owner) {
          throw new Error(
            `duplicate output '${output.id}': claimed by '${claimer.taskId}' and '${task.id}'`,
          )
        }
      }
    }
  }

  private index(task: Task): void {
    for (const output of task.outputs) {
      if (isArtifact(output)) {
        this.exactOutputs.set(output.id, { artifact: output, taskId: task.id })
      } else {
        this.prefixOutputs.push({ prefix: output, taskId: task.id })
      }
    }
  }

  private unindex(task: Task): void {
    for (const output of task.outputs) {
      if (isArtifact(output)) {
        const claimer = this.exactOutputs.get(output.id)
        if (claimer && claimer.taskId === task.id) {
          this.exactOutputs.delete(output.id)
        }
      }
    }
    for (let i = this.prefixOutputs.length - 1; i >= 0; i--) {
      const entry = this.prefixOutputs[i]
      if (entry && entry.taskId === task.id) {
        this.prefixOutputs.splice(i, 1)
      }
    }
  }

  /**
   * Tasks that must finish before `task` can run.
   *
   * Artifact input: exact producer of that id, prefix outputs that
   * cover it, and tasks whose outputs this artifact `covers`
   * (a directory listing waits for writers under it).
   *
   * Prefix input: every current writer of a covered artifact or
   * overlapping prefix.
   */
  private producersOf(task: Task): string[] {
    const ids = new Set<string>()
    for (const input of task.inputs) {
      if (isPrefix(input)) {
        this.addPrefixProducers(input, ids)
      } else {
        this.addArtifactProducers(input, ids)
      }
    }
    ids.delete(task.id)
    return [...ids]
  }

  private addPrefixProducers(input: Prefix, ids: Set<string>): void {
    for (const entry of this.exactOutputs.values()) {
      if (input.covers(entry.artifact)) {
        ids.add(entry.taskId)
      }
    }
    for (const entry of this.prefixOutputs) {
      if (input.overlaps(entry.prefix)) {
        ids.add(entry.taskId)
      }
    }
  }

  private addArtifactProducers(input: Artifact, ids: Set<string>): void {
    const exact = this.exactOutputs.get(input.id)
    if (exact) {
      ids.add(exact.taskId)
    }
    for (const entry of this.prefixOutputs) {
      if (entry.prefix.covers(input)) {
        ids.add(entry.taskId)
      }
    }
    if (!input.coversOthers) return
    for (const entry of this.exactOutputs.values()) {
      if (input.covers(entry.artifact)) {
        ids.add(entry.taskId)
      }
    }
  }

  private unfinishedProducers(task: Task): string[] {
    const unfinished: string[] = []
    const producers = this.producersOf(task)
    for (const id of producers) {
      const slot = this.slots.get(id)
      if (!slot) continue
      if (slot.phase === "pending" || slot.phase === "running") {
        unfinished.push(id)
      }
    }
    return unfinished
  }

  private anyReady(): boolean {
    for (const slot of this.slots.values()) {
      if (slot.phase !== "pending") continue
      if (this.unfinishedProducers(slot.task).length === 0) {
        return true
      }
    }
    return false
  }

  private kick(slot: Slot): void {
    if (slot.launched === slot.generation) return
    if (slot.phase !== "pending") return
    slot.launched = slot.generation
    this.workCount += 1
    void this.execute(slot).finally(() => {
      this.workCount -= 1
      this.maybeIdle()
    })
  }

  private async execute(slot: Slot): Promise<void> {
    const generation = slot.generation
    const wait = await this.waitForInputs(slot, generation)
    if (generation !== slot.generation) return
    if (wait === "cancelled") return
    if (wait === "failed") {
      this.finish(slot, {
        type: "failed",
        error: new Error(`dependency of '${slot.task.id}' failed`),
      })
      return
    }
    if (wait === "deadlock") {
      this.finish(slot, {
        type: "failed",
        error: new Error(`deadlock waiting for inputs of '${slot.task.id}'`),
      })
      return
    }

    const skip = await this.decideSkip(slot.task)
    if (generation !== slot.generation) return
    if (skip) {
      this.finish(slot, { type: "skipped", reason: skip })
      return
    }

    slot.abort = new AbortController()
    slot.phase = "running"
    this.runningCount += 1

    const ctx = this.contextFor(slot, generation)
    try {
      await slot.task.run(ctx)
      if (this.endIfStopped(slot, generation)) return
      if (slot.listenerError === null) {
        await this.recordSuccess(slot, generation)
      }
      if (this.endIfStopped(slot, generation)) return
      if (slot.listenerError !== null) {
        this.finish(slot, { type: "failed", error: slot.listenerError })
        return
      }
      this.finish(slot, { type: "executed" })
    } catch (error) {
      const err = toError(error)
      if (generation !== slot.generation) {
        // A stopped task often throws because ctx.signal aborted. That is not an error.
        if (!isAbort(error, slot.abort.signal)) {
          this.addError(err)
        }
        this.endIfStopped(slot, generation)
        return
      }
      // A listener error fails the task even if the task caught it.
      // The task's own error, if it threw another one, goes to `errors`.
      const listenerError = slot.listenerError
      if (listenerError !== null && listenerError !== err) {
        this.addError(err)
      }
      this.finish(slot, { type: "failed", error: listenerError ?? err })
    }
  }

  /**
   * Ends a task that `setTasks`, `add`, or `remove` stopped while it ran. They already sent
   * its withdrawn events. Returns false when the task is still current.
   */
  private endIfStopped(slot: Slot, generation: number): boolean {
    if (generation === slot.generation) return false
    if (slot.phase !== "completed") {
      this.finish(slot, { type: "cancelled", reason: "replaced" })
    }
    // A cancelled task does not own its listener error, so the error goes to `errors`.
    if (slot.listenerError !== null) {
      this.addError(slot.listenerError)
    }
    return true
  }

  private async waitForInputs(slot: Slot, generation: number): Promise<WaitResult> {
    while (true) {
      if (generation !== slot.generation) return "cancelled"
      const producers = this.producersOf(slot.task)
      const unfinished: string[] = []
      for (const id of producers) {
        const producer = this.slots.get(id)
        if (!producer) continue
        if (producer.phase === "pending" || producer.phase === "running") {
          unfinished.push(id)
          continue
        }
        if (producer.outcome && producer.outcome.type === "failed") {
          return "failed"
        }
      }
      if (unfinished.length === 0) return "ok"
      if (this.runningCount === 0 && !this.anyReady()) {
        return "deadlock"
      }
      await this.waitTick()
    }
  }

  private contextFor(slot: Slot, generation: number): Context {
    return {
      signal: slot.abort!.signal,
      add: (task: Task) => {
        this.asTask(slot, () => this.add(task))
      },
      remove: (id: string) => {
        this.asTask(slot, () => this.remove(id))
      },
      produced: (artifact: Artifact) => {
        if (generation !== slot.generation) return
        this.asTask(slot, () => this.report(slot, "produced", artifact))
      },
      deleted: (artifact: Artifact) => {
        if (generation !== slot.generation) return
        this.asTask(slot, () => this.report(slot, "deleted", artifact))
      },
    }
  }

  private report(slot: Slot, kind: "produced" | "deleted", artifact: Artifact): void {
    if (!this.outputCovers(slot.task, artifact)) {
      throw new Error(
        `task '${slot.task.id}' ${kind} '${artifact.id}', which no output covers`,
      )
    }
    // A reported id gets no produced event after the task returns. The subscriber
    // already has the last report for it, so the last report wins.
    slot.reported.add(artifact.id)
    const event: ArtifactEvent = { kind, artifact, taskId: slot.task.id }
    this.sendAll([event])
  }

  private outputCovers(task: Task, artifact: Artifact): boolean {
    for (const output of task.outputs) {
      if (isPrefix(output) && output.covers(artifact)) return true
      if (isArtifact(output) && output.id === artifact.id) return true
    }
    return false
  }

  private async recordSuccess(slot: Slot, generation: number): Promise<void> {
    for (const output of slot.task.outputs) {
      // A subscriber can remove or replace this task. Then it sends no more events.
      if (generation !== slot.generation) return
      if (!isArtifact(output)) continue
      if (slot.reported.has(output.id)) continue
      const event: ArtifactEvent = { kind: "produced", artifact: output, taskId: slot.task.id }
      try {
        this.asTask(slot, () => this.sendAll([event]))
      } catch {
        // sendAll kept the error in slot.listenerError, and execute fails the task with it.
      }
    }

    if (generation !== slot.generation) return
    if (slot.listenerError !== null) return
    if (!this.store) return
    const inputStamps = await this.stampMap(this.artifactRefs(slot.task.inputs))
    const outputStamps = await this.stampMap(this.artifactRefs(slot.task.outputs))
    if (generation !== slot.generation) return
    const state: TaskState = { inputStamps, outputStamps }
    await this.store.set(slot.task.id, state)
  }

  private asTask(slot: Slot, call: () => void): void {
    const previous = this.caller
    // A task that already completed owns no error; its listener errors go to `errors`.
    if (slot.phase === "running") {
      this.caller = slot
    } else {
      this.caller = null
    }
    try {
      call()
    } finally {
      this.caller = previous
    }
  }

  /**
   * Sends every event, even after a listener throws. With a caller task,
   * each error goes to that task, and the first one is thrown after the loop.
   * Without one, each error goes to `errors`.
   */
  private sendAll(events: Iterable<ArtifactEvent>): void {
    const slot = this.caller
    let first: Error | null = null
    for (const event of events) {
      try {
        this.send(event)
      } catch (error) {
        const err = toError(error)
        if (slot === null) {
          this.addError(err)
          continue
        }
        if (first === null) {
          first = err
        }
        this.blame(slot, err)
      }
    }
    if (first !== null) {
      throw first
    }
  }

  private blame(slot: Slot, error: Error): void {
    if (slot.listenerError === null) {
      slot.listenerError = error
      return
    }
    // A nested send already reported this error, and it came back up through a listener.
    if (slot.listenerError === error) return
    this.addError(error)
  }

  private addError(error: Error): void {
    if (this.errors.includes(error)) return
    this.errors.push(error)
  }

  /** Errors that reach the build after the send returned, such as an async subscriber's rejection. */
  protected override rejected(reason: unknown): void {
    this.addError(toError(reason))
  }

  private async decideSkip(task: Task): Promise<"content" | "order" | null> {
    const inputs = this.artifactRefs(task.inputs)
    const outputs = this.artifactRefs(task.outputs)
    const inputStamps = await this.stampMap(inputs)
    const outputStamps = await this.stampMap(outputs)

    for (const output of outputs) {
      const stamp = outputStamps[output.id]
      if (!stamp || (stamp.order === undefined && stamp.content === undefined)) {
        return null
      }
    }

    const last = this.store ? await this.store.get(task.id) : null
    if (last) {
      if (!sameIds(last.inputStamps, inputStamps)) return null
      if (!sameIds(last.outputStamps, outputStamps)) return null
      const content = contentDecision(inputs, inputStamps, last.inputStamps)
      if (content === "match") return "content"
      if (content === "differ") return null
    }

    if (ordersFresh(inputs, outputs, inputStamps, outputStamps)) {
      return "order"
    }
    return null
  }

  private artifactRefs(refs: readonly Ref[]): Artifact[] {
    const artifacts: Artifact[] = []
    for (const ref of refs) {
      if (isArtifact(ref)) artifacts.push(ref)
    }
    return artifacts
  }

  private async stampMap(artifacts: Artifact[]): Promise<Record<string, Stamp>> {
    const result: Record<string, Stamp> = {}
    for (const artifact of artifacts) {
      const order = await artifact.orderStamp()
      const content = await artifact.contentStamp()
      const stamp: Stamp = {}
      if (order !== null) stamp.order = order
      if (content !== null) stamp.content = content
      result[artifact.id] = stamp
    }
    return result
  }

  private finish(slot: Slot, outcome: Outcome): void {
    if (slot.phase === "running") {
      this.runningCount -= 1
    }
    slot.phase = "completed"
    slot.outcome = outcome
    this.outcomes.set(slot.task, outcome)
    this.wake()
  }

  private wake(): void {
    const waiters = this.waiters
    this.waiters = []
    for (const waiter of waiters) {
      waiter()
    }
    if (this.started) {
      for (const slot of this.slots.values()) {
        if (slot.phase === "pending") {
          this.kick(slot)
        }
      }
    }
    this.maybeIdle()
  }

  private waitTick(): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.push(resolve)
    })
  }

  private idle(): Promise<void> {
    if (this.workCount === 0) {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve)
    })
  }

  private maybeIdle(): void {
    if (this.workCount !== 0) return
    const waiters = this.idleWaiters
    this.idleWaiters = []
    for (const waiter of waiters) {
      waiter()
    }
  }
}

function sameIds(
  left: Record<string, Stamp>,
  right: Record<string, Stamp>,
): boolean {
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  for (const key of leftKeys) {
    if (!(key in right)) return false
  }
  return true
}

function contentDecision(
  inputs: Artifact[],
  current: Record<string, Stamp>,
  stored: Record<string, Stamp>,
): "match" | "differ" | "unknown" {
  if (inputs.length === 0) return "unknown"
  let sawAll = true
  for (const input of inputs) {
    const now = current[input.id]
    const then = stored[input.id]
    if (!now || now.content === undefined || !then || then.content === undefined) {
      sawAll = false
      continue
    }
    if (now.content !== then.content) return "differ"
  }
  if (!sawAll) return "unknown"
  return "match"
}

function ordersFresh(
  inputs: Artifact[],
  outputs: Artifact[],
  inputStamps: Record<string, Stamp>,
  outputStamps: Record<string, Stamp>,
): boolean {
  if (outputs.length === 0) return false
  let maxInput: bigint | null = null
  for (const input of inputs) {
    const stamp = inputStamps[input.id]
    if (!stamp || stamp.order === undefined) return false
    if (maxInput === null || stamp.order > maxInput) {
      maxInput = stamp.order
    }
  }
  let minOutput: bigint | null = null
  for (const output of outputs) {
    const stamp = outputStamps[output.id]
    if (!stamp || stamp.order === undefined) return false
    if (minOutput === null || stamp.order < minOutput) {
      minOutput = stamp.order
    }
  }
  if (minOutput === null) return false
  if (maxInput === null) return true
  return maxInput <= minOutput
}

/** An artifact and a prefix with the same id are different outputs. */
function refKey(ref: Ref): string {
  if (isPrefix(ref)) return `prefix ${ref.id}`
  return `artifact ${ref.id}`
}

function toError(value: unknown): Error {
  if (value instanceof Error) return value
  return new Error(String(value))
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  if (error === signal.reason) return true
  if (typeof error !== "object" || error === null) return false
  return (error as { name?: unknown }).name === "AbortError"
}
