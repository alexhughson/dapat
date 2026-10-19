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

/** The default number of events that one drain of the event queue can send. */
export const SEND_LIMIT = 10_000

class Slot {
  generation = 1
  launched = 0
  phase: Phase = "pending"
  abort: AbortController | null = null
  // The ids that this run reported with ctx.produced or ctx.deleted.
  reported = new Set<string>()
  outcome: Outcome | null = null

  constructor(
    public task: Task,
    // The owner that gave the task: `add:<task id>` for build.add.
    public owner: string,
  ) {}
}

export class Build extends Emitter<ArtifactEvent> {
  private readonly store: Store | undefined
  private readonly sendLimit: number
  private readonly slots = new Map<string, Slot>()
  // For each owner, the ids of the tasks that it gave. Slot.owner is the reverse.
  private readonly owners = new Map<string, Set<string>>()
  private readonly exactOutputs = new Map<string, { artifact: Artifact; taskId: string }>()
  private readonly prefixOutputs: { prefix: Prefix; taskId: string }[] = []
  private readonly outcomes = new Map<Task, Outcome>()
  private readonly errors: Error[] = []
  // The events that wait to go to the subscribers, oldest first.
  private queue: ArtifactEvent[] = []
  private draining = false
  // The first subscriber error or send-limit error. Each later run() rejects with it.
  private fatal: Error | null = null

  private started = false
  private runningCount = 0
  private workCount = 0
  private waiters: Array<() => void> = []
  private idleWaiters: Array<() => void> = []

