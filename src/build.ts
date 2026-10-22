import type { Artifact } from "./artifact"
import { Emitter } from "./emitter"
import type { AnyMatcher } from "./matcher"
import type { MatchedArtifactEvent } from "./matched-artifact"
import { OutputIndex } from "./output-index"
import { Task, isArtifact, isPrefix, type Context, type Ref } from "./task"
import type { Store, TaskState } from "./store"
import { Outcome, Result, type RunReason } from "./result"
import { TaskGroup, type GroupTasks } from "./task-group"
import { TaskMaterializer, type TaskMaterializerConfig } from "./task-materializer"

export type ArtifactEvent =
  | { kind: "promised"; output: Ref; taskId: string }
  | { kind: "produced"; artifact: Artifact; taskId: string }
  | { kind: "deleted"; artifact: Artifact; taskId: string }
  | { kind: "withdrawn"; output: Ref; taskId: string }

type Phase = "pending" | "running" | "completed"

type WaitResult = "ok" | "failed" | "cancelled" | "deadlock"

/**
 * Why a blocked task wakes:
 * - "wake": each producer that it waited for has ended, or was replaced or removed. Also sent when
 *   the task itself ends while it waits, and when the build fails. The task looks at its producers again.
 * - "failed": a producer that it waited for failed.
 * - "deadlock": no task runs, and every pending task waits for a producer.
 */
type WakeSignal = "wake" | "failed" | "deadlock"

/** The default number of events that subscribers can cause during one drain of the event queue. */
export const SEND_LIMIT = 10_000

// The build that each matcher belongs to. A matcher sends its matches to one build only.
const matcherBuilds = new WeakMap<AnyMatcher, Build>()

// The outputs of no task. Shared, and never changed.
const NO_OUTPUTS: ReadonlyMap<string, Ref> = new Map()

/** A TaskMaterializer that uses a matcher, and the name it gives that matcher. */
type MatcherHearer = {
  // A TaskMaterializer of any matcher types.
  taskMaterializer: { hear(matcherName: string, event: MatchedArtifactEvent): void }
  matcherName: string
}

type MatchEventToHear = MatcherHearer & { event: MatchedArtifactEvent }

class Slot {
  generation = 1
  launched = 0
  phase: Phase = "pending"
  abort: AbortController | null = null
  // The ids that this run reported with ctx.produced or ctx.deleted.
  reported = new Set<string>()
  outcome: Outcome | null = null
  // While the task waits for its inputs (Build.block until Build.resume):
  // - waitingOn: the unfinished producers that its last look found. Each one holds this slot in its `waiters`.
  // - waitCount: how many of them did not end yet, and were not replaced or removed. At 0 the task wakes.
  // - wakeUp: the function that wakes the task. null when the task does not wait.
  waitingOn: Slot[] = []
  waitCount = 0
  wakeUp: ((signal: WakeSignal) => void) | null = null
  // The slots that wait for this slot to end. Build.endWait tells each of them when it ends.
  readonly waiters = new Set<Slot>()
  // The place of the task id in Build.slots. A replacement keeps the place, as Map.set does.
  // A change starts its new slots in this order, as run() does.
  order = 0

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
  // The last Slot.order that the build gave.
  private lastOrder = 0
  // The slots that a change made and that did not start yet: before the first run(), or during its scans.
  private readonly notStarted = new Set<Slot>()
  // For each group, the ids of its tasks. Slot.group is the reverse.
  private readonly taskIdsByGroup = new Map<TaskGroup, Set<string>>()
  // The groups that build.add made. A replacement with the same id keeps its group.
  private readonly addedTaskGroups = new WeakSet<TaskGroup>()
  private readonly exactOutputs = new Map<string, { artifact: Artifact; taskId: string }>()
  // The outputs of the tasks in the build, by the id of the task that declares them. producersOf looks here.
  private readonly liveOutputs = new OutputIndex<string>()
  private readonly outcomes = new Map<Task, Outcome>()
  private readonly errors: Error[] = []
  // The events that wait to go to the subscribers, oldest first.
  private queue: ArtifactEvent[] = []
  private draining = false
  // The number of change() calls that did not reach their drain yet. See checkDeadlock().
  private changeDepth = 0
  // The first subscriber error or send-limit error. Each later run() rejects with it.
  private fatal: Error | null = null
  // The slot whose report the build sends now. null outside ctx.produced and ctx.deleted.
  private reportingSlot: Slot | null = null
  // The outputs of the tasks that a report removed, each with the running task that sent the report.
  // Such a task can come back while the reporter runs: for example, the reporter deletes a matched
  // file and then writes it again. Until the reporter ends, a reader of these outputs waits for it.
  private readonly removedOutputs = new OutputIndex<RemovedTask>()
  // The removed tasks that each reporter put in removedOutputs. finish() deletes them when the reporter ends.
  private readonly removedTasksByReporter = new Map<Slot, RemovedTask[]>()

