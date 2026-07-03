import type { Artifact } from "./artifact";
import { Task, type BuildContext } from "./task";
import { State, MemoryState } from "./state";
import { Result, Outcome } from "./result";

// ============================================
// Graph Resolution
// ============================================
// These pure functions analyze tasks to build a dependency graph.
// All outputs are indexed first, then dependencies are resolved.
// This ensures order of task addition doesn't affect correctness.

interface OutputIndex {
  exact: Map<string, Task>;
  prefixes: Array<[string, Task]>;
}

interface TaskGraph {
  tasks: Task[];
  dependencies: Map<Task, Set<Task>>;
  outputs: OutputIndex;
}

function buildOutputIndex(tasks: Task[]): OutputIndex {
  const exact = new Map<string, Task>();
  const prefixes: Array<[string, Task]> = [];

  for (const task of tasks) {
    for (const output of task.outputs) {
      if (output.isPrefix) {
        prefixes.push([output.id, task]);
      } else {
        const existing = exact.get(output.id);
        if (existing) {
          throw new Error(
            `Duplicate output '${output.id}': produced by both '${existing.id}' and '${task.id}'`
          );
        }
        exact.set(output.id, task);
      }
    }
  }

  return { exact, prefixes };
}

function findProducer(input: Artifact, index: OutputIndex): Task | undefined {
  // Exact match by ID
  const exactMatch = index.exact.get(input.id);
  if (exactMatch) return exactMatch;

  // Input is a prefix (e.g., directory) - find any output under it
  if (input.isPrefix) {
    for (const [id, task] of index.exact) {
      if (id.startsWith(input.id)) return task;
    }
  }

  // Check if input falls under a prefix output
  for (const [prefix, task] of index.prefixes) {
    if (input.id.startsWith(prefix)) return task;
  }

  return undefined;
}

function resolveDependencies(tasks: Task[]): TaskGraph {
  // Phase 1: Index all outputs (must complete before phase 2)
  const outputs = buildOutputIndex(tasks);

  // Phase 2: Resolve dependencies (now all producers are known)
  const dependencies = new Map<Task, Set<Task>>();

  for (const task of tasks) {
    const deps = new Set<Task>();
    for (const input of task.inputs) {
      const producer = findProducer(input, outputs);
      if (producer) deps.add(producer);
    }
    dependencies.set(task, deps);
  }

  return { tasks, dependencies, outputs };
}

function topologicalSort(graph: TaskGraph): Task[] {
  const result: Task[] = [];
  const done = new Set<Task>();

  while (done.size < graph.tasks.length) {
    const ready = graph.tasks.filter(
      (t) => !done.has(t) && [...graph.dependencies.get(t)!].every((d) => done.has(d))
    );
    if (ready.length === 0) {
      const remaining = graph.tasks
        .filter((t) => !done.has(t))
        .map((t) => t.id);
      throw new Error(
        `Cycle detected in task graph. Remaining tasks: ${remaining.join(", ")}`
      );
    }
    result.push(...ready);
    ready.forEach((t) => done.add(t));
  }

  return result;
}

// ============================================
// Build (User API)
// ============================================

export interface BuildOptions {
  state?: State;
  parallelism?: number;
  onTaskDone?: (task: Task, executed: boolean) => Promise<void>;
}

export class Build {
  private readonly tasks: Task[] = [];
  private readonly state: State;
  private readonly parallelism: number;
  private readonly onTaskDone?: (task: Task, executed: boolean) => Promise<void>;

  constructor(options: BuildOptions = {}) {
    this.state = options.state ?? new MemoryState();
    this.parallelism = options.parallelism ?? 4;
    this.onTaskDone = options.onTaskDone;
  }

  add(task: Task): void {
    this.tasks.push(task);
  }

  outputs(): Set<Artifact> {
    return new Set(this.tasks.flatMap((t) => t.outputs));
  }

  inputs(): Set<Artifact> {
    return new Set(this.tasks.flatMap((t) => t.inputs));
  }

  externalInputs(): Set<Artifact> {
    const producedIds = new Set([...this.outputs()].map((a) => a.id));
    return new Set([...this.inputs()].filter((a) => !producedIds.has(a.id)));
  }

  plan(): Task[] {
    const graph = resolveDependencies(this.tasks);
    return topologicalSort(graph);
  }

  async run(): Promise<Result> {
    const graph = resolveDependencies(this.tasks);
    const executor = new Executor(graph, this.state, this.parallelism, this.onTaskDone);
    return executor.run();
  }
}

// ============================================
// Executor (Internal)
// ============================================
// Executes a resolved task graph with parallelism and change detection.
// Supports dynamic task addition during execution.

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

class Semaphore {
  private permits: number;
  private waiters: (() => void)[] = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter();
    } else {
      this.permits++;
    }
  }

  async withPermit<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

