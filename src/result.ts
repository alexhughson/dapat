import type { Task } from "./task"

export type Outcome =
  | { type: "executed" }
  | { type: "skipped"; reason: "content" | "order" }
  | { type: "failed"; error: Error }
  | { type: "cancelled"; reason: "replaced" | "removed" }

export class Result {
  readonly success: boolean
  readonly executed: readonly Task[]
  readonly skipped: readonly Task[]
  readonly failed: ReadonlyMap<Task, Error>
  readonly cancelled: readonly Task[]
  /** Errors that no task owns: subscriber errors from sends that no running task caused, errors that a task throws after it was stopped or after a subscriber error failed it, and async subscriber rejections. */
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
    this.errors = [...errors]
    this.success = failed.size === 0 && errors.length === 0
  }
}
