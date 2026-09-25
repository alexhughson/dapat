import { mkdir, rename } from "node:fs/promises"
import path from "node:path"
import type { Store, TaskState } from "../../src/store"
import { decodeState, encodeState, type EncodedTaskState } from "./codec"

type FileData = {
  tasks: Record<string, EncodedTaskState>
}

/** One in-flight chain per store path so concurrent set/delete do not collide on rename. */
const writeChains = new Map<string, Promise<void>>()

function noop(): void {}

export class JsonStore implements Store {
  constructor(readonly path: string) {}

  async get(taskId: string): Promise<TaskState | null> {
    const data = await this.load()
    const encoded = data.tasks[taskId]
    if (!encoded) return null
    return decodeState(encoded)
  }

  async set(taskId: string, state: TaskState): Promise<void> {
    await this.withLock(async () => {
      const data = await this.load()
      data.tasks[taskId] = encodeState(state)
      await this.save(data)
    })
  }

  async delete(taskId: string): Promise<void> {
    await this.withLock(async () => {
      const data = await this.load()
      delete data.tasks[taskId]
      await this.save(data)
    })
  }

  async clear(): Promise<void> {
    await this.withLock(async () => {
      await this.save({ tasks: {} })
    })
  }

  private withLock(fn: () => Promise<void>): Promise<void> {
    const prev = writeChains.get(this.path) ?? Promise.resolve()
    const next = prev.then(fn)
    // Keep the chain going even when fn rejects; the caller still sees the error.
    writeChains.set(this.path, next.then(noop, noop))
    return next
  }

  private async load(): Promise<FileData> {
    const file = Bun.file(this.path)
    if (!(await file.exists())) {
      return { tasks: {} }
    }
    const parsed: unknown = await file.json()
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      throw new Error(
        `JsonStore '${this.path}': root must be an object with a tasks field`,
      )
    }
    const record = parsed as Record<string, unknown>
    if (
      !("tasks" in record) ||
      record.tasks === null ||
      typeof record.tasks !== "object" ||
      Array.isArray(record.tasks)
    ) {
      throw new Error(
        `JsonStore '${this.path}': expected { tasks: object }, got invalid shape`,
      )
    }
    return parsed as FileData
  }

  private async save(data: FileData): Promise<void> {
    await mkdir(path.dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    await Bun.write(tmp, JSON.stringify(data))
    await rename(tmp, this.path)
  }
}
