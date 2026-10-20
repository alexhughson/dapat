import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import path from "node:path"
import type { Store, TaskState } from "../../src/store"

export class SqliteStore implements Store {
  private readonly db: Database
  private readonly owns: boolean

  constructor(db: Database | string) {
    if (typeof db === "string") {
      // bun:sqlite treats ":memory:" and "" as databases with no file.
      if (db !== ":memory:" && db !== "") {
        mkdirSync(path.dirname(db), { recursive: true })
      }
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
    return JSON.parse(row.payload) as TaskState
  }

  async set(taskId: string, state: TaskState): Promise<void> {
    const payload = JSON.stringify(state)
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
