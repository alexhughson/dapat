import type { Task } from "./task"

/**
 * Why a task ran instead of skipping: the first difference that the skip check found.
 * `id` names the input or output. A prefix with a null stamp, such as an IdPrefix, is "unstamped".
 */
export type RunReason =
  | { kind: "no-store" }
  | { kind: "no-inputs" }
  | { kind: "no-record" }
  | { kind: "input-unstamped"; id: string }
  | { kind: "output-unstamped"; id: string }
  | { kind: "input-ids-changed" }
  | { kind: "input-changed"; id: string }
  | { kind: "output-missing"; id: string }
  | { kind: "output-ids-changed" }
  | { kind: "output-changed"; id: string }

export type Outcome =
  | { type: "executed"; reason: RunReason }
  | { type: "skipped" }
  | { type: "failed"; error: Error }
  | { type: "cancelled"; reason: "replaced" | "removed" }

export class Result {
  readonly success: boolean
  readonly executed: readonly Task[]
  readonly skipped: readonly Task[]
  readonly failed: ReadonlyMap<Task, Error>
  readonly cancelled: readonly Task[]
  /** The outcome of each task. An executed outcome says why the task ran. */
  readonly outcomes: ReadonlyMap<Task, Outcome>
  /** Errors that no task owns: a non-abort error that a task throws after it was replaced or removed, and a rejected store delete. */
  readonly errors: readonly Error[]

  constructor(outcomes: ReadonlyMap<Task, Outcome>, errors: readonly Error[]) {
    const executed: Task[] = []
    const skipped: Task[] = []
    const failed = new Map<Task, Error>()
    const cancelled: Task[] = []

    for (const [task, outcome] of outcomes) {
      if (outcome.type === "executed") {
        executed.push(task)
      } else if (outcome.type === "skipped") {
        skipped.push(task)
      } else if (outcome.type === "failed") {
        failed.set(task, outcome.error)
      } else {
        cancelled.push(task)
      }
    }

    this.executed = executed
    this.skipped = skipped
    this.failed = failed
    this.cancelled = cancelled
    this.outcomes = new Map(outcomes)
    this.errors = [...errors]
    this.success = failed.size === 0 && errors.length === 0
  }
}