type Completion = { promise: Promise<Outcome>; resolve: (v: Outcome) => void };

class Executor implements BuildContext {
  // Mutable copy of output index (extended by dynamic tasks)
  private readonly outputs: OutputIndex;

  // Task completion tracking
  private readonly completions = new Map<Task, Completion>();
  private readonly results = new Map<Task, Outcome>();

  // Completion detection
  private pendingCount = 0;
  private readonly allDone = Promise.withResolvers<void>();

  // Parallelism and timing
  private readonly semaphore: Semaphore;
  private readonly startTime = Date.now();

  constructor(
    private readonly graph: TaskGraph,
    private readonly state: State,
    parallelism: number,
    private readonly onTaskDone?: (task: Task, executed: boolean) => Promise<void>
  ) {
    // Copy output index so dynamic tasks can extend it
    this.outputs = {
      exact: new Map(graph.outputs.exact),
      prefixes: [...graph.outputs.prefixes],
    };
    this.semaphore = new Semaphore(parallelism);
  }

  run(): Promise<Result> {
    // Phase 1: Register completions for all tasks (so any task can await any other)
    for (const task of this.graph.tasks) {
      const { promise, resolve } = Promise.withResolvers<Outcome>();
      this.completions.set(task, { promise, resolve });
      this.pendingCount++;
    }

    // Phase 2: Start all tasks
    for (const [task, deps] of this.graph.dependencies) {
      this.executeTask(task, deps);
    }

    return this.awaitCompletion();
  }

  // BuildContext: add dynamic task during execution
  add(task: Task): void {
    // Register outputs (may throw on duplicate)
    for (const output of task.outputs) {
      if (output.isPrefix) {
        this.outputs.prefixes.push([output.id, task]);
      } else {
        const existing = this.outputs.exact.get(output.id);
        if (existing) {
          throw new Error(
            `Duplicate output '${output.id}': produced by both '${existing.id}' and '${task.id}'`
          );
        }
        this.outputs.exact.set(output.id, task);
      }
    }

    // Resolve dependencies against current output index
    const deps = new Set<Task>();
    for (const input of task.inputs) {
      const producer = findProducer(input, this.outputs);
      if (producer) deps.add(producer);
    }

    const { promise, resolve } = Promise.withResolvers<Outcome>();
    this.completions.set(task, { promise, resolve });
    this.pendingCount++;
    this.executeTask(task, deps);
  }

  private async executeTask(task: Task, deps: Set<Task>): Promise<void> {
    try {
      // Wait for all dependencies
      for (const dep of deps) {
        const outcome = await this.completions.get(dep)!.promise;
        if (outcome.type === "failed") {
          this.complete(task, Outcome.failed(
            new Error(`Dependency '${dep.id}' failed`, { cause: outcome.error })
          ));
          return;
        }
      }

      // Execute with parallelism control
      const outcome = await this.semaphore.withPermit(() => this.runTask(task));
      this.complete(task, outcome);
    } catch (e) {
      this.complete(task, Outcome.failed(toError(e)));
    }
  }

  private async runTask(task: Task): Promise<Outcome> {
    const needsRebuild = await this.checkNeedsRebuild(task);

    if (needsRebuild) {
      try {
        await task.run(this);
        await this.recordSignatures(task);
        await task.onDone?.(true);
        await this.onTaskDone?.(task, true);
        return Outcome.executed();
      } catch (e) {
        return Outcome.failed(toError(e));
      }
    } else {
      await task.onDone?.(false);
      await this.onTaskDone?.(task, false);
      return Outcome.skipped();
    }
  }

  private complete(task: Task, outcome: Outcome): void {
    this.results.set(task, outcome);
    this.completions.get(task)!.resolve(outcome);
    this.pendingCount--;
    if (this.pendingCount === 0) {
      this.allDone.resolve();
    }
  }

  private async checkNeedsRebuild(task: Task): Promise<boolean> {
    const stored = await this.state.get(task.id);
    if (!stored) return true;

    const currentIds = new Set(task.inputs.map((i) => i.id));
    if (currentIds.size !== stored.size) return true;
    for (const id of currentIds) {
      if (!stored.has(id)) return true;
    }

    for (const input of task.inputs) {
      const current = (await input.signature()) ?? "";
      const previous = stored.get(input.id) ?? "";
      if (current !== previous) return true;
    }

    return false;
  }

  private async recordSignatures(task: Task): Promise<void> {
    const sigs = new Map<string, string>();
    for (const input of task.inputs) {
      sigs.set(input.id, (await input.signature()) ?? "");
    }
    await this.state.set(task.id, sigs);
  }

  private async awaitCompletion(): Promise<Result> {
    if (this.pendingCount === 0) {
      return new Result(new Map(), 0);
    }

    await this.allDone.promise;
    return new Result(new Map(this.results), Date.now() - this.startTime);
  }
}
