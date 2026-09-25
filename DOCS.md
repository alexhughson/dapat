# dapat documentation

dapat runs tasks. It skips a task when the outputs of that task are still current.

This document has two parts:

- The [usage guide](#usage-guide) explains how the library works and how to build a pipeline with it.
- The [API reference](#api-reference) lists each exported class, function, and type.

---

# Usage guide

## 1. Overview

You describe your work as **tasks**. Each task names its inputs and its outputs. Inputs and outputs can be files. They can also be S3 objects, database rows, or values in memory.

dapat wraps each input and output in an **artifact**, which is a subclass of `Artifact`. The subclass tells dapat how to find out if the thing changed, with a timestamp, a hash, or both. dapat includes artifact classes for files, S3, and SQLite. For anything else, write a small subclass ([section 4](#4-artifacts)).

When you run a **build**, dapat does these steps for each task:

1. It waits for the tasks that write the inputs of the task.
2. It compares the current artifact stamps with the stamps from the last successful run. The **store** keeps the last stamps.
3. It skips the task when the stamps show that the outputs are current. Otherwise, it runs the task.

dapat does not know about disks or SQL. It only reads artifact ids and stamps. The adapters in `dapat/contrib` supply files, S3, and SQLite.

There are two ways to declare tasks:

- Use `Build` and `Task` when you know each task in advance, or when your code decides which tasks to add. Sections 3 to 9 describe this.
- Use `RuleBuild` when you want one task for each set of matching inputs, for example each file that matches a path template, or each commit in a repository. [Section 11](#11-rules-with-rulebuild) describes this. `RuleBuild` makes `Task` objects and adds them to a `Build`, so sections 5 to 9 also apply to it.

## 2. Install and import

dapat runs on Bun only. The adapters use `Bun.file`, `Bun.write`, `Bun.CryptoHasher`, and `bun:sqlite`.

Link the package from a local checkout:

```sh
cd path/to/dapat && bun link
cd path/to/your-project && bun link dapat
```

The package has two entry points:

| Import | Contents |
| --- | --- |
| `dapat` | `Build`, `Task`, `Artifact`, `Prefix`, `IdPrefix`, `MemoryStore`, `Result`, and their types |
| `dapat/contrib` | `FileArtifact`, `DirectoryArtifact`, `PathPrefix`, `S3ObjectArtifact`, `S3Prefix`, `MemoryS3`, `SqliteRowArtifact`, `SqliteTableArtifact`, `SqliteTablePrefix`, `JsonStore`, `SqliteStore`, `RuleBuild`, `InputGen`, `FieldGen`, `capture`, `VarsMap`, `FilePattern`, `FileGlob`, `FileOutput`, `DirOutput`, `S3Pattern`, `S3Glob`, `S3Output`, `S3PrefixOutput`, and a short factory function for each artifact and prefix (`file`, `directory`, `pathPrefix`, `s3Object`, `s3Prefix`, `sqliteRow`, `sqliteTable`, `sqliteTablePrefix`) |

## 3. First build

This build has two tasks. `upper` reads `in.txt` and writes `mid.txt`. `wrap` reads `mid.txt` and writes `out.txt`.

```ts
import { Build, Task } from "dapat"
import { FileArtifact, JsonStore } from "dapat/contrib"

const src = new FileArtifact("in.txt")
const mid = new FileArtifact("mid.txt")
const out = new FileArtifact("out.txt")
const store = new JsonStore(".dapat/state.json")

const build = new Build({ store })

build.add(
  new Task({
    id: "wrap",
    inputs: [mid],
    outputs: [out],
    run: async () => {
      const text = new TextDecoder().decode(await mid.read())
      await Bun.write(out.path, `[${text}]`)
    },
  }),
)

build.add(
  new Task({
    id: "upper",
    inputs: [src],
    outputs: [mid],
    run: async () => {
      const text = new TextDecoder().decode(await src.read())
      await Bun.write(mid.path, text.toUpperCase())
    },
  }),
)

const result = await build.run()
if (!result.success) {
  for (const [task, error] of result.failed) {
    console.error(`${task.id}: ${error.message}`)
  }
  process.exit(1)
}
console.log("executed:", result.executed.map((task) => task.id))
console.log("skipped:", result.skipped.map((task) => task.id))
```

The code adds `wrap` before `upper`. This order has no effect. `wrap` waits for `upper` because `mid` is an input of `wrap` and an output of `upper`.

Put `hello` into `in.txt`, and then run the script more than one time:

1. **First run.** Both tasks execute. `out.txt` contains `[HELLO]`.
2. **No change.** Both tasks skip.
3. **Change `in.txt` to `bye`.** Both tasks execute. `out.txt` contains `[BYE]`.
4. **Run `touch in.txt`.** The modification time changes, but the bytes do not. Both tasks skip, because dapat compares the content of `in.txt` with the stored hash.

[Section 6](#6-when-a-task-skips) gives the full rules.

### Read the result

`build.run()` returns a `Result`:

- `success` is `true` when no task failed.
- `executed` lists the tasks that ran and did not fail.
- `skipped` lists the tasks that dapat did not run, because their outputs were current.
- `failed` is a `Map<Task, Error>`.
- `cancelled` lists the tasks that were replaced or removed before they finished ([section 8](#8-failure-cancellation-and-replacement)).

A failed task does not stop the build. The other tasks continue. `build.run()` does not throw when a task fails, so always check `result.success`.

Call `build.run()` one time for each `Build`. A second call does not run the completed tasks again. To run the pipeline again, make a new `Build` with the same store.

## 4. Artifacts

An artifact has four parts:

```ts
abstract class Artifact<T = unknown> {
  abstract readonly id: string
  abstract orderStamp(): Promise<bigint | null>
  abstract contentStamp(): Promise<string | null>
  abstract read(): Promise<T>
}
```

- **`id`** identifies the artifact. Two artifact objects with the same id are the same artifact. dapat connects tasks only through ids.
- **`orderStamp()`** returns a number that increases when the value changes, for example a modification time or a version number.
- **`contentStamp()`** returns a hash of the value.
- **`read()`** returns the value. dapat never calls `read()`. Only your task code calls it.

Return `null` from a stamp method when the value does not exist. You can also return `null` when you cannot calculate that stamp. An artifact needs at least one stamp. If it has none, dapat always runs each task that reads or writes it.

### Choose ids

Use a URI-like id that includes the kind of artifact, so that ids of different kinds cannot collide. The contrib adapters use these ids:

| Adapter | Id |
| --- | --- |
| `FileArtifact("out/a.txt")` | `file:/abs/path/out/a.txt` |
| `DirectoryArtifact("out")`, `PathPrefix("out")` | `file:/abs/path/out/` |
| `S3ObjectArtifact(client, "b", "k/x")` | `s3://b/k/x` |
| `SqliteRowArtifact` | `sqlite:table/pkColumn/pk` |
| `SqliteTableArtifact`, `SqliteTablePrefix` | `sqlite:table/` |

### Prefixes

Think of an id as a file path. Think of a **prefix** as a folder. The id `map:pages/` is a folder. The ids `map:pages/1` and `map:pages/2` are files in that folder. `map:pages/` is a prefix of both ids.

dapat compares ids as plain strings. An id is in a folder when the id starts with the id of the folder. End each folder id with `/`. If you do not, the folder `file:/p/out` also contains the file `file:/p/outgoing.txt`.

dapat has two kinds of prefix:

- A **plain prefix** is a folder name only. It has no stamp and no value. The classes are `IdPrefix`, `PathPrefix`, `S3Prefix`, and `SqliteTablePrefix`. Use a plain prefix when a task writes files, but you do not know their names before the task runs ([section 5](#5-tasks-and-dependencies)).
- A **prefix artifact** is a folder that you can stamp and read. Its stamps come from the artifacts in the folder. The classes are `DirectoryArtifact` and `SqliteTableArtifact`. Use a prefix artifact when a task reads all of the contents of a folder.

### Write your own artifact

This artifact is a key in a `Map`. The map entry holds a value and a version number.

```ts
import { Artifact } from "dapat"

type Entry = { value: string; version: bigint }

class MapEntry extends Artifact<string> {
  readonly id: string

  constructor(readonly map: Map<string, Entry>, readonly key: string) {
    super()
    this.id = `map:${key}`
  }

  async orderStamp(): Promise<bigint | null> {
    const entry = this.map.get(this.key)
    if (!entry) return null
    return entry.version
  }

  async contentStamp(): Promise<string | null> {
    const entry = this.map.get(this.key)
    if (!entry) return null
    const hasher = new Bun.CryptoHasher("sha256")
    hasher.update(entry.value)
    return hasher.digest("hex")
  }

  async read(): Promise<string> {
    const entry = this.map.get(this.key)
    if (!entry) throw new Error(`missing ${this.id}`)
    return entry.value
  }
}
```

Keep order stamps in the same unit as the other artifacts in the same task. dapat compares order stamps as plain integers ([section 13](#13-limits)).

### Write your own prefix artifact

To make an artifact act as a folder, override two members. `covers(other)` returns true when the artifact is a prefix of `other`. `coversOthers` must return true. Otherwise, dapat does not call `covers`.

```ts
get coversOthers(): boolean {
  return true
}

covers(other: Artifact): boolean {
  return other.id.startsWith(this.id)
}
```

`DirectoryArtifact` and `SqliteTableArtifact` use these overrides.

## 5. Tasks and dependencies

```ts
new Task({
  id: string,
  inputs?: (Artifact | Prefix)[],
  outputs?: (Artifact | Prefix)[],
  run: (ctx: Context) => Promise<void>,
})
```

The task `id` must be unique in a build. The store uses the task `id` as its key, so use an id that stays the same from run to run.

The task writes its outputs itself. dapat does not write, move, or delete files.

### What `build.run()` does

```text
build.run()
├─ starts every task at the same time; each task does these steps:
│  ├─ wait for inputs
│  │   ├─ a producer task failed           → this task fails: "dependency of '<id>' failed"
│  │   └─ no task can make progress        → this task fails: "deadlock waiting for inputs of '<id>'"
│  ├─ decide if the task can skip
│  │   ├─ stamp every artifact input and output
│  │   ├─ compare with the store record     → skipped, reason "content"
│  │   └─ compare order stamps              → skipped, reason "order"
│  ├─ task.run(ctx)
│  │   └─ ctx.produced(artifact)            → calls each listener whose prefix covers the artifact
│  └─ on success
│      ├─ announce each declared artifact output to the listeners
│      └─ store.set(task.id, stamps of inputs and outputs)
└─ waits until no task and no listener is in progress → returns Result
```

### How dapat finds dependencies

You do not declare edges. dapat finds them from the ids of your inputs and outputs. Task B waits for task A in these cases:

- B has the artifact input `x`, and A has an artifact output with the same id `x`.
- B has the artifact input `x`, and A has a plain prefix output that contains `x`.
- B has a prefix artifact input `L`, and A has an artifact output inside `L`. For example, a task that reads `DirectoryArtifact("out")` waits for a task that writes `FileArtifact("out/a.txt")`.
- B has a plain prefix input `p`, and A has an artifact output inside `p`.
- B has a plain prefix input `p`, and A has a plain prefix output inside `p`, or a plain prefix output that contains `p`.

A prefix artifact input does **not** wait for a plain prefix output in a subfolder. For example, a task that reads `DirectoryArtifact("out")` does not wait for a task with the output `PathPrefix("out/sub")`. The reader can run first. To make the reader wait, give the writer an output that is a prefix of `out/` itself, or give the reader the input `PathPrefix("out")`.

An input that no task writes is a **source**, for example `in.txt` in section 3. dapat does not wait for a source.

Only one task can declare a given artifact as an output. `build.add()` throws `duplicate output '<id>'` when a second task declares the same output id. One task also cannot declare the same output two times.

A waiting task finds its producers again each time a task is added, removed, or completed. When a producer finishes, the waiting task continues in this way:

- If the producer executed or skipped, the waiting task goes on to the skip check.
- If the producer failed, the waiting task fails with `dependency of '<id>' failed`.
- If the producer was replaced, the waiting task waits for the new task with the same id.
- If the producer was removed, the waiting task goes on to the skip check. It does not fail.

If you add a producer after `build.run()` starts, a consumer waits for it only if that consumer is still waiting for other inputs. A consumer that has already started does not stop.

Tasks with no dependency between them run at the same time. dapat has no concurrency limit. [Section 12.2](#122-limit-parallel-work) shows how to limit parallel work inside `run`.

### Outputs with unknown names

Some tasks write a set of artifacts, and the names are not known before the task runs. For example, a task can split a document into pages. For this case, declare a plain prefix output: the folder that the task writes into. Then call `ctx.produced(artifact)` for each artifact that the task writes.

This sample uses `MapEntry` and `Entry` from [section 4](#write-your-own-artifact):

```ts
import { Build, IdPrefix, Task } from "dapat"

const map = new Map<string, Entry>()
map.set("doc", { value: "p1\np2", version: 1n })
const doc = new MapEntry(map, "doc")

const build = new Build()

build.add(
  new Task({
    id: "split",
    inputs: [doc],
    outputs: [new IdPrefix("map:pages/")],
    run: async (ctx) => {
      const lines = (await doc.read()).split("\n")
      for (let i = 0; i < lines.length; i++) {
        const key = `pages/${i + 1}`
        map.set(key, { value: lines[i]!, version: 2n })
        ctx.produced(new MapEntry(map, key))
      }
    },
  }),
)
```

A task that reads `map:pages/1` now waits for `split`. `ctx.produced()` throws when the artifact is not a declared output of the task and is not in one of the task's output folders. The task then fails.

A plain prefix has no stamp. When dapat makes a skip decision ([section 6](#6-when-a-task-skips)), it ignores prefix inputs and prefix outputs. So `split` has no artifact outputs, and it cannot skip by order.

### The `ctx` argument

The `ctx` argument of `run` has these members:

- `ctx.signal` is an `AbortSignal`. It aborts when the task is replaced or removed. Pass it to `fetch` and other APIs that accept a signal.
- `ctx.add(task)` adds a task to the build. The task starts when its inputs are ready.
- `ctx.remove(id)` removes a task from the build.
- `ctx.produced(artifact)` tells dapat that the task wrote `artifact`.

You can also call `build.add()` and `build.remove()` from outside a task while `build.run()` is running. `build.run()` returns only when no task is running and no `build.listen()` handler ([section 9](#9-listen-to-produced-artifacts)) is running.

## 6. When a task skips

dapat makes the decision for each task after the tasks that write its inputs finish. It stamps each artifact input and output. Then it uses the first rule that applies:

1. **An output is missing.** An output has no order stamp and no content stamp. dapat **runs** the task.
2. **The store has a record for this task id.**
   1. The set of input ids or output ids is different from the record. dapat **runs** the task.
   2. An input has a content stamp now and in the record, and the two stamps are different. dapat **runs** the task.
   3. Each input has a content stamp now and in the record, and all of the stamps are equal. dapat **skips** the task with the reason `"content"`.
   4. Otherwise, dapat goes to rule 3.
3. **Order check.** All inputs and outputs have an order stamp, and the newest input is not newer than the oldest output. dapat **skips** the task with the reason `"order"`.
4. In all other cases, dapat **runs** the task.

Some results of these rules:

- You touch an input, but its bytes do not change. The task skips by content.
- An input changes, but the outputs have newer modification times. The task runs, because the content check comes before the order check.
- There is no store, and the outputs are newer than the inputs. The task skips by order, as in `make`.
- The task has no artifact inputs, and its outputs exist. The task skips by order.
- The task has inputs and no artifact outputs, and the store has matching content. The task skips by content. Without a matching record, it runs each time.
- A list of inputs gains or loses an artifact. The task runs, because the set of ids changed.
- You delete an output. The task runs.

After a task runs with no error, dapat stamps its artifact inputs and outputs again, and it writes those stamps to the store. It does not write stamps for a failed task, so a failed task runs again on the next build.

The stamp methods do real I/O. For example, `FileArtifact.contentStamp()` reads and hashes the full file, and `DirectoryArtifact.contentStamp()` reads every file under the directory.

### 6.1 Why did a task run or skip?

`Result` tells you which tasks ran and which skipped. It does not tell you the reason. To find the reason, do these steps:

1. Make sure that each output exists. A missing output always makes the task run.
2. Read the task's record with `await store.get(taskId)`. If it is `null`, the task has never succeeded with this store. Then only the order check applies.
3. Compare the record with the current stamps. Call `await artifact.contentStamp()` and `await artifact.orderStamp()` on each input and output. Compare the values with `inputStamps` and `outputStamps` in the record.
4. Make sure that the task declares every file that it reads. dapat does not see an input that the task does not declare. A change to that file does not make the task run.

## 7. Stores

The store keeps the stamps from the last successful run of each task. The store is optional. Without a store, only the missing-output rule and the order check apply.

| Store | Use it for |
| --- | --- |
| `MemoryStore` | Tests, and builds that repeat in one process |
| `JsonStore(path)` | Small builds on one machine, in which few tasks finish at the same time |
| `SqliteStore(db or path)` | Larger builds, and builds with many parallel tasks. It uses the table `dapat_task_state`. |

```ts
import { Build } from "dapat"
import { SqliteStore } from "dapat/contrib"

const store = new SqliteStore(".dapat/state.db")
const build = new Build({ store })
```

`JsonStore` reads the whole file and writes it again for each change. It writes to `<path>.tmp` and then renames that file to `<path>`. It does not lock the file, so two processes must not use the same file at the same time. Parallel tasks in one build can also call `store.set` at the same time:

- Two calls that overlap can lose one record. The next build then uses only the order check for that task.
- Overlapping calls share one `.tmp` file, so one `rename` can fail. The task that called it then fails.

`SqliteStore` accepts an open `Database` from `bun:sqlite` or a file path. If you give a path, the store opens the database, and `close()` closes it. If you give a `Database`, `close()` does nothing.

The store keeps stamps for artifact inputs and outputs only. It does not keep prefixes. It does not keep the artifacts that a task produced with `ctx.produced()`.

Add the store file to `.gitignore`. To make tasks run again, see [section 12.1](#121-force-tasks-to-run-again).

## 8. Failure, cancellation, and replacement

### Failure

- A task that throws goes into `result.failed` with its error.
- A task that waits for a failed task also fails, with the error `dependency of '<its own id>' failed`.
- A task can read a source that does not exist. Then `read()` throws, and the task fails with that error, for example `ENOENT`.
- A dependency cycle does not stop the build. When no task is running and no task can start, each waiting task fails with `deadlock waiting for inputs of '<id>'`.

```ts
const result = await build.run()
if (!result.success) {
  for (const [task, error] of result.failed) {
    console.error(`${task.id}: ${error.message}`)
  }
}
```

Task `make-a` writes `a` and throws `disk full`. Task `use-a` reads `a`. This code prints:

```text
make-a: disk full
use-a: dependency of 'use-a' failed
```

### Replacement

Call `build.add()` with a task id that is already in the build. The new task replaces the old task. What dapat does depends on the state of the old task:

- **The old task is waiting.** dapat marks the old task `cancelled` with the reason `"replaced"`, and does not run it.
- **The old task is running.** dapat aborts `ctx.signal` of the old task. The old run ends as `cancelled`, even if it finishes without an error. dapat retracts the artifacts that the old run produced.
- **The old task is finished.** dapat retracts the artifacts that the old task produced and that the new task does not declare.

In each case, the new task then waits, skips, or runs in the usual way.

Your task code must stop work when `ctx.signal` aborts. dapat does not stop a running function.

`Result` uses `Task` objects as keys, not ids. A replaced task and its replacement are both in the result, as two different objects.

### Removal

`build.remove(id)` removes the task. It aborts the task if the task is running. It retracts the artifacts that the task produced. If the task had not finished, dapat marks it `cancelled` with the reason `"removed"`.

`build.remove(id)` also starts to delete the store record for the task, but it does not wait for the delete. `build.run()` can return before the delete is done, and a delete error is not reported.

dapat does not delete files or objects. Retraction only sends events ([section 9](#9-listen-to-produced-artifacts)).

## 9. Listen to produced artifacts

A listener gets an event each time a task produces or retracts an artifact under a prefix:

```ts
type ArtifactEvent = {
  type: "produced" | "retracted"
  id: string      // the artifact id
  taskId: string  // the task that produced the artifact
}

const stop = build.listen(prefix, (event) => { ... })
stop() // unsubscribe
```

The event does not contain the artifact object. Make a new artifact from `event.id` if you need one.

dapat sends a `produced` event at these times:

- when a task calls `ctx.produced(artifact)`.
- when a task runs with no error, for each declared artifact output. dapat sends this event before the task counts as finished. Thus a listener can add a task that reads the output, and that new task waits for the writer.

When you call `listen()`, dapat first replays the artifacts that were already produced in this build and that are in the folder of the prefix.

A task that skips sends no events ([section 13](#13-limits)).

A listener can add tasks. This listener adds one task for each page from the `split` sample in section 5. Add it to that sample before `build.run()`:

```ts
build.listen(new IdPrefix("map:pages/"), (event) => {
  if (event.type !== "produced") return
  const key = event.id.slice("map:".length)
  const page = new MapEntry(map, key)
  const shot = new MapEntry(map, key.replace("pages/", "shots/"))
  build.add(
    new Task({
      id: `shot:${key}`,
      inputs: [page],
      outputs: [shot],
      run: async () => {
        map.set(shot.key, { value: "img", version: 9n })
      },
    }),
  )
})

const result = await build.run()
// executed: split, shot:pages/1, shot:pages/2
```

Handle errors inside the listener. dapat reports listener errors in different ways for different events:

- **A declared output of a task that succeeded.** The task that wrote the output fails.
- **`ctx.produced`, a retraction, or a replay from `listen`.** dapat does not wait for the listener. The error becomes an unhandled promise rejection.

`RuleBuild` ([section 11](#11-rules-with-rulebuild)) uses this mechanism. Each input generator that calls `feed.listen` adds one listener.

## 10. Built-in artifacts

The [API reference](#api-reference) gives the full details of each class.

### 10.1 Files: `FileArtifact`, `DirectoryArtifact`, `PathPrefix`

A relative path resolves against the current working directory when you create the object.

| Class | Order stamp | Content stamp | `read()` returns |
| --- | --- | --- | --- |
| `FileArtifact(path)` | modification time in nanoseconds | SHA-256 of the bytes | `Uint8Array` |
| `DirectoryArtifact(path)` | the newest modification time of the directory and the files in it | SHA-256 of each relative path and the hash of that file | absolute paths of all files, in all subdirectories |
| `PathPrefix(path)` | none | none | none (plain prefix) |

### 10.2 S3: `S3ObjectArtifact`, `S3Prefix`, `S3Client`, `MemoryS3`

dapat does not include an AWS client. You give it an object that has these four methods:

```ts
interface S3Client {
  head(bucket: string, key: string): Promise<S3Head | null>
  get(bucket: string, key: string): Promise<Uint8Array>
  put(bucket: string, key: string, body: Uint8Array): Promise<S3Head>
  list(bucket: string, prefix: string): Promise<string[]>
}

interface S3Head {
  lastModified: Date
  etag: string
}
```

Write an adapter for the AWS SDK or for your own HTTP client. The adapter must obey these rules:

- `head` must return `null` when the object does not exist. Do not throw. A `null` tells dapat that an output is missing, so the task must run.
- `list` must return every key under the prefix. S3 `ListObjectsV2` returns at most 1000 keys in one response. Follow `ContinuationToken` until the response is not truncated.
- `put` must return the `lastModified` and `etag` of the new object.

`MemoryS3` implements this interface in memory. Use it for tests.

| Class | Order stamp | Content stamp | `read()` returns |
| --- | --- | --- | --- |
| `S3ObjectArtifact(client, bucket, key)` | `lastModified` in milliseconds | `etag` | `Uint8Array` |
| `S3Prefix(bucket, keyPrefix)` | none | none | none (plain prefix) |

### 10.3 SQLite: `SqliteRowArtifact`, `SqliteTableArtifact`, `SqliteTablePrefix`

These classes take a `bun:sqlite` `Database`. Table and column names must match `[A-Za-z_][A-Za-z0-9_]*`. Other names cause a throw.

| Class | Order stamp | Content stamp | `read()` returns |
| --- | --- | --- | --- |
| `SqliteRowArtifact({ db, table, pkColumn, pk, orderColumn? })` | the value of `orderColumn`, or `rowid` | SHA-256 of the column values | the row as an object |
| `SqliteTableArtifact({ db, table, pkColumn, orderColumn? })` | the largest row order stamp | SHA-256 of the hashes of all rows | the primary keys |
| `SqliteTablePrefix(table)` | none | none | none (plain prefix) |

`SqliteTableArtifact` is a prefix artifact. Each row is a file in the folder `sqlite:table/`.

An `UPDATE` does not change the `rowid`. If rows change in place, give an `orderColumn` that your code increases on each write, or use a persistent store so that the content check decides.

## 11. Rules with `RuleBuild`

A `Task` names exact artifacts. Many builds instead need a rule such as "for each `src/<name>.txt`, write `out/<name>.txt`". `RuleBuild` does this.

A rule has named inputs. Each input is an **input generator**. A generator finds its source items and groups them by a set of **vars**. For each set of vars, it gives one value: one artifact, or a list of artifacts. The generator decides which. `RuleBuild` joins the values of all inputs on the var names that they share. It adds one task to a `Build` for each joined set of vars.

The generators in `dapat/contrib` read files and S3 objects. You can write a generator for any other source, for example the commits of a git repository ([section 11.8](#118-write-your-own-input-generator)).

```ts
import { Build } from "dapat"
import { FileOutput, FilePattern, JsonStore, RuleBuild } from "dapat/contrib"

const build = new Build({ store: new JsonStore(".dapat/state.json") })
const rules = new RuleBuild(build)

rules.rule({
  name: "upper",
  inputs: { src: new FilePattern("src/<name>.txt") },
  outputs: { mid: new FileOutput("mid/<name>.txt") },
  run: async (ctx) => {
    const text = new TextDecoder().decode(await ctx.inputs.src.read())
    await Bun.write(ctx.outputs.mid.path, text.toUpperCase())
  },
})

rules.rule({
  name: "wrap",
  inputs: { mid: new FilePattern("mid/<name>.txt") },
  outputs: { out: new FileOutput("out/<name>.txt") },
  run: async (ctx) => {
    const text = new TextDecoder().decode(await ctx.inputs.mid.read())
    await Bun.write(ctx.outputs.out.path, `[${text}]`)
  },
})

const result = await rules.run()
```

When `src/hello.txt` exists, `rules.run()` creates the task `upper:name=hello`. That task writes `mid/hello.txt`. The `mid/` generator sees the new file, and `RuleBuild` creates `wrap:name=hello`. The `mid/` directory does not have to exist before the build.

`rules.run()` starts every generator, creates the tasks, and calls `build.run()`. It returns the same `Result`.

Inputs and outputs use different classes. `FilePattern` finds files and gives them to tasks. `FileOutput` names the file that a task writes. The two classes use the same template syntax.

`ctx.inputs.src` and `ctx.outputs.mid` both have the type `FileArtifact`. TypeScript gets these types from the generators, so a rule needs no casts.

### 11.1 A complete pipeline

This pipeline writes one draft for each pair of a specialty and a section. Then it revises each draft with the feedback that a person wrote.

```text
inputs/<section>.md                     brief for one section
generic/<specialty>.md                  style guide for one specialty
process/<specialty>/<section>.md        process notes for one pair
        │
        ▼  rule "draft"
drafts/<specialty>/<section>.md
feedback/<specialty>/<section>.md       optional: comments from a reviewer
attachments/<specialty>/<section>/**    optional: any number of extra files
        │
        ▼  rule "revise"
final/<specialty>/<section>.md
```

```ts
import { Build } from "dapat"
import { FileGlob, FileOutput, FilePattern, JsonStore, RuleBuild } from "dapat/contrib"
import * as model from "./model"

const build = new Build({ store: new JsonStore(".dapat/state.json") })
const rules = new RuleBuild(build)

rules.rule({
  name: "draft",
  inputs: {
    brief: new FilePattern("inputs/<section>.md"),
    guide: new FilePattern("generic/<specialty>.md"),
    process: new FilePattern("process/<specialty>/<section>.md"),
  },
  outputs: { draft: new FileOutput("drafts/<specialty>/<section>.md") },
  run: async (ctx) => {
    const text = await model.draft(ctx.inputs.brief, ctx.inputs.guide, ctx.inputs.process)
    await Bun.write(ctx.outputs.draft.path, text)
  },
})

rules.rule({
  name: "revise",
  inputs: {
    draft: new FilePattern("drafts/<specialty>/<section>.md"),
    feedback: new FilePattern("feedback/<specialty>/<section>.md"),
    attachments: new FileGlob("attachments/<specialty>/<section>/**"),
  },
  optional: ["feedback", "attachments"],
  outputs: { final: new FileOutput("final/<specialty>/<section>.md") },
  run: async (ctx) => {
    if (ctx.inputs.feedback === undefined) {
      await Bun.write(ctx.outputs.final.path, await ctx.inputs.draft.read())
      return
    }
    const attachments = ctx.inputs.attachments ?? []
    const text = await model.revise(ctx.inputs.draft, ctx.inputs.feedback, attachments)
    await Bun.write(ctx.outputs.final.path, text)
  },
})

const result = await rules.run()
```

The `attachments` input is a `FileGlob`. Its template ends with `**`, so it can match many files for one set of vars, and its value is a list. The other inputs are `FilePattern`s. A template with no glob names one path for each set of vars, so each of their values is one file.

In `revise`, the context has these types:

| Member | Type |
| --- | --- |
| `ctx.inputs.draft` | `FileArtifact` |
| `ctx.inputs.feedback` | `FileArtifact \| undefined` |
| `ctx.inputs.attachments` | `FileArtifact[] \| undefined` |
| `ctx.outputs.final` | `FileArtifact` |
| `ctx.vars` | `Vars`, for example `{ specialty: "law", section: "intro" }` |

Start with these files:

```text
inputs/intro.md
inputs/costs.md
generic/law.md
generic/tax.md
process/law/intro.md
process/law/costs.md
process/tax/intro.md
feedback/law/intro.md
attachments/law/intro/chart.png
attachments/law/intro/table.csv
```

`rules.run()` makes these tasks:

| Task | Reason |
| --- | --- |
| `draft:section=costs,specialty=law` | All three inputs have a value for these vars. |
| `draft:section=intro,specialty=law` | All three inputs have a value for these vars. |
| `draft:section=intro,specialty=tax` | All three inputs have a value for these vars. |
| no task for `tax` and `costs` | `process/tax/costs.md` does not exist. A required input removes each set of vars that it has no value for. |
| `revise:section=intro,specialty=law` | It gets its draft, `feedback/law/intro.md`, and a list of both attachments, sorted by path. |
| `revise:section=costs,specialty=law` | `feedback` and `attachments` are `undefined`. Optional inputs do not remove tasks. |
| `revise:section=intro,specialty=tax` | The same as the row above. |

The `revise` tasks do not exist when the build starts, because no drafts exist yet. Each `draft` task writes its output. The `drafts/` generator then sets a value for the new file, and `RuleBuild` adds the matching `revise` task during the same build. Each `revise` task waits for its `draft` task, because the draft file is an output of one task and an input of the other.

Run the script again with no change, and all six tasks skip. Then add `feedback/tax/intro.md`. Only `revise:section=intro,specialty=tax` executes, because its list of inputs changed.

### 11.2 How `RuleBuild` makes tasks

Each input of a rule keeps a table. The generator of the input fills the table. The table has at most one entry for each set of vars. The value of an entry is one artifact or a list of artifacts:

```text
input "process"       new FilePattern("process/<specialty>/<section>.md")
  { specialty: "law", section: "intro" }  →  FileArtifact process/law/intro.md
  { specialty: "law", section: "costs" }  →  FileArtifact process/law/costs.md
  { specialty: "tax", section: "intro" }  →  FileArtifact process/tax/intro.md

input "attachments"   new FileGlob("attachments/<specialty>/<section>/**")
  { specialty: "law", section: "intro" }  →  [ FileArtifact attachments/law/intro/chart.png,
                                               FileArtifact attachments/law/intro/table.csv ]
```

`RuleBuild` makes the tasks of a rule in these steps:

1. It takes the tables of the **required** inputs. An input is required when its name is not in `optional`.
2. It joins the var sets of those tables on the var names that they share. Two var sets join when each shared name has the same value. The result is the list of **task vars**. When two inputs share no var name, the join gives every combination of their entries.
3. For each set of task vars, it gives each input the value of its matching entry. An optional input with no matching entry gives `undefined`.
4. It renders each output from the task vars.
5. It adds a task for each new set of task vars. It adds a task again when one of its input entries changed. It removes the task for each set of task vars that no longer exists.

Each captured var is a task var. So each value of a var makes a different task. To give several artifacts to one task, use a generator whose value is a list. For example, use a template with `*` or `**`, or leave an identity field out of a field spec ([section 11.8](#118-write-your-own-input-generator)).

The generator class decides the type of its value, because only the generator knows if one set of vars can match more than one item. The type in `ctx.inputs` comes from the generator:

| Input | Value in `ctx.inputs` |
| --- | --- |
| `new FilePattern("feedback/<specialty>/<section>.md")` | `FileArtifact` |
| `new FileGlob("attachments/<specialty>/<section>/**")` | `FileArtifact[]`, sorted by path |
| `new GitCommits(repo, { commit: capture("sha") })` | `GitCommitArtifact` |
| `new GitCommits(repo, { branch: capture("branch") })` | `GitCommitArtifact[]` |
| any of these, with its name in `optional` | the same type, or `undefined` |

The optional list belongs to the rule, not to the generator. One generator can be required in one rule and optional in a different rule.

`rule()` checks the shape of the rule. It throws in these conditions:

- A name in `optional` is not the name of an input.
- The rule has no required input.
- An optional input uses a var that no required input captures. Because of this check, an optional input never changes the number of tasks. Use `*` for that part of the template.
- An output uses a var that no required input captures.

A generator with no vars has at most one entry. If it is a required input, every task gets its value when the entry exists, and the rule makes no tasks when the entry does not exist. For example, `new FileGlob("config/*.json")` gives all the config files to every task. Put it in `optional` if the rule must run when no config file exists.

The default task id is `<name>:<var>=<value>,...`, with the vars sorted by name. Give `id: (vars) => string` in the rule to set a different id.

### 11.3 Template syntax

All the file and S3 classes take a template. A template is a list of segments separated by `/`:

| Segment | Matches | Example |
| --- | --- | --- |
| text | the same text | `src` |
| `<var>` in a segment | one or more characters, and saves them as `var` | `<name>.txt`, `page-<n>` |
| `*` in a segment | any characters in one segment, including none | `*.md` |
| `**` | zero or more segments | `turns/<sid>/**` |

When a var appears more than one time in a template, all of its matches must be the same.

A var match is greedy. For the segment `x-y-z`, the template `<a>-<b>` saves `a = "x-y"` and `b = "z"`.

A var matches in one segment only. It never matches a `/`.

Choose the class from the template:

| Class | Role | Template | Value for each set of vars |
| --- | --- | --- | --- |
| `FilePattern` | input | no `*` and no `**` | one `FileArtifact` |
| `FileGlob` | input | at least one `*` or `**` | a `FileArtifact[]` of every matching file, sorted by path |
| `FileOutput` | output | no `*` and no `**` | one `FileArtifact` |
| `DirOutput` | output | ends with `/`, no glob | one `PathPrefix` |

Each constructor throws if the template does not agree with its class. For example, `new FilePattern("posts/*.md")` throws and tells you to use `FileGlob`.

An output template can use only the vars that the required inputs capture, so an output never uses a glob.

When the last file for a set of vars goes away, a `FileGlob` deletes that entry. So a required `FileGlob` input needs at least one file.

A relative file template starts at `process.cwd()` when the constructor runs. Give `{ root }` to start somewhere else, for example `new FilePattern("src/<name>.txt", { root: dir })`. A template that starts with `/` is absolute.

An S3 template starts with `s3://<bucket>/`. `S3Pattern`, `S3Glob`, and `S3Output` also take `{ client }`.

Start each template with a literal directory. The generator walks every file under the literal start of the template. A template such as `<name>.txt` has no literal start, so the generator walks all of the root, including `node_modules` and `.git`.

### 11.4 Outputs

An output is an **output generator**. It renders one artifact or one prefix from the task vars:

| Output | Declare | Value in `ctx.outputs` | Before the task runs |
| --- | --- | --- | --- |
| one file | `new FileOutput("index/<topic>.txt")` | `FileArtifact` | `RuleBuild` creates the parent directory. |
| file prefix | `new DirOutput("pages/<doc>/")` | `PathPrefix` | `RuleBuild` creates the directory. |
| one S3 object | `new S3Output("s3://docs/index/<topic>.txt", { client })` | `S3ObjectArtifact` | nothing |
| S3 prefix | `new S3PrefixOutput("s3://docs/pages/<doc>/")` | `S3Prefix` | nothing |

An input generator is not an output generator. TypeScript rejects a `FilePattern` or a `FileGlob` in `outputs`, and it rejects a `FileOutput` in `inputs`.

A task with a prefix output must call `ctx.produced(artifact)` for each file or object that it writes under the prefix. Other rules can then match those artifacts in the same build:

```ts
rules.rule({
  name: "paginate",
  inputs: { src: new FilePattern("inbox/<doc>.txt") },
  outputs: { pages: new DirOutput("pages/<doc>/") },
  run: async (ctx) => {
    const text = new TextDecoder().decode(await ctx.inputs.src.read())
    const lines = text.split("\n")
    for (let i = 0; i < lines.length; i++) {
      const page = new FileArtifact(path.join(ctx.outputs.pages.path, `${i + 1}.txt`))
      await Bun.write(page.path, lines[i]!)
      ctx.produced(page)
    }
  },
})
```

### 11.5 How `RuleBuild` finds new values

```text
rules.run()
├─ load()
│   └─ for each rule, for each input: await gen.start(feed)
│       ├─ the generator sets the values that exist now    feed.set(vars, value)
│       └─ the generator asks for events                   feed.listen(prefix, fn) → build.listen(prefix, …)
├─ sync(): for each rule, join the tables → build.add(task) and build.remove(id)
└─ build.run()
    └─ a task writes an artifact and announces it (declared output or ctx.produced)
        └─ Build calls each listener whose prefix covers the artifact
            └─ generator callback: feed.set(vars, value) or feed.delete(vars)
                └─ RuleBuild syncs each rule that uses this input
                    ├─ build.add(task) for each new set of task vars
                    ├─ build.add(task) again for each task whose input entry changed
                    └─ build.remove(id) for each set of task vars that no longer exists
```

This loop lets one rule feed another rule. It also lets a rule feed itself, as in `examples/agent-loop.ts`. Each turn writes `turns/<sid>/<n+1>/prompt.txt`, and that file matches the first rule of the next turn.

A task that skips sends no events. The file and S3 generators still find the outputs of skipped tasks, because `start` lists the existing files and objects before the build runs.

### 11.6 The rule context

`run(ctx)` gets a `RuleContext`:

| Member | Value |
| --- | --- |
| `ctx.vars` | The task vars, for example `{ specialty: "law", section: "intro" }` |
| `ctx.inputs.<name>` | The value of each input. The generator sets its type. An optional input can also be `undefined` ([section 11.2](#112-how-rulebuild-makes-tasks)). |
| `ctx.outputs.<name>` | The artifact or prefix of each output ([section 11.4](#114-outputs)) |
| `ctx.produced(artifact)` | Announces an artifact under a prefix output |
| `ctx.signal` | The `AbortSignal` of the task |

### 11.7 S3 rules

`S3Pattern`, `S3Glob`, `S3Output`, and `S3PrefixOutput` do for S3 keys what the file classes do for paths. They use the same template syntax, after `s3://<bucket>/`. One rule can use file generators and S3 generators together:

```ts
import { FileOutput, MemoryS3, S3ObjectArtifact, S3Pattern, S3PrefixOutput } from "dapat/contrib"

const s3 = new MemoryS3()

rules.rule({
  name: "paginate",
  inputs: { src: new S3Pattern("s3://docs/inbox/<doc>.txt", { client: s3 }) },
  outputs: { pages: new S3PrefixOutput("s3://docs/pages/<doc>/") },
  run: async (ctx) => {
    const text = new TextDecoder().decode(await ctx.inputs.src.read())
    const lines = text.split("\n")
    for (let i = 0; i < lines.length; i++) {
      const key = `${ctx.outputs.pages.keyPrefix}${i + 1}.txt`
      await s3.put("docs", key, new TextEncoder().encode(lines[i]!))
      ctx.produced(new S3ObjectArtifact(s3, "docs", key))
    }
  },
})

rules.rule({
  name: "shot",
  inputs: { page: new S3Pattern("s3://docs/pages/<doc>/<page>.txt", { client: s3 }) },
  outputs: { shot: new FileOutput("shots/<doc>/<page>.png") },
  run: async (ctx) => {
    await Bun.write(ctx.outputs.shot.path, await ctx.inputs.page.read())
  },
})
```

`S3Pattern` and `S3Glob` list the existing objects with `client.list`. `S3Output` needs a client, because an `S3ObjectArtifact` reads its stamps through the client. `S3PrefixOutput` gives a plain prefix, so it needs no client.

### 11.8 Write your own input generator

An input generator is a subclass of `InputGen<V>`. `V` is the type of its value for one set of vars: one artifact, or a list of artifacts:

```ts
type Value = Artifact | readonly Artifact[]

abstract class InputGen<V extends Value> {
  abstract readonly varNames: readonly string[]
  abstract start(feed: Feed<V>): Promise<void>
}

interface Feed<V extends Value> {
  set(vars: Vars, value: V): void
  delete(vars: Vars): void
  listen(prefix: Prefix, fn: (event: ArtifactEvent) => void | Promise<void>): void
}
```

The generator does all of the work of finding items and grouping them. `RuleBuild` only stores the value for each set of vars, joins the tables, and makes tasks.

Obey these rules when you write a generator:

- `start` sets each value that exists now. `RuleBuild` waits for the promise before it makes tasks.
- After `start`, set or delete values only inside a `listen` callback. `RuleBuild` syncs the tasks after each callback. The `Build` waits for its listeners, so it cannot finish before that sync. A value that you set from a timer or a file watcher can arrive after `build.run()` returns, and then no task uses it.
- The vars must have exactly the names in `varNames`. `feed.set` and `feed.delete` throw if they do not.
- There is one entry for each set of vars. `feed.set` replaces the value of an existing entry, and the tasks that use it are added again.
- A generator whose value is a list keeps that list itself. It adds and removes items, sorts them, and sets the whole list again after each change. An empty list is a valid value, and a required input with an empty list still makes a task. To remove the task, delete the entry.
- `RuleBuild` calls `start` one time for each input that uses the generator. Keep the state of one input inside `start`, not in fields of the generator. `VarsMap` is a map with `Vars` keys that helps with this state.
- Each value must contain artifacts. The `Build` decides when to wait and when to skip from the artifacts of a task. If a source has no natural artifact, make a small one whose content stamp is the value. The first example below does this.

#### A fixed list of values

This generator gives one value for each item in a list. It reads no files:

```ts
import { Artifact } from "dapat"
import { InputGen, type Feed } from "dapat/contrib"

class ValueArtifact extends Artifact<string> {
  readonly id: string

  constructor(readonly name: string, readonly value: string) {
    super()
    this.id = `value:${name}=${value}`
  }

  async orderStamp(): Promise<bigint | null> {
    return null
  }

  async contentStamp(): Promise<string | null> {
    return this.value
  }

  async read(): Promise<string> {
    return this.value
  }
}

class Values extends InputGen<ValueArtifact> {
  readonly varNames: readonly string[]

  constructor(private readonly name: string, private readonly values: string[]) {
    super()
    this.varNames = [name]
  }

  async start(feed: Feed<ValueArtifact>): Promise<void> {
    for (const value of this.values) {
      feed.set({ [this.name]: value }, new ValueArtifact(this.name, value))
    }
  }
}
```

This rule joins the values with files on the shared var `locale`:

```ts
rules.rule({
  name: "translate",
  inputs: {
    locale: new Values("locale", ["fr", "de"]),
    page: new FilePattern("pages/<locale>/<page>.md"),
  },
  outputs: { out: new FileOutput("site/<locale>/<page>.html") },
  run: async (ctx) => {
    // ...
  },
})
```

The file `pages/es/home.md` makes no task, because `es` is not in the list.

#### How the glob generator groups files

`FileGlob` extends `InputGen<FileArtifact[]>`, as your generator does. It groups the matching files for each set of vars itself. This is a short form of its `start` method:

```ts
async start(feed: Feed<FileArtifact[]>): Promise<void> {
  const groups = new VarsMap<Set<string>>()

  const update = (filePath: string, present: boolean): void => {
    const vars = this.match(filePath)
    if (vars === null) return
    const paths = groups.get(vars) ?? new Set<string>()
    if (present) {
      paths.add(filePath)
    } else {
      paths.delete(filePath)
    }
    if (paths.size === 0) {
      groups.delete(vars)
      feed.delete(vars)
      return
    }
    groups.set(vars, paths)
    const sorted = [...paths].sort()
    const files: FileArtifact[] = []
    for (const p of sorted) {
      files.push(new FileArtifact(p))
    }
    feed.set(vars, files)
  }

  const existing = await walkFiles(this.staticPrefix)
  for (const filePath of existing) {
    update(filePath, true)
  }
  feed.listen(new PathPrefix(this.staticPrefix), (event) => {
    const filePath = event.id.slice("file:".length)
    update(filePath, event.type === "produced")
  })
}
```

`FilePattern` is the same without the groups. Each path gives one value, and a retracted path deletes its entry.

#### Field generators

Many sources give records with named fields. For example, a git commit record has a `commit` field and a `branch` field. A subclass of `FieldGen` lets the user of the generator choose one of three settings for each field:

| Field spec | Effect |
| --- | --- |
| `branch: "main"` | Keep only the records where `branch` is `main`. |
| `commit: capture("sha")` | Save the field as the var `sha`. |
| field left out | Ignore the field. Records that are different only in this field go to the same set of vars. |

When two fields capture the same var name, the two values must be equal.

The subclass also names its **identity fields**. These are the fields that together pick one artifact. For a commit, the identity field is `commit`. The spec then decides the type of the value:

- When the spec gives every identity field, as a literal or a capture, one set of vars picks one artifact. The value is `A`.
- When the spec leaves out an identity field, one set of vars can pick many artifacts. The value is `A[]`, sorted by artifact id, with no duplicates.

```ts
abstract class FieldGen<
  F extends string,              // all field names
  Id extends F,                  // identity fields
  A extends Artifact,            // artifact of one record
  S extends FieldSpec<F>,        // the spec that the user gave
> extends InputGen<FieldValue<Id, A, S>> {
  constructor(spec: S, identity: readonly Id[])
  protected abstract records(): Promise<FieldRecord<F, A>[]>
  protected literal(field: F): string | undefined
}

type FieldSpec<F extends string> = Partial<Record<F, string | Capture>>
type FieldRecord<F extends string, A extends Artifact> = {
  fields: Record<F, string>
  artifact: A
}
type FieldValue<Id extends string, A extends Artifact, S> =
  [Exclude<Id, keyof S>] extends [never] ? A : A[]
```

A subclass implements `records`. `FieldGen.start` calls `records` one time, applies the spec, groups the records by vars, and sets the values. It does not listen. If your source can change during a build, override `start`. A subclass can call `this.literal(field)` to ask its source for fewer records.

When the value is one artifact, two records with the same vars must have the same artifact id. If they do not, the identity fields are wrong, and `start` throws.

This generator gives the commits of a git repository:

```ts
import { $ } from "bun"
import { Artifact } from "dapat"
import { FieldGen, type FieldRecord, type FieldSpec } from "dapat/contrib"

class GitCommitArtifact extends Artifact<string> {
  readonly id: string

  constructor(readonly repo: string, readonly sha: string) {
    super()
    this.id = `git:${repo}@${sha}`
  }

  async orderStamp(): Promise<bigint | null> {
    return null
  }

  async contentStamp(): Promise<string | null> {
    return this.sha
  }

  async read(): Promise<string> {
    return this.sha
  }
}

type CommitField = "commit" | "branch"

class GitCommits<S extends FieldSpec<CommitField>>
  extends FieldGen<CommitField, "commit", GitCommitArtifact, S> {
  constructor(readonly repo: string, spec: S) {
    super(spec, ["commit"])
  }

  protected async records(): Promise<FieldRecord<CommitField, GitCommitArtifact>[]> {
    const branches: string[] = []
    const only = this.literal("branch")
    if (only !== undefined) {
      branches.push(only)
    } else {
      const refs = await $`git -C ${this.repo} for-each-ref --format=%(refname:short) refs/heads`.text()
      for (const line of refs.split("\n")) {
        if (line.length > 0) branches.push(line)
      }
    }

    const records: FieldRecord<CommitField, GitCommitArtifact>[] = []
    for (const branch of branches) {
      const shas = await $`git -C ${this.repo} rev-list ${branch}`.text()
      for (const sha of shas.split("\n")) {
        if (sha.length === 0) continue
        const artifact = new GitCommitArtifact(this.repo, sha)
        records.push({ fields: { commit: sha, branch }, artifact })
      }
    }
    return records
  }
}
```

The same class gives four different sets of tasks:

| Input | Tasks | Value |
| --- | --- | --- |
| `new GitCommits(repo, { commit: capture("sha") })` | one for each commit in any branch | `GitCommitArtifact` |
| `new GitCommits(repo, { branch: "main", commit: capture("sha") })` | one for each commit in `main` | `GitCommitArtifact` |
| `new GitCommits(repo, { branch: capture("branch"), commit: capture("sha") })` | one for each pair of a branch and a commit in that branch | `GitCommitArtifact` |
| `new GitCommits(repo, { branch: capture("branch") })` | one for each branch | `GitCommitArtifact[]`, every commit in the branch |

In the first row, the spec leaves out `branch`. A commit that is in two branches gives two records with the same vars and the same artifact, so it gives one value. In the last row, the spec leaves out `commit`, which is an identity field, so the value is a list.

This rule counts the lines of the files in each commit:

```ts
rules.rule({
  name: "count",
  inputs: { commit: new GitCommits(repo, { commit: capture("sha") }) },
  outputs: { count: new FileOutput("counts/<sha>.txt") },
  run: async (ctx) => {
    const sha = ctx.inputs.commit.sha
    const out = await $`git -C ${repo} grep -c "" ${sha}`.nothrow().text()
    let total = 0
    for (const line of out.split("\n")) {
      if (line.length === 0) continue
      total += Number(line.slice(line.lastIndexOf(":") + 1))
    }
    await Bun.write(ctx.outputs.count.path, String(total))
  },
})
```

The content stamp of a commit artifact is its sha, and a commit never changes. So with a store, each old commit skips, and only new commits execute.

Other git generators follow the same shape. A `GitBranches` generator with a `branch` field, and an artifact whose content stamp is the sha at the tip of the branch, pairs with files:

```ts
inputs: {
  branch: new GitBranches(repo, { branch: capture("branch") }),
  notes: new FilePattern("branchNotes/<branch>.md"),
},
optional: ["notes"],
```

With `optional: ["notes"]`, each branch gets a task, and `ctx.inputs.notes` is `undefined` for a branch with no notes file. Without it, only the branches with a notes file get a task. A branch name that contains `/` never matches `<branch>` ([section 13](#13-limits)).

To give each commit task the list of the branches that contain it, write a `GitCommitBranches` generator whose artifact is the branch and whose identity field is `branch`. Capture only `commit`. The spec leaves out the identity field, so the value is a list of branches.

The git generators in this section are examples. `dapat/contrib` does not include them yet.

### 11.9 More examples

The repo has these examples. Run them with `bun run examples/<name>.ts`:

- `first-build.ts` shows the two tasks from section 3. Run it from a directory that contains `in.txt`.
- `file-pipeline.ts` shows two rules in a chain.
- `draft-revise.ts` is the pipeline from [section 11.1](#111-a-complete-pipeline), with a fake model.
- `custom-gen.ts` joins the `Values` generator from [section 11.8](#118-write-your-own-input-generator) with files.
- `s3-pages-screenshots.ts` shows an S3 prefix output, and one file for each page.
- `agent-loop.ts` shows an agent with more than one turn. Each turn writes the prompt for the next turn, and a rule matches the new prompt. The code has no `while` loop.

The last three examples run in a temporary directory. They import from `../src` and `../contrib`. In your project, import from `dapat` and `dapat/contrib`.

## 12. Recipes

### 12.1 Force tasks to run again

To run every task again, clear the store before the build:

```ts
const store = new JsonStore(".dapat/state.json")
await store.clear()
const build = new Build({ store })
```

To run one task again, delete its record with `await store.delete(taskId)`. If the outputs of that task are newer than its inputs, the task still skips by order. Delete one of its outputs as well to make sure that it runs.

### 12.2 Limit parallel work

dapat starts every ready task at the same time. To limit how many tasks do heavy work at the same time, share a gate between the tasks:

```ts
function gate(max: number) {
  let active = 0
  const waiting: Array<() => void> = []
  return async function <T>(work: () => Promise<T>): Promise<T> {
    if (active < max) {
      active += 1
    } else {
      await new Promise<void>((resolve) => waiting.push(resolve))
    }
    try {
      return await work()
    } finally {
      const next = waiting.shift()
      if (next) {
        next()
      } else {
        active -= 1
      }
    }
  }
}

const cpu = gate(4)

build.add(
  new Task({
    id: "encode",
    inputs: [src],
    outputs: [out],
    run: async () => {
      await cpu(async () => {
        // heavy work here
      })
    },
  }),
)
```

When a task finishes, the gate gives its place directly to the next waiting task. So no more than `max` tasks do work at the same time.

### 12.3 Run in CI

A new checkout sets the modification time of each file to the time of the checkout. The order check therefore does not give useful results in CI. To skip unchanged tasks in CI, keep these items in the CI cache between runs:

- the store file, for example `.dapat/state.json`.
- the output files of the tasks.

dapat then uses the content check, which does not depend on modification times. If the cache is empty, every task runs.

## 13. Limits

- **A task that skips sends no events.** This applies to its prefix outputs and to its declared outputs. A `build.listen()` handler sees nothing from that task on the next build. The file and S3 generators of `RuleBuild` do not have this problem, because they list the existing files and objects before the build runs. A generator that you write must do the same in `start`.
- **A template var does not match `/`.** A git branch such as `feature/x` never matches `branchNotes/<branch>.md`, and the output `reports/<branch>.md` makes a subfolder. A generator that gives such values must encode `/`, for example as `%2F`, so that its vars are equal to the vars from the file names. This is not solved yet.
- **A generator cannot add values from outside `RuleBuild`.** A generator sets values in `start` and in `listen` callbacks only. A change that comes from a person or another program during the build, such as a new commit, is not seen until the next build.
- **Order stamps have different units.** dapat compares the order stamps of all artifacts in one task as plain integers. `FileArtifact` and `DirectoryArtifact` use nanoseconds. `S3ObjectArtifact` uses milliseconds. `SqliteRowArtifact` uses `rowid` or your `orderColumn`. If one task has artifacts of two kinds, the order check gives wrong results. For example, an S3 input and a file output always look current. The content check comes first, so a persistent store decides correctly after the first successful run. On the first run, and each time the task has no store record, the order check decides.
- **A prefix artifact input does not wait for a plain prefix output in a subfolder.** See [section 5](#how-dapat-finds-dependencies).
- **`FileArtifact` stamp methods return `null` for all errors.** For example, a permission error on a file looks like a missing file. The task then runs again and does not fail. Check file permissions when a task always runs.
- **No timeout and no concurrency limit.** All ready tasks start at the same time. Add limits and timeouts in your task code ([section 12.2](#122-limit-parallel-work)), and use `ctx.signal` to stop work.
- **`build.remove(id)` does not wait for the store.** Do not depend on the record being deleted when `build.run()` returns.
- **Bun only.** The adapters use Bun APIs.

---

# API reference

All paths in this section are relative to the repo root. `dapat` is `src/index.ts`. `dapat/contrib` is `contrib/index.ts`.

## Core (`dapat`)

### `class Build`

```ts
new Build(opts?: { store?: Store })
```

| Member | Description |
| --- | --- |
| `add(task: Task): void` | Adds a task. If a task with the same id exists, replaces it (see [section 8](#replacement)). If `run()` has started, the task starts at once. Throws if another task already declares one of its exact outputs, or if the task declares one output twice. |
| `remove(id: string): void` | Removes a task. Aborts it if it is running and retracts its announced artifacts. Starts to delete its store record, but does not wait for the delete. Does nothing if the id is not known. |
| `listen(prefix: Prefix, fn: ArtifactListener): () => void` | Calls `fn` for each announced artifact that `prefix` covers. It first replays the artifacts that were already announced. Returns a function that removes the listener. |
| `run(): Promise<Result>` | Starts every task and resolves when no task and no listener is in progress. Does not reject when a task fails. |

### `class Task`

```ts
new Task(init: TaskInit)
```

| Field | Type | Description |
| --- | --- | --- |
| `id` | `string` | Unique in one `Build`. |
| `inputs` | `readonly Ref[]` | Artifacts and prefixes that the task reads. Default `[]`. |
| `outputs` | `readonly Ref[]` | Artifacts and prefixes that the task writes. Default `[]`. |
| `run` | `(ctx: Context) => Promise<void>` | The work. Throw to fail the task. |

The constructor copies `inputs` and `outputs`. Later changes to your arrays do not change the task.

### `interface TaskInit`

```ts
interface TaskInit {
  id: string
  inputs?: Ref[]
  outputs?: Ref[]
  run: (ctx: Context) => Promise<void>
}
```

### `interface Context`

The object that the build passes to `task.run`.

| Member | Description |
| --- | --- |
| `signal: AbortSignal` | Aborted when the task is replaced or removed. |
| `add(task: Task): void` | Same as `build.add`. |
| `remove(id: string): void` | Same as `build.remove`. |
| `produced(artifact: Artifact): void` | Announces an artifact to the listeners. Throws if no output of the task covers it. Does nothing if the task was replaced. |

### `type Ref`

```ts
type Ref = Artifact | Prefix
```

### `isArtifact(ref: Ref): ref is Artifact` and `isPrefix(ref: Ref): ref is Prefix`

Type guards. They use `instanceof`.

### `abstract class Artifact<T = unknown>`

| Member | Description |
| --- | --- |
| `abstract readonly id: string` | Unique id. Artifacts with the same id are the same thing. |
| `abstract orderStamp(): Promise<bigint \| null>` | A value that increases when the artifact changes. `null` if the artifact does not exist. |
| `abstract contentStamp(): Promise<string \| null>` | A hash of the content. `null` if the artifact does not exist. |
| `abstract read(): Promise<T>` | Reads the value. |
| `covers(other: Artifact): boolean` | Default: `other.id === this.id`. Override it for listings. |
| `get coversOthers(): boolean` | Default: `false`. Return `true` when `covers` can match other ids. |

### `abstract class Prefix`

| Member | Description |
| --- | --- |
| `abstract readonly id: string` | The region. End it with a delimiter. |
| `covers(artifact: Artifact): boolean` | Default: `artifact.id` equals or starts with `this.id`. |
| `overlaps(other: Prefix): boolean` | Default: one id equals or starts with the other. |

### `class IdPrefix extends Prefix`

```ts
new IdPrefix(id: string)
```

A prefix whose region is the id string.

### `interface Store`

| Method | Description |
| --- | --- |
| `get(taskId): Promise<TaskState \| null>` | The record of the last successful run, or `null`. |
| `set(taskId, state): Promise<void>` | Writes a record. The build calls it after each successful run. |
| `delete(taskId): Promise<void>` | Deletes a record. The build calls it from `remove`. |
| `clear(): Promise<void>` | Deletes every record. The build does not call it. |

To write your own store, implement these four methods. `Stamp.order` is a `bigint`, and `JSON.stringify` cannot encode it. Convert it to a string before you write it, and back with `BigInt()` when you read it. `JsonStore` and `SqliteStore` do this.

### `interface TaskState` and `interface Stamp`

```ts
interface TaskState {
  inputStamps: Record<string, Stamp>  // keyed by artifact id
  outputStamps: Record<string, Stamp>
}

interface Stamp {
  order?: bigint
  content?: string
}
```

### `class MemoryStore implements Store`

```ts
new MemoryStore()
```

Keeps records in a `Map`. The records are lost when the process ends. `MemoryStore` is also exported from `dapat/contrib`.

### `class Result`

| Field | Type | Description |
| --- | --- | --- |
| `success` | `boolean` | `true` when no task failed. Cancelled tasks do not make it `false`. |
| `executed` | `readonly Task[]` | Tasks whose `run` completed. |
| `skipped` | `readonly Task[]` | Tasks that the skip rules skipped. |
| `failed` | `ReadonlyMap<Task, Error>` | Tasks that threw, whose producer failed, or that were in a deadlock. |
| `cancelled` | `readonly Task[]` | Tasks that were replaced or removed before they completed. |

`Result` does not give the reason for a skip. The build keeps an `Outcome` for each task, but no public member returns it. See [section 6.1](#61-why-did-a-task-run-or-skip).

### `type Outcome`

```ts
type Outcome =
  | { type: "executed" }
  | { type: "skipped"; reason: "content" | "order" }
  | { type: "failed"; error: Error }
  | { type: "cancelled"; reason: "replaced" | "removed" }
```

### `type ArtifactEvent` and `type ArtifactListener`

```ts
type ArtifactEvent = {
  type: "produced" | "retracted"
  id: string      // artifact id
  taskId: string  // task that announced or retracted it
}

type ArtifactListener = (event: ArtifactEvent) => void | Promise<void>
```

## Filesystem (`dapat/contrib`)

Relative paths are resolved against `process.cwd()` when you construct the artifact.

### `class FileArtifact extends Artifact<Uint8Array>` and `file(path)`

```ts
new FileArtifact(path: string)
file(path: string): FileArtifact
```

| Member | Value |
| --- | --- |
| `path` | Absolute path |
| `id` | `file:<absolute path>` |
| `orderStamp()` | Modification time in nanoseconds. `null` if the path is missing or is not a regular file. |
| `contentStamp()` | SHA-256 hex of the bytes. `null` if the file cannot be read. |
| `read()` | The bytes. Throws if the file is missing. |

### `class DirectoryArtifact extends Artifact<string[]>` and `directory(path)`

```ts
new DirectoryArtifact(path: string)
directory(path: string): DirectoryArtifact
```

| Member | Value |
| --- | --- |
| `path` | Absolute path, ending with `/` |
| `id` | `file:<absolute path>/` |
| `covers(other)` | `true` for every id under the directory |
| `coversOthers` | `true` |
| `orderStamp()` | The largest modification time of the directory and every file under it, in nanoseconds. `null` if the directory is missing. |
| `contentStamp()` | SHA-256 of the sorted lines `<relative path>=<file sha256>`. `null` if the directory is missing. |
| `read()` | Absolute paths of every file under the directory, at any depth. Throws if the directory is missing. |

### `class PathPrefix extends Prefix` and `pathPrefix(path)`

```ts
new PathPrefix(path: string)
pathPrefix(path: string): PathPrefix
```

| Member | Value |
| --- | --- |
| `path` | Absolute path, ending with `/` |
| `id` | `file:<absolute path>/` |

## S3 (`dapat/contrib`)

### `interface S3Client` and `interface S3Head`

See [section 10.2](#102-s3-s3objectartifact-s3prefix-s3client-memorys3).

### `class S3ObjectArtifact extends Artifact<Uint8Array>` and `s3Object(client, bucket, key)`

```ts
new S3ObjectArtifact(client: S3Client, bucket: string, key: string)
s3Object(client: S3Client, bucket: string, key: string): S3ObjectArtifact
```

| Member | Value |
| --- | --- |
| `client`, `bucket`, `key` | The constructor arguments |
| `id` | `s3://<bucket>/<key>` |
| `orderStamp()` | `head().lastModified` in milliseconds. `null` if `head` returns `null`. |
| `contentStamp()` | `head().etag`. `null` if `head` returns `null`. |
| `read()` | `client.get(bucket, key)` |

### `class S3Prefix extends Prefix` and `s3Prefix(bucket, keyPrefix)`

```ts
new S3Prefix(bucket: string, keyPrefix: string)
s3Prefix(bucket: string, keyPrefix: string): S3Prefix
```

`id` is `s3://<bucket>/<keyPrefix>/`. The constructor adds the trailing `/` if `keyPrefix` is not empty and does not end with `/`.

### `class MemoryS3 implements S3Client`

```ts
new MemoryS3()
```

Keeps objects in a `Map`. `put` sets the `etag` to the SHA-256 of the body. `put` also sets `lastModified` to a value that increases by at least 1 ms on each call, so two fast writes get different order stamps. `get` throws for a missing object. `list` returns sorted keys.

## SQLite (`dapat/contrib`)

### `class SqliteRowArtifact extends Artifact<Record<string, unknown>>` and `sqliteRow(opts)`

```ts
sqliteRow(opts: {
  db: Database
  table: string
  pkColumn: string
  pk: string | number
  orderColumn?: string
}): SqliteRowArtifact
```

| Member | Value |
| --- | --- |
| `table`, `pkColumn`, `orderColumn` | The validated names |
| `pk` | The primary key as a string |
| `id` | `sqlite:<table>/<pkColumn>/<pk>` |
| `orderStamp()` | The value of `orderColumn` as a `bigint`, or the `rowid` if you give no `orderColumn`. `null` if the row is missing. |
| `contentStamp()` | SHA-256 of the sorted `column=value` lines, without `rowid`. `null` if the row is missing. |
| `read()` | The row without `rowid`. Throws if the row is missing. |

### `class SqliteTableArtifact extends Artifact<string[]>` and `sqliteTable(opts)`

```ts
sqliteTable(opts: {
  db: Database
  table: string
  pkColumn: string
  orderColumn?: string
}): SqliteTableArtifact
```

| Member | Value |
| --- | --- |
| `id` | `sqlite:<table>/` |
| `covers(other)`, `coversOthers` | Covers every row id of the table |
| `orderStamp()` | The largest row order stamp. `null` if the table does not exist. |
| `contentStamp()` | SHA-256 of the sorted `<pk>=<row hash>` lines. `null` if the table does not exist. |
| `read()` | Every primary key as a string. Throws if the table does not exist. |

### `class SqliteTablePrefix extends Prefix` and `sqliteTablePrefix(table)`

```ts
sqliteTablePrefix(table: string): SqliteTablePrefix
```

`id` is `sqlite:<table>/`.

## Stores (`dapat/contrib`)

### `class JsonStore implements Store`

```ts
new JsonStore(path: string)
```

Keeps every record in one JSON file with the shape `{ "tasks": { "<taskId>": { "inputStamps": ..., "outputStamps": ... } } }`. Order stamps are written as strings. A missing file is the same as an empty store. `set` creates the parent directory.

### `class SqliteStore implements Store`

```ts
new SqliteStore(db: Database | string)
```

Creates the table `dapat_task_state (task_id TEXT PRIMARY KEY, payload TEXT)` if it does not exist. `payload` is the record as JSON. `close()` closes the database only if the store opened it from a path.

### `MemoryStore`

The same class as the core `MemoryStore`.

## Rules (`dapat/contrib`)

### `class RuleBuild`

```ts
new RuleBuild(build: Build)
```

| Member | Description |
| --- | --- |
| `rule<I, Opt, O>(spec: Rule<I, Opt, O>): void` | Checks the shape of the rule ([section 11.2](#112-how-rulebuild-makes-tasks)) and adds it. Throws if the shape is bad. Call it before `load` or `run`. |
| `load(): Promise<void>` | Calls `start` on the generator of each input, waits for the values, and adds the matching tasks to the build. |
| `run(): Promise<Result>` | Calls `load()`, then `build.run()`. |

### `interface Rule<I, Opt, O>`

```ts
interface Rule<
  I extends Record<string, InputGen<Value>>,
  Opt extends keyof I,
  O extends Record<string, OutputGen>,
> {
  name: string
  inputs: I
  optional?: readonly Opt[]          // default: [] (every input is required)
  outputs: O
  id?: (vars: Vars) => string        // default: `${name}:${k=v,...}`
  run: (ctx: RuleContext<I, Opt, O>) => Promise<void>
}
```

TypeScript infers `Opt` from the names in `optional`.

### `interface RuleContext<I, Opt, O>`

```ts
interface RuleContext<I, Opt extends keyof I, O> {
  readonly vars: Vars
  readonly inputs: {
    [K in keyof I]: K extends Opt ? InputValue<I[K]> | undefined : InputValue<I[K]>
  }
  readonly outputs: { [K in keyof O]: OutputRef<O[K]> }
  readonly signal: AbortSignal
  produced(artifact: Artifact): void
}

type InputValue<G> = G extends InputGen<infer V> ? V : never
type OutputRef<G> = G extends OutputGen<infer R> ? R : never
```

See [section 11.6](#116-the-rule-context).

### `type Value`

```ts
type Value = Artifact | readonly Artifact[]
```

The value of one input for one set of vars. `RuleBuild` gives each artifact in the value to the task as an input, so the task waits for the writers of those artifacts and uses their stamps to decide if it skips.

### `abstract class InputGen<V extends Value>`

| Member | Description |
| --- | --- |
| `abstract readonly varNames: readonly string[]` | The var names of each entry, in a fixed order |
| `abstract start(feed: Feed<V>): Promise<void>` | Sets the values that exist now, and calls `feed.listen` for later changes. `RuleBuild` calls it one time for each input. |

See [section 11.8](#118-write-your-own-input-generator) for the rules that a generator must obey.

### `interface Feed<V extends Value>`

| Member | Description |
| --- | --- |
| `set(vars: Vars, value: V): void` | Adds the entry for `vars`, or replaces its value. Throws if the names in `vars` are not equal to `varNames`. |
| `delete(vars: Vars): void` | Removes the entry for `vars`. It does nothing if the entry does not exist. |
| `listen(prefix: Prefix, fn): void` | Calls `fn(event)` for each artifact that a task produces or retracts under `prefix`. `RuleBuild` syncs the tasks after `fn` returns. |

### `class VarsMap<T>`

A map whose keys are `Vars`. Two `Vars` objects with the same names and values are the same key. It has `get(vars)`, `set(vars, value)`, `delete(vars)`, `size`, and `entries()`. Generators use it to keep their groups.

### `interface OutputGen<R extends Ref = Ref>`

```ts
interface OutputGen<R extends Ref = Ref> {
  readonly varNames: readonly string[]
  ref(vars: Vars): R                 // the output artifact or prefix for the task vars
  prepare(ref: R): Promise<void>     // called before the task runs, for example to make a directory
}

type OutputRef<O> = O extends OutputGen<infer R> ? R : never
```

### `abstract class FieldGen<F, Id, A, S> extends InputGen<FieldValue<Id, A, S>>`

```ts
new (spec: S, identity: readonly Id[])

type FieldSpec<F extends string> = Partial<Record<F, string | Capture>>
type FieldRecord<F extends string, A extends Artifact> = {
  fields: Record<F, string>
  artifact: A
}
type FieldValue<Id extends string, A extends Artifact, S> =
  [Exclude<Id, keyof S>] extends [never] ? A : A[]
```

| Type parameter | Meaning |
| --- | --- |
| `F extends string` | All field names of a record |
| `Id extends F` | The identity fields, which together pick one artifact |
| `A extends Artifact` | The artifact of one record |
| `S extends FieldSpec<F>` | The spec that the user gave. The subclass passes it through, so TypeScript can find the value type. |

| Member | Description |
| --- | --- |
| `spec`, `identity` | The values from the constructor |
| `varNames` | The names of the captures in `spec`, in the order of the spec keys, with no duplicates |
| `many: boolean` | `true` when `spec` leaves out an identity field. The value is then `A[]`. |
| `protected abstract records(): Promise<FieldRecord<F, A>[]>` | Every record of the source. The subclass implements this. |
| `protected literal(field: F): string \| undefined` | The literal value of `field` in the spec, or `undefined` |
| `start(feed)` | Calls `records()` one time. Drops each record that does not match a literal, or whose captures of one name are different. Groups the other records by vars, and sets one value for each group. When `many` is `false`, it throws if a group has two different artifact ids. It does not listen. |

### `class Capture` and `capture(name)`

```ts
new Capture(name: string)
capture(name: string): Capture
```

In a field spec, a `Capture` saves the field as the var `name`.

### `class FilePattern extends InputGen<FileArtifact>`

```ts
new FilePattern(template: string, opts?: { root?: string })   // root default: process.cwd()
```

An input. The template has no glob. The constructor throws if the template contains `*` or `**`. See [section 11.3](#113-template-syntax).

| Member | Description |
| --- | --- |
| `template`, `varNames` | The template and the var names in template order |
| `staticPrefix: string` | The absolute path of the literal start, ending with `/` |
| `match(absPath: string): Vars \| null` | The vars that the path binds, or `null` if it does not match |
| `start(feed)` | Walks the files under `staticPrefix`, and sets one value for each file that matches. It listens on `staticPrefix`, sets a value for each produced file, and deletes the entry of each retracted file. |

### `class FileOutput implements OutputGen<FileArtifact>`

```ts
new FileOutput(template: string, opts?: { root?: string })   // root default: process.cwd()
```

An output of one file. The constructor throws if the template contains `*` or `**`, or ends with `/`.

| Member | Description |
| --- | --- |
| `template`, `varNames` | The template and the var names in template order |
| `render(vars: Vars): string` | The absolute path for the vars. Throws if a var is missing. |
| `ref(vars)` | `new FileArtifact(render(vars))` |
| `prepare(artifact)` | Creates the parent directory |

### `class FileGlob extends InputGen<FileArtifact[]>`

```ts
new FileGlob(template: string, opts?: { root?: string })
```

An input. The template has at least one `*` or `**`. The constructor throws if the template has no glob.

| Member | Description |
| --- | --- |
| `template`, `varNames`, `staticPrefix`, `match` | As for `FilePattern` |
| `start(feed)` | Groups the matching files by vars. Sets the sorted list for each group after each change, and deletes a group when its last file goes away. |

### `class DirOutput implements OutputGen<PathPrefix>`

```ts
new DirOutput(template: string, opts?: { root?: string })
```

An output of a directory. The constructor throws if the template does not end with `/`, or if it contains a glob. `ref(vars)` gives a `PathPrefix` for the rendered directory. `prepare` creates the directory.

### `class S3Pattern extends InputGen<S3ObjectArtifact>`

```ts
new S3Pattern(template: string, opts: { client: S3Client })   // template: s3://<bucket>/<key template>
```

An input. The constructor throws if the template does not start with `s3://<bucket>/`, or if it contains a glob.

| Member | Description |
| --- | --- |
| `template`, `bucket`, `client`, `varNames` | The values from the constructor, and the var names in template order |
| `keyPrefix: string` | The literal start of the key, ending with `/`, or `""` |
| `match(key: string): Vars \| null` | The vars that the key binds |
| `start(feed)` | Lists the objects under `keyPrefix` with `client.list`, and listens on the prefix |

### `class S3Output implements OutputGen<S3ObjectArtifact>`

```ts
new S3Output(template: string, opts: { client: S3Client })   // template: s3://<bucket>/<key template>
```

An output of one S3 object. The constructor throws if the template does not start with `s3://<bucket>/`, contains a glob, or ends with `/`.

| Member | Description |
| --- | --- |
| `template`, `bucket`, `client`, `varNames` | The values from the constructor, and the var names in template order |
| `render(vars: Vars): string` | The key for the vars |
| `ref(vars)` | `new S3ObjectArtifact(client, bucket, render(vars))` |
| `prepare()` | Does nothing |

### `class S3Glob extends InputGen<S3ObjectArtifact[]>`

```ts
new S3Glob(template: string, opts: { client: S3Client })
```

As `FileGlob`, for S3 keys.

### `class S3PrefixOutput implements OutputGen<S3Prefix>`

```ts
new S3PrefixOutput(template: string)   // s3://<bucket>/<key template>/
```

An output of a key prefix. The constructor throws if the template does not end with `/`, or if it contains a glob. `ref(vars)` gives an `S3Prefix` for the rendered key. `prepare` does nothing.

### Types

```ts
type Vars = Readonly<Record<string, string>>
```
