import { mkdir, rename } from "node:fs/promises"
import path from "node:path"
import type { Store, TaskState } from "../../src/store"

type FileData = {
  tasks: Record<string, TaskState>
}

/** Counts temp files in this process, so that no two writes share a temp name. */
let tempCount = 0

export class JsonStore implements Store {
  /** The last write. Each write waits for the one before it. */
  private writes: Promise<void> = Promise.resolve()

  constructor(readonly path: string) {}

  async get(taskId: string): Promise<TaskState | null> {
    const data = await this.load()
    return data.tasks[taskId] ?? null
  }

  async set(taskId: string, state: TaskState): Promise<void> {
    await this.queue(async () => {
      const data = await this.load()
      data.tasks[taskId] = state
      await this.save(data)
    })
  }

  async delete(taskId: string): Promise<void> {
    await this.queue(async () => {
      const data = await this.load()
      delete data.tasks[taskId]
      await this.save(data)
    })
  }

  async clear(): Promise<void> {
    await this.queue(async () => {
      await this.save({ tasks: {} })
    })
  }

  /**
   * Runs `write` after the writes before it. The read and the write of one change
   * run together, so two changes do not drop each other's record.
   */
  private queue(write: () => Promise<void>): Promise<void> {
    const next = this.writes.then(write)
    // A failed write rejects for its caller only. The next write still runs.
    this.writes = next.catch(() => {})
    return next
  }

  private async load(): Promise<FileData> {
    const file = Bun.file(this.path)
    if (!(await file.exists())) {
      return { tasks: {} }
    }
    const parsed = (await file.json()) as FileData
    if (!parsed || typeof parsed !== "object" || !parsed.tasks) {
      return { tasks: {} }
    }
    return parsed
  }

  private async save(data: FileData): Promise<void> {
    await mkdir(path.dirname(this.path), { recursive: true })
    tempCount += 1
    const tmp = `${this.path}.${process.pid}.${tempCount}.tmp`
    await Bun.write(tmp, JSON.stringify(data))
    await rename(tmp, this.path)
  }
}
