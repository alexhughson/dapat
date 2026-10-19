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
| `dapat/contrib` | `FileArtifact`, `DirectoryArtifact`, `PathPrefix`, `S3ObjectArtifact`, `S3Prefix`, `MemoryS3`, `SqliteRowArtifact`, `SqliteTableArtifact`, `SqliteTablePrefix`, `JsonStore`, `SqliteStore`, and a short factory function for each artifact and prefix (`file`, `directory`, `pathPrefix`, `s3Object`, `s3Prefix`, `sqliteRow`, `sqliteTable`, `sqliteTablePrefix`) |

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
4. **Run `touch in.txt`.** The modification time changes, but the bytes do not. Both tasks skip, because dapat compares the content of `in.txt` with the stored hash.

[Section 6](#6-when-a-task-skips) gives the full rules.

The repo has this build in `examples/first-build.ts`. Run it with `bun run examples/first-build.ts` from a directory that contains `in.txt`.

### Read the result

`build.run()` returns a `Result`:

- `success` is `true` when no task failed and `errors` is empty.
- `executed` lists the tasks that ran and did not fail.
- `skipped` lists the tasks that dapat did not run, because their outputs were current.
- `failed` is a `Map<Task, Error>`.
- `cancelled` lists the tasks that were replaced or removed before they finished ([section 8](#8-failure-cancellation-and-replacement)).
- `errors` lists the errors that no task owns ([section 9](#9-subscribe-to-artifact-events)). These are subscriber errors from sends that no running task caused, errors that a task throws after it was stopped or after a subscriber error failed it, and async subscriber rejections.

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

Keep order stamps in the same unit as the other artifacts in the same task. dapat compares order stamps as plain integers ([section 12](#12-limits)).

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
├─ the first time only: sends a promised event for each output of each task that you added before it
├─ starts every task at the same time; each task does these steps:
│  ├─ wait for inputs
│  │   ├─ a producer task failed           → this task fails: "dependency of '<id>' failed"
│  │   └─ no task can make progress        → this task fails: "deadlock waiting for inputs of '<id>'"
│  ├─ decide if the task can skip
│  │   ├─ stamp every artifact input and output
│  │   ├─ compare with the store record     → skipped, reason "content"
│  │   └─ compare order stamps              → skipped, reason "order"
│  ├─ task.run(ctx)
│  │   └─ ctx.produced(artifact)            → calls each subscriber before it returns
│  └─ on success
│      ├─ send a produced event for each declared artifact output that the task did not report
│      └─ store.set(task.id, stamps of inputs and outputs)
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

If you add a producer after `build.run()` starts, a consumer waits for it only if that consumer is still waiting for other inputs. A consumer that has already started does not stop.

Tasks with no dependency between them run at the same time. dapat has no concurrency limit. [Section 11.2](#112-limit-parallel-work) shows how to limit parallel work inside `run`.

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

You can also call `build.add()` and `build.remove()` from outside a task while `build.run()` is running. `build.run()` returns when every task that it started has finished. Subscribers ([section 9](#9-subscribe-to-artifact-events)) run synchronously, so the build does not wait for them separately.

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
- **The old task is running.** dapat aborts `ctx.signal` of the old task. The old run ends as `cancelled`, even if it finishes without an error. A later `ctx.produced` call from the old run does nothing. If the old run throws an `AbortError` (for example from `ctx.signal.throwIfAborted()`), dapat ignores it. Any other error from the old run goes into `result.errors`. The same applies to a task that `build.remove` stops.

In each case, the new task then waits, skips, or runs in the usual way.

In `build.add`, dapat sends events only for the outputs that changed ([section 9](#9-subscribe-to-artifact-events)). It compares the outputs by kind (artifact or prefix) and `id`:

1. A `withdrawn` event for each output that subscribers know from the old task and that the new task does not declare.
2. A `promised` event for each output of the new task that subscribers do not know yet.

An output that both tasks declare gets no event. The new task now owns it, and dapat withdraws it when you remove the new task. Before the first `build.run()`, a replacement sends no events. `build.run()` then sends the `promised` events of the new task only.

Your task code must stop work when `ctx.signal` aborts. dapat does not stop a running function.

`Result` uses `Task` objects as keys, not ids. A replaced task and its replacement are both in the result, as two different objects. Always pass a new `Task` object to replace a task. dapat does not support adding the same `Task` object again while it runs.

### Removal

`build.remove(id)` removes the task. It aborts the task if the task is running. It sends a `withdrawn` event for each output that the task declares. If the task had not finished, dapat marks it `cancelled` with the reason `"removed"`.

`build.remove(id)` also starts to delete the store record for the task, but it does not wait for the delete. `build.run()` can return before the delete is done, and a delete error is not reported.

dapat does not delete files or objects. A `withdrawn` event only tells subscribers that the output will not come ([section 9](#9-subscribe-to-artifact-events)).

## 9. Subscribe to artifact events

`Build` is an `Emitter<ArtifactEvent>`. A subscriber gets an event when a task that declares an output enters the build, when a task produces an artifact, and when a task that declares an output leaves the build:

```ts
type ArtifactEvent =
  | { kind: "promised"; output: Ref; taskId: string }
  | { kind: "produced"; artifact: Artifact; taskId: string }
  | { kind: "withdrawn"; output: Ref; taskId: string }

build.subscribe((event) => { ... })
```

`taskId` is the task that declares the output or produced the artifact. The subscriber gets every event. To use only some artifacts, check `event.output.id` or `event.artifact.id` in the subscriber.

dapat sends a `promised` event for each declared output, an artifact or a prefix:

- at the start of the first `build.run()`, for each task that you added before it. dapat sends these events before any task starts. Thus a subscriber that you add after `build.add` and before `build.run()` gets them.
- when you add a task after `build.run()` started, with `build.add`, `ctx.add`, or from a subscriber. dapat sends the events before `add` returns.

A `promised` event means that the output will exist when the task finishes. Thus a subscriber knows about an output before any task runs.

dapat sends a `produced` event at these times:

- when a task calls `ctx.produced(artifact)`.
- when a task runs with no error, for each declared artifact output that the task did not report with `ctx.produced`. dapat sends this event before the task counts as finished. Thus a subscriber can add a task that reads the output, and that new task waits for the writer.

dapat sends a `withdrawn` event for each declared output when it removes the task, and for each output that a replacement does not declare ([section 8](#8-failure-cancellation-and-replacement)). A withdrawn artifact will not come. A withdrawn prefix means that each artifact under it that this task would write will not come, also the artifacts that the task reported with `ctx.produced`. dapat does not send one event for each of those artifacts. Another task can still declare or write an artifact under that prefix.

For one output of one task, a subscriber gets the events in this order: `promised`, then `produced` if the task produces it, then `withdrawn` if the task leaves the build. A subscriber gets no `produced` event before the `promised` event, and no event after the `withdrawn` event. A task that you remove before the first `build.run()` sends no events.

dapat keeps, for each task id, the outputs that it told subscribers about. Each `add` and `remove` sends one event at a time, until those outputs equal the outputs of the current task with that id. dapat works out each event just before it sends it. Thus a subscriber can add, replace, or remove the same task id during an event, and no subscriber gets an old event after that change. Each output is promised one time, even if a task declares it two times. To keep this order with more than one subscriber, see [Event order with more than one subscriber](#event-order-with-more-than-one-subscriber).

Delivery is synchronous. dapat calls each subscriber in the order that it subscribed, and it waits for each call to return. Thus, when `ctx.produced` returns, each task that a subscriber added is already in the build. A subscriber must not return a promise. If it returns one, dapat does not wait for it: the send throws `subscriber returned a promise; subscribers must be synchronous`, and dapat reports that error as below. If the promise rejects, its error goes into `result.errors`.

`subscribe` does not replay earlier events. Subscribe before the first `build.run()` to get all events. A subscriber that you add during a send gets the next event, not the current one.

A task that skips sends no `produced` events ([section 12](#12-limits)).

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
        map.set(shot.key, { value: "img", version: 9n })
      },
    }),
  )
})

const result = await build.run()
// executed: split, shot:pages/1, shot:pages/2
```

### Subscriber errors

A subscriber that throws stops that event: the later subscribers do not get it. dapat still sends the other events of the same call. For example, `build.remove(id)` sends a `withdrawn` event for each output of the task, even when the first one throws. dapat changes its own state before it sends, so a throw never leaves a task half added, half removed, or half replaced.

dapat reports each error one time, in one of these ways:

- **A running task caused the send.** This applies to `ctx.produced`, `ctx.add`, `ctx.remove`, and the events for the declared outputs after the task returns. It also applies to a `build.add` or `build.remove` that a subscriber calls during one of these sends.
  - The task fails with the first error, and the error goes into `result.failed`.
  - The task fails even if it catches the error. If the task then throws its own error, its own error goes into `result.errors`.
  - `ctx.produced`, `ctx.add`, and `ctx.remove` throw the first error after they send all events.
  - If one call gets more than one error, the other errors go into `result.errors`.
  - A subscriber error on one declared output does not stop the events for the other declared outputs. The task fails, and those artifacts stay produced until dapat withdraws them.
  - If a subscriber removes or replaces the task during these sends, the task ends as `cancelled`. dapat sends no more events for it, writes no store record for it, and puts its error into `result.errors`.
- **No running task caused the send.** For example, you call `build.add(task)` or `build.remove(id)` from outside a task, and a subscriber throws on the `promised` or `withdrawn` event. Then `build.add` and `build.remove` do not throw. The error goes into `result.errors`, and `result.success` is `false`. This also applies to the `promised` events at the start of `build.run()`, and to a `ctx` call from a task that already finished. When a running task calls `ctx.add` or `ctx.remove`, the error goes to that task, as in the first case.

`result.errors` holds every error of the build so far that no task owns. An error that occurs after `build.run()` returns appears in the result of the next `build.run()` on the same build.

dapat does not ignore a subscriber error.

A subscriber must not call the `ctx` of a task. Use `build.add` and `build.remove`. A `ctx` that a subscriber calls can report one error for two tasks.

### Event order with more than one subscriber

A subscriber can change tasks during a send, and that change sends new events at once. A later subscriber then gets the new events before the event that caused them. For example, subscriber 1 removes the writer when it gets `produced x`. Subscriber 2 then gets `withdrawn x` before `produced x`.

So let only one subscriber change tasks in reaction to an event, or write subscribers that do not depend on the order of events for one artifact.

A subscriber that undoes each change it sees never settles. For example, it removes a task on `promised` and adds it again on `withdrawn`. The calls nest until the stack overflows, and `result.errors` holds the overflow errors.

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

## 11. Recipes

### 11.1 Force tasks to run again

To run every task again, clear the store before the build:

```ts
const store = new JsonStore(".dapat/state.json")
await store.clear()
const build = new Build({ store })
```

To run one task again, delete its record with `await store.delete(taskId)`. If the outputs of that task are newer than its inputs, the task still skips by order. Delete one of its outputs as well to make sure that it runs.

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

A new checkout sets the modification time of each file to the time of the checkout. The order check therefore does not give useful results in CI. To skip unchanged tasks in CI, keep these items in the CI cache between runs:

- the store file, for example `.dapat/state.json`.
- the output files of the tasks.

dapat then uses the content check, which does not depend on modification times. If the cache is empty, every task runs.

## 12. Limits

- **A task that skips sends no `produced` events.** This applies to its prefix outputs and to its declared outputs. A subscriber gets only the `promised` events of that task on the next build.
- **Order stamps have different units.** dapat compares the order stamps of all artifacts in one task as plain integers. `FileArtifact` and `DirectoryArtifact` use nanoseconds. `S3ObjectArtifact` uses milliseconds. `SqliteRowArtifact` uses `rowid` or your `orderColumn`. If one task has artifacts of two kinds, the order check gives wrong results. For example, an S3 input and a file output always look current. The content check comes first, so a persistent store decides correctly after the first successful run. On the first run, and each time the task has no store record, the order check decides.
- **A prefix artifact input does not wait for a plain prefix output in a subfolder.** See [section 5](#how-dapat-finds-dependencies).
- **`FileArtifact` stamp methods return `null` for all errors.** For example, a permission error on a file looks like a missing file. The task then runs again and does not fail. Check file permissions when a task always runs.
- **No timeout and no concurrency limit.** All ready tasks start at the same time. Add limits and timeouts in your task code ([section 11.2](#112-limit-parallel-work)), and use `ctx.signal` to stop work.
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
| `add(task: Task): void` | Adds a task. If a task with the same id exists, replaces it (see [section 8](#replacement)). If `run()` has started, sends a `promised` event for each declared output, and the task starts at once. Throws if another task already declares one of its exact outputs, or if the task declares one output twice. |
| `remove(id: string): void` | Removes a task. Aborts it if it is running and sends a `withdrawn` event for each declared output. Starts to delete its store record, but does not wait for the delete. Does nothing if the id is not known. |
| `subscribe(listener: (event: ArtifactEvent) => void): void` | From `Emitter`. Calls `listener` synchronously for each artifact event. Does not replay earlier events. See [section 9](#9-subscribe-to-artifact-events). |
| `run(): Promise<Result>` | The first time, sends a `promised` event for each output of each task that is in the build. Then starts every task and resolves when every started task has finished. Does not reject when a task fails. |

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
| `produced(artifact: Artifact): void` | Sends a `produced` event to each subscriber before it returns. Throws if no output of the task covers it. Also throws if a subscriber throws, and then the task fails ([section 9](#subscriber-errors)). Does nothing if the task was replaced or removed. |

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
| `success` | `boolean` | `true` when no task failed and `errors` is empty. Cancelled tasks do not make it `false`. |
| `executed` | `readonly Task[]` | Tasks whose `run` completed. |
| `skipped` | `readonly Task[]` | Tasks that the skip rules skipped. |
| `failed` | `ReadonlyMap<Task, Error>` | Tasks that threw, whose producer failed, or that were in a deadlock. |
| `cancelled` | `readonly Task[]` | Tasks that were replaced or removed before they completed. |
| `errors` | `readonly Error[]` | Errors that no task owns: subscriber errors from sends that no running task caused, errors that a task throws after it was stopped or after a subscriber error failed it, and async subscriber rejections. It keeps the errors of earlier runs of the same build. |

`Result` does not give the reason for a skip. The build keeps an `Outcome` for each task, but no public member returns it. See [section 6.1](#61-why-did-a-task-run-or-skip).

### `type Outcome`

```ts
type Outcome =
  | { type: "executed" }
  | { type: "skipped"; reason: "content" | "order" }
  | { type: "failed"; error: Error }
  | { type: "cancelled"; reason: "replaced" | "removed" }
```

### `class Emitter<E>`

| Member | Description |
| --- | --- |
| `subscribe(listener: (event: E) => void): void` | Adds a listener. Listeners get events in the order that they subscribed. |
| `protected send(event: E): void` | Calls each listener synchronously, in order. If a listener throws, `send` stops and throws that error to its caller. If a listener returns a promise, `send` throws an error. |
| `protected rejected(reason: unknown): void` | Called when a listener's returned promise rejects. The default throws `reason` again, so the rejection stays unhandled. `Build` overrides it and puts the error in `result.errors`. |

`Build` extends `Emitter<ArtifactEvent>`.

### `type ArtifactEvent`

```ts
type ArtifactEvent =
  | { kind: "promised"; output: Ref; taskId: string }
  | { kind: "produced"; artifact: Artifact; taskId: string }
  | { kind: "withdrawn"; output: Ref; taskId: string }
```

| Kind | dapat sends it when |
| --- | --- |
| `promised` | a task that declares `output` enters the build: at the start of the first `run()`, or at `add` after that. |
| `produced` | the task wrote `artifact`: from `ctx.produced`, or for a declared artifact output after the task returns. |
| `withdrawn` | the task that declared `output` leaves the build: `remove`, or a replacement that does not declare it. |

`taskId` is the task that declares the output or produced the artifact. See [section 9](#9-subscribe-to-artifact-events).

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
