import type { Artifact } from "./artifact"
import { Emitter } from "./emitter"
import type { AnyMatcher } from "./matcher"
import type { Prefix } from "./prefix"
import { Task, isArtifact, isPrefix, type Context, type Ref } from "./task"
import type { Store, TaskState } from "./store"
import { Outcome, Result } from "./result"
import { TaskGroup } from "./task-group"
import { TaskMaterializer, type TaskMaterializerConfig } from "./task-materializer"

export type ArtifactEvent =
  | { kind: "promised"; output: Ref; taskId: string }
  | { kind: "produced"; artifact: Artifact; taskId: string }
  | { kind: "deleted"; artifact: Artifact; taskId: string }
  | { kind: "withdrawn"; output: Ref; taskId: string }

type Phase = "pending" | "running" | "completed"

type WaitResult = "ok" | "failed" | "cancelled" | "deadlock"

/** The default number of events that subscribers can cause during one drain of the event queue. */
export const SEND_LIMIT = 10_000

// The build that each matcher belongs to. A matcher sends its matches to one build only.
const matcherBuilds = new WeakMap<AnyMatcher, Build>()

// The outputs of no task. Shared, and never changed.
const NO_OUTPUTS: ReadonlyMap<string, Ref> = new Map()

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
    // The group that gave the task.
    public group: TaskGroup,
  ) {}
}

export class Build extends Emitter<ArtifactEvent> {
  private readonly store: Store | undefined
  private readonly sendLimit: number
  private readonly slots = new Map<string, Slot>()
  // For each group, the ids of its tasks. Slot.group is the reverse.
  private readonly taskIdsByGroup = new Map<TaskGroup, Set<string>>()
  // The group that build.add made for each task id. A replacement with the same id keeps its group.
  private readonly addedTaskGroups = new Map<string, TaskGroup>()
  private readonly exactOutputs = new Map<string, { artifact: Artifact; taskId: string }>()
  // The prefix outputs of all tasks. The producer lookup scans them; exact outputs are in exactOutputs.
  private readonly prefixOutputs: PrefixOutput[] = []
  private readonly outcomes = new Map<Task, Outcome>()
  private readonly errors: Error[] = []
  // The events that wait to go to the subscribers, oldest first.
  private queue: ArtifactEvent[] = []
  private draining = false
  // The first subscriber error or send-limit error. Each later run() rejects with it.
  private fatal: Error | null = null

  // The matchers of every build.each, each one time, in the order of the build.each calls.
  private readonly matchers = new Set<AnyMatcher>()
  private eachCount = 0

  private started = false
  // True while the first run() waits for the scans. No task starts then.
  private scanning = false
  // The scans of the first run(). Every run() waits for them before it starts a task.
  private scans: Promise<void> | null = null
  // Aborts the scans. fail() aborts it, so a fatal error ends the wait for the scans.
  private readonly scanAbort = new AbortController()
  private runningCount = 0
  private workCount = 0
  private waiters: Array<() => void> = []
  private idleWaiters: Array<() => void> = []

  constructor(opts?: { store?: Store; sendLimit?: number }) {
    super()
    this.store = opts?.store
    const sendLimit = opts?.sendLimit ?? SEND_LIMIT
    if (!Number.isInteger(sendLimit) || sendLimit < 1) {
      let shown = String(sendLimit)
      if (typeof sendLimit === "string") {
        shown = JSON.stringify(sendLimit)
      }
      throw new Error(`sendLimit must be a positive integer, not ${shown}`)
    }
    this.sendLimit = sendLimit
  }

  add(task: Task): void {
    let group = this.addedTaskGroups.get(task.id)
    if (group === undefined) {
      group = new TaskGroup(`build.add ${task.id}`)
      this.addedTaskGroups.set(task.id, group)
    }
    this.setTasks(group, [task])
  }

