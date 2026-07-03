import { unlink, rename } from "node:fs/promises";

export interface State {
  get(taskId: string): Promise<Map<string, string> | null>;
  set(taskId: string, signatures: Map<string, string>): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryState implements State {
  private store = new Map<string, Map<string, string>>();

  async get(taskId: string): Promise<Map<string, string> | null> {
    return this.store.get(taskId) ?? null;
  }

  async set(taskId: string, signatures: Map<string, string>): Promise<void> {
    this.store.set(taskId, new Map(signatures));
  }

  async clear(): Promise<void> {
    this.store.clear();
  }
}

export class JsonState implements State {
  private data: { tasks: Record<string, Record<string, string>> } = {
    tasks: {},
  };
  private loaded = false;

  constructor(private readonly path: string) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const file = Bun.file(this.path);
      if (await file.exists()) {
        const content = await file.text();
        this.data = JSON.parse(content);
      }
    } catch {
      this.data = { tasks: {} };
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    const content = JSON.stringify(this.data, null, 2);
    const tmpPath = `${this.path}.tmp`;
    await Bun.write(tmpPath, content);
    await rename(tmpPath, this.path);
  }

  async get(taskId: string): Promise<Map<string, string> | null> {
    await this.load();
    const record = this.data.tasks[taskId];
    if (!record) return null;
    return new Map(Object.entries(record));
  }

  async set(taskId: string, signatures: Map<string, string>): Promise<void> {
    await this.load();
    this.data.tasks[taskId] = Object.fromEntries(signatures);
    await this.save();
  }

  async clear(): Promise<void> {
    this.data = { tasks: {} };
    this.loaded = true;
    try {
      await unlink(this.path);
    } catch {
      // File may not exist
    }
  }
}
