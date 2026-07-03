import type { Task } from "./task";

export type Outcome =
  | { type: "executed" }
  | { type: "skipped" }
  | { type: "failed"; error: Error };

export const Outcome = {
  executed: (): Outcome => ({ type: "executed" }),
  skipped: (): Outcome => ({ type: "skipped" }),
  failed: (error: Error): Outcome => ({ type: "failed", error }),
} as const;

export class Result {
  constructor(
    public readonly outcomes: ReadonlyMap<Task, Outcome>,
    public readonly durationMs: number
  ) {}

  get success(): boolean {
    for (const outcome of this.outcomes.values()) {
      if (outcome.type === "failed") return false;
    }
    return true;
  }

  get executed(): ReadonlySet<Task> {
    return new Set(
      [...this.outcomes.entries()]
        .filter(([, o]) => o.type === "executed")
        .map(([t]) => t)
    );
  }

  get skipped(): ReadonlySet<Task> {
    return new Set(
      [...this.outcomes.entries()]
        .filter(([, o]) => o.type === "skipped")
        .map(([t]) => t)
    );
  }

  get failed(): ReadonlySet<Task> {
    return new Set(
      [...this.outcomes.entries()]
        .filter(([, o]) => o.type === "failed")
        .map(([t]) => t)
    );
  }
}