  /** Removes the task from its group. The other tasks of the group stay. */
  remove(id: string): void {
    const slot = this.slots.get(id)
    if (!slot) return
    // A group of build.add has one task, so it is now empty and a later add can make a new one.
    if (this.addedTaskGroups.get(id) === slot.group) {
      this.addedTaskGroups.delete(id)
    }
    this.change(slot.group, [], [slot])
  }

  /**
   * Makes tasks for each artifact that the matcher finds.
   * Call it before the first run(): that run scans each matcher before any task starts.
   */
  each<M extends Record<string, AnyMatcher>>(config: TaskMaterializerConfig<M>): void {
    if (this.started) {
      throw new Error("build.each must come before the first build.run()")
    }
    const number = this.eachCount + 1
    const taskMaterializer = new TaskMaterializer(number, config, (group, tasks) => this.setTasks(group, tasks))
    const matcher = taskMaterializer.matcher
    const matcherBuild = matcherBuilds.get(matcher)
    if (matcherBuild !== undefined && matcherBuild !== this) {
      throw new Error(`build.each ${number}: its matcher belongs to another Build; make a new matcher for each Build`)
    }
    this.eachCount = number
    matcher.subscribe((event) => {
      // An error here is fatal, like a subscriber error. The matcher's send never sees it.
      try {
        taskMaterializer.hear(event)
      } catch (error) {
        this.fail(toError(error))
      }
    })
    // Each matcher gets each artifact event one time, even if several build.each calls use it.
    if (!this.matchers.has(matcher)) {
      matcherBuilds.set(matcher, this)
      this.matchers.add(matcher)
      this.subscribe((event) => matcher.receiveArtifactEvent(event))
    }
  }

  /**
   * Makes `tasks` the tasks of `group`. Adds each new id, replaces each known id,
   * and removes each id that the group had before and does not get now.
   * build.add and build.each call it. Throws, with no change, if another group has one of the ids.
   */
  protected setTasks(group: TaskGroup, tasks: readonly Task[]): void {
    this.assertSettable(group, tasks)
    const given = new Set<string>()
    for (const task of tasks) {
      given.add(task.id)
    }
    const dropped: Slot[] = []
    const before = this.taskIdsByGroup.get(group) ?? new Set<string>()
    for (const id of before) {
      if (given.has(id)) continue
      dropped.push(this.slots.get(id)!)
    }
    this.change(group, tasks, dropped)
  }

