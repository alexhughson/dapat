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
- Use `FileBuild` when you want one task for each file or S3 object that matches a path template. [Section 11](#11-rules-with-filebuild) describes this. `FileBuild` makes `Task` objects and adds them to a `Build`, so sections 5 to 9 also apply to it.

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
| `dapat/contrib` | `FileArtifact`, `DirectoryArtifact`, `PathPrefix`, `S3ObjectArtifact`, `S3Prefix`, `MemoryS3`, `SqliteRowArtifact`, `SqliteTableArtifact`, `SqliteTablePrefix`, `JsonStore`, `SqliteStore`, `FileBuild`, `FilePattern`, `S3Pattern`, and a short factory function for each artifact and prefix (`file`, `directory`, `pathPrefix`, `s3Object`, `s3Prefix`, `sqliteRow`, `sqliteTable`, `sqliteTablePrefix`) |

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

`FileBuild` ([section 11](#11-rules-with-filebuild)) uses this mechanism.

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

## 11. Rules with `FileBuild`

A `Task` names exact artifacts. Many builds instead need a rule such as "for each `src/<name>.txt`, write `out/<name>.txt`". `FileBuild` does this. You write rules with path templates. `FileBuild` finds the matching files, and it adds one task to a `Build` for each set of template values.

```ts
import { Build } from "dapat"
import { FileBuild, FilePattern, JsonStore } from "dapat/contrib"

const build = new Build({ store: new JsonStore(".dapat/state.json") })
const files = new FileBuild(build, { root: "." })

files.rule({
  name: "upper",
  inputs: { src: new FilePattern("src/<name>.txt") },
  outputs: { mid: new FilePattern("mid/<name>.txt") },
  run: async (ctx) => {
    const text = new TextDecoder().decode(await ctx.file("src").read())
    await Bun.write(ctx.outputFile("mid").path, text.toUpperCase())
  },
})

files.rule({
  name: "wrap",
  inputs: { mid: new FilePattern("mid/<name>.txt") },
  outputs: { out: new FilePattern("out/<name>.txt") },
  run: async (ctx) => {
    const text = new TextDecoder().decode(await ctx.file("mid").read())
    await Bun.write(ctx.outputFile("out").path, `[${text}]`)
  },
})

const result = await files.run()
```

When `src/hello.txt` exists, `files.run()` creates the task `upper:name=hello`. That task writes `mid/hello.txt`. `FileBuild` then matches the new file against the `wrap` rule, and it creates `wrap:name=hello`. The `mid/` directory does not have to exist before the build.

`files.run()` scans the files under each input pattern, creates the tasks, and calls `build.run()`. It returns the same `Result`.

### 11.1 Template syntax

A template is a list of segments separated by `/`:

| Segment | Matches | Example |
| --- | --- | --- |
| text | the same text | `src` |
| `<var>` in a segment | one or more characters, and saves them as `var` | `<name>.txt`, `page-<n>` |
| `*` in a segment | any characters in one segment, including none | `*.md` |
| `**` | zero or more segments | `turns/<sid>/**` |

When a var appears more than one time in a template, all of its matches must be the same.

A var match is greedy. For the segment `x-y-z`, the template `<a>-<b>` saves `a = "x-y"` and `b = "z"`.

A relative template starts at the `root` of the `FileBuild`. A template that starts with `/` is absolute.

Start each input template with a literal directory. `scan` walks every file under the literal start of the template. A template such as `<name>.txt` has no literal start, so `scan` walks all of `root`, including `node_modules` and `.git`.

### 11.2 Input kinds

| Kind | How to declare | Value in `ctx` |
| --- | --- | --- |
| single | `new FilePattern("src/<name>.txt")` | `ctx.file("src")`. Exactly one file must match for each set of vars. |
| list | a template with `*` or `**`, or `{ list: true }` | `ctx.files("posts")`, sorted by path. It can be empty. |
| optional | `{ optional: true }` | `ctx.inputs.meta` is `undefined` when no file matches |

### 11.3 How `FileBuild` makes tasks

A rule creates one task for each combination of var values that all required inputs share. The required inputs are the single inputs and the list inputs that contain a var. A list input with a var needs at least one match. A list input without a var does not change the combinations. It gets every match. An optional input adds its file when a match exists. It does not remove combinations.

This rule creates one index for each topic. It adds a metadata file when one exists:

```ts
import path from "node:path"

files.rule({
  name: "index",
  inputs: {
    posts: new FilePattern("posts/<topic>/*.md"),
    meta: new FilePattern("meta/<topic>.txt", { optional: true }),
  },
  outputs: { out: new FilePattern("index/<topic>.txt") },
  run: async (ctx) => {
    const names = ctx.files("posts").map((f) => path.basename(f.path))
    const meta = ctx.inputs.meta ? "meta" : "nometa"
    await Bun.write(ctx.outputFile("out").path, `${names.join(",")} ${meta}`)
  },
})
```

The start state is `posts/a/1.md`, `posts/a/2.md`, `posts/b/1.md`, and `meta/a.txt`. These runs use one `JsonStore`:

1. **First run.** `index:topic=a` and `index:topic=b` execute. `index/a.txt` contains `1.md,2.md meta`.
2. **No change.** Both tasks skip.
3. **Add `posts/b/2.md`.** `index:topic=b` executes, because its list of inputs changed. `index:topic=a` skips.
4. **Delete `posts/a/2.md`.** `index:topic=a` executes, and `index/a.txt` now contains `1.md meta`. `index:topic=b` skips.

The default task id is `<name>:<var>=<value>,...`, with the vars sorted by name. Give `id: (vars) => string` in the rule to set a different id.

If a single input matches more than one file for one set of vars, `FileBuild` throws `rule '<name>' input '<input>' matched <n> items for <vars>`. During `scan`, this error rejects `files.run()`. During the build, the error comes from a listener, so the rules for listener errors in [section 9](#9-listen-to-produced-artifacts) apply.

### 11.4 Outputs

- A **single** output, such as `index/<topic>.txt`, must use only vars that the inputs bind. If an output uses a var that no input binds, `FileBuild` creates no task and gives no error. `FileBuild` creates the parent directory before the task runs. Get the path with `ctx.outputFile(name).path`.
- A **list** output, such as `pages/<doc>/*.txt`, becomes a plain prefix output. The prefix stops at the first glob. For a `FilePattern`, `FileBuild` creates the directory. The task must call `ctx.produced(new FileArtifact(path))` for each file that it writes. Other rules can then match those files in the same build.

### 11.5 How `FileBuild` finds new files

```text
files.run()
├─ scan()
│   ├─ for each rule, for each input pattern: walk the files under the literal start of the template
│   ├─ match each file id against every input pattern and keep the vars
│   └─ for each rule: combine the vars → make tasks → build.add(task)
└─ build.run()
    └─ a task writes a file and announces it (declared output or ctx.produced)
        └─ FileBuild listener (listens under the literal start of every input and output template)
            ├─ match the id against every input pattern
            └─ combine the vars again
                ├─ build.add(task) for each new set of vars
                ├─ build.add(task) again for each task whose input was announced again
                └─ build.remove(id) for each set of vars that no longer exists
```

This loop lets one rule feed another rule. It also lets a rule feed itself, as in `examples/agent-loop.ts`. Each turn writes `turns/<sid>/<n+1>/prompt.txt`, and that file matches the first rule of the next turn.

A task that skips sends no events. `FileBuild` still finds the outputs of skipped tasks, because `scan` finds existing files before the build runs.

### 11.6 The rule context

`run(ctx)` gets a `FileContext`:

| Member | Returns |
| --- | --- |
| `ctx.vars` | The var values of this task, for example `{ name: "hello" }` |
| `ctx.file(name)` | The single input `name` as a `FileArtifact`. It throws if the input is a list, missing, or not a file. |
| `ctx.files(name)` | The input `name` as a `FileArtifact[]` |
| `ctx.item(name)` | The single input `name` as an `Item`. Use it for S3 inputs. |
| `ctx.items(name)` | The input `name` as an `Item[]` |
| `ctx.inputs` | Every input by name, as `Item`, `Item[]`, or `undefined` |
| `ctx.outputFile(name)` | The single output `name` as a `FileArtifact` |
| `ctx.outputObject(name)` | The single output `name` as an `S3ObjectArtifact` |
| `ctx.outputPrefix(name)` | The prefix of the list output `name` |
| `ctx.outputs` | Every single output by name |
| `ctx.produced(item)` | Announces a file or object under a list output |
| `ctx.signal` | The task's `AbortSignal` |

An `Item` is an `Artifact<Uint8Array>`: a file or an S3 object.

### 11.7 S3 rules

`S3Pattern` has the same template syntax and options for S3 keys. Give the bucket in the template, as `s3://docs/...`, or in the options, as `{ client, bucket: "docs" }`. You can use file patterns and S3 patterns in the same rule:

```ts
import { FilePattern, MemoryS3, S3ObjectArtifact, S3Pattern } from "dapat/contrib"

const s3 = new MemoryS3()

files.rule({
  name: "paginate",
  inputs: { src: new S3Pattern("s3://docs/inbox/<doc>.txt", { client: s3 }) },
  outputs: { pages: new S3Pattern("s3://docs/pages/<doc>/*.txt", { client: s3 }) },
  run: async (ctx) => {
    const lines = new TextDecoder().decode(await ctx.item("src").read()).split("\n")
    for (let i = 0; i < lines.length; i++) {
      const key = `pages/${ctx.vars.doc}/${i + 1}.txt`
      await s3.put("docs", key, new TextEncoder().encode(lines[i]!))
      ctx.produced(new S3ObjectArtifact(s3, "docs", key))
    }
  },
})

files.rule({
  name: "shot",
  inputs: { page: new S3Pattern("s3://docs/pages/<doc>/<page>.txt", { client: s3 }) },
  outputs: { shot: new FilePattern("shots/<doc>/<page>.png") },
  run: async (ctx) => {
    await Bun.write(ctx.outputFile("shot").path, await ctx.item("page").read())
  },
})
```

For S3 inputs, use `ctx.item(name)` and `ctx.items(name)`. For S3 outputs, use `ctx.outputObject(name)`. `S3Pattern` scans with `client.list`.

### 11.8 More examples

The repo has these examples. Run them with `bun run examples/<name>.ts`:

- `first-build.ts` shows the two tasks from section 3. Run it from a directory that contains `in.txt`.
- `file-pipeline.ts` shows two rules in a chain.
- `s3-pages-screenshots.ts` shows an S3 list output, and one file for each page.
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

- **A task that skips sends no events.** This applies to its prefix outputs and to its declared outputs. A `build.listen()` handler sees nothing from that task on the next build. `FileBuild` does not have this problem, because it scans for existing files before it runs.
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

## FileBuild (`dapat/contrib`)

### `class FileBuild`

```ts
new FileBuild(build: Build, opts?: { root?: string })
```

`root` is the directory for relative templates. The default is `process.cwd()`.

| Member | Description |
| --- | --- |
| `rule(spec: FileRule): void` | Adds a rule and listens under the literal start of each input and output template. Call it before `scan` or `run`. |
| `scan(): Promise<void>` | Finds existing files and objects for every input pattern and adds the matching tasks to the build. |
| `run(): Promise<Result>` | Calls `scan()`, then `build.run()`. |

### `interface FileRule`

```ts
interface FileRule {
  name: string
  inputs: Record<string, ItemPattern>
  outputs: Record<string, ItemPattern>
  id?: (vars: Vars) => string        // default: `${name}:${k=v,...}`
  run: (ctx: FileContext) => Promise<void>
}
```

### `interface FileContext`

See [section 11.6](#116-the-rule-context).

### `class FilePattern implements ItemPattern`

```ts
new FilePattern(template: string, opts?: FilePatternOpts)

type FilePatternOpts = { optional?: boolean; list?: boolean }
```

| Member | Description |
| --- | --- |
| `template`, `optional`, `list`, `varNames` | The template, the options, and the var names in template order. `list` is `true` if you set it or if the template has a glob. |
| `staticPrefix(root): string` | Absolute path of the literal start, ending with `/`. |
| `match(absPath, root): Vars \| null` | Vars bound by the path, or `null` if it does not match. |
| `render(vars, root): string` | The absolute path for the vars. Throws if a var is missing or the template has a glob. |

### `class S3Pattern implements ItemPattern`

```ts
new S3Pattern(template: string, opts: S3PatternOpts)

type S3PatternOpts = {
  client: S3Client
  bucket?: string
  optional?: boolean
  list?: boolean
}
```

`template` is `s3://<bucket>/<key template>`, or a key template when you give `bucket`. The constructor throws if it cannot find a bucket, or if the two buckets are different.

| Member | Description |
| --- | --- |
| `template`, `bucket`, `client`, `optional`, `list`, `varNames` | As for `FilePattern` |
| `keyPrefix(): string` | The literal start of the key, ending with `/`, or `""` |
| `match(key): Vars \| null` | Vars bound by the key |
| `render(vars): string` | The key for the vars |

### `interface ItemPattern`

The interface that `FileBuild` uses for patterns. `FilePattern` and `S3Pattern` implement it. Implement it to match a different type of storage.

```ts
interface ItemPattern {
  readonly optional: boolean
  readonly list: boolean
  readonly varNames: readonly string[]
  listenPrefix(root: string): Prefix                 // prefix for the literal start of the template
  boundPrefix(vars: Vars, root: string): Prefix      // prefix up to the first glob or unbound var
  matchId(id: string, root: string): Vars | null     // bind an artifact id, or null
  renderId(vars: Vars, root: string): string         // artifact id for the vars
  artifact(id: string, root: string): Item           // make the artifact for an id
  scan(root: string): Promise<string[]>              // ids of existing items under the literal start
  prepareOutput(artifact: Item): Promise<void>       // called before run for each single output
  sortKey(artifact: Item): string                    // sort key for list inputs
}
```

### Types

```ts
type Vars = Record<string, string>
type Item = Artifact<Uint8Array>
type ItemInput = Item | Item[] | undefined
type FileInput = ItemInput
```
