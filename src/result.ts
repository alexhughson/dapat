import type { Task } from "./task"

export type Outcome =
  | { type: "executed" }
  | { type: "skipped" }
  | { type: "failed"; error: Error }
  | { type: "cancelled"; reason: "replaced" | "removed" }

/**
 * A record in the store that no task of the build owns at the end of the run.
 * `outputIds` are the ids of the artifact outputs in the record. dapat deletes nothing.
 */
export type Orphan = { taskId: string; outputIds: readonly string[] }

export class Result {
  readonly success: boolean
  readonly executed: readonly Task[]
  readonly skipped: readonly Task[]
  readonly failed: ReadonlyMap<Task, Error>
  readonly cancelled: readonly Task[]
  /**
   * Errors that no task owns: a non-abort error that a task throws after it was replaced or removed,
   * a rejected store delete, and a rejected store read for the orphans.
   */
  readonly errors: readonly Error[]
  /** The records in the store that no task of the build owns at the end of the run, in task id order. Empty with no store. */
  readonly orphans: readonly Orphan[]

  constructor(outcomes: ReadonlyMap<Task, Outcome>, errors: readonly Error[], orphans: readonly Orphan[]) {
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
    this.orphans = [...orphans]
    this.success = failed.size === 0 && errors.length === 0
  }
}