  /**
   * Adds or replaces each task in `tasks` and removes each slot in `dropped`.
   * It changes the state, puts the events on the queue, and then ends the stopped tasks.
   * It drains the queue last.
   */
  private change(group: TaskGroup, tasks: readonly Task[], dropped: readonly Slot[]): void {
    const replaced: Slot[] = []
    // All withdrawn events of the call go before any promised event. Thus an output
    // that moves from one task to another in one call is withdrawn before it is promised.
    const withdrawn: ArtifactEvent[] = []
    const promised: ArtifactEvent[] = []
    // In both loops below, a stopped task sees the new generation, so its later
    // ctx.produced and ctx.deleted do nothing.
    for (const slot of dropped) {
      slot.generation += 1
      this.unindex(slot.task)
      this.slots.delete(slot.task.id)
      addOutputEvents(withdrawn, "withdrawn", slot.task.id, outputsByKey(slot.task), NO_OUTPUTS)
    }
    for (const task of tasks) {
      let before = NO_OUTPUTS
      const existing = this.slots.get(task.id)
      if (existing) {
        existing.generation += 1
        this.unindex(existing.task)
        replaced.push(existing)
        before = outputsByKey(existing.task)
      }
      this.slots.set(task.id, new Slot(task, group))
      this.index(task)
      const after = outputsByKey(task)
      addOutputEvents(withdrawn, "withdrawn", task.id, before, after)
      addOutputEvents(promised, "promised", task.id, after, before)
    }

    const ids = new Set(this.taskIdsByGroup.get(group))
    for (const slot of dropped) {
      ids.delete(slot.task.id)
    }
    for (const task of tasks) {
      ids.add(task.id)
    }
    if (ids.size === 0) {
      this.taskIdsByGroup.delete(group)
    } else {
      this.taskIdsByGroup.set(group, ids)
    }
    // An abort listener below can change tasks too. Its events must come after these.
    this.push(withdrawn)
    this.push(promised)

    // finish wakes the waiting tasks, and abort() runs the task's abort listeners
    // at once, so the state must be whole first.
    const running: Slot[] = []
    for (const slot of dropped) {
      if (slot.phase === "running") running.push(slot)
      if (this.store) {
        void this.deleteRecord(this.store, slot.task.id)
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
    this.drain()
  }

  /** Starts to delete the record of a task. run() waits for it. A delete error goes to `errors`. */
  private async deleteRecord(store: Store, id: string): Promise<void> {
    this.workCount += 1
    try {
      // Inside the try, a delete that throws at once also goes to `errors`.
      await store.delete(id)
    } catch (error) {
      this.errors.push(toError(error))
    } finally {
      this.workCount -= 1
      this.maybeIdle()
    }
  }

  /** Rejects with the first subscriber error or send-limit error of the build. */
  async run(): Promise<Result> {
    if (!this.started) {
      this.started = true
      // Tells subscribers about the tasks that were added before the first run().
      const events: ArtifactEvent[] = []
      for (const slot of this.slots.values()) {
        addOutputEvents(events, "promised", slot.task.id, outputsByKey(slot.task), NO_OUTPUTS)
      }
      this.push(events)
      this.drain()
      // A build with no matchers starts its tasks in this same call, as before build.each existed.
      if (this.matchers.size > 0 && this.fatal === null) {
        this.scans = this.scanAll()
      }
    }
    // A run() that starts while the first run() scans waits for the same scans.
    if (this.scans !== null) {
      await this.scans
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
   * Runs the scan of each matcher at the same time. Returns when every scan has
   * returned, or at once when the build fails: the first scan error is fatal, and a
   * scan that ignores its aborted signal must not keep run() waiting.
   */
  private async scanAll(): Promise<void> {
    const signal = this.scanAbort.signal
    const aborted = new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true })
    })
    const scans: Promise<void>[] = []
    this.scanning = true
    for (const matcher of this.matchers) {
      scans.push(this.scan(matcher, signal))
    }
    await Promise.race([Promise.all(scans), aborted])
    this.scanning = false
  }

  private async scan(matcher: AnyMatcher, signal: AbortSignal): Promise<void> {
    try {
      await matcher.scan(signal)
    } catch (error) {
      this.fail(toError(error))
    }
  }

  /** Puts `events` at the end of the queue. Before the first run(), the build sends no events. */
  private push(events: readonly ArtifactEvent[]): void {
    if (!this.started) return
    // After a fatal error, the build sends no more events.
    if (this.fatal !== null) return
    for (const event of events) {
      this.queue.push(event)
    }
  }

  /**
   * Sends the queue, one event at a time to every subscriber, until it is empty.
   * A subscriber that changes tasks during a send only pushes events, and this drain
   * sends them after the current event reached every subscriber.
   */
  private drain(): void {
    if (this.draining) return
    this.draining = true
    try {
      this.sendQueue()
    } finally {
      this.draining = false
    }
  }

