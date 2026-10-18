import type { Artifact } from "./artifact"
import { Emitter } from "./emitter"
import type { Prefix } from "./prefix"
import { Task, isArtifact, isPrefix, type Context, type Ref } from "./task"
import type { Stamp, Store, TaskState } from "./store"
import { Outcome, Result } from "./result"

export type ArtifactEvent =
  | { kind: "produced"; artifact: Artifact; taskId: string }
  | { kind: "retracted"; artifact: Artifact; taskId: string }

type Phase = "pending" | "running" | "completed"

type WaitResult = "ok" | "failed" | "cancelled" | "deadlock"

class Slot {
  generation = 1
  launched = 0
  phase: Phase = "pending"
  abort: AbortController | null = null
  produced: Artifact[] = []
  outcome: Outcome | null = null
  // The first listener error from a send that this task caused. The task fails with it.
  listenerError: Error | null = null

  constructor(public task: Task) {}
}

export class Build extends Emitter<ArtifactEvent> {
  private readonly store: Store | undefined
  private readonly slots = new Map<string, Slot>()
  private readonly exactOutputs = new Map<string, { artifact: Artifact; taskId: string }>()
  private readonly prefixOutputs: { prefix: Prefix; taskId: string }[] = []
  private readonly provisions = new Map<string, { artifact: Artifact; taskId: string }>()
  private readonly outcomes = new Map<Task, Outcome>()
  private readonly errors: Error[] = []

  private started = false
  private runningCount = 0
  private workCount = 0
  // The running task that is inside ctx.add, ctx.remove, ctx.produced, or the
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
    const existing = this.slots.get(task.id)
    this.assertAddable(task, existing ? task.id : null)

    let retractions: ArtifactEvent[] = []
    if (existing) {
      existing.generation += 1
      this.unindex(existing.task)
      if (existing.phase === "running" && existing.abort) {
        existing.abort.abort()
      } else if (existing.phase === "pending") {
        this.finish(existing, { type: "cancelled", reason: "replaced" })
      } else if (existing.phase === "completed") {
        retractions = this.retractLost(existing, task)
      }
    }

    const slot = new Slot(task)
    this.slots.set(task.id, slot)
    this.index(task)

