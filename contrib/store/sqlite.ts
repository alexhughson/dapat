import { Database } from "bun:sqlite"
import type { Store, TaskState } from "../../src/store"
import { decodeState, encodeState, type EncodedTaskState } from "./codec"

export class SqliteStore implements Store {
  private readonly db: Database
  private readonly owns: boolean

  constructor(db: Database | string) {
    if (typeof db === "string") {
      this.db = new Database(db)
      this.owns = true
    } else {
      this.db = db
      this.owns = false
    }
    this.db.run(`
      CREATE TABLE IF NOT EXISTS dapat_task_state (
        task_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      )
    `)
  }

  async get(taskId: string): Promise<TaskState | null> {
    const row = this.db
      .query(`SELECT payload FROM dapat_task_state WHERE task_id = ?`)
      .get(taskId) as { payload: string } | null
    if (!row) return null
    const encoded = JSON.parse(row.payload) as EncodedTaskState
    return decodeState(encoded)
  }

  async set(taskId: string, state: TaskState): Promise<void> {
    const payload = JSON.stringify(encodeState(state))
    this.db
      .query(
        `INSERT INTO dapat_task_state (task_id, payload) VALUES (?, ?)
         ON CONFLICT(task_id) DO UPDATE SET payload = excluded.payload`,
      )
      .run(taskId, payload)
  }

  async delete(taskId: string): Promise<void> {
    this.db.query(`DELETE FROM dapat_task_state WHERE task_id = ?`).run(taskId)
  }

  async clear(): Promise<void> {
    this.db.run(`DELETE FROM dapat_task_state`)
  }

  close(): void {
    if (this.owns) this.db.close()
  }
}