  private sendQueue(): void {
    // The limit counts only the events that subscribers cause, not the events that started the drain.
    const initial = this.queue.length
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
      const caused = sent - initial
      if (caused >= this.sendLimit && this.queue.length > 0) {
        const message =
          `send limit: subscribers caused ${caused} events in one drain, and more wait; ` +
          `the last sent was '${eventLine(event).slice(0, 400)}'`
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
    this.scanAbort.abort(error)
    for (const slot of this.slots.values()) {
      if (slot.phase === "running" && slot.abort) slot.abort.abort()
    }
    // Wakes the waiting tasks, so that they see the error and stop.
    this.wake()
  }

  /** Throws if `setTasks(group, tasks)` would break a rule of the build. */
  private assertSettable(group: TaskGroup, tasks: readonly Task[]): void {
    const ids = new Set<string>()
    // Each exact output id in `tasks`, and the task that declares it.
    const claims = new Map<string, string>()
    for (const task of tasks) {
      if (ids.has(task.id)) {
        throw new Error(`group '${group.label}' gives task '${task.id}' twice`)
      }
      ids.add(task.id)
      const existing = this.slots.get(task.id)
      if (existing && existing.group !== group) {
        throw new Error(
          `task '${task.id}' is in two groups: '${existing.group.label}' and '${group.label}'`,
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
        // The tasks of this group are all replaced or removed, so their outputs are free.
        const claimer = this.exactOutputs.get(output.id)
        if (claimer && this.slots.get(claimer.taskId)!.group !== group) {
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
      }
      if (isPrefix(output)) {
        this.prefixOutputs.push({ output, taskId: task.id })
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
   * Artifact input: exact producer of that id, and prefix outputs that cover it.
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
      if (input.overlaps(entry.output)) {
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
      if (entry.output.covers(input)) {
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
    if (this.scanning) return
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
    // Lets the code that added the task finish first. Thus a producer that the same
    // synchronous code adds later is in the build when the task looks for its producers.
    await Promise.resolve()
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

    // The input stamps from before the run. The record keeps these, so an input
    // that changes during the run makes the next build run the task again.
    // The wait above already gave the producers under each prefix input time to finish.
    let inputStamps: StampMap | null = null
    let skip = false
    try {
      if (this.store) {
        inputStamps = await this.stampRefs(slot.task.inputs)
        skip = await this.canSkip(this.store, slot.task, inputStamps)
      }
    } catch (error) {
      // A store or a stamp() that throws fails the task, as an error in task.run does.
      if (generation !== slot.generation) return
      if (this.fatal !== null) return
      this.finish(slot, { type: "failed", error: toError(error) })
      return
    }
    if (generation !== slot.generation) return
    if (this.fatal !== null) return
    if (skip) {
      this.finish(slot, { type: "skipped" })
      return
    }

    slot.abort = new AbortController()
    slot.phase = "running"
    this.runningCount += 1

    const ctx = this.contextFor(slot, generation)
    try {
      await slot.task.run(ctx)
      if (this.endIfStopped(slot, generation)) return
      await this.recordSuccess(slot, generation, inputStamps)
      if (this.endIfStopped(slot, generation)) return
      this.finish(slot, { type: "executed" })
    } catch (error) {
      if (generation !== slot.generation) {
        // A stopped task often throws because ctx.signal aborted. That is not an error.
        if (!isAbort(error, slot.abort.signal)) {
          this.errors.push(toError(error))
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
    this.push([event])
    this.drain()
  }

  private outputCovers(task: Task, artifact: Artifact): boolean {
    for (const output of task.outputs) {
      if (isPrefix(output) && output.covers(artifact)) return true
      if (isArtifact(output) && output.id === artifact.id) return true
    }
    return false
  }

  private async recordSuccess(
    slot: Slot,
    generation: number,
    inputStamps: StampMap | null,
  ): Promise<void> {
    for (const output of slot.task.outputs) {
      // A subscriber can remove or replace this task. Then it sends no more events.
      // Each event is sent alone, so that the next check sees the change.
      if (generation !== slot.generation) return
      if (!isArtifact(output)) continue
      if (slot.reported.has(output.id)) continue
      const event: ArtifactEvent = { kind: "produced", artifact: output, taskId: slot.task.id }
      this.push([event])
      this.drain()
    }

    if (generation !== slot.generation) return
    // Subscribers did not get every event, so the build keeps no record.
    if (this.fatal !== null) return
    if (!this.store) return
    if (inputStamps === null) return
    const outputStamps = await this.stampRefs(slot.task.outputs)
    if (generation !== slot.generation) return
    // A fatal error can come during the stamp reads above.
    if (this.fatal !== null) return
    const state: TaskState = { inputStamps, outputStamps }
    await this.store.set(slot.task.id, state)
  }

  /**
   * Gets the rejection of a promise that a subscriber returned. The send already failed
   * the build with the first error. This override only keeps the rejection from being unhandled.
   */
  protected override rejected(): void {}

  /**
   * True when the task has an input, every prefix has a stamp, every output exists,
   * and the stamps and ids equal the record. `inputStamps` are the current input stamps.
   */
  private async canSkip(store: Store, task: Task, inputStamps: StampMap): Promise<boolean> {
    // With no input, nothing can show that the result is still current.
    if (task.inputs.length === 0) return false
    // stampRefs leaves out a prefix with a null stamp. That prefix cannot tell what is under it.
    for (const input of task.inputs) {
      if (!Object.hasOwn(inputStamps, refKey(input))) return false
    }
    const record = await store.get(task.id)
    if (!record) return false
    // A record with two stamps for each id has a different shape. It counts as no record.
    // A record from PR 7, before prefix stamps, keyed its stamps by bare id. No key
    // matches the current "artifact <id>" keys, so the task runs once and writes a new record.
    if (!isStampMap(record.inputStamps)) return false
    if (!isStampMap(record.outputStamps)) return false
    if (!sameStamps(record.inputStamps, inputStamps)) return false

    const outputStamps = newStampMap()
    for (const output of task.outputs) {
      const stamp = await output.stamp()
      if (stamp === null) return false
      const key = refKey(output)
      if (!Object.hasOwn(record.outputStamps, key)) return false
      if (record.outputStamps[key] !== stamp) return false
      outputStamps[key] = stamp
    }
    const recordedCount = Object.keys(record.outputStamps).length
    const currentCount = Object.keys(outputStamps).length
    if (recordedCount !== currentCount) return false
    return true
  }

  /**
   * The stamps of `refs`, keyed by refKey. A prefix with a null stamp is left out:
   * the record never holds it, and the task always runs.
   */
  private async stampRefs(refs: readonly Ref[]): Promise<StampMap> {
    const result = newStampMap()
    for (const ref of refs) {
      const stamp = await ref.stamp()
      if (stamp === null && isPrefix(ref)) continue
      result[refKey(ref)] = stamp
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

/** Stamps keyed by refKey, so a prefix and an artifact with the same id cannot collide. */
type StampMap = Record<string, string | null>

/** An output and the task that declares it. */
type PrefixOutput = { output: Prefix; taskId: string }

/** An empty stamp map with no prototype, so that an id such as "__proto__" is a plain key. */
function newStampMap(): StampMap {
  return Object.create(null) as StampMap
}

/** True when both maps have the same ids, and each id has the same stamp. */
function sameStamps(recorded: StampMap, current: StampMap): boolean {
  const recordedIds = Object.keys(recorded)
  const currentIds = Object.keys(current)
  if (recordedIds.length !== currentIds.length) return false
  for (const id of currentIds) {
    if (!Object.hasOwn(recorded, id)) return false
    if (recorded[id] !== current[id]) return false
  }
  return true
}

/** True when each value is a string or null. A stamp map from an older record is not. */
function isStampMap(value: unknown): value is StampMap {
  if (typeof value !== "object" || value === null) return false
  if (Array.isArray(value)) return false
  for (const stamp of Object.values(value)) {
    if (stamp === null) continue
    if (typeof stamp !== "string") return false
  }
  return true
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
  outputs: ReadonlyMap<string, Ref>,
  except: ReadonlyMap<string, Ref>,
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