  constructor(opts?: { store?: Store; sendLimit?: number }) {
    super()
    this.store = opts?.store
    this.sendLimit = opts?.sendLimit ?? SEND_LIMIT
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
    // All withdrawn events of the call go before any promised event. Thus an output
    // that moves from one task to another in one call is withdrawn before it is promised.
    const withdrawn: ArtifactEvent[] = []
    const promised: ArtifactEvent[] = []
    const none = new Map<string, Ref>()
    // In both loops below, a stopped task sees the new generation, so its later
    // ctx.produced and ctx.deleted do nothing.
    for (const slot of dropped) {
      slot.generation += 1
      this.unindex(slot.task)
      this.slots.delete(slot.task.id)
      addOutputEvents(withdrawn, "withdrawn", slot.task.id, outputsByKey(slot.task), none)
    }
    for (const task of tasks) {
      let before = none
      const existing = this.slots.get(task.id)
      if (existing) {
        existing.generation += 1
        this.unindex(existing.task)
        replaced.push(existing)
        before = outputsByKey(existing.task)
      }
      this.slots.set(task.id, new Slot(task, owner))
      this.index(task)
      const after = outputsByKey(task)
      addOutputEvents(withdrawn, "withdrawn", task.id, before, after)
      addOutputEvents(promised, "promised", task.id, after, before)
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
        // The build does not wait for the delete. A delete error goes to result.errors.
        this.store.delete(slot.task.id).then(undefined, (error: unknown) => {
          this.addError(toError(error))
        })
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
    // Before the first run(), the build sends no events. run() then promises the current outputs.
    if (!this.started) return
    this.emit([...withdrawn, ...promised])
  }

  /** Rejects with the first subscriber error or send-limit error of the build. */
  async run(): Promise<Result> {
    if (!this.started) {
      this.started = true
      // Tells subscribers about the tasks that were added before the first run().
      const events: ArtifactEvent[] = []
      for (const slot of this.slots.values()) {
        addOutputEvents(events, "promised", slot.task.id, outputsByKey(slot.task), new Map())
      }
      this.emit(events)
    }
    if (this.fatal !== null) throw this.fatal
    for (const slot of this.slots.values()) {
      this.kick(slot)
    }
    await this.idle()
    if (this.fatal !== null) throw this.fatal
    return new Result(this.outcomes, this.errors)
  }

  /**
   * Puts `events` on the queue. If no drain runs, sends the queue until it is empty.
   * A subscriber that changes tasks during a send only adds events to the queue.
   * The drain that runs sends them after the current event reached every subscriber.
   */
  private emit(events: readonly ArtifactEvent[]): void {
    // After a fatal error, the build sends no more events.
    if (this.fatal !== null) return
    for (const event of events) {
      this.queue.push(event)
    }
    if (this.draining) return
    this.draining = true
    try {
      this.drain()
    } finally {
      this.draining = false
    }
  }

  private drain(): void {
    let sent = 0
    while (this.queue.length > 0) {
      const event = this.queue.shift()!
      try {
        this.send(event)
      } catch (error) {
        this.fail(toError(error))
        return
      }
      sent += 1
      if (sent === this.sendLimit && this.queue.length > 0) {
        const message = `send limit: one drain sent ${sent} events, and more wait; the last was '${eventLine(event)}'`
        this.fail(new Error(message))
        return
      }
    }
  }

  /**
   * Keeps the first fatal error, clears the queue, and aborts every running task.
   * The build then starts no task and sends no event, and run() rejects with the error.
   */
  private fail(error: Error): void {
    if (this.fatal !== null) return
    this.fatal = error
    this.queue = []
    for (const slot of this.slots.values()) {
      if (slot.phase === "running" && slot.abort) slot.abort.abort()
    }
    // Wakes the waiting tasks, so that they see the error and stop.
    this.wake()
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
    if (this.fatal !== null) return
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
    if (this.fatal !== null) return
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
    if (this.fatal !== null) return
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
      await this.recordSuccess(slot, generation)
      if (this.endIfStopped(slot, generation)) return
      this.finish(slot, { type: "executed" })
    } catch (error) {
      if (generation !== slot.generation) {
        // A stopped task often throws because ctx.signal aborted. That is not an error.
        if (!isAbort(error, slot.abort.signal)) {
          this.addError(toError(error))
        }
        this.endIfStopped(slot, generation)
        return
      }
      this.finish(slot, { type: "failed", error: toError(error) })
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
    return true
  }

  private async waitForInputs(slot: Slot, generation: number): Promise<WaitResult> {
    while (true) {
      if (generation !== slot.generation) return "cancelled"
      if (this.fatal !== null) return "cancelled"
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
        this.add(task)
      },
      remove: (id: string) => {
        this.remove(id)
      },
      produced: (artifact: Artifact) => {
        if (generation !== slot.generation) return
        this.report(slot, "produced", artifact)
      },
      deleted: (artifact: Artifact) => {
        if (generation !== slot.generation) return
        this.report(slot, "deleted", artifact)
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
    this.emit([event])
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
      // Each event is sent alone, so that the next check sees the change.
      if (generation !== slot.generation) return
      if (this.fatal !== null) return
      if (!isArtifact(output)) continue
      if (slot.reported.has(output.id)) continue
      const event: ArtifactEvent = { kind: "produced", artifact: output, taskId: slot.task.id }
      this.emit([event])
    }

    if (generation !== slot.generation) return
    // Subscribers did not get every event, so the build keeps no record.
    if (this.fatal !== null) return
    if (!this.store) return
    const inputStamps = await this.stampMap(this.artifactRefs(slot.task.inputs))
    const outputStamps = await this.stampMap(this.artifactRefs(slot.task.outputs))
    if (generation !== slot.generation) return
    const state: TaskState = { inputStamps, outputStamps }
    await this.store.set(slot.task.id, state)
  }

  private addError(error: Error): void {
    if (this.errors.includes(error)) return
    this.errors.push(error)
  }

  /**
   * Gets the rejection of a promise that a subscriber returned. The send already
   * failed the build, so this error is kept only if it is the first one.
   */
  protected override rejected(reason: unknown): void {
    this.fail(toError(reason))
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

/** The outputs of `task` by refKey. An output that the task declares two times is here one time. */
function outputsByKey(task: Task): Map<string, Ref> {
  const outputs = new Map<string, Ref>()
  for (const output of task.outputs) {
    outputs.set(refKey(output), output)
  }
  return outputs
}

/** Adds a `kind` event for each output in `outputs` whose key is not in `except`. */
function addOutputEvents(
  events: ArtifactEvent[],
  kind: "promised" | "withdrawn",
  taskId: string,
  outputs: Map<string, Ref>,
  except: Map<string, Ref>,
): void {
  for (const [key, output] of outputs) {
    if (except.has(key)) continue
    events.push({ kind, output, taskId })
  }
}

/** "<kind> <id> by <task id>", for error messages. */
function eventLine(event: ArtifactEvent): string {
  if (event.kind === "produced" || event.kind === "deleted") {
    return `${event.kind} ${event.artifact.id} by ${event.taskId}`
  }
  return `${event.kind} ${event.output.id} by ${event.taskId}`
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