    if (this.started) {
      this.kick(slot)
    }
    this.wake()
    this.sendAll(retractions)
  }

  remove(id: string): void {
    const slot = this.slots.get(id)
    if (!slot) return

    // A running task sees the new generation, so its later ctx.produced does nothing.
    slot.generation += 1
    this.unindex(slot.task)
    if (slot.phase === "running" && slot.abort) {
      slot.abort.abort()
    }
    const retractions = this.retractAll(slot)
    this.slots.delete(id)
    if (this.store) {
      void this.store.delete(id)
    }
    if (slot.phase !== "completed") {
      this.finish(slot, { type: "cancelled", reason: "removed" })
    }
    this.wake()
    this.sendAll(retractions)
  }

  async run(): Promise<Result> {
    this.started = true
    for (const slot of this.slots.values()) {
      this.kick(slot)
    }
    await this.idle()
    return new Result(this.outcomes, this.errors)
  }

  private assertAddable(task: Task, replacingId: string | null): void {
    const seen = new Set<string>()
    for (const output of task.outputs) {
      if (!isArtifact(output)) continue
      if (seen.has(output.id)) {
        throw new Error(`task '${task.id}' declares output '${output.id}' twice`)
      }
      seen.add(output.id)
      const owner = this.exactOutputs.get(output.id)
      if (owner && owner.taskId !== task.id && owner.taskId !== replacingId) {
        throw new Error(
          `duplicate output '${output.id}': claimed by '${owner.taskId}' and '${task.id}'`,
        )
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
        const owner = this.exactOutputs.get(output.id)
        if (owner && owner.taskId === task.id) {
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

    const abort = new AbortController()
    slot.abort = abort
    slot.phase = "running"
    this.runningCount += 1

    const ctx = this.contextFor(slot, generation)
    try {
      await slot.task.run(ctx)
      if (this.endIfStopped(slot, generation, abort)) return
      if (slot.listenerError === null) {
        await this.recordSuccess(slot)
      }
      if (slot.listenerError !== null) {
        this.finish(slot, { type: "failed", error: slot.listenerError })
        return
      }
      this.finish(slot, { type: "executed" })
    } catch (error) {
      if (this.endIfStopped(slot, generation, abort)) return
      // A listener error fails the task even if the task caught it and threw something else.
      let err = toError(error)
      if (slot.listenerError !== null) {
        err = slot.listenerError
      }
      this.finish(slot, { type: "failed", error: err })
    } finally {
      if (slot.phase === "running") {
        this.runningCount -= 1
      }
    }
  }

  /**
   * Ends a task whose run returned after `remove` or a replacement.
   * Returns false when the task is still current.
   */
  private endIfStopped(slot: Slot, generation: number, abort: AbortController): boolean {
    if (slot.phase === "completed") {
      // `remove` already finished it and sent its retractions.
      this.keepStrayError(slot)
      return true
    }
    if (generation === slot.generation && !abort.signal.aborted) return false
    const retractions = this.retractAll(slot)
    this.finish(slot, { type: "cancelled", reason: "replaced" })
    this.keepStrayError(slot)
    this.sendAll(retractions)
    return true
  }

  /** A cancelled task does not own its listener error, so the error goes to `errors`. */
  private keepStrayError(slot: Slot): void {
    if (slot.listenerError === null) return
    this.addError(slot.listenerError)
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
        this.asTask(slot, () => this.announce(slot, artifact))
      },
    }
  }

  private announce(slot: Slot, artifact: Artifact): void {
    if (!this.outputCovers(slot.task, artifact)) {
      throw new Error(
        `task '${slot.task.id}' produced '${artifact.id}', which no output covers`,
      )
    }
    this.provisions.set(artifact.id, { artifact, taskId: slot.task.id })
    slot.produced.push(artifact)
    this.sendAll([{ kind: "produced", artifact, taskId: slot.task.id }])
  }

  private outputCovers(task: Task, artifact: Artifact): boolean {
    for (const output of task.outputs) {
      if (isPrefix(output) && output.covers(artifact)) return true
      if (isArtifact(output) && output.id === artifact.id) return true
    }
    return false
  }

  private async recordSuccess(slot: Slot): Promise<void> {
    const events: ArtifactEvent[] = []
    for (const output of slot.task.outputs) {
      if (!isArtifact(output)) continue
      const already = slot.produced.some((a) => a.id === output.id)
      if (already) continue
      this.provisions.set(output.id, { artifact: output, taskId: slot.task.id })
      slot.produced.push(output)
      events.push({ kind: "produced", artifact: output, taskId: slot.task.id })
    }
    this.asTask(slot, () => this.sendAll(events))

    if (!this.store) return
    const inputStamps = await this.stampMap(this.artifactRefs(slot.task.inputs))
    const outputStamps = await this.stampMap(this.artifactRefs(slot.task.outputs))
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
  private sendAll(events: readonly ArtifactEvent[]): void {
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

  /** Clears the provisions of the artifacts that `next` no longer declares. */
  private retractLost(oldSlot: Slot, next: Task): ArtifactEvent[] {
    const kept = new Set<string>()
    for (const output of next.outputs) {
      if (isArtifact(output)) kept.add(output.id)
    }
    const events: ArtifactEvent[] = []
    for (const artifact of oldSlot.produced) {
      if (kept.has(artifact.id)) continue
      events.push(this.retractOne(oldSlot.task.id, artifact))
    }
    return events
  }

  private retractAll(slot: Slot): ArtifactEvent[] {
    const events: ArtifactEvent[] = []
    for (const artifact of slot.produced) {
      events.push(this.retractOne(slot.task.id, artifact))
    }
    slot.produced = []
    return events
  }

  /** Clears the provision and returns the event. The caller sends it after its state changes. */
  private retractOne(taskId: string, artifact: Artifact): ArtifactEvent {
    const current = this.provisions.get(artifact.id)
    if (current && current.taskId === taskId) {
      this.provisions.delete(artifact.id)
    }
    return { kind: "retracted", artifact, taskId }
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

function toError(value: unknown): Error {
  if (value instanceof Error) return value
  return new Error(String(value))
}
