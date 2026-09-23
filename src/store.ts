export interface Stamp {
  order?: bigint
  content?: string
}

export interface TaskState {
  inputStamps: Record<string, Stamp>
  outputStamps: Record<string, Stamp>
}

export interface Store {
  get(taskId: string): Promise<TaskState | null>
  set(taskId: string, state: TaskState): Promise<void>
  delete(taskId: string): Promise<void>
  clear(): Promise<void>
}

export class MemoryStore implements Store {
  private readonly tasks = new Map<string, TaskState>()

  async get(taskId: string): Promise<TaskState | null> {
    return this.tasks.get(taskId) ?? null
  }

  async set(taskId: string, state: TaskState): Promise<void> {
    this.tasks.set(taskId, state)
  }

  async delete(taskId: string): Promise<void> {
    this.tasks.delete(taskId)
  }

  async clear(): Promise<void> {
    this.tasks.clear()
  }
}