  // The matchers of every build.each, each one time, in the order of the build.each calls,
  // with the TaskMaterializers that use each one.
  private readonly hearersByMatcher = new Map<AnyMatcher, MatcherHearer[]>()
  private eachCount = 0
  // The matcher events that wait for a TaskMaterializer.hear, oldest first. See hearMatchEvents.
  private matchEvents: MatchEventToHear[] = []
  private hearing = false
  // The open step of task changes: the new tasks of each group, which the build applies at the end
  // of the step. null when no step is open. See setTasksOfGroups.
  private pendingTasksByGroup: Map<TaskGroup, readonly Task[]> | null = null

  private started = false
  // True while the first run() waits for the scans. No task starts then.
  private scanning = false
  // The scans of the first run(). Every run() waits for them before it starts a task.
  private scans: Promise<void> | null = null
  // Aborts the scans. fail() aborts it, so a fatal error ends the wait for the scans.
  private readonly scanAbort = new AbortController()
  private runningCount = 0
  // The slots in the phase "pending", and the slots among them that wait for a producer.
  // When no task runs and every pending slot waits, no task can make progress: a deadlock.
  // pendingCount changes in three places only: +1 for each new slot in change(), -1 when execute()
  // sets "running", and -1 when finish() ends a slot that is still pending.
  // A pending slot that is not in `blocked` (not started yet, or in its stamp phase) prevents a deadlock.
  private pendingCount = 0
  private readonly blocked = new Set<Slot>()
  private workCount = 0
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
    const slot = this.slots.get(task.id)
    let group: TaskGroup
    if (slot && this.addedTaskGroups.has(slot.group)) {
      group = slot.group
    } else {
      group = new TaskGroup(`build.add ${task.id}`)
      this.addedTaskGroups.add(group)
    }
    // add never joins the open step: it throws at once, before it changes anything.
    this.applyTasksOfGroups([{ group, tasks: [task] }])
  }

  /** Removes the task from its group. The other tasks of the group stay. */
  remove(id: string): void {
    const slot = this.slots.get(id)
    if (!slot) return
    this.change([], [slot])
  }

  /**
   * Makes tasks for each joined set of the matches of its matchers.
   * Call it before the first run(): that run scans each matcher before any task starts.
   */
  each<M extends Record<string, AnyMatcher>, const R extends keyof M & string = keyof M & string>(
    config: TaskMaterializerConfig<M, R>,
  ): void {
    if (this.started) {
      throw new Error("build.each must come before the first build.run()")
    }
    const number = this.eachCount + 1
    const taskMaterializer = new TaskMaterializer(number, config, (group, tasks) => this.setTasksOfGroups([{ group, tasks }]))
    const matcherNames = Object.keys(config.matchersByName)
    for (const name of matcherNames) {
      const matcherBuild = matcherBuilds.get(config.matchersByName[name]!)
      if (matcherBuild !== undefined && matcherBuild !== this) {
        throw new Error(
          `build.each ${number}: its matcher '${name}' belongs to another Build; make a new matcher for each Build`,
        )
      }
    }
    this.eachCount = number
    for (const name of matcherNames) {
      const matcher = config.matchersByName[name]!
      const newHearer: MatcherHearer = { taskMaterializer, matcherName: name }
      const knownHearers = this.hearersByMatcher.get(matcher)
      if (knownHearers !== undefined) {
        knownHearers.push(newHearer)
        continue
      }
      const hearers: MatcherHearer[] = [newHearer]
      matcherBuilds.set(matcher, this)
      this.hearersByMatcher.set(matcher, hearers)
      // Each matcher gets each artifact event one time, even if several build.each calls use it.
      this.subscribe((event) => matcher.receiveArtifactEvent(event))
      // One subscription for all build.each calls of the matcher. It queues the event for each
      // of them at once, so each one hears the events of the matcher in send order, also an
      // event that the `tasks` of another build.each sends.
      matcher.subscribe((event) => {
        // A failed build makes no more tasks, so it does not call `tasks` again.
        if (this.fatal) return
        for (const hearer of hearers) {
          this.matchEvents.push({ taskMaterializer: hearer.taskMaterializer, matcherName: hearer.matcherName, event })
        }
        this.hearMatchEvents()
      })
    }
  }

  /**
   * Gives each waiting matcher event to its TaskMaterializer, oldest first, until none waits.
   * A hear never runs inside another hear: a matcher event that comes during a hear, from
   * `tasks` or from a subscriber of the events of a task change, waits here, and this loop hears it
   * next. So the outermost matcher send still returns only after every task it caused exists.
   * The events join the open step of the scans or of the current drain. With no open step,
   * the events that this call hears are one step of their own.
   * An error here is fatal, like a subscriber error. The matcher's send never sees it.
   */
  private hearMatchEvents(): void {
    if (this.hearing) return
    // A matcher event that comes from a drain or a scan joins their step. Else it opens its own.
    const ownStep = this.pendingTasksByGroup === null
    if (ownStep) this.pendingTasksByGroup = new Map()
    this.hearing = true
    try {
      while (this.matchEvents.length > 0 && this.fatal === null) {
        const next = this.matchEvents.shift()!
        next.taskMaterializer.hear(next.matcherName, next.event)
      }
    } catch (error) {
      this.matchEvents = []
      this.fail(toError(error))
    } finally {
      this.hearing = false
      if (this.fatal) {
        this.matchEvents = []
      }
    }
    if (ownStep) this.closeOpenStep()
  }

  /**
   * Makes the tasks of each group in `changes` its new tasks: adds each new id, replaces each known id,
   * and removes each id that the group had before and that no group of the step gets now.
   * While a step is open, the changes join it, and the build applies them all at the end of the step.
   * A later change of a group in the same step replaces its earlier one. A step is open while the
   * first run() scans, during each drain of the event queue, and during each matcher event that
   * comes from outside a drain. Else the changes are a step of their own.
   * The rules apply to the state after the whole step. A task id can move from one group of the
   * step to another one: that is a replacement, as a known id in one group is, so its store record stays.
   * Throws, with no change, if a step of its own breaks a rule. An open step that breaks a rule is a fatal error.
   */
  protected setTasksOfGroups(changes: readonly GroupTasks[]): void {
    if (this.pendingTasksByGroup !== null) {
      for (const { group, tasks } of changes) {
        this.pendingTasksByGroup.set(group, tasks)
      }
      return
    }
    this.applyTasksOfGroups(changes)
  }

  /**
   * Closes the open step and applies its changes. An error is fatal. The events of the changes
   * drain in a new step. Returns true when the step had a change.
   */
  private closeOpenStep(): boolean {
    const pending = this.pendingTasksByGroup
    this.pendingTasksByGroup = null
    if (pending === null || pending.size === 0) return false
    const changes: GroupTasks[] = []
    for (const [group, tasks] of pending) {
      changes.push({ group, tasks })
    }
    try {
      this.applyTasksOfGroups(changes)
    } catch (error) {
      this.fail(toError(error))
      return false
    }
    return true
  }

  /** Applies one step of task changes now. Throws, with no change, if the step breaks a rule. */
  private applyTasksOfGroups(changes: readonly GroupTasks[]): void {
    this.assertSettable(changes)
    const given = new Set<string>()
    for (const change of changes) {
      for (const task of change.tasks) {
        given.add(task.id)
      }
    }
    const dropped: Slot[] = []
    for (const change of changes) {
      const before = this.taskIdsByGroup.get(change.group) ?? new Set<string>()
      for (const id of before) {
        if (given.has(id)) continue
        dropped.push(this.slots.get(id)!)
      }
    }
    this.change(changes, dropped)
  }

  /**
   * Adds or replaces each task of `changes` and removes each slot in `dropped`.
   * It changes the state, puts the events on the queue, and then ends the stopped tasks.
   * It drains the queue last.
   */
  private change(changes: readonly GroupTasks[], dropped: readonly Slot[]): void {
    // No deadlock check until the subscribers got the events of this change: one of them can
    // change the tasks again and so end the deadlock. checkDeadlock() runs after the drain.
    this.changeDepth += 1
    try {
      this.applyChange(changes, dropped)
    } finally {
      this.changeDepth -= 1
    }
    this.drain()
    this.checkDeadlock()
  }

  /** The part of change() before its drain. It runs with changeDepth above 0. */
  private applyChange(changes: readonly GroupTasks[], dropped: readonly Slot[]): void {
    const replaced: Slot[] = []
    const created: Slot[] = []
    // All withdrawn events of the call go before any promised event. Thus an output
    // that moves from one task to another in one call is withdrawn before it is promised.
    const withdrawn: ArtifactEvent[] = []
    const promised: ArtifactEvent[] = []
    // A task that a report removes still counts as a producer until the reporter ends.
    const reporter = this.reportingSlot
    if (reporter !== null && reporter.phase === "running" && dropped.length > 0) {
      this.keepRemovedOutputs(reporter, dropped)
    }
    // In both loops below, a stopped task sees the new generation, so its later
    // ctx.produced and ctx.deleted do nothing.
    for (const slot of dropped) {
      slot.generation += 1
      this.unindex(slot.task)
      this.slots.delete(slot.task.id)
      addOutputEvents(withdrawn, "withdrawn", slot.task.id, outputsByKey(slot.task), NO_OUTPUTS)
    }
    for (const { group, tasks } of changes) {
      for (const task of tasks) {
        let before = NO_OUTPUTS
        const existing = this.slots.get(task.id)
        if (existing) {
          existing.generation += 1
          this.unindex(existing.task)
          replaced.push(existing)
          before = outputsByKey(existing.task)
        }
        const slot = new Slot(task, group)
        if (existing) {
          slot.order = existing.order
        } else {
          this.lastOrder += 1
          slot.order = this.lastOrder
        }
        this.slots.set(task.id, slot)
        this.pendingCount += 1
        created.push(slot)
        this.index(task)
        const after = outputsByKey(task)
        addOutputEvents(withdrawn, "withdrawn", task.id, before, after)
        addOutputEvents(promised, "promised", task.id, after, before)
      }
    }

    // build.remove drops one slot of a group that is not in `changes`.
    for (const slot of dropped) {
      const ids = this.taskIdsByGroup.get(slot.group)!
      ids.delete(slot.task.id)
      if (ids.size === 0) this.taskIdsByGroup.delete(slot.group)
    }
    // Each group of the step has exactly its new ids. An id that moved to another group left it.
    for (const { group, tasks } of changes) {
      const ids = new Set<string>()
      for (const task of tasks) {
        ids.add(task.id)
      }
      if (ids.size === 0) {
        this.taskIdsByGroup.delete(group)
      } else {
        this.taskIdsByGroup.set(group, ids)
      }
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
    // A task that waited for a replaced or removed task looks for its producers again.
    // finish() above already did this for the slots that it ended. A replaced running slot ends later.
    for (const slot of dropped) {
      this.endWait(slot, false)
    }
    for (const slot of replaced) {
      this.endWait(slot, false)
    }
    for (const slot of created) {
      this.notStarted.add(slot)
    }
    // Before the first run(), and during its scans, run() starts the slots later.
    if (this.started && !this.scanning && this.fatal === null) {
      // In the order of this.slots, as run() starts them.
      const starts = [...this.notStarted]
      starts.sort((a, b) => a.order - b.order)
      this.notStarted.clear()
      for (const slot of starts) {
        this.kick(slot)
      }
    }
    this.maybeIdle()
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
      // No task starts before the scans return, so all the task changes until then are one step.
      // So a set that exists only for a while during the scans never shows.
      if (this.hearersByMatcher.size > 0) this.pendingTasksByGroup = new Map()
      this.push(events)
      this.drain()
      // A build with no matchers starts its tasks in this same call, as before build.each existed.
      if (this.hearersByMatcher.size > 0 && this.fatal === null) {
        this.scans = this.scanAll()
      }
    }
    // A run() that starts while the first run() scans waits for the same scans.
    if (this.scans !== null) {
      await this.scans
    }
    if (this.fatal !== null) throw this.fatal
    this.notStarted.clear()
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
    for (const matcher of this.hearersByMatcher.keys()) {
      scans.push(this.scan(matcher, signal))
    }
    await Promise.race([Promise.all(scans), aborted])
    this.scanning = false
    this.closeOpenStep()
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
      // The open step of the scans or of a matcher event belongs to its opener, which applies it.
      if (this.pendingTasksByGroup !== null) {
        this.sendQueue()
        return
      }
      // One step for each pass over the queue: the task changes of all the events of the pass.
      // The events of those changes then make the next pass, until no change is left.
      // A build.each that feeds itself makes a pass for each round, so the passes have a limit too.
      let passes = 0
      let changed = true
      while (changed && this.fatal === null) {
        if (passes >= this.sendLimit) {
          this.fail(new Error(`send limit: ${passes} passes in one drain, and more task changes wait; a build.each can feed itself`))
          return
        }
        passes += 1
        this.pendingTasksByGroup = new Map()
        this.sendQueue()
        changed = this.closeOpenStep()
      }
    } finally {
      this.draining = false
    }
    // A change during the drain did not check for a deadlock. See checkDeadlock().
    this.checkDeadlock()
  }

  /** Sends the queue until it is empty: one pass of a drain. */
  private sendQueue(): void {
    // The limit counts only the events that subscribers cause, not the events that started the pass.
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
          `send limit: subscribers caused ${caused} events in one pass of a drain, and more wait; ` +
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
    // The build applies no more task changes.
    this.pendingTasksByGroup = null
    this.scanAbort.abort(error)
    for (const slot of this.slots.values()) {
      if (slot.phase === "running" && slot.abort) slot.abort.abort()
    }
    // Wakes the waiting tasks, so that they see the error and stop.
    const blocked = [...this.blocked]
    for (const slot of blocked) {
      this.resume(slot, "wake")
    }
    this.maybeIdle()
  }

  /** Throws if `setTasksOfGroups(changes)` would break a rule of the build. */
  private assertSettable(changes: readonly GroupTasks[]): void {
    const groupsOfStep = new Set<TaskGroup>()
    for (const { group } of changes) {
      if (groupsOfStep.has(group)) {
        throw new Error(`group '${group.label}' is in one setTasksOfGroups step twice`)
      }
      groupsOfStep.add(group)
    }
    // Each id in the step, and its group.
    const groupsById = new Map<string, TaskGroup>()
    // Each exact output id in the step, and the task that declares it.
    const claims = new Map<string, string>()
    for (const { group, tasks } of changes) {
      for (const task of tasks) {
        const otherGroup = groupsById.get(task.id)
        if (otherGroup === group) {
          throw new Error(`group '${group.label}' gives task '${task.id}' twice`)
        }
        if (otherGroup !== undefined) {
          throw new Error(`task '${task.id}' is in two groups: '${otherGroup.label}' and '${group.label}'`)
        }
        groupsById.set(task.id, group)
        // The tasks of the groups of the step are all replaced or removed, so only another group holds an id.
        const existing = this.slots.get(task.id)
        if (existing && !groupsOfStep.has(existing.group)) {
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
          const claimer = this.exactOutputs.get(output.id)
          if (claimer && !groupsOfStep.has(this.slots.get(claimer.taskId)!.group)) {
            throw new Error(
              `duplicate output '${output.id}': claimed by '${claimer.taskId}' and '${task.id}'`,
            )
          }
        }
      }
    }
  }

  private index(task: Task): void {
    for (const output of task.outputs) {
      if (isArtifact(output)) {
        this.exactOutputs.set(output.id, { artifact: output, taskId: task.id })
      }
      this.liveOutputs.add(output, task.id)
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
      this.liveOutputs.delete(output, task.id)
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
      this.liveOutputs.ownersFor(input, (taskId) => {
        ids.add(taskId)
      })
    }
    ids.delete(task.id)
    return [...ids]
  }

  /** Keeps the outputs of each slot in `dropped` in removedOutputs, with `reporter`, the running task whose report dropped them. */
  private keepRemovedOutputs(reporter: Slot, dropped: readonly Slot[]): void {
    let removedTasks = this.removedTasksByReporter.get(reporter)
    if (removedTasks === undefined) {
      removedTasks = []
      this.removedTasksByReporter.set(reporter, removedTasks)
    }
    for (const slot of dropped) {
      const removed: RemovedTask = { task: slot.task, reporter }
      removedTasks.push(removed)
      for (const output of slot.task.outputs) {
        this.removedOutputs.add(output, removed)
      }
    }
  }

  /** Deletes the removed tasks that `reporter` put in removedOutputs. */
  private forgetRemovedOutputs(reporter: Slot): void {
    const removedTasks = this.removedTasksByReporter.get(reporter)
    if (removedTasks === undefined) return
    this.removedTasksByReporter.delete(reporter)
    for (const removed of removedTasks) {
      for (const output of removed.task.outputs) {
        this.removedOutputs.delete(output, removed)
      }
    }
  }

  /**
   * The running tasks whose report removed a task that wrote an input of `task`.
   * The rules are the same as in producersOf. A removed task with the id of `task` does not count.
   */
  private reportersOfRemovedProducers(task: Task): Slot[] {
    const reporters = new Set<Slot>()
    for (const input of task.inputs) {
      this.removedOutputs.ownersFor(input, (removed) => {
        if (removed.task.id === task.id) return
        if (removed.reporter.phase !== "running") return
        reporters.add(removed.reporter)
      })
    }
    return [...reporters]
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
    // Null when the task skips.
    let reason: RunReason | null = { kind: "no-store" }
    try {
      if (this.store) {
        inputStamps = await this.stampRefs(slot.task.inputs)
        reason = await this.runReason(this.store, slot.task, inputStamps)
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
    if (reason === null) {
      this.finish(slot, { type: "skipped" })
      return
    }

    slot.abort = new AbortController()
    slot.phase = "running"
    this.pendingCount -= 1
    this.runningCount += 1

    const ctx = this.contextFor(slot, generation)
    try {
      await slot.task.run(ctx)
      if (this.endIfStopped(slot, generation)) return
      await this.recordSuccess(slot, generation, inputStamps)
      if (this.endIfStopped(slot, generation)) return
      this.finish(slot, { type: "executed", reason })
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
   * Ends a task that `setTasksOfGroups`, `add`, or `remove` stopped while it ran. They already sent
   * its withdrawn events. Returns false when the task is still current.
   */
  private endIfStopped(slot: Slot, generation: number): boolean {
    if (generation === slot.generation) return false
    if (slot.phase !== "completed") {
      this.finish(slot, { type: "cancelled", reason: "replaced" })
    }
    return true
  }

  /**
   * Waits until no producer of the task is pending or running. The task looks for its producers again
   * only when each producer it waits for has ended, or was replaced or removed. A producer that a
   * later change adds is found by that next look.
   */
  private async waitForInputs(slot: Slot, generation: number): Promise<WaitResult> {
    let deadlocked = false
    while (true) {
      if (generation !== slot.generation) return "cancelled"
      if (this.fatal !== null) return "cancelled"
      const producers = this.producersOf(slot.task)
      const unfinished: Slot[] = []
      for (const id of producers) {
        const producer = this.slots.get(id)
        if (!producer) continue
        if (producer.phase === "pending" || producer.phase === "running") {
          unfinished.push(producer)
          continue
        }
        if (producer.outcome && producer.outcome.type === "failed") {
          return "failed"
        }
      }
      // A producer that a running task's report removed still counts until that task ends.
      const reporters = this.reportersOfRemovedProducers(slot.task)
      for (const reporter of reporters) {
        if (reporter === slot) continue
        if (unfinished.includes(reporter)) continue
        unfinished.push(reporter)
      }
      if (unfinished.length === 0) return "ok"
      // The look after a deadlock wake still finds an unfinished producer: the task is in the deadlock.
      if (deadlocked) return "deadlock"
      const signal = await this.block(slot, unfinished)
      if (signal === "failed") {
        if (generation !== slot.generation || this.fatal !== null) return "cancelled"
        return "failed"
      }
      // After a deadlock, the next look still fails the task when a producer failed.
      if (signal === "deadlock") deadlocked = true
    }
  }

  /**
   * Makes the slot wait for each producer in `unfinished`. Resolves when resume() wakes it.
   * `unfinished` holds each producer one time, and each one is pending or running.
   */
  private block(slot: Slot, unfinished: Slot[]): Promise<WakeSignal> {
    const woken = new Promise<WakeSignal>((resolve) => {
      slot.wakeUp = resolve
    })
    slot.waitingOn = unfinished
    slot.waitCount = unfinished.length
    for (const producer of unfinished) {
      producer.waiters.add(slot)
    }
    this.blocked.add(slot)
    this.checkDeadlock()
    return woken
  }

  /** Wakes a waiting slot with `signal`, and takes it off the producers it waited for. */
  private resume(slot: Slot, signal: WakeSignal): void {
    const wakeUp = slot.wakeUp
    if (wakeUp === null) return
    slot.wakeUp = null
    this.blocked.delete(slot)
    for (const producer of slot.waitingOn) {
      producer.waiters.delete(slot)
    }
    slot.waitingOn = []
    wakeUp(signal)
  }

  /**
   * Tells each slot that waits for `producer` that the producer ended, or was replaced or removed.
   * A slot wakes when the last producer it waits for has ended, or at once when one failed.
   * Each path that ends, replaces, or removes a slot must call this: finish() and change().
   * Else a task that waits for that slot never wakes.
   */
  private endWait(producer: Slot, failed: boolean): void {
    // resume() deletes the waiter from producer.waiters, so loop over a copy.
    const waiters = [...producer.waiters]
    for (const waiter of waiters) {
      waiter.waitCount -= 1
      if (failed) {
        this.resume(waiter, "failed")
      } else if (waiter.waitCount === 0) {
        this.resume(waiter, "wake")
      }
    }
    producer.waiters.clear()
  }

  /**
   * When no task runs and every pending task waits for a producer, wakes each of them with "deadlock".
   * It does nothing during a change() or a drain: the events that wait for the subscribers can make a
   * subscriber change the tasks and so end the deadlock. The drain checks again when it ends.
   */
  private checkDeadlock(): void {
    if (this.fatal !== null) return
    if (this.changeDepth > 0) return
    if (this.draining) return
    if (this.runningCount !== 0) return
    if (this.blocked.size === 0) return
    if (this.blocked.size !== this.pendingCount) return
    const blocked = [...this.blocked]
    for (const slot of blocked) {
      this.resume(slot, "deadlock")
    }
  }

  private contextFor(slot: Slot, generation: number): Context {
    return {
      signal: slot.abort!.signal,
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
    const previousReportingSlot = this.reportingSlot
    this.reportingSlot = slot
    try {
      this.push([event])
      this.drain()
    } finally {
      this.reportingSlot = previousReportingSlot
    }
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
   * Null when the task has an input, every prefix has a stamp, every output exists,
   * and the stamps and ids equal the record. Otherwise the first difference, which is
   * why the task runs. `inputStamps` are the current input stamps.
   */
  private async runReason(store: Store, task: Task, inputStamps: StampMap): Promise<RunReason | null> {
    // With no input, nothing can show that the result is still current.
    if (task.inputs.length === 0) return { kind: "no-inputs" }
    // stampRefs leaves out a prefix with a null stamp. That prefix cannot tell what is under it.
    for (const input of task.inputs) {
      if (!Object.hasOwn(inputStamps, refKey(input))) return { kind: "input-unstamped", id: input.id }
    }
    const record = await store.get(task.id)
    if (!record) return { kind: "no-record" }
    // A record with two stamps for each id has a different shape. It counts as no record.
    // A record from PR 7, before prefix stamps, keyed its stamps by bare id. No key
    // matches the current "artifact <id>" keys, so the task runs once and writes a new record.
    if (!isStampMap(record.inputStamps)) return { kind: "no-record" }
    if (!isStampMap(record.outputStamps)) return { kind: "no-record" }
    if (!sameIds(record.inputStamps, inputStamps)) return { kind: "input-ids-changed" }
    for (const input of task.inputs) {
      const key = refKey(input)
      if (record.inputStamps[key] !== inputStamps[key]) return { kind: "input-changed", id: input.id }
    }

    const outputStamps = newStampMap()
    for (const output of task.outputs) {
      const stamp = await output.stamp()
      if (stamp === null && isPrefix(output)) return { kind: "output-unstamped", id: output.id }
      const key = refKey(output)
      if (!Object.hasOwn(record.outputStamps, key)) return { kind: "output-ids-changed" }
      if (stamp === null) return { kind: "output-missing", id: output.id }
      if (record.outputStamps[key] !== stamp) return { kind: "output-changed", id: output.id }
      outputStamps[key] = stamp
    }
    const recordedCount = Object.keys(record.outputStamps).length
    const currentCount = Object.keys(outputStamps).length
    if (recordedCount !== currentCount) return { kind: "output-ids-changed" }
    return null
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
    if (slot.phase === "pending") {
      this.pendingCount -= 1
    }
    slot.phase = "completed"
    slot.outcome = outcome
    this.forgetRemovedOutputs(slot)
    this.outcomes.set(slot.task, outcome)
    // A slot that ends while it waits (replaced or removed) wakes and sees its new generation.
    this.resume(slot, "wake")
    this.endWait(slot, outcome.type === "failed")
    this.checkDeadlock()
    this.maybeIdle()
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

/** A task that a report removed, and the running task that sent the report. */
type RemovedTask = { task: Task; reporter: Slot }

/** An empty stamp map with no prototype, so that an id such as "__proto__" is a plain key. */
function newStampMap(): StampMap {
  return Object.create(null) as StampMap
}

/** True when both maps have the same ids. The stamps can differ. */
function sameIds(recorded: StampMap, current: StampMap): boolean {
  const recordedIds = Object.keys(recorded)
  const currentIds = Object.keys(current)
  if (recordedIds.length !== currentIds.length) return false
  for (const id of currentIds) {
    if (!Object.hasOwn(recorded, id)) return false
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
