import type { Artifact } from "./artifact";

export interface BuildContext {
  add(task: Task): void;
}

export interface TaskConfig {
  id: string;
  inputs?: Artifact[];
  outputs?: Artifact[];
  run: (ctx: BuildContext) => Promise<void>;
  onDone?: (executed: boolean) => Promise<void>;
}

export class Task {
  readonly id: string;
  readonly inputs: Artifact[];
  readonly outputs: Artifact[];
  readonly run: (ctx: BuildContext) => Promise<void>;
  readonly onDone?: (executed: boolean) => Promise<void>;

  constructor(config: TaskConfig) {
    this.id = config.id;
    this.inputs = config.inputs ?? [];
    this.outputs = config.outputs ?? [];
    this.run = config.run;
    this.onDone = config.onDone;
  }

  toString(): string {
    return this.id;
  }
}
