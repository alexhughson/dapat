import { mkdir, rename } from "node:fs/promises"
import path from "node:path"
import type { Store, TaskState } from "../../src/store"
import { decodeState, encodeState, type EncodedTaskState } from "./codec"

type FileData = {
  tasks: Record<string, EncodedTaskState>
}

export class JsonStore implements Store {
  constructor(readonly path: string) {}

  async get(taskId: string): Promise<TaskState | null> {
    const data = await this.load()
    const encoded = data.tasks[taskId]
    if (!encoded) return null
    return decodeState(encoded)
  }

  async set(taskId: string, state: TaskState): Promise<void> {
    const data = await this.load()
    data.tasks[taskId] = encodeState(state)
    await this.save(data)
  }

  async delete(taskId: string): Promise<void> {
    const data = await this.load()
    delete data.tasks[taskId]
    await this.save(data)
  }

  async clear(): Promise<void> {
    await this.save({ tasks: {} })
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
    const tmp = `${this.path}.tmp`
    await Bun.write(tmp, JSON.stringify(data))
    await rename(tmp, this.path)
  }
}
