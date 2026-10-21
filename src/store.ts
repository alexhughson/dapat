/**
 * The stamps of the last successful run of a task. Each key is "artifact <id>" or
 * "prefix <id>", so a prefix and an artifact with the same id cannot collide.
 * For an artifact, null means it did not exist. A prefix with a null stamp is left out.
 */
export interface TaskState {
  inputStamps: Record<string, string | null>
  outputStamps: Record<string, string | null>
}

export interface Store {
  get(taskId: string): Promise<TaskState | null>
  set(taskId: string, state: TaskState): Promise<void>
  delete(taskId: string): Promise<void>
  clear(): Promise<void>
  /** The task id of each record in the store. The build reads it at the end of each run to find orphans. */
  ids(): Promise<readonly string[]>
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

  async ids(): Promise<readonly string[]> {
    return [...this.tasks.keys()]
  }
}
