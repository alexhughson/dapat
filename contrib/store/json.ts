import { mkdir, readFile, rename, rm } from "node:fs/promises"
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
    // An id such as "constructor" must not find an inherited key.
    if (!Object.hasOwn(data.tasks, taskId)) return null
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
      await this.save({ tasks: newTasks() })
    })
  }

  /** Reads the file one time. */
  async entries(): Promise<Iterable<readonly [string, TaskState]>> {
    const data = await this.load()
    return Object.entries(data.tasks)
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

  /** Reads the file. A missing file is an empty store. */
  private async load(): Promise<FileData> {
    // Read the bytes in one call. A rename can replace the file between two calls.
    let text: string
    try {
      text = await readFile(this.path, "utf8")
    } catch (error) {
      if (isMissing(error)) return { tasks: newTasks() }
      throw error
    }
    const parsed = JSON.parse(text) as FileData
    const tasks = newTasks()
    if (!parsed || typeof parsed !== "object" || !parsed.tasks) {
      return { tasks }
    }
    // Copy into an object with no prototype, so that an id such as "__proto__" is a plain key.
    for (const taskId of Object.keys(parsed.tasks)) {
      const state = parsed.tasks[taskId]
      if (state === undefined) continue
      tasks[taskId] = state
    }
    return { tasks }
  }

  private async save(data: FileData): Promise<void> {
    await mkdir(path.dirname(this.path), { recursive: true })
    tempCount += 1
    const tmp = `${this.path}.${process.pid}.${tempCount}.tmp`
    try {
      await Bun.write(tmp, JSON.stringify(data))
      await rename(tmp, this.path)
    } catch (error) {
      await rm(tmp, { force: true })
      throw error
    }
  }
}

/** An empty task map with no prototype. */
function newTasks(): Record<string, TaskState> {
  return Object.create(null) as Record<string, TaskState>
}

function isMissing(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  return (error as { code?: unknown }).code === "ENOENT"
}
