# Dapat

A simple, extensible build system in TypeScript.

## Installation

```bash
bun add dapat
```

## Quick Start

```typescript
import { Build, Task, file, virtual } from "dapat";

const build = new Build();

build.add(new Task({
  id: "compile",
  inputs: [file("src/main.ts")],
  outputs: [file("dist/main.js")],
  run: async () => {
    // Your build logic here
    await Bun.build({
      entrypoints: ["src/main.ts"],
      outdir: "dist",
    });
  },
}));

const result = await build.run();
console.log(result.success ? "Build succeeded!" : "Build failed!");
```

## Core Concepts

### Build

The `Build` class orchestrates task execution. It:
- Determines task order from input/output relationships (DAG)
- Detects what needs rebuilding (change detection)
- Runs tasks in parallel when possible
- Fails fast if any task fails

```typescript
const build = new Build({
  state: new JsonState(".build-state.json"), // Persist state for incremental builds
  parallelism: 8,                            // Max concurrent tasks (default: 4)
  onTaskDone: async (task, executed) => {    // Optional callback
    console.log(`${task.id}: ${executed ? "executed" : "skipped"}`);
  },
});
```

### Task

A `Task` is a unit of work with inputs and outputs.

```typescript
const task = new Task({
  id: "compile",
  inputs: [file("src/main.ts")],   // What this task reads
  outputs: [file("dist/main.js")], // What this task produces
  run: async (ctx) => {
    // Your build logic
  },
  onDone: async (executed) => {
    // Called whether task ran or was skipped
  },
});
```

### Artifact

An `Artifact` represents something that can change. The build system tracks artifact signatures to detect when tasks need to re-run.

**Built-in artifact types:**

```typescript
import { file, directory, virtual } from "dapat";

// File artifact - tracks file content via SHA-256 hash
file("src/main.ts")

// Directory artifact - matches anything under this path
directory("src/")

// Virtual artifact - custom signature function
virtual("config", async () => JSON.stringify(config))
```

### State

State persists build information for incremental builds.

```typescript
import { MemoryState, JsonState } from "dapat";

// In-memory (lost on process exit) - good for testing
const memState = new MemoryState();

// Persistent JSON file - enables incremental builds
const jsonState = new JsonState(".build-state.json");
```

## Creating Tasks

### Using Task Constructor

```typescript
build.add(new Task({
  id: "bundle",
  inputs: [directory("src/")],
  outputs: [file("dist/bundle.js")],
  run: async () => {
    await bundle();
  },
}));
```

### Creating Task Subclasses

For reusable task types, extend the `Task` class:

```typescript
class TypeScriptCompileTask extends Task {
  constructor(src: string, out: string) {
    super({
      id: `compile:${src}`,
      inputs: [file(src)],
      outputs: [file(out)],
      run: async () => {
        await tsc(src, out);
      },
    });
  }
}

// Usage
build.add(new TypeScriptCompileTask("src/main.ts", "dist/main.js"));
build.add(new TypeScriptCompileTask("src/utils.ts", "dist/utils.js"));
```

## Incremental Builds

The build system tracks input signatures to skip unchanged tasks:

```typescript
const state = new JsonState(".build-state.json");

// First run: all tasks execute
const build1 = new Build({ state });
build1.add(/* tasks */);
await build1.run(); // Tasks run

// Second run: unchanged tasks are skipped
const build2 = new Build({ state });
build2.add(/* same tasks */);
await build2.run(); // Tasks skipped if inputs unchanged
```

## Dynamic Tasks

Tasks can add new tasks during execution:

```typescript
build.add(new Task({
  id: "discover",
  inputs: [directory("src/")],
  outputs: [virtual("discovery-done")],
  run: async (ctx) => {
    const files = await glob("src/**/*.ts");

    for (const f of files) {
      ctx.add(new Task({
        id: `compile:${f}`,
        inputs: [file(f), virtual("discovery-done")],
        outputs: [file(f.replace("src/", "dist/").replace(".ts", ".js"))],
        run: async () => {
          await compile(f);
        },
      }));
    }
  },
}));
```

## Query API

Inspect the build graph without executing:

```typescript
// What tasks produce
build.outputs();

// What tasks consume
build.inputs();

// Dependencies not produced by any task
build.externalInputs();

// Topological order (throws on cycle)
build.plan();
```

