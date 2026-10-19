# dapat documentation

dapat runs tasks. It skips a task when the outputs of that task are still current.

This document has two parts:

- The [usage guide](#usage-guide) explains how the library works and how to build a pipeline with it.
- The [API reference](#api-reference) lists each exported class, function, and type.

---

# Usage guide

## 1. Overview

You describe your work as **tasks**. Each task names its inputs and its outputs. Inputs and outputs can be files. They can also be S3 objects, database rows, or values in memory.

dapat wraps each input and output in an **artifact**, which is a subclass of `Artifact`. The subclass gives dapat a **stamp**: a string that changes when the thing changes, for example a hash. dapat includes artifact classes for files, S3, and SQLite. For anything else, write a small subclass ([section 4](#4-artifacts)).

When you run a **build**, dapat does these steps for each task:

1. It waits for the tasks that write the inputs of the task.
2. It compares the current stamps of the inputs and outputs with the stamps from the last successful run. The **store** keeps the last stamps.
3. It skips the task when every stamp is equal to the stamp from the last run. Otherwise, it runs the task.

dapat does not know about disks or SQL. It only reads artifact ids and stamps. The adapters in `dapat/contrib` supply files, S3, and SQLite.

You declare tasks with `Build` and `Task`. You can know each task in advance, or your code can decide which tasks to add. Sections 3 to 9 describe this.

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
| `dapat/contrib` | `FileArtifact`, `DirectoryArtifact`, `PathPrefix` (and the types `FileStampMode` and `FileStampOptions`), `S3ObjectArtifact`, `S3Prefix`, `MemoryS3`, `SqliteRowArtifact`, `SqliteTableArtifact`, `SqliteTablePrefix`, `JsonStore`, `SqliteStore`, and a short factory function for each artifact and prefix (`file`, `directory`, `pathPrefix`, `s3Object`, `s3Prefix`, `sqliteRow`, `sqliteTable`, `sqliteTablePrefix`) |

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
  for (const error of result.errors) {
    console.error(error.message)
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
4. **Run `touch in.txt`.** The modification time changes, but the bytes do not. By default, the stamp of a `FileArtifact` is the modification time and the size, so the stamp changes. Both tasks run. To skip in this case, use `new FileArtifact("in.txt", { stamp: "hash" })`. Then the stamp is a hash of the bytes ([section 10.1](#101-files-fileartifact-directoryartifact-pathprefix)).

[Section 6](#6-when-a-task-skips) gives the full rules.

The repo has this build in `examples/first-build.ts`. Run it with `bun run examples/first-build.ts` from a directory that contains `in.txt`.

### Read the result

`build.run()` returns a `Result`:

- `success` is `true` when no task failed and `errors` is empty.
- `executed` lists the tasks that ran and did not fail.
- `skipped` lists the tasks that dapat did not run, because every stamp equalled the record ([section 6](#6-when-a-task-skips)).
- `failed` is a `Map<Task, Error>`.
- `cancelled` lists the tasks that were replaced or removed before they finished ([section 8](#8-failure-cancellation-and-replacement)).
- `errors` lists the errors that no task owns: a non-abort error that a task throws after it was replaced or removed ([section 8](#replacement)), and a store delete that rejects ([section 8](#removal)).

A failed task does not stop the build. The other tasks continue. `build.run()` does not throw when a task fails, so always check `result.success`. `build.run()` rejects in three cases only: a subscriber throws, a subscriber returns a promise, or subscribers reach the send limit ([section 9](#subscriber-errors)).

You can call `build.run()` again on the same `Build`, for example after you add more tasks. A second call runs only the tasks that have not run yet. It does not run the completed tasks again. Its result also lists the tasks of the earlier calls. To run the whole pipeline again, make a new `Build` with the same store.

## 4. Artifacts

An artifact has four parts:

```ts
abstract class Artifact<T = unknown> {
  abstract readonly id: string
  abstract stamp(): Promise<string | null>
  abstract read(): Promise<T>
}
```

- **`id`** identifies the artifact. Two artifact objects with the same id are the same artifact. dapat connects tasks only through ids.
- **`stamp()`** returns a string that changes when the value changes, for example a hash of the value. dapat compares two stamps for equality only. It never asks which stamp is newer.
- **`read()`** returns the value. dapat never calls `read()`. Only your task code calls it.

Return `null` from `stamp()` when the value does not exist. A `null` stamp on an output makes the task run. A `null` stamp on an input is a valid stamp: if the input is still missing on the next build, the stamp is still equal.

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

- A **plain prefix** is a folder. It has a stamp, but no value. The classes are `IdPrefix`, `PathPrefix`, `S3Prefix`, and `SqliteTablePrefix`. Use a plain prefix when a task writes files, but you do not know their names before the task runs ([section 5](#5-tasks-and-dependencies)). Also use it as an input when a task reads files in a folder.
- A **prefix artifact** is a folder that you can stamp and read. Its stamp comes from the artifacts in the folder. The classes are `DirectoryArtifact` and `SqliteTableArtifact`. Use a prefix artifact when a task reads all of the contents of a folder.

### Prefix stamps

A plain prefix has a `stamp()` method, as an artifact has. The stamp changes when anything under the prefix changes. Each prefix class chooses how to make it. For example, `PathPrefix` hashes the relative path and the stamp of each file under the folder.

Example: a task writes `index.html` from every page under `pages/`. Its input is `pathPrefix("pages/")`.

1. Build 1 sees `a.md`, `b.md`, and `c.md`. The task runs.
2. You add `d.md`. The stamp of the prefix changes.
3. Build 2 runs the task, and `index.html` lists `d.md`.

An edit to a page or a deleted page also changes the stamp.

An empty or missing folder has a real stamp, for example the hash of an empty list. So a task can skip when its folder is still empty.

A prefix returns `null` from `stamp()` when it cannot tell what is under it. Then each task that uses that prefix runs on each build. The base class `Prefix` returns `null`. `IdPrefix` uses the base class, because an id string cannot list its children. A skip could then hide a change, so the task runs. `SqliteTablePrefix` also returns `null`.

To write your own prefix with a stamp, extend `Prefix` and override `stamp()`. List the children, and hash each child id with its stamp. Sort the lines first, so that the order of the list has no effect.

### Write your own artifact

This artifact is a key in a `Map`. The map entry holds a value.

```ts
import { Artifact } from "dapat"

type Entry = { value: string }

class MapEntry extends Artifact<string> {
  readonly id: string

  constructor(readonly map: Map<string, Entry>, readonly key: string) {
    super()
    this.id = `map:${key}`
  }

  async stamp(): Promise<string | null> {
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

Choose a stamp that changes each time the value changes. Two kinds work well:

- A hash of the value. It is correct, but `stamp()` must read the full value.
- A version number or a modification time, as a string, for example `String(version)`. It is fast. It also changes when your code writes the same value again, so a task can run one extra time.

If two different values can have the same stamp, dapat can skip a task that must run.

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

Each task in a build has one owner. `build.add(task)` gives the task the owner `add:<task id>`, so a replacement with the same id has the same owner. Later versions of dapat add rules, which make tasks under their own owners. A task id can have only one owner, so `build.add` will throw if a rule already made a task with the same id. `build.remove(id)` removes the task from its owner, and the owner can give the same id again later. For `build.add` and `build.remove`, owners change nothing else.

The task writes its outputs itself. dapat does not write, move, or delete files. When a task deletes an artifact, it reports the delete with `ctx.deleted(artifact)`.

### What `build.run()` does

```text
build.run()
├─ the first time only: sends a promised event for each output of each task that you added before it
├─ starts every task at the same time; each task does these steps:
│  ├─ wait for inputs
│  │   ├─ a producer task failed           → this task fails: "dependency of '<id>' failed"
│  │   └─ no task can make progress        → this task fails: "deadlock waiting for inputs of '<id>'"
│  ├─ decide if the task can skip
│  │   ├─ stamp every input: artifacts and prefixes
│  │   ├─ read the store record of the task
│  │   ├─ stamp every output: artifacts and prefixes
│  │   ├─ all stamps equal the record       → skipped
│  │   └─ store.get or stamp() throws       → this task fails
│  ├─ task.run(ctx)
│  │   ├─ ctx.produced(artifact)            → calls each subscriber before it returns
│  │   └─ ctx.deleted(artifact)             → calls each subscriber before it returns
│  └─ on success
│      ├─ send a produced event for each declared artifact output that the task did not report
│      │  with ctx.produced or ctx.deleted
│      └─ store.set(task.id, input stamps from before the run, output stamps from after it)
└─ waits until every started task has finished → returns Result
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

After `build.run()` starts, a new task looks for its producers when the current synchronous code ends: at the next `await` or `return` of the code that added it. The subscriber calls that the add causes are part of that synchronous code ([The event queue](#the-event-queue)). A producer that you add after an `await` can come too late. Then the consumer waits for it only if the consumer is still waiting for other inputs. A consumer that has already started does not stop.

To make sure that a consumer waits for its producer, use one of these ways:

- Add the producer first.
- Give the producer and the consumer in one `setTasks` call.
- Add the producer from a subscriber, when it gets the `promised` event of the consumer.

Adding both in the same synchronous code also works:

```ts
await build.run()
build.add(consumer) // reads x
build.add(producer) // writes x
await build.run()   // consumer waits for producer
```

Tasks with no dependency between them run at the same time. dapat has no concurrency limit. [Section 11.2](#112-limit-parallel-work) shows how to limit parallel work inside `run`.

### Outputs with unknown names

Some tasks write a set of artifacts, and the names are not known before the task runs. For example, a task can split a document into pages. For this case, declare a plain prefix output: the folder that the task writes into. Then call `ctx.produced(artifact)` for each artifact that the task writes.

This sample uses `MapEntry` and `Entry` from [section 4](#write-your-own-artifact):

```ts
import { Build, IdPrefix, Task } from "dapat"

const map = new Map<string, Entry>()
map.set("doc", { value: "p1\np2" })
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
        map.set(key, { value: lines[i]! })
        ctx.produced(new MapEntry(map, key))
      }
    },
  }),
)
```

A task that reads `map:pages/1` now waits for `split`. `ctx.produced()` throws when the artifact is not a declared output of the task and is not in one of the task's output folders. The task then fails.

`IdPrefix` cannot list the pages, so its stamp is `null` ([Prefix stamps](#prefix-stamps)). Thus `split` runs on each build. To let `split` skip, use a prefix subclass whose `stamp()` lists the pages in the map. Then `split` skips when `doc` and the pages have the same stamps as in the record.

### The `ctx` argument

The `ctx` argument of `run` has these members:

- `ctx.signal` is an `AbortSignal`. It aborts when the task is replaced or removed. Pass it to `fetch` and other APIs that accept a signal.
- `ctx.add(task)` adds a task to the build. The task starts when its inputs are ready.
- `ctx.remove(id)` removes a task from the build.
- `ctx.produced(artifact)` tells dapat that the task wrote `artifact`.
- `ctx.deleted(artifact)` tells dapat that the task deleted `artifact`. dapat does not delete it. An output of the task must cover `artifact`, as for `ctx.produced`.

You can also call `build.add()` and `build.remove()` from outside a task while `build.run()` is running. `build.run()` returns when every task that it started has finished. Subscribers ([section 9](#9-subscribe-to-artifact-events)) run synchronously, so the build does not wait for them separately.

## 6. When a task skips

dapat makes the decision for each task after the tasks that write its inputs finish. It uses one rule.

dapat **skips** the task when all of these are true:

- The task has at least one input or output.
- The build has a store, and the store has a record for the task id.
- The record has the same input ids and the same output ids as the task.
- Each artifact output exists. Its stamp is not `null`.
- No prefix input or output has a `null` stamp.
- The current stamp of each input and output, artifact or prefix, is equal to the stamp in the record.

In all other cases, dapat **runs** the task. With no store, with no record for the task, with no input or output to compare, or with an `IdPrefix`, the task always runs.

The examples below use a task `compile` with the input `src.txt` and the output `out.txt`. The build has a store.

1. **No record.** This is the first build with this store. The task runs. Then dapat writes the stamps of `src.txt` and `out.txt` to the store.
2. **Same stamps.** Nothing changed since the last build. The stamps of `src.txt` and `out.txt` are equal to the record. The task skips.
3. **An input changed.** You edit `src.txt`. Its stamp is different from the record. The task runs.
4. **An output is missing.** You delete `out.txt`. Its stamp is `null`. The task runs.
5. **The ids changed.** You add the input `header.txt` to the task. The record has no stamp for `header.txt`. The task runs.

Some more results of the rule:

- You edit an output by hand. Its stamp is different from the record, so the task runs and writes the output again.
- You touch an input, but its bytes do not change. By default, `FileArtifact` uses the modification time and the size as its stamp, so the stamp changes. The task runs. With `{ stamp: "hash" }`, the stamp does not change, and the task skips.
- You add a file to a folder that a `PathPrefix` input covers. The stamp of the prefix changes. The task runs.
- An input is missing on two builds in a row. Its stamp is `null` both times. The stamps are equal, so this input does not make the task run.
- The task has no inputs and no outputs, for example a deploy task. dapat has nothing to compare, so the task runs on each build.
- The task has an `IdPrefix` input or output. Its stamp is `null`, so the task runs on each build.
- A task deletes one of its declared artifact outputs and calls `ctx.deleted`. That output is then missing, so the task runs on each build. To delete an artifact and still skip, declare its folder as a prefix output with a stamp, for example a `PathPrefix`. An `IdPrefix` output makes the task run on each build. Call `ctx.deleted` on each run, also when the artifact is already gone. If you do not, dapat sends a `produced` event for the missing output after the task returns.

dapat does not ask which modification time is newer. Older versions of dapat skipped a task when its outputs were newer than its inputs, as `make` does. That check is gone. A file stamp can hold a modification time, but dapat compares it for equality only. Without a store record, a task runs.

dapat stamps the inputs, artifacts and prefixes, before the task runs. It stamps a prefix input after the tasks that write under the prefix have finished. After the task runs with no error, dapat stamps the outputs, artifacts and prefixes. Then it writes the input stamps from before the run and the output stamps from after the run to the store. If an input changes while the task runs, the record keeps the old stamp, so the next build runs the task again. dapat does not write stamps for a failed task, so a failed task runs again on the next build.

The `stamp()` methods do real I/O. For example, `FileArtifact.stamp()` reads the modification time and size of the file, and `PathPrefix.stamp()` walks the folder and does the same for each file. With `{ stamp: "hash" }`, they read and hash the full bytes. dapat calls `stamp()` only when the build has a store. Before a task runs, it always stamps the inputs. It stamps the outputs only when the store has a record for the task.

If `store.get()` or a `stamp()` method throws during this check, the task fails with that error. It does not run. The tasks that read its outputs fail too, as for any failed task.

### 6.1 Why did a task run or skip?

`Result` tells you which tasks ran and which skipped. It does not tell you the reason. To find the reason, do these steps:

1. Read the task's record with `await store.get(taskId)`. If it is `null`, the task has never succeeded with this store, so it runs.
2. Call `await artifact.stamp()` on each artifact input and output. Compare the values with `inputStamps` and `outputStamps` in the record. Call `await prefix.stamp()` on each prefix input and output. Compare the values with `inputPrefixStamps` and `outputPrefixStamps`. A missing id, an extra id, a different stamp, a `null` output stamp, or a `null` prefix stamp makes the task run.
3. Make sure that the task declares every file that it reads. dapat does not see an input that the task does not declare. A change to that file does not make the task run.

## 7. Stores

The store keeps the stamps from the last successful run of each task. The store is optional. Without a store, every task runs on each build.

| Store | Use it for |
| --- | --- |
| `MemoryStore` | Tests, and builds that repeat in one process |
| `JsonStore(path)` | Small builds on one machine |
| `SqliteStore(db or path)` | Larger builds, and builds with many parallel tasks. It uses the table `dapat_task_state`. |

```ts
import { Build } from "dapat"
import { SqliteStore } from "dapat/contrib"

const store = new SqliteStore(".dapat/state.db")
const build = new Build({ store })
```

`JsonStore` reads the whole file and writes it again for each change. It writes to a temp file with a unique name next to `<path>`, and then renames that file to `<path>`. One `JsonStore` object does its changes one at a time, so parallel tasks in one build do not lose records. It does not lock the file, so two processes, or two `JsonStore` objects with the same path, must not use the file at the same time.

If the file is not valid JSON, each `get` throws, so each task fails. Call `store.clear()` or delete the file to start again.

`SqliteStore` accepts an open `Database` from `bun:sqlite` or a file path. If you give a path, the store opens the database, and `close()` closes it. If you give a `Database`, `close()` does nothing.

The store keeps one stamp for each declared input and output: a string, or `null`. It keeps artifact stamps and prefix stamps in separate maps, so a prefix and an artifact with the same id cannot share a stamp. It does not keep the artifacts that a task reported with `ctx.produced()` or `ctx.deleted()`.

dapat treats a record in an older shape as no record. The task runs, and dapat writes a record in the new shape. So the first build after an upgrade runs every task one time. These records are older:

- A record with no prefix stamp maps. Older versions of dapat did not stamp prefixes.
- A record with two stamps for each id, an order stamp and a content stamp.

Add the store file to `.gitignore`. To make tasks run again, see [section 11.1](#111-force-tasks-to-run-again).

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
  for (const error of result.errors) {
    console.error(error.message)
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
- **The old task is running.** dapat aborts `ctx.signal` of the old task. The old run ends as `cancelled`, even if it finishes without an error. A later `ctx.produced` or `ctx.deleted` call from the old run does nothing. If the old run throws an `AbortError` (for example from `ctx.signal.throwIfAborted()`), dapat ignores it. Any other error from the old run goes into `result.errors`. The same applies to a task that `build.remove` stops.

In each case, the new task then waits, skips, or runs in the usual way.

In `build.add`, dapat sends events only for the outputs that changed ([section 9](#9-subscribe-to-artifact-events)). It compares the outputs by kind (artifact or prefix) and `id`:

1. A `withdrawn` event for each output that the old task declares and the new task does not declare.
2. A `promised` event for each output that the new task declares and the old task does not declare.

An output that both tasks declare gets no event. The new task now owns it, and dapat withdraws it when you remove the new task. Before the first `build.run()`, a replacement sends no events. `build.run()` then sends the `promised` events of the new task only.

Your task code must stop work when `ctx.signal` aborts. dapat does not stop a running function.

`Result` uses `Task` objects as keys, not ids. A replaced task and its replacement are both in the result, as two different objects. Always pass a new `Task` object to replace a task. dapat does not support adding the same `Task` object again while it runs.

### Removal

`build.remove(id)` removes the task. It aborts the task if the task is running. It sends a `withdrawn` event for each output that the task declares. If the task had not finished, dapat marks it `cancelled` with the reason `"removed"`.

`build.remove(id)` also starts to delete the store record for the task. `build.remove` does not wait for the delete, but `build.run()` does. A delete error goes into `result.errors`.

dapat does not delete files or objects. A `withdrawn` event only tells subscribers that the output will not come ([section 9](#9-subscribe-to-artifact-events)).

## 9. Subscribe to artifact events

`Build` is an `Emitter<ArtifactEvent>`. A subscriber gets an event when a task that declares an output enters the build, when a task produces or deletes an artifact, and when a task that declares an output leaves the build:

```ts
type ArtifactEvent =
  | { kind: "promised"; output: Ref; taskId: string }
  | { kind: "produced"; artifact: Artifact; taskId: string }
  | { kind: "deleted"; artifact: Artifact; taskId: string }
  | { kind: "withdrawn"; output: Ref; taskId: string }

build.subscribe((event) => { ... })
```

`taskId` is the task that declares the output, or that produced or deleted the artifact. The subscriber gets every event. To use only some artifacts, check `event.output.id` or `event.artifact.id` in the subscriber.

dapat sends a `promised` event for each declared output, an artifact or a prefix:

- at the start of the first `build.run()`, for each task that you added before it. dapat sends these events before any task starts. Thus a subscriber that you add after `build.add` and before `build.run()` gets them.
- when you add a task after `build.run()` started, with `build.add`, `ctx.add`, or from a subscriber. dapat sends the events before the outermost call returns ([The event queue](#the-event-queue)).

A `promised` event means that the output will exist when the task finishes, unless the task reports it with `ctx.deleted`. Thus a subscriber knows about an output before any task runs.

dapat sends a `produced` event at these times:

- when a task calls `ctx.produced(artifact)`.
- when a task runs with no error, for each declared artifact output that the task did not report with `ctx.produced` or `ctx.deleted`. dapat sends this event before the task counts as finished. Thus a subscriber can add a task that reads the output, and that new task waits for the writer.

dapat sends a `deleted` event when a task calls `ctx.deleted(artifact)`. A task can report one artifact more than one time. The last report is the current one. For example, a task deletes a declared output and then writes it again: the subscriber gets `deleted`, then `produced`. A declared output whose last report is `deleted` gets no `produced` event after the task returns.

dapat sends a `withdrawn` event for each declared output when it removes the task, and for each output that a replacement does not declare ([section 8](#8-failure-cancellation-and-replacement)). A withdrawn artifact will not come. A withdrawn prefix means that each artifact under it that this task would write will not come, also the artifacts that the task reported with `ctx.produced`. dapat does not send one event for each of those artifacts. Another task can still declare or write an artifact under that prefix.

For one output of one task, a subscriber gets the events in this order: `promised`, then `produced` or `deleted` for each report of the task, then `withdrawn` if the task leaves the build. A subscriber gets no `produced` or `deleted` event before the `promised` event, and no event after the `withdrawn` event. A task that you remove before the first `build.run()` sends no events.

Each `add`, `remove`, and `setTasks` compares the old and the new outputs of each task id that it changes. One call puts all its `withdrawn` events on the queue before any `promised` event. Thus an output that moves from one task to another in one call is withdrawn before it is promised again. Each output is promised one time, even if a task declares it two times. For the order across calls, see [The event queue](#the-event-queue).

Delivery is synchronous. dapat calls each subscriber in the order that it subscribed, and it waits for each call to return. Thus, when `ctx.produced` returns, each task that a subscriber added is already in the build. A subscriber must not return a promise. If it returns one, dapat does not wait for it: the send fails with `subscriber returned a promise; subscribers must be synchronous`, and `build.run()` rejects with that error ([Subscriber errors](#subscriber-errors)). If the promise then rejects, dapat drops that rejection, because it keeps only the first error.

`subscribe` does not replay earlier events. Subscribe before the first `build.run()` to get all events. A subscriber that you add during a send gets the next event, not the current one.

A task that skips sends no `produced` or `deleted` events ([section 12](#12-limits)).

A subscriber can add tasks. This subscriber adds one task for each page from the `split` sample in section 5. Add it to that sample before `build.run()`:

```ts
build.subscribe((event) => {
  if (event.kind !== "produced") return
  if (!event.artifact.id.startsWith("map:pages/")) return
  const key = event.artifact.id.slice("map:".length)
  const page = new MapEntry(map, key)
  const shot = new MapEntry(map, key.replace("pages/", "shots/"))
  build.add(
    new Task({
      id: `shot:${key}`,
      inputs: [page],
      outputs: [shot],
      run: async () => {
        map.set(shot.key, { value: "img" })
      },
    }),
  )
})

const result = await build.run()
// executed: split, shot:pages/1, shot:pages/2
```

### Subscriber errors

A subscriber is part of your program, like the code that adds tasks. A throw in a subscriber is a bug in the program, not a failure of one task. So dapat has two rules:

- A task's own error goes into `result.failed`. The other tasks continue ([section 8](#failure)).
- Every other error makes `build.run()` reject. These errors are a subscriber that throws, a subscriber that returns a promise, and the send limit ([The event queue](#the-event-queue)).

When a subscriber throws, dapat does these steps:

1. The throw stops that event. The later subscribers do not get it.
2. dapat keeps the error as the fatal error of the build, and clears the queue. dapat does not send the other events in the queue.
3. dapat aborts `ctx.signal` of each running task. It starts no more tasks, sends no more events, and writes no more store records.
4. `build.run()` rejects with the error, after each running task returned.

The call that caused the send does not throw. This applies to `build.add`, `build.remove`, `ctx.add`, `ctx.remove`, `ctx.produced`, and `ctx.deleted`. dapat changes its own state before it sends, so the call still adds, removes, or replaces the task.

dapat keeps only the first error. It clears the queue and sends no more events, so no later subscriber error can occur.

An error outside `build.run()` waits for the next run. For example, a subscriber throws on the `promised` event of a `build.add` after `build.run()` returned. Then `build.add` returns normally, and the next `build.run()` rejects with the error at once and runs no task. Each later `build.run()` on the same build rejects with the same error. To run again, make a new `Build`.

This subscriber throws on each produced artifact:

```ts
build.subscribe((event) => {
  if (event.kind === "produced") throw new Error("index is full")
})
build.add(new Task({ id: "write", outputs: [out], run: async () => {} }))

try {
  await build.run()
} catch (error) {
  console.error(error) // Error: index is full
}
```

`write` runs, and dapat sends `produced` for `out` after `write` returns. The subscriber throws, and `build.run()` rejects with `index is full`. dapat writes no store record for `write`.

### The event queue

dapat keeps one queue of events for the build. A call that changes the state first changes the state, and then puts its events at the end of the queue. These calls are `add`, `remove`, `setTasks`, `ctx.produced`, `ctx.deleted`, the end of a task, and the start of the first `build.run()`. If no drain is in progress, the call then drains the queue: it sends one event at a time to every subscriber, until the queue is empty. The call returns after the drain.

A subscriber that changes tasks during a send does not start a new drain. Its events go at the end of the queue. The current event first reaches every subscriber, and then the new events follow. Thus every subscriber gets every event in the same order, and that order is the order of the state changes.

An event can be stale when it arrives. Then its correction always comes later in the queue. For example, task `t` declares `x`. Subscriber 1 replaces `t` with a task that declares `y` when it gets `promised x by t`. Both subscribers get these events, in this order:

```text
promised x by t     (subscriber 1 replaces t during this event)
withdrawn x by t
promised y by t
produced y by t
```

Subscriber 2 gets `promised x by t` after `t` stopped declaring `x`, and then `withdrawn x by t`. A subscriber that applies every event in order ends with the true state. Do not act on one event in a way that a later event cannot undo.

**The send limit.** During one drain, subscribers can cause at most 10,000 events (`SEND_LIMIT`). The limit counts only the events that subscribers cause during the drain. It does not count the events of the call that started the drain. Thus a `setTasks` call or a first `build.run()` with more than 10,000 outputs does not reach it. To change the limit, use `new Build({ sendLimit })`. The value must be a positive integer. You cannot turn the limit off.

The limit counts all events that subscribers cause in one drain, also correct ones. For example, a subscriber adds one task for each `promised` event. On a first `build.run()` with more than `sendLimit` outputs, the start of the run sends more than `sendLimit` `promised` events in one drain, and the subscriber causes one more `promised` event for each of them. That build reaches the limit. Set a higher `sendLimit` for such a build.

The limit stops a subscriber that undoes each change that it sees. For example, a subscriber removes a task on `promised` and adds it again on `withdrawn`. Then the queue never becomes empty. At the limit, the drain stops with this error:

```text
send limit: subscribers caused 10000 events in one drain, and more wait; the last sent was 'promised x by t'
```

dapat handles this error as a subscriber error: `build.run()` rejects with it.

## 10. Built-in artifacts

The [API reference](#api-reference) gives the full details of each class.

### 10.1 Files: `FileArtifact`, `DirectoryArtifact`, `PathPrefix`

A relative path resolves against the current working directory when you create the object.

| Class | Stamp | `read()` returns |
| --- | --- | --- |
| `FileArtifact(path, { stamp })` | the modification time and size, or the SHA-256 of the bytes | `Uint8Array` |
| `DirectoryArtifact(path, { stamp })` | SHA-256 of each relative path and the stamp of that file. `null` if the directory is missing. | absolute paths of all files, in all subdirectories |
| `PathPrefix(path, { stamp })` | SHA-256 of each relative path and the stamp of that file. A missing directory has the stamp of an empty list. | none (plain prefix) |

#### Time or hash

Each of the three classes takes the option `stamp: "time" | "hash"`. The factory functions `file()`, `directory()`, and `pathPrefix()` take it too. The default is `"time"`.

- `"time"`: the stamp of a file is its modification time in nanoseconds and its size. dapat reads no bytes.
- `"hash"`: the stamp of a file is the SHA-256 of its bytes. dapat reads each file in full.

`"time"` is the default because it is much faster. These are measured times on Bun, with a cold cache and then a warm cache:

| Files | `"time"` | `"hash"` |
| --- | --- | --- |
| 400 text pages, 2 MB | 21–26 ms / 13–19 ms | 47–55 ms / 22–23 ms |
| 40 image files, 86 MB | 5–6 ms / 2–3 ms | 165–371 ms / 115–155 ms |
| 1 file, 287 MB | 2–3 ms / under 1 ms | 0.4–2 s / 0.4–0.6 s |

`"time"` has a cost. A `touch`, a `git checkout`, or a copy that changes the modification time and keeps the bytes changes the stamp. Then the task runs again. Set `stamp: "hash"` where a run is expensive, for example a task that calls a paid model.

```ts
const prompt = file("prompts/summary.txt", { stamp: "hash" })
const pages = pathPrefix("pages/", { stamp: "hash" })
```

Older versions of dapat used the hash for every file. After an upgrade, every stamp of a file is different, so each task with a file runs one time.

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

| Class | Stamp | `read()` returns |
| --- | --- | --- |
| `S3ObjectArtifact(client, bucket, key)` | `etag` | `Uint8Array` |
| `S3Prefix(client, bucket, keyPrefix)` | SHA-256 of each key under the prefix and its `etag` | none (plain prefix) |

### 10.3 SQLite: `SqliteRowArtifact`, `SqliteTableArtifact`, `SqliteTablePrefix`

These classes take a `bun:sqlite` `Database`. Table and column names must match `[A-Za-z_][A-Za-z0-9_]*`. Other names cause a throw.

| Class | Stamp | `read()` returns |
| --- | --- | --- |
| `SqliteRowArtifact({ db, table, pkColumn, pk })` | SHA-256 of the column values | the row as an object |
| `SqliteTableArtifact({ db, table, pkColumn })` | SHA-256 of the hashes of all rows | the primary keys |
| `SqliteTablePrefix(table)` | `null`, so a task that uses it runs on each build | none (plain prefix) |

`SqliteTableArtifact` is a prefix artifact. Each row is a file in the folder `sqlite:table/`.

## 11. Recipes

### 11.1 Force tasks to run again

To run every task again, clear the store before the build:

```ts
const store = new JsonStore(".dapat/state.json")
await store.clear()
const build = new Build({ store })
```

To run one task again, delete its record with `await store.delete(taskId)`. A task with no record always runs.

### 11.2 Limit parallel work

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

### 11.3 Run in CI

A task skips only when the store has a record for it. To skip unchanged tasks in CI, keep these items in the CI cache between runs:

- the store file, for example `.dapat/state.json`.
- the output files of the tasks.

A new checkout changes the modification time of each file. With the default `stamp: "time"`, that changes the stamp of each file, and every task with a file input runs. In CI, pass `{ stamp: "hash" }` to `FileArtifact`, `DirectoryArtifact`, and `PathPrefix`. A hash does not change when the bytes stay the same. The ids of these artifacts are absolute paths. So check out the repo at the same path on each CI run. At a different path, the ids change, and every task runs. If the cache is empty, every task runs.

## 12. Limits

- **A task that skips sends no `produced` or `deleted` events.** This applies to its prefix outputs and to its declared outputs. A subscriber gets only the `promised` events of that task on the next build.
- **A task with an `IdPrefix` input or output runs on each build.** An `IdPrefix` cannot list what is under it, so its stamp is `null`. A skip could hide a change under it. `SqliteTablePrefix` is the same. To let the task skip, use a prefix that can stamp, for example `PathPrefix` or `S3Prefix`, or write a prefix subclass with a `stamp()` method.
- **A `"time"` stamp can miss a fast edit.** A file system keeps the modification time with a limited precision, for example a few milliseconds. If you edit a file soon after dapat stamped it, and the size stays the same, the stamp can stay the same. Then the task skips. Use `stamp: "hash"` for files that a program edits during the build.
- **A prefix artifact input does not wait for a plain prefix output in a subfolder.** See [section 5](#how-dapat-finds-dependencies).
- **`FileArtifact.stamp()` returns `null` for all errors.** For example, a permission error on a file looks like a missing file. On an output, the task then runs again and does not fail. On an input, a `null` stamp on two builds in a row is equal, so the task can skip. Check file permissions when a task always runs or never runs.
- **No timeout and no concurrency limit.** All ready tasks start at the same time. Add limits and timeouts in your task code ([section 11.2](#112-limit-parallel-work)), and use `ctx.signal` to stop work.
- **Bun only.** The adapters use Bun APIs.

---

# API reference

All paths in this section are relative to the repo root. `dapat` is `src/index.ts`. `dapat/contrib` is `contrib/index.ts`.

## Core (`dapat`)

### `class Build`

```ts
new Build(opts?: { store?: Store; sendLimit?: number })
```

`sendLimit` is the number of events that subscribers can cause during one drain of the event queue. The default is `SEND_LIMIT` (10,000), which `dapat` exports. The constructor throws if `sendLimit` is not a positive integer. The limit cannot be turned off. See [The event queue](#the-event-queue).

| Member | Description |
| --- | --- |
| `add(task: Task): void` | Adds a task. If a task with the same id exists, replaces it (see [section 8](#replacement)). If `run()` has started, sends a `promised` event for each declared output, and the task starts at once. Does not throw when a subscriber throws ([section 9](#subscriber-errors)). Throws if another task already declares one of its exact outputs, if the task declares one output twice, or if another owner holds that id ([section 5](#5-tasks-and-dependencies)). |
| `remove(id: string): void` | Removes a task. Aborts it if it is running and sends a `withdrawn` event for each declared output. Does not throw when a subscriber throws. Starts to delete its store record. Does not wait for the delete, but `run()` does. A delete error goes into `result.errors`. Does nothing if the id is not known. The other tasks of the same owner stay. |
| `subscribe(listener: (event: ArtifactEvent) => void): void` | From `Emitter`. Calls `listener` synchronously for each artifact event, in the order of the event queue. Does not replay earlier events. See [section 9](#9-subscribe-to-artifact-events). |
| `protected setTasks(owner: string, tasks: readonly Task[]): void` | Makes `tasks` the tasks of `owner` ([section 5](#5-tasks-and-dependencies)). Adds each new id, replaces each known id, and removes each id that `owner` gave before and does not give now. Changes all state first, then puts the events on the queue: all `withdrawn` events of the call first, then the `promised` events, by id in list order. A dropped task ends as `cancelled` with the reason `"removed"` if it had not finished. Throws and changes nothing if another owner has one of the ids, if `tasks` has one id two times, or if two tasks declare one exact output. `add(task)` calls `setTasks("add:" + task.id, [task])`. Rules will call it; your code does not. |
| `run(): Promise<Result>` | The first time, sends a `promised` event for each output of each task that is in the build. Then starts every task and resolves when every started task has finished. Does not reject when a task fails. Rejects with the first subscriber error or send-limit error of the build, at once if that error happened before the call ([section 9](#subscriber-errors)). |

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
| `produced(artifact: Artifact): void` | Sends a `produced` event to each subscriber before it returns. Throws if no output of the task covers it. Does not throw when a subscriber throws: `build.run()` rejects instead ([section 9](#subscriber-errors)). Does nothing if the task was replaced or removed. |
| `deleted(artifact: Artifact): void` | Call it after the task deleted `artifact`. Sends a `deleted` event to each subscriber before it returns. A declared output that the task last reported as deleted gets no `produced` event after the task returns. Throws and does nothing in the same cases as `produced`. |

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
| `abstract stamp(): Promise<string \| null>` | A string that changes when the artifact changes. `null` if the artifact does not exist. dapat compares stamps for equality only. A throw fails the task that dapat stamps the artifact for. |
| `abstract read(): Promise<T>` | Reads the value. |
| `covers(other: Artifact): boolean` | Default: `other.id === this.id`. Override it for listings. |
| `get coversOthers(): boolean` | Default: `false`. Return `true` when `covers` can match other ids. |

### `abstract class Prefix`

| Member | Description |
| --- | --- |
| `abstract readonly id: string` | The region. End it with a delimiter. |
| `stamp(): Promise<string \| null>` | A string that changes when anything under the prefix changes. An empty region has a real stamp. `null` when the prefix cannot tell what is under it; then each task that uses it runs. Default: `null`. A throw fails the task that dapat stamps the prefix for. See [Prefix stamps](#prefix-stamps). |
| `covers(artifact: Artifact): boolean` | Default: `artifact.id` equals or starts with `this.id`. |
| `overlaps(other: Prefix): boolean` | Default: one id equals or starts with the other. |

### `class IdPrefix extends Prefix`

```ts
new IdPrefix(id: string)
```

A prefix whose region is the id string. Its stamp is `null`, because an id string cannot list its children. So a task that uses an `IdPrefix` runs on each build.

### `interface Store`

| Method | Description |
| --- | --- |
| `get(taskId): Promise<TaskState \| null>` | The record of the last successful run, or `null`. |
| `set(taskId, state): Promise<void>` | Writes a record. The build calls it after each successful run. |
| `delete(taskId): Promise<void>` | Deletes a record. The build calls it from `remove`. |
| `clear(): Promise<void>` | Deletes every record. The build does not call it. |

To write your own store, implement these four methods. A record holds strings and `null` only, so `JSON.stringify` can encode it as it is. `get` can return a record in an older shape. The build then treats it as no record ([section 7](#7-stores)).

### `interface TaskState`

```ts
interface TaskState {
  inputStamps: Record<string, string | null>  // keyed by artifact id
  outputStamps: Record<string, string | null>
  inputPrefixStamps: Record<string, string | null>  // keyed by prefix id
  outputPrefixStamps: Record<string, string | null>
}
```

In the artifact maps, `null` means that the artifact did not exist. In the prefix maps, `null` means that the prefix could not tell what was under it.

### `class MemoryStore implements Store`

```ts
new MemoryStore()
```

Keeps records in a `Map`. The records are lost when the process ends. `MemoryStore` is also exported from `dapat/contrib`.

### `class Result`

| Field | Type | Description |
| --- | --- | --- |
| `success` | `boolean` | `true` when no task failed and `errors` is empty. Cancelled tasks do not make it `false`. |
| `executed` | `readonly Task[]` | Tasks whose `run` completed. |
| `skipped` | `readonly Task[]` | Tasks that the skip rule skipped. |
| `failed` | `ReadonlyMap<Task, Error>` | Tasks that threw, whose producer failed, or that were in a deadlock. |
| `cancelled` | `readonly Task[]` | Tasks that were replaced or removed before they completed. |
| `errors` | `readonly Error[]` | Errors that no task owns: a non-abort error that a task throws after it was replaced or removed, and a store delete that rejects. It keeps the errors of earlier runs of the same build. A subscriber error is not here: `run()` rejects with it. |

`Result` does not say why a task ran. The build keeps an `Outcome` for each task, but no public member returns it. See [section 6.1](#61-why-did-a-task-run-or-skip).

### `type Outcome`

```ts
type Outcome =
  | { type: "executed" }
  | { type: "skipped" }
  | { type: "failed"; error: Error }
  | { type: "cancelled"; reason: "replaced" | "removed" }
```

### `class Emitter<E>`

| Member | Description |
| --- | --- |
| `subscribe(listener: (event: E) => void): void` | Adds a listener. Listeners get events in the order that they subscribed. |
| `protected send(event: E): void` | Calls each listener synchronously, in order. If a listener throws, `send` stops and throws that error to its caller. If a listener returns a promise, `send` throws an error. |
| `protected rejected(reason: unknown): void` | Called when a listener's returned promise rejects. The default throws `reason` again, so the rejection stays unhandled. `Build` overrides it with an empty method, so the rejection is not unhandled. The send already made `run()` reject ([section 9](#subscriber-errors)). |

`Build` extends `Emitter<ArtifactEvent>`.

### `type ArtifactEvent`

```ts
type ArtifactEvent =
  | { kind: "promised"; output: Ref; taskId: string }
  | { kind: "produced"; artifact: Artifact; taskId: string }
  | { kind: "deleted"; artifact: Artifact; taskId: string }
  | { kind: "withdrawn"; output: Ref; taskId: string }
```

| Kind | dapat sends it when |
| --- | --- |
| `promised` | a task that declares `output` enters the build: at the start of the first `run()`, or at `add` after that. The event can be stale; then a `withdrawn` event follows ([The event queue](#the-event-queue)). |
| `produced` | the task wrote `artifact`: from `ctx.produced`, or for a declared artifact output after the task returns. |
| `deleted` | the task deleted `artifact`: from `ctx.deleted`. |
| `withdrawn` | the task that declared `output` leaves the build: `remove`, or a replacement that does not declare it. |

`taskId` is the task that declares the output, or that produced or deleted the artifact. See [section 9](#9-subscribe-to-artifact-events).

## Filesystem (`dapat/contrib`)

Relative paths are resolved against `process.cwd()` when you construct the artifact.

### `class FileArtifact extends Artifact<Uint8Array>` and `file(path)`

```ts
new FileArtifact(path: string, opts?: { stamp?: "time" | "hash" })
file(path: string, opts?: { stamp?: "time" | "hash" }): FileArtifact
```

| Member | Value |
| --- | --- |
| `path` | Absolute path |
| `id` | `file:<absolute path>` |
| `stampMode` | `"time"` or `"hash"`. Default `"time"`. The constructor throws for any other value. |
| `stamp()` | `"time"`: `<modification time in ns>:<size>`. `"hash"`: SHA-256 hex of the bytes. `null` if the path is not a file that dapat can read. |
| `read()` | The bytes. Throws if the file is missing. |

### `class DirectoryArtifact extends Artifact<string[]>` and `directory(path)`

```ts
new DirectoryArtifact(path: string, opts?: { stamp?: "time" | "hash" })
directory(path: string, opts?: { stamp?: "time" | "hash" }): DirectoryArtifact
```

| Member | Value |
| --- | --- |
| `path` | Absolute path, ending with `/` |
| `id` | `file:<absolute path>/` |
| `covers(other)` | `true` for every id under the directory |
| `coversOthers` | `true` |
| `stampMode` | `"time"` or `"hash"`. Default `"time"`. |
| `stamp()` | SHA-256 of the sorted lines `<relative path>=<file stamp>`. Each file stamp is as in `FileArtifact`. `null` if the directory is missing. |
| `read()` | Absolute paths of every file under the directory, at any depth. Throws if the directory is missing. |

### `class PathPrefix extends Prefix` and `pathPrefix(path)`

```ts
new PathPrefix(path: string, opts?: { stamp?: "time" | "hash" })
pathPrefix(path: string, opts?: { stamp?: "time" | "hash" }): PathPrefix
```

| Member | Value |
| --- | --- |
| `path` | Absolute path, ending with `/` |
| `id` | `file:<absolute path>/` |
| `stampMode` | `"time"` or `"hash"`. Default `"time"`. |
| `stamp()` | SHA-256 of the sorted lines `<relative path>=<file stamp>` for every file under the path, at any depth. Each file stamp is as in `FileArtifact`. A missing directory has the stamp of an empty list. Never `null`. |

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
| `stamp()` | `head().etag`. `null` if `head` returns `null`. |
| `read()` | `client.get(bucket, key)` |

### `class S3Prefix extends Prefix` and `s3Prefix(client, bucket, keyPrefix)`

```ts
new S3Prefix(client: S3Client, bucket: string, keyPrefix: string)
s3Prefix(client: S3Client, bucket: string, keyPrefix: string): S3Prefix
```

`id` is `s3://<bucket>/<keyPrefix>/`. The constructor adds the trailing `/` if `keyPrefix` is not empty and does not end with `/`.

`stamp()` lists the keys under `<keyPrefix>/` with `client.list`, and calls `client.head` for each key. It returns the SHA-256 of the sorted lines `<key>=<etag>`. It skips a key that `head` does not find. An empty prefix has the stamp of an empty list. Older versions took no `client`.

### `class MemoryS3 implements S3Client`

```ts
new MemoryS3()
```

Keeps objects in a `Map`. `put` sets the `etag` to the SHA-256 of the body. `put` also sets `lastModified` to a value that increases by at least 1 ms on each call. `get` throws for a missing object. `list` returns sorted keys.

## SQLite (`dapat/contrib`)

### `class SqliteRowArtifact extends Artifact<Record<string, unknown>>` and `sqliteRow(opts)`

```ts
sqliteRow(opts: {
  db: Database
  table: string
  pkColumn: string
  pk: string | number
}): SqliteRowArtifact
```

| Member | Value |
| --- | --- |
| `table`, `pkColumn` | The validated names |
| `pk` | The primary key as a string |
| `id` | `sqlite:<table>/<pkColumn>/<pk>` |
| `stamp()` | SHA-256 of the sorted `column=value` lines, without `rowid`. `null` if the row is missing. |
| `read()` | The row without `rowid`. Throws if the row is missing. |

### `class SqliteTableArtifact extends Artifact<string[]>` and `sqliteTable(opts)`

```ts
sqliteTable(opts: {
  db: Database
  table: string
  pkColumn: string
}): SqliteTableArtifact
```

| Member | Value |
| --- | --- |
| `id` | `sqlite:<table>/` |
| `covers(other)`, `coversOthers` | Covers every row id of the table |
| `stamp()` | SHA-256 of the sorted `<pk>=<row hash>` lines. `null` if the table does not exist. |
| `read()` | Every primary key as a string. Throws if the table does not exist. |

### `class SqliteTablePrefix extends Prefix` and `sqliteTablePrefix(table)`

```ts
sqliteTablePrefix(table: string): SqliteTablePrefix
```

`id` is `sqlite:<table>/`. `stamp()` is the base `Prefix.stamp()`, which returns `null`. So a task that uses a `SqliteTablePrefix` runs on each build.

## Stores (`dapat/contrib`)

### `class JsonStore implements Store`

```ts
new JsonStore(path: string)
```

Keeps every record in one JSON file with the shape `{ "tasks": { "<taskId>": { "inputStamps": ..., "outputStamps": ..., "inputPrefixStamps": ..., "outputPrefixStamps": ... } } }`. Each stamp is a string or `null`. A missing file is the same as an empty store. `set` creates the parent directory.

### `class SqliteStore implements Store`

```ts
new SqliteStore(db: Database | string)
```

Creates the table `dapat_task_state (task_id TEXT PRIMARY KEY, payload TEXT)` if it does not exist. `payload` is the record as JSON. `close()` closes the database only if the store opened it from a path.

### `MemoryStore`

The same class as the core `MemoryStore`.