## Extending the System

### Custom Artifact Types

Extend `Artifact` for custom resources:

```typescript
import { Artifact } from "dapat";

class S3Artifact extends Artifact {
  constructor(bucket: string, key: string) {
    super(`s3://${bucket}/${key}`);
  }

  async signature(): Promise<string | null> {
    // Return ETag from S3 HEAD request
    const response = await s3.headObject({ Bucket: this.bucket, Key: this.key });
    return response.ETag ?? null;
  }

  async exists(): Promise<boolean> {
    try {
      await s3.headObject({ Bucket: this.bucket, Key: this.key });
      return true;
    } catch {
      return false;
    }
  }
}
```

### Custom State Backends

Implement `State` for custom storage:

```typescript
import { State } from "dapat";

class RedisState implements State {
  constructor(private redis: RedisClient) {}

  async get(taskId: string): Promise<Map<string, string> | null> {
    const data = await this.redis.get(`build:${taskId}`);
    if (!data) return null;
    return new Map(Object.entries(JSON.parse(data)));
  }

  async set(taskId: string, signatures: Map<string, string>): Promise<void> {
    await this.redis.set(
      `build:${taskId}`,
      JSON.stringify(Object.fromEntries(signatures))
    );
  }

  async clear(): Promise<void> {
    const keys = await this.redis.keys("build:*");
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
  }
}
```

### Reusable Task Classes

Create domain-specific task types:

```typescript
class DockerBuildTask extends Task {
  constructor(dockerfile: string, tag: string, context: string = ".") {
    super({
      id: `docker:${tag}`,
      inputs: [file(dockerfile), directory(context)],
      outputs: [virtual(`docker-image:${tag}`)],
      run: async () => {
        await $`docker build -f ${dockerfile} -t ${tag} ${context}`;
      },
    });
  }
}

class NpmInstallTask extends Task {
  constructor() {
    super({
      id: "npm-install",
      inputs: [file("package.json"), file("package-lock.json")],
      outputs: [directory("node_modules/")],
      run: async () => {
        await $`npm ci`;
      },
    });
  }
}
```

## API Reference

### Build

```typescript
class Build {
  constructor(options?: BuildOptions);
  add(task: Task): void;
  outputs(): Set<Artifact>;
  inputs(): Set<Artifact>;
  externalInputs(): Set<Artifact>;
  plan(): Task[];
  run(): Promise<Result>;
}

interface BuildOptions {
  state?: State;
  parallelism?: number;
  onTaskDone?: (task: Task, executed: boolean) => Promise<void>;
}
```

### Task

```typescript
class Task {
  readonly id: string;
  readonly inputs: Artifact[];
  readonly outputs: Artifact[];
  readonly run: (ctx: BuildContext) => Promise<void>;
  readonly onDone?: (executed: boolean) => Promise<void>;

  constructor(config: TaskConfig);
}

interface BuildContext {
  add(task: Task): void;
}
```

### Result

```typescript
class Result {
  readonly outcomes: ReadonlyMap<Task, Outcome>;
  readonly durationMs: number;
  readonly success: boolean;
  readonly executed: ReadonlySet<Task>;
  readonly skipped: ReadonlySet<Task>;
  readonly failed: ReadonlySet<Task>;
}

type Outcome =
  | { type: "executed" }
  | { type: "skipped" }
  | { type: "failed"; error: Error };
```

### Artifact

```typescript
abstract class Artifact {
  readonly id: string;
  get isPrefix(): boolean;
  abstract signature(): Promise<string | null>;
  abstract exists(): Promise<boolean>;
  matches(other: Artifact): boolean;
}

// Built-in implementations
class FileArtifact extends Artifact { }
class DirectoryArtifact extends Artifact { }
class VirtualArtifact extends Artifact { }

// Helper functions
function file(path: string): Artifact;
function directory(path: string): Artifact;
function virtual(id: string, sig?: () => Promise<string | null>): Artifact;
```

### State

```typescript
interface State {
  get(taskId: string): Promise<Map<string, string> | null>;
  set(taskId: string, signatures: Map<string, string>): Promise<void>;
  clear(): Promise<void>;
}

class MemoryState implements State { }
class JsonState implements State {
  constructor(path: string);
}
```
