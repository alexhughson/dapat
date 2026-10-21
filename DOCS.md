# dapat documentation

dapat runs tasks. It skips a task when the outputs of that task are still current.

This document has two parts:

- The [usage guide](#usage-guide) explains how the library works and how to build a pipeline with it.
- The [API reference](#api-reference) lists each exported class, function, and type.

---

# Usage guide

## 1. Overview

You describe your work as **tasks**. Each task names its inputs and its outputs. Inputs and outputs can be files. They can also be S3 objects, database rows, or values in memory.

dapat wraps each input and output in an **artifact**, which is a subclass of `Artifact`. The subclass gives dapat a **stamp**: a string that changes when the thing changes, for example a hash. dapat includes artifact classes for files and S3. For anything else, write a small subclass ([section 4](#4-artifacts)).

When you run a **build**, dapat does these steps for each task:

1. It waits for the tasks that write the inputs of the task.
2. It compares the current stamps of the inputs and outputs with the stamps from the last successful run. The **store** keeps the last stamps.
3. It skips the task when every stamp is equal to the stamp from the last run. Otherwise, it runs the task.

dapat does not know about disks or SQL. It only reads artifact ids and stamps. The adapters in `dapat/contrib` supply files, two matchers of files, S3, and stores in JSON and SQLite.

You declare tasks with `Build` and `Task`. You can know each task in advance, or your code can decide which tasks to add. Sections 3 to 9 describe this. `build.each` makes tasks for you from the things that matchers find, and joins them on shared var names ([section 10](#10-buildeach-tasks-for-each-matched-artifact)).

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
| `dapat` | `Build`, `TaskGroup`, `Task`, `Artifact`, `Prefix`, `IdPrefix`, `Matcher`, `MemoryStore`, `Result`, and their types |
| `dapat/contrib` | `FileArtifact`, `FilesystemPrefix`, `FileMatcher`, `FileGroupMatcher` (and the types `FileStampMode`, `FileStampOptions`, `FileMatcherOptions`, and `FilePatternSyntax`), `S3ObjectArtifact`, `S3Prefix`, `MemoryS3` (and the types `S3Client`, `S3Head`, and `S3ListEntry`), `JsonStore`, and `SqliteStore` |

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
4. **Run `touch in.txt`.** The modification time changes, but the bytes do not. By default, the stamp of a `FileArtifact` is a hash of the bytes, so the stamp does not change. Both tasks skip. With `new FileArtifact("in.txt", { stamp: "time" })`, the stamp is the modification time and the size, so both tasks run ([section 11.1](#111-files-fileartifact-filesystemprefix)).

[Section 6](#6-when-a-task-skips) gives the full rules.

The repo has this build in `examples/first-build.ts`. Run it from a folder that contains `in.txt`, with `bun run <path to dapat>/examples/first-build.ts`.

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
| `FilesystemPrefix("out")` | `file:/abs/path/out/` |
| `S3ObjectArtifact(client, "b", "k/x")` | `s3://b/k/x` |

### Prefixes

Think of an id as a file path. Think of a **prefix** as a folder. The id `map:pages/` is a folder. The ids `map:pages/1` and `map:pages/2` are files in that folder. `map:pages/` is a prefix of both ids.

dapat compares ids as plain strings. An id is in a folder when the id starts with the id of the folder. End each folder id with `/`. If you do not, the folder `file:/p/out` also contains the file `file:/p/outgoing.txt`.

A prefix has a stamp, but no value of its own. The classes are `IdPrefix`, `FilesystemPrefix`, and `S3Prefix`. Use a prefix in two places:

- **As an output**, when a task writes files, but you do not know their names before the task runs ([section 5](#outputs-with-unknown-names)).
- **As an input**, when a task reads the files in a folder. The task waits for each task that writes into the folder.

`new FilesystemPrefix(path)` stands for a folder. Its `list()` method returns the absolute path of each file under the folder, at any depth. A missing folder lists no files.

Example: a task joins every file under `out/` into `bundle.txt`.

```ts
import { Task } from "dapat"
import { FileArtifact, FilesystemPrefix } from "dapat/contrib"

const out = new FilesystemPrefix("out")
const bundle = new FileArtifact("bundle.txt")

new Task({
  id: "bundle",
  inputs: [out],
  outputs: [bundle],
  run: async () => {
    const paths = await out.list()
    paths.sort()
    const parts: string[] = []
    for (const filePath of paths) {
      parts.push(await Bun.file(filePath).text())
    }
    await Bun.write(bundle.path, parts.join("\n"))
  },
})
```

`bundle` waits for each task that writes a file in `out/`. It runs again when a file in `out/` is added, edited, or deleted. `bundle.txt` is next to `out/`, not in it ([Prefix layouts](#prefix-layouts)).

### Prefix stamps

A prefix has a `stamp()` method, as an artifact has. The stamp changes when anything under the prefix changes. Each prefix class chooses how to make it. For example, `FilesystemPrefix` hashes the relative path and the stamp of each file under the folder. Each file stamp is the hash of the bytes, or with `{ stamp: "time" }` the modification time and the size, as for `new FileArtifact()`.

Example: a task writes `index.html` from every page under `pages/`. Its input is `new FilesystemPrefix("pages/")`. `index.html` is next to `pages/`, not in it. In `pages/`, it would change the stamp of its own input ([Prefix layouts](#prefix-layouts)).

1. Build 1 sees `a.md`, `b.md`, and `c.md`. The task runs.
2. You add `d.md`. The stamp of the prefix changes.
3. Build 2 runs the task, and `index.html` lists `d.md`.

An edit to a page or a deleted page also changes the stamp.

An empty or missing folder has a real stamp, for example the hash of an empty list. So a task can skip when its folder is still empty. This also means that a task whose folder output holds no files does not run again when you delete that empty folder.

A prefix returns `null` from `stamp()` when it cannot tell what is under it. Then each task that uses that prefix runs on each build. The base class `Prefix` returns `null`. `IdPrefix` uses the base class, because an id string cannot list its children. A skip could then hide a change, so the task runs.

To write your own prefix with a stamp, extend `Prefix` and override `stamp()`. List the children, and hash each child id with its stamp. Sort the lines first, so that the order of the list has no effect. [Section 5](#outputs-with-unknown-names) has an example.

### Prefix layouts

A **region** is a prefix: a ref that stands for many ids, for example `new FilesystemPrefix("out")`. Regions may overlap, and two tasks may declare the same region. dapat does not reject them. (Two tasks that declare the same artifact are still rejected as a duplicate output.) But two layouts make tasks run again with no edits, and dapat gives no warning:

- **A task writes into a folder that it reads.** For example, a task reads `new FilesystemPrefix("pages/")` and writes `pages/index.html`. With the default `"hash"` stamp, the task runs on builds 1 and 2 and skips from build 3, if it writes the same bytes each time. With `stamp: "time"`, the task runs on every build. Put `index.html` next to `pages/`, not in it.
- **Two tasks write into one folder.** For example, `split` writes `new FilesystemPrefix("out/")`, and `index` writes `out/index.html`. The writers, and a task that reads `out/`, run again on later builds. In some layouts they run on every build. Give each writer its own folder, for example `out/pages/` for `split`.

[Section 13](#13-limits) explains what runs again and why.

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

The task writes its outputs itself. dapat does not write, move, or delete files. When a task deletes an artifact, it reports the delete with `ctx.deleted(artifact)`.

### Task groups

Each task in a build is in one task group. A group holds a list of tasks. The build replaces the list of a group as one unit.

For example, this build has two `build.add` tasks and one `build.each` over two posts. `lint` and `test` are any two tasks. The matcher is a `FileMatcher` ([section 10](#filematcher-one-match-for-each-file)).

```ts
build.add(lint)
build.add(test)
build.each({
  matchersByName: { post: new FileMatcher("posts/<slug>.md") }, // finds posts/a.md and posts/b.md
  *tasks(vars, matched) {
    yield new Task({ id: `page:${vars.slug}`, inputs: [matched.post.data], outputs: [/* ... */], run: async () => {} })
  },
})
```

The build has four task groups:

| Group | Made by | Tasks |
| --- | --- | --- |
| `build.add lint` | `build.add(lint)` | `lint` |
| `build.add test` | `build.add(test)` | `test` |
| `build.each 1 slug=a` | the match of `posts/a.md` | `page:a` |
| `build.each 1 slug=b` | the match of `posts/b.md` | `page:b` |

Now you delete `posts/b.md`. The matcher sends `gone` with the vars `{ slug: "b" }`. `build.each` sets the task list of the group `build.each 1 slug=b` to an empty list. Thus the build removes `page:b`. The other three groups do not change.

The rules:

- Each task id is in exactly one group, so `build.add` throws if `build.each` already made a task with that id.
- `build.add(task)` makes one group for the task id. When you add the same id again, the replacement stays in the same group.
- `build.each` makes one group for each joined set of matches ([section 10](#10-buildeach-tasks-for-each-matched-artifact)).
- A subclass of `Build` can call `setTasksOfGroups([{ group, tasks }, ...])`. It replaces the whole list of each group. It adds each new id, replaces each known id, and removes each id that no group of the call gets again.
- `build.remove(id)` removes the task from its group. The other tasks of the group stay, and the group can get the same id again later.
- After `build.remove(id)`, a later `build.add` with that id makes a new group. A task that `build.each` made and that you remove comes back only when its match changes, or after `gone` and then `found`.
- A group is an object, a `TaskGroup`. Its label is only for error messages. Two groups with the same label are two different groups. Thus two parts of your code cannot share a group only because they use the same label.

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
- B has the artifact input `x`, and A has a prefix output that contains `x`.
- B has a prefix input `p`, and A has an artifact output inside `p`. For example, a task that reads `new FilesystemPrefix("out")` waits for a task that writes `new FileArtifact("out/a.txt")`.
- B has a prefix input `p`, and A has a prefix output inside `p`, or a prefix output that contains `p`. For example, a task that reads `new FilesystemPrefix("out")` waits for a task that writes `new FilesystemPrefix("out/sub")`.

An input that no task writes is a **source**, for example `in.txt` in section 3. dapat does not wait for a source.

Only one task can declare a given artifact as an output. `build.add()` throws `duplicate output '<id>'` when a second task declares the same output id. One task also cannot declare the same output two times. Two tasks can still write into one folder, and a task can write into a folder that it reads. Those tasks can run again with no edits ([Prefix layouts](#prefix-layouts)).

A waiting task finds its producers again each time a task is added, removed, or completed. When a producer finishes, the waiting task continues in this way:

- If the producer executed or skipped, the waiting task goes on to the skip check.
- If the producer failed, the waiting task fails with `dependency of '<id>' failed`.
- If the producer was replaced, the waiting task waits for the new task with the same id.
- If the producer was removed, the waiting task goes on to the skip check. It does not fail.

After `build.run()` starts, a new task looks for its producers when the current synchronous code ends: at the next `await` or `return` of the code that added it. The subscriber calls that the add causes are part of that synchronous code ([The event queue](#the-event-queue)). A producer that you add after an `await` can come too late. Then the consumer waits for it only if the consumer is still waiting for other inputs. A consumer that has already started does not stop.

To make sure that a consumer waits for its producer, use one of these ways:

- Add the producer first.
- Give the producer and the consumer in one `setTasksOfGroups` call.
- Add the producer from a subscriber, when it gets the `promised` event of the consumer.

Adding both in the same synchronous code also works:

```ts
await build.run()
build.add(consumer) // reads x
build.add(producer) // writes x
await build.run()   // consumer waits for producer
```

Tasks with no dependency between them run at the same time. dapat has no concurrency limit. [Section 12.2](#122-limit-parallel-work) shows how to limit parallel work inside `run`.

### Outputs with unknown names

Some tasks write a set of artifacts, and the names are not known before the task runs. For example, a task can split a document into pages. For this case, declare a prefix output: the folder that the task writes into. Then call `ctx.produced(artifact)` for each artifact that the task writes.

This sample uses `MapEntry` and `Entry` from [section 4](#write-your-own-artifact). `MapPrefix` is a folder of map keys. Its stamp lists each key in the folder with its value, so `split` can skip:

```ts
import { Build, Prefix, Task } from "dapat"

class MapPrefix extends Prefix {
  readonly id: string

  constructor(readonly map: Map<string, Entry>, readonly folder: string) {
    super()
    this.id = `map:${folder}`
  }

  async stamp(): Promise<string | null> {
    const lines: string[] = []
    for (const [key, entry] of this.map) {
      if (!key.startsWith(this.folder)) continue
      lines.push(`${key}=${entry.value}`)
    }
    lines.sort()
    const hasher = new Bun.CryptoHasher("sha256")
    hasher.update(lines.join("\n"))
    return hasher.digest("hex")
  }
}

const map = new Map<string, Entry>()
map.set("doc", { value: "p1\np2" })
const doc = new MapEntry(map, "doc")

const build = new Build()

build.add(
  new Task({
    id: "split",
    inputs: [doc],
    outputs: [new MapPrefix(map, "pages/")],
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

`split` skips when `doc` and the pages have the same stamps as in the record. With `new IdPrefix("map:pages/")` as the output, `split` runs on each build, because an `IdPrefix` cannot list the pages ([Prefix stamps](#prefix-stamps)).

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

In one sentence: dapat skips a task that has an input when no output and no prefix has a `null` stamp, and every id and stamp equals the record. In detail, dapat **skips** the task when all of these are true:

- The task has at least one input.
- The build has a store, and the store has a record for the task id.
- The record has the same input ids and the same output ids as the task.
- Each artifact output exists. Its stamp is not `null`.
- No prefix input or output has a `null` stamp.
- The current stamp of each input and output, artifact or prefix, is equal to the stamp in the record.

In all other cases, dapat **runs** the task. With no store, with no record for the task, with no input, or with an `IdPrefix`, the task always runs.

The examples below use a task `compile` with the input `src.txt` and the output `out.txt`. The build has a store.

1. **No record.** This is the first build with this store. The task runs. Then dapat writes the stamps of `src.txt` and `out.txt` to the store.
2. **Same stamps.** Nothing changed since the last build. The stamps of `src.txt` and `out.txt` are equal to the record. The task skips.
3. **An input changed.** You edit `src.txt`. Its stamp is different from the record. The task runs.
4. **An output is missing.** You delete `out.txt`. Its stamp is `null`. The task runs.
5. **The ids changed.** You add the input `header.txt` to the task. The record has no stamp for `header.txt`. The task runs.

Some more results of the rule:

- You edit an output by hand. Its stamp is different from the record, so the task runs and writes the output again.
- You touch an input, but its bytes do not change. By default, `FileArtifact` uses a hash of the bytes as its stamp, so the stamp does not change. The task skips. With `{ stamp: "time" }`, the stamp changes, and the task runs.
- A task runs again and writes its output file with the same bytes. A task that reads that file skips, because the hash is the same. With `{ stamp: "time" }`, the write gives the file a new modification time, so the task that reads it runs.
- You add a file to a folder that a `FilesystemPrefix` input covers. The stamp of the prefix changes. The task runs.
- An input is missing on two builds in a row. Its stamp is `null` both times. The stamps are equal, so this input does not make the task run.
- The task has no inputs, for example a deploy task, or a task that fetches data into `raw/` with only a prefix output. Nothing can tell dapat that the result is still current, so the task runs on each build. To let it skip, give it an input, for example a config file.
- The task has an `IdPrefix` input or output. Its stamp is `null`, so the task runs on each build.
- A task deletes one of its declared artifact outputs and calls `ctx.deleted`. That output is then missing, so the task runs on each build. To delete an artifact and still skip, declare its folder as a prefix output with a stamp, for example a `FilesystemPrefix`. The task must also have an input. An `IdPrefix` output makes the task run on each build. Call `ctx.deleted` on each run, also when the artifact is already gone. If you do not, dapat sends a `produced` event for the missing output after the task returns.

dapat does not ask which modification time is newer. Older versions of dapat skipped a task when its outputs were newer than its inputs, as `make` does. That check is gone. A file stamp can hold a modification time, but dapat compares it for equality only. Without a store record, a task runs.

dapat stamps the inputs, artifacts and prefixes, before the task runs. It stamps a prefix input after the tasks that write under the prefix have finished. After the task runs with no error, dapat stamps the outputs, artifacts and prefixes. Then it writes the input stamps from before the run and the output stamps from after the run to the store. If an input changes while the task runs, the record keeps the old stamp, so the next build runs the task again. dapat does not write stamps for a failed task, so a failed task runs again on the next build.

The `stamp()` methods do real I/O. For example, `FileArtifact.stamp()` reads and hashes the full bytes of the file, and `FilesystemPrefix.stamp()` walks the folder and does the same for each file. With `{ stamp: "time" }`, they read only the modification time and the size. dapat calls `stamp()` only when the build has a store. Before a task runs, it always stamps the inputs. It stamps the outputs only when the store has a record for the task.

If `store.get()` or a `stamp()` method throws during this check, the task fails with that error. It does not run. The tasks that read its outputs fail too, as for any failed task.

### 6.1 Why did a task run or skip?

`Result` tells you which tasks ran and which skipped. It does not tell you the reason. To find the reason, do these steps:

1. Read the task's record with `await store.get(taskId)`. If it is `null`, the task has never succeeded with this store, so it runs.
2. Call `await ref.stamp()` on each input and output. Compare the values with `inputStamps` and `outputStamps` in the record. The key of an artifact is `artifact <id>`, and the key of a prefix is `prefix <id>`. A missing key, an extra key, a different stamp, a `null` output stamp, or a `null` prefix stamp makes the task run.
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

`SqliteStore` accepts an open `Database` from `bun:sqlite` or a file path. If you give a path, the store creates the folder of the path, opens the database, and `close()` closes it. If you give a `Database`, `close()` does nothing.

The store keeps one stamp for each declared input and output. The key is `artifact <id>` or `prefix <id>`, so a prefix and an artifact with the same id cannot share a stamp. An artifact stamp is a string, or `null` for a missing artifact. A prefix with a `null` stamp has no key, because the task runs anyway. The store does not keep the artifacts that a task reported with `ctx.produced()` or `ctx.deleted()`.

dapat treats a record from an older version as no record. The task runs, and dapat writes a record in the new shape. So the first build after an upgrade runs every task one time. Older versions keyed the stamps by the bare id, or wrote two stamps for each id.

Add the store file to `.gitignore`. To make tasks run again, see [section 12.1](#121-force-tasks-to-run-again).

## 8. Failure, cancellation, and replacement

### Failure

- A task that throws goes into `result.failed` with its error.
- A task that waits for a failed task also fails, with the error `dependency of '<its own id>' failed`.
- A task can read a source that does not exist. Then `read()` throws, and the task fails with that error, for example `ENOENT`.
- A dependency cycle does not stop the build. When no task runs, and each task that has not ended waits for a producer, no task can make progress. Then each waiting task looks at its producers one more time. If one of them failed, the task fails with `dependency of '<id>' failed`. Else it fails with `deadlock waiting for inputs of '<id>'`. The tasks look one after the other, so a task can look before a producer in the deadlock fails. That task gets the deadlock message.
- A task whose producer failed before the deadlock gets `dependency of '<id>' failed`, also when a cycle elsewhere in the build cannot make progress. For example, `C` reads the output of `P`, `P` reads the outputs of `F` and of `G`, `F` throws, and `G` and `H` read each other's output. Then `F` fails with its error, `P` and `C` fail with `dependency of '<id>' failed`, and `G` and `H` fail with `deadlock waiting for inputs of '<id>'`.

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

Each `add`, `remove`, and `setTasksOfGroups` step compares the old and the new outputs of each task id that it changes. One call puts all its `withdrawn` events on the queue before any `promised` event. Thus an output that moves from one task to another in one call is withdrawn before it is promised again. Each output is promised one time, even if a task declares it two times. For the order across calls, see [The event queue](#the-event-queue).

Delivery is synchronous. dapat calls each subscriber in the order that it subscribed, and it waits for each call to return. Thus, when `ctx.produced` returns, each task that a subscriber added is already in the build. A subscriber must not return a promise. If it returns one, dapat does not wait for it: the send fails with `subscriber returned a promise; subscribers must be synchronous`, and `build.run()` rejects with that error ([Subscriber errors](#subscriber-errors)). If the promise then rejects, dapat drops that rejection, because it keeps only the first error.

`subscribe` does not replay earlier events. Subscribe before the first `build.run()` to get all events. A subscriber that you add during a send gets the next event, not the current one.

A task that skips sends no `produced` or `deleted` events ([section 13](#13-limits)).

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

dapat keeps one queue of events for the build. A call that changes the state first changes the state, and then puts its events at the end of the queue. These calls are `add`, `remove`, a `setTasksOfGroups` step, `ctx.produced`, `ctx.deleted`, the end of a task, and the start of the first `build.run()`. If no drain is in progress, the call then drains the queue: it sends one event at a time to every subscriber, until the queue is empty. The call returns after the drain.

A subscriber that changes tasks during a send does not start a new drain. Its events go at the end of the queue. The task changes of `build.each` during a drain wait in an open step until the queue is empty. Then the build applies them as one change, and their events make one more pass over the queue ([`setTasksOfGroups`](#class-build)). The current event first reaches every subscriber, and then the new events follow. Thus every subscriber gets every event in the same order, and that order is the order of the state changes.

An event can be stale when it arrives. Then its correction always comes later in the queue. For example, task `t` declares `x`. Subscriber 1 replaces `t` with a task that declares `y` when it gets `promised x by t`. Both subscribers get these events, in this order:

```text
promised x by t     (subscriber 1 replaces t during this event)
withdrawn x by t
promised y by t
produced y by t
```

Subscriber 2 gets `promised x by t` after `t` stopped declaring `x`, and then `withdrawn x by t`. A subscriber that applies every event in order ends with the true state. Do not act on one event in a way that a later event cannot undo.

**The send limit.** A drain sends the queue in passes. The first pass sends the events of the call that started the drain. When `build.each` has task changes from a pass, the build applies them as one step at the end of the pass, and their events make the next pass ([`setTasksOfGroups`](#class-build)). A drain with no change of `build.each` has one pass. `sendLimit` (default 10,000, `SEND_LIMIT`) limits two things:

- **The events that subscribers cause in one pass.** The limit does not count the events that started the pass: the events of the call that started the drain, or the events of the step that the build applied before the pass. Thus a `setTasksOfGroups` step, a first `build.run()`, or a pipeline of several `build.each` calls with more than 10,000 outputs does not reach it.
- **The passes of one drain.** A `build.each` that feeds itself, for example a task that declares `turns/<n+1>.txt` for the match `turns/<n>.txt`, makes one pass for each round. At the limit, the drain stops with the error `send limit: 10000 passes in one drain, and more task changes wait; a build.each can feed itself`.

To change the limit, use `new Build({ sendLimit })`. The value must be a positive integer. You cannot turn the limit off.

The limit counts all events that subscribers cause in one pass, also correct ones. For example, a subscriber adds one task for each `promised` event. On a first `build.run()` with more than `sendLimit` outputs, the start of the run sends more than `sendLimit` `promised` events in one pass, and the subscriber causes one more `promised` event for each of them. That build reaches the limit. Set a higher `sendLimit` for such a build.

The limit stops a subscriber that undoes each change that it sees. For example, a subscriber removes a task on `promised` and adds it again on `withdrawn`. Then the queue never becomes empty. At the limit, the drain stops with this error:

```text
send limit: subscribers caused 10000 events in one pass of a drain, and more wait; the last sent was 'promised x by t'
```

dapat handles this error as a subscriber error: `build.run()` rejects with it.

## 10. `build.each`: tasks for each matched artifact

Often you want one task for each thing of one kind: one HTML page for each markdown file, or one summary for each chapter. You do not want to list these tasks by hand, because the list changes when the files change.

`build.each` makes these tasks for you. You give it two parts:

- one or more **matchers**, which find the things. A matcher sends one **matched artifact** for each thing it finds.
- a `tasks` function, which makes the tasks for one **joined set**: one matched artifact of each matcher.

`build.run()` asks each matcher to scan, and `build.each` turns each matched artifact into tasks. These tasks then run like the tasks that you add with `build.add`. They use the same scheduler, the same store, and the same skip rule ([section 6](#6-when-a-task-skips)).

Inside the build, a `TaskMaterializer` does this work. It acts like a materialized view of the matches: it listens to the `found` and `gone` events of its matchers, joins their matches on the var names that they share, and keeps one task list in the build for each joined set. A new joined set adds its tasks, a changed set replaces them, and a gone set removes them.

A matcher also gets each output that a task declares or writes. So a task can make new things while the build runs, and `build.each` makes their tasks in the same run.

For files, use `FileMatcher` from `dapat/contrib` for one match for each file ([`FileMatcher`](#filematcher-one-match-for-each-file)), or `FileGroupMatcher` for one match with a list of files ([`FileGroupMatcher`](#filegroupmatcher-one-match-with-a-list-of-files)). For other things, write a small subclass of `Matcher` ([Write your own matcher](#write-your-own-matcher)).

### Example: pages joined to a template

This program makes one HTML page for each file `content/<lang>/<slug>.md`. Each page uses the template of its language, `templates/<lang>.html`:

```ts
import { Build, Task } from "dapat"
import { FileArtifact, FileMatcher, JsonStore } from "dapat/contrib"

const build = new Build({ store: new JsonStore(".dapat/state.json") })

build.each({
  matchersByName: {
    page: new FileMatcher("content/<lang>/<slug>.md"),
    template: new FileMatcher("templates/<lang>.html"),
  },
  *tasks(vars, matched) {
    const page = matched.page.data // a FileArtifact
    const template = matched.template.data // the template with the same lang
    const html = new FileArtifact(`site/${vars.lang}/${vars.slug}.html`)
    yield new Task({
      id: `page:${vars.lang}/${vars.slug}`,
      inputs: [page, template],
      outputs: [html],
      run: async () => {
        const text = await Bun.file(page.path).text()
        const layout = await Bun.file(template.path).text()
        await Bun.write(html.path, layout.replace("{{body}}", text))
      },
    })
  },
})

const result = await build.run()
```

Each `FileMatcher` reads its var names from its pattern: `page` has `lang` and `slug`, and `template` has `lang`. The two matchers share the var name `lang`. So each page joins with the template of the same `lang`. With these files:

```
content/en/hello.md
content/en/about.md
content/fr/hello.md
content/de/hello.md
templates/en.html
templates/fr.html
```

`build.each` makes three joined sets:

| Joined set | `vars` | `matched.page` | `matched.template` | Task |
| --- | --- | --- | --- | --- |
| `build.each 1 lang=en slug=hello` | `{ lang: "en", slug: "hello" }` | `content/en/hello.md` | `templates/en.html` | `page:en/hello` |
| `build.each 1 lang=en slug=about` | `{ lang: "en", slug: "about" }` | `content/en/about.md` | `templates/en.html` | `page:en/about` |
| `build.each 1 lang=fr slug=hello` | `{ lang: "fr", slug: "hello" }` | `content/fr/hello.md` | `templates/fr.html` | `page:fr/hello` |

`content/de/hello.md` has no template with `lang` `de`, so it has no joined set and no task.

If the `template` matcher sends `gone` for `{ lang: "fr" }`, `build.each` removes `page:fr/hello`. If it then sends `found` for `{ lang: "fr" }` again, `page:fr/hello` comes back. If it sends `found` for `{ lang: "en" }` with a different artifact, `build.each` replaces the tasks of the two `en` sets. The `fr` task does not change.

### Joins on shared var names

`build.each` joins the matches of its matchers like a database join. These are the parts:

- A **shared var name** is a var name that two matchers both have. In the example, `lang`.
- A **joined set** has one matched artifact of each matcher. Each shared var name has the same value in all of them. Every matcher must have a match in the set, unless it is not in `required` ([`required`](#required-matchers-that-a-set-can-do-without)). A page with no template of its `lang` is in no set.
- `vars` of a joined set holds all the vars of all its matched artifacts. The order is the order of the names in `matchersByName`, and then the `varNames` order of each matcher. A var name comes one time, at its first place. A var of a matcher that is not required is not in `vars` when the set has no match of it ([`required`](#required-matchers-that-a-set-can-do-without)).
- `matched.<name>` is the matched artifact of the matcher `<name>`, with the data type of that matcher. It is `undefined` for a matcher that is not required and has no match in the set.
- Each joined set has one task group. Its label is `build.each <number> <var name>=<var value> ...`, in the order of `vars`.

With three matchers, each pair joins on the var names that the pair shares. For example, `page` has `lang` and `slug`, `template` has `lang`, and `review` has `lang` and `slug`. Then each page gets the template of its `lang` and the review of its `lang` and `slug`. A page with no review is in no set, unless `review` is not in `required`.

A matcher does not need to share a var name with every other matcher. It needs to share one with at least one other matcher, so that all the matchers form one connected group. `template` with `lang`, `page` with `lang` and `slug`, and `author` with `slug` form one group: `page` connects the other two.

If the matchers do not form one connected group, `build.each` throws. Without a shared var name, each match of one group would join with each match of the other group, and the number of tasks would be the product of the two. Example: `page` has only `slug`, and `template` has only `lang`:

```
build.each 1: the required matchers ['template'] share no var name with required matcher 'page' or its required partners; each required matcher must share a var name with another required matcher, and a matcher that is not required does not connect them
```

Only shared var names join. To join two matchers on some of their vars and not on others, give the others different names in the patterns. Example: each page gets a card with each banner of its `lang`:

```ts
build.each({
  matchersByName: {
    page: new FileMatcher("content/<lang>/<page>.md"),
    banner: new FileMatcher("banners/<lang>/<banner>.png"),
  },
  *tasks(vars) {
    const name = `${vars.lang}/${vars.page}/${vars.banner}`
    yield new Task({ id: `card:${name}`, outputs: [new FileArtifact(`cards/${name}.png`)], run: async () => {} })
  },
})
```

The pages `en/hello` and `en/install` and the banners `en/blue` and `en/red` make four sets, because only `lang` joins. If both patterns used `<name>`, `name` would join too, and a page would get only the banner with its own name. Put each var in the task id, or two sets give one task id and the build throws.

One matcher alone is always valid. Each of its matches is a joined set with one member. A required matcher with no var names shares no var, so it fails this check when the `build.each` has another required matcher.

`build.each` keeps **indexes** for each matcher. An index maps the values of some var names to the matches that have them. A matcher has one index for each set of var names that the join looks it up by. In the example, `page` has an index by `lang`. When one match changes, `build.each` looks up its partners in these indexes. It does not scan all the matches again. So the join costs one index lookup for each other matcher, and the work for each partner that it finds.

The build keeps an index of the outputs of all tasks, by id. A task that waits for its inputs finds its producers in this index. It does not check every task. A waiting task looks for its producers again only when each producer that it waits for has ended, or was replaced or removed. When one of these producers fails, the task fails at once. A change of tasks starts only its new tasks. So the scheduling cost of a task grows with the number of its producers, not with the number of all tasks. Two cases still cost more ([Limits](#13-limits)): a prefix class with its own `covers()` (or, for an input, its own `overlaps()`), and producers of one prefix input that come one at a time. `bun bench/scheduler.ts`, `bun bench/book.ts`, and `bun bench/join.ts` measure the cost.

A matcher event that comes while `build.each` handles another one waits. It comes from `tasks`, or from a subscriber of the events of the change. `build.each` handles the waiting events in order, after the current one. Each `build.each` call thus sees each event alone. The tasks still exist before the outermost `send` of the matcher returns.

### Steps of task changes

`build.each` does not change the tasks of the build at once. It gives its changes to an open step ([`setTasksOfGroups`](#class-build)), and the build applies the step later, as one change:

- During the scans of the first `build.run()`, all the changes until the last scan returns are one step.
- After that, all the changes of one pass over the event queue are one step. The events that the step makes, for example the `promised` events of its new tasks, then make the next pass and the next step. So when the outputs of one `build.each` feed another `build.each`, the second one gets all of them before its changes are applied.
- A matcher event that your code sends outside a drain, for example from a file watcher, is one step.

So a task id can move from one set to another set in one step. For example, take the review example in [`required`](#required-matchers-that-a-set-can-do-without), but with a task id that does not hold `vars.reviewer`, such as `page:${vars.lang}/${vars.slug}`. Then the task `page:en/hello` of the set with no review moves to the set `reviewer=ann` when the review is found. The build treats this as a replacement: the task keeps its store record, and the next build can skip it. Two sets can also swap their task ids in one step. The rule that two sets cannot give one task id applies after the step. Thus the order in which the scans find the pages and the reviews does not change the result of the first run: a set that exists only for a while during the scans never gets its tasks. Matches that come in separate steps after the scans can still pass through such a set ([Limits](#13-limits)).

### `required`: matchers that a set can do without

By default, a joined set needs a match of each matcher. Sometimes a task can use a thing when it exists, and work without it when it does not. For example, a page uses its reviews when they exist. Put the names of the matchers that each set must have in `required`:

```ts
build.each({
  matchersByName: {
    page: new FileMatcher("content/<lang>/<slug>.md"),
    review: new FileMatcher("reviews/<lang>/<slug>/<reviewer>.json"),
  },
  required: ["page"],
  *tasks(vars, matched) {
    const name = `${vars.lang}/${vars.slug}.${vars.reviewer ?? "nobody"}`
    const inputs: Ref[] = [matched.page.data]
    if (matched.review !== undefined) {
      inputs.push(matched.review.data)
    }
    yield new Task({ id: `page:${name}`, inputs, outputs: [new FileArtifact(`site/${name}.html`)], run: async () => {} })
  },
})
```

`page` has the `varNames` `lang` and `slug`. `review` has the `varNames` `lang`, `slug`, and `reviewer`. `review` is not required. It joins each page like a LEFT JOIN in SQL:

- A page with reviews has one joined set for each of its reviews.
- A page with no review has one joined set. In it, `matched.review` is `undefined`, and `vars.reviewer` is `undefined`.

With these files:

```
content/en/about.md
content/en/hello.md
reviews/en/about/ann.json
reviews/en/about/bob.json
```

`build.each` makes three joined sets:

| Joined set | `vars` | `matched.page` | `matched.review` |
| --- | --- | --- | --- |
| `build.each 1 lang=en slug=about reviewer=ann` | `{ lang: "en", slug: "about", reviewer: "ann" }` | `content/en/about.md` | `reviews/en/about/ann.json` |
| `build.each 1 lang=en slug=about reviewer=bob` | `{ lang: "en", slug: "about", reviewer: "bob" }` | `content/en/about.md` | `reviews/en/about/bob.json` |
| `build.each 1 lang=en slug=hello` | `{ lang: "en", slug: "hello" }` | `content/en/hello.md` | `undefined` |

Each set has its own task group, and the label has each var that has a value. Two sets cannot give one task id, so put `vars.reviewer` in the task id, as the example does.

Without `required`, `hello` has no review, so it has no set and no task.

The sets change when the reviews change. Start with `content/en/hello.md` and no review:

1. The set `lang=en slug=hello` has `matched.review === undefined`.
2. The `review` matcher sends `found` for `{ lang: "en", slug: "hello", reviewer: "ann" }`. `build.each` removes the set with no review, and its tasks. Then it adds the set `reviewer=ann`.
3. The `review` matcher sends `found` for `reviewer: "bob"`. `build.each` adds the set `reviewer=bob`. The set `reviewer=ann` does not change.
4. The `review` matcher sends `gone` for `reviewer: "bob"`. `build.each` removes the set `reviewer=bob`.
5. The `review` matcher sends `gone` for `reviewer: "ann"`. `build.each` removes the set `reviewer=ann`, and adds the set with no review again.

A review of a page that does not exist makes no set. It waits, and joins the page when the page is found.

A matcher that is not required and has only var names that the required matchers have is simpler. Each set has one match of it, or none. Its found and gone keep the set, and replace its tasks in the same task group. For example, a `branch` matcher with only `lang` gives each page the branch of its `lang`, or `undefined`. A matcher with no var names is in every set.

On the first run, `tasks` can run more than one time for one set, for example when the scan finds the page before its review. Each set ends with one task list, and no task starts before the scans finish.

`build.each` gives its task changes to the build in steps ([Steps of task changes](#steps-of-task-changes)). If a task id does not hold `vars.reviewer`, for example `page:${vars.lang}/${vars.slug}`, the task can move from the set with no review to the set `reviewer=ann` in one step, and keep its store record.

#### Several matchers that are not required: the order of the names

The matchers that are not required join one after the other, in the order of their names in `matchersByName`, as SQL does with several LEFT JOINs.

The **ON vars** of a matcher that is not required are its var names that a required matcher or an earlier matcher that is not required has. `build.each` finds them one time, when you call it. A match joins a set only when the set has a value for each ON var, and the values are equal. Each match that joins makes one set, and adds its other vars to it. If no match joins, the matcher is `undefined` in the set, and it adds no var.

A set that has no value for an ON var joins no match, as NULL equals nothing in SQL. Example: `page` has `slug` and is required. `comment` has `slug` and `author`. `info` has `author`. Both are not required, in the order `{ page, comment, info }`. The ON vars of `info` are `author`, from `comment`. There is one info, for ann. If two earlier matchers both have an ON var, a set has only one value for it, because the later matcher joined on it.

| Page | Its comments | Its joined sets |
| --- | --- | --- |
| `a` | one, by ann | one set: `author=ann`, `matched.info` is the info of ann |
| `b` | none | one set: `author` is `undefined`, and `matched.info` is `undefined`. No info joins, because the set has no author. |

When two of them have different var names of their own, the sets are each pair of their matches. A page with 2 reviews (`reviewer`) and 2 comments (`commenter`) has 4 sets. A page with 2 reviews and no comment has 2 sets, with `matched.comment === undefined`.

When two of them share a var name that no required matcher has, the order of the names changes the sets. Example: `review` and `rating` both have `lang`, `slug`, and `reviewer`, and both are not required. The ON vars of the second one include `reviewer`.

| Page | Its reviews and ratings | `{ page, review, rating }` | `{ page, rating, review }` |
| --- | --- | --- | --- |
| `en/about` | a review by ann, a rating by bob | one set: `reviewer=ann`, `matched.review` is the review of ann, `matched.rating` is `undefined` | one set: `reviewer=bob`, `matched.rating` is the rating of bob, `matched.review` is `undefined` |
| `en/hello` | a rating by bob, no review | one set: `reviewer` is `undefined`, both are `undefined`. The rating does not join, because the set has no reviewer. | one set: `reviewer=bob`, `matched.rating` is the rating of bob, `matched.review` is `undefined` |

In the first order, `review` joins first. It sets `reviewer` to `ann` for `en/about`, and the rating of bob does not agree. For `en/hello`, it sets no `reviewer`, so no rating joins. In the second order, `rating` joins first and sets `reviewer` to `bob`. **So if you change the order of the names, the tasks can change.** Put the matcher that sets the var first.

A matcher that is not required and has no ON vars joins each set with each of its matches, as `LEFT JOIN ... ON TRUE` does in SQL. For example, a `tag` matcher with only `tag`, after `page` with `slug`: 2 pages and 2 tags make 4 sets. With no tag, each page has one set with `matched.tag === undefined`. This is valid, but each found and gone of a tag changes the sets of every page.

#### The rules

- **If you leave `required` out, every matcher is required.** This is the behavior of a `build.each` with no `required`.
- **The required matchers must form one connected group by shared var names.** A matcher that is not required does not connect them.
- **`required` must name at least one matcher, and each name must be a name in `matchersByName`.** A set needs a required match, so `required: []` is an error.

#### Types

The `vars` argument of `tasks` has the type `JoinedVars<M, R>`:

- If every matcher is required, for example when you leave `required` out, it is `Vars`. Each var is a `string`.
- Else it is `Readonly<Record<string, string | undefined>>`. A var of a matcher that is not required is `undefined` in a set with no match of it. TypeScript does not know the var names, so **when you give `required`, a var of a required matcher also needs a check or `!`**, for example `vars.lang!`. In a template string, as in `` `page:${vars.slug}` ``, you need no check.

TypeScript knows which matched artifacts can be `undefined`, when `required` is one literal list. `matched.page` is a `MatchedArtifact`. `matched.review` is a `MatchedArtifact` or `undefined`, so you must check it before you read `matched.review.data`. If `required` has a wider type, for example `cond ? ["page", "review"] : ["page"]` or a variable of type `("page" | "review")[]`, TypeScript treats every name in that type as required. Then check `matched` and `vars` for `undefined` yourself. TypeScript does not check an empty list. `build.each` checks it when you call it.

#### Cost

`build.each` keeps an index of the required joins for each matcher that is not required, by the var names that it shares with the required matchers. A found or gone of such a match looks up its required joins in that index. For each one, it runs the left joins again over the matches of that join only, and changes only the sets that are different. A matcher that is not required and shares no var name with the required matchers, for example `info` or `tag` above, is in the index entry of every required join. So each of its found and gone events runs the left joins of every required join again.

### Example with one matcher

This program makes one HTML page for each file `posts/<slug>.md`:

```ts
import { Build, Task } from "dapat"
import { FileArtifact, FileMatcher, JsonStore } from "dapat/contrib"

const build = new Build({ store: new JsonStore(".dapat/state.json") })

build.each({
  matchersByName: { post: new FileMatcher("posts/<slug>.md") },
  *tasks(vars, matched) {
    const post = matched.post.data // a FileArtifact, the data type of FileMatcher
    const html = new FileArtifact(`site/${vars.slug}.html`)
    yield new Task({
      id: `page:${vars.slug}`,
      inputs: [post],
      outputs: [html],
      run: async () => {
        const text = await Bun.file(post.path).text()
        await Bun.write(html.path, `<pre>${text}</pre>`)
      },
    })
  },
})

const result = await build.run()
```

With `posts/hello.md` and `posts/bye.md`, the first run does these steps:

1. The scan of the matcher reads the folder `posts` and sends `found` for `{ slug: "hello" }` and `{ slug: "bye" }`.
2. For each matched artifact, `build.each` calls `tasks`.
3. The scan returns. The build adds `page:hello` and `page:bye` in one step, and starts both tasks.

The next time the program runs with no change, both tasks skip. If you add a task with `build.add` that declares the output `posts/news.md`, the matcher gets its `promised` event and sends `found` for `{ slug: "news" }`. `build.each` adds `page:news`, and `page:news` waits for the task that writes the post.

### `FileMatcher`: one match for each file

`FileMatcher` is in `dapat/contrib`. It finds the files that fit a pattern, and sends one matched artifact for each file. The data of each match is a `FileArtifact`, so `FileMatcher` is a `Matcher<FileArtifact>`.

```ts
import { FileMatcher } from "dapat/contrib"

const pages = new FileMatcher("content/<lang>/<section>/<slug>.md")
const templates = new FileMatcher("templates/<lang>.html")
```

[examples/file-pipeline.ts](examples/file-pipeline.ts) is a program that you can run. It joins pages to templates, writes HTML, and makes one sitemap for each lang. Run it two times: the second run skips each task.

#### The pattern

- The parts of a pattern are separated by `/`. `<name>` is a var. A var matches one or more characters, but not `/`. Thus a var never crosses a folder.
- The matcher reads its `varNames` from the pattern, in order. `templates/<lang>.html` has the var names `["lang"]`. For the file `templates/en.html`, the match is `{ vars: { lang: "en" }, data: <FileArtifact of templates/en.html> }`. `content/<lang>/<section>/<slug>.md` has the var names `["lang", "section", "slug"]`.
- One part can hold text and vars together, for example `<slug>.md` or `v<major>.<minor>.json`. When a name has more than one split, the first var takes as much text as it can. `v1.2.3.json` gives `major` `"1.2"` and `minor` `"3"`.
- Two vars must have text between them. `<a><b>.md` throws, because a name such as `xy.md` has more than one split.
- A var name has letters, digits, and `_`, and does not start with a digit. Each `<` and `>` must enclose a var name. `<lang-x>`, `<1>`, and a `<` or `>` in a file name throw.
- A `..` part throws, also a `..` that would remove a var, as in `a/<x>/../b.md`. For a folder above the working directory, give an absolute pattern, for example `path.resolve("../shared/<slug>.md")`.
- A var also matches a name that starts with `.`. `content/<slug>.md` finds `content/._a.md` with `slug` `"._a"`.
- A var can come two times. `docs/<lang>/<lang>.md` matches `docs/en/en.md`, and it does not match `docs/en/fr.md`.
- A pattern with no var names one file. Its `varNames` is `[]`, and it has one match or none.
- A `FileMatcher` pattern cannot have `*` or `**`. The constructor throws, and the message names `FileGroupMatcher`. Use one var for each part that changes, or use `FileGroupMatcher` for one match with a list of files ([`FileGroupMatcher`](#filegroupmatcher-one-match-with-a-list-of-files)).
- An empty pattern throws.
- A var never takes the value `..`. A file outside the root of the pattern never fits.

The `<`, `>`, `*`, and `**` markers have their meaning in the whole pattern, also in the root folder. When a folder or file name holds one of them, use the `syntax` option to set other markers: `varStart` and `varEnd` for a var, `anyName` for `*`, and `anyFolders` for `**`. Each marker that you leave out keeps its default. A default marker that the syntax replaces is a literal character. The constructor throws for an empty marker, a marker with `/`, an `anyName` or `anyFolders` that is `.` or `..`, two equal markers, and a marker that holds another marker. Only `anyFolders` can hold `anyName`, as `**` holds `*`.

```ts
new FileMatcher("/data/a<b>/{lang}/{slug}.md", { syntax: { varStart: "{", varEnd: "}" } })
```

#### Paths

A relative pattern resolves against the current working directory when you create the matcher, as the path of a `FileArtifact` does. An absolute pattern stays as it is. The matcher removes each `./` from the pattern. `matcher.root` is the folder that the pattern is relative to, and `matcher.pattern` is the pattern after this change.

Each `FileArtifact` that the matcher sends has an absolute path. The `stamp` option goes to each of these `FileArtifact` objects.

#### The scan

The scan reads only the folders that the pattern names. For a part with no var, for example `content`, it adds the name to the path and reads nothing. For a part with a var, it reads the folder and keeps only the names that fit that part. It goes down to the depth of the pattern, and sends `found` for each file that fits, in name order. It stats only symlinks, and entries whose type the filesystem does not report. A link loop adds no file. On a filesystem that ignores case, such as the macOS default, a part with no var also finds a folder whose name differs only in case.

- A missing folder has no files. This is not an error, because a task can make the folder later.
- The scan follows symlinks. A link to a file counts as that file. A broken link adds nothing.
- Every other error, for example a permission error, makes `build.run()` reject.

#### Events during the run

A file has a match while one of these is true:

- The file is on disk, as far as the matcher knows. The matcher knows this when the scan found the file, or a task produced it, and no task deleted it after that.
- A task in the build declares the file as an output.

`receiveArtifactEvent` must do no I/O, so the matcher does not look at the disk during the run. It uses only the scan and the events of the build. It hears only events of a `FileArtifact` whose path fits the pattern.

| Build event | `FileMatcher` does |
| --- | --- |
| `promised`: a task declares the file | sends `found`, if it has not sent it |
| `produced`: a task wrote the file | sends `found`, if it has not sent it |
| `deleted`: a task deleted the file | sends `gone`, unless a task still declares the file |
| `withdrawn`: the task that declared the file leaves the build | sends `gone`, unless the file is on disk |

The matcher sends `found` one time for each file. It sends `gone` only for a file that it sent `found` for. After `gone`, a new `promised` or `produced` sends `found` again. The matcher keeps a record only for a file that has a match now.

An output can move from one task to another task in one step, for example when a `build.each` set changes the id of its task. The build sends the `withdrawn` event before the `promised` event, so the matcher sends `gone` and then `found`. `build.each` applies both in the same step. Thus the task of the match stays in the build: the build replaces it, and it keeps its store record.

A `promised` event of a `FilesystemPrefix` gives no file name, so it makes no match. A task that writes files into a prefix output must call `ctx.produced` for each file ([Matches during the run](#matches-during-the-run)).

#### Between runs

dapat does not delete old outputs. When you delete a source file, the next scan does not find it, so its task is not in the build. But the outputs of that task from the last run stay on disk. A `FileMatcher` whose pattern fits those outputs finds them in its scan. For example, a task makes `upper/<slug>.txt` from `content/<slug>.md`, and a second `build.each` uses `new FileMatcher("upper/<slug>.txt")`. When you delete `content/b.md`, the task `upper:b` goes away, but `upper/b.txt` stays, and the task of the second `build.each` for `b` stays too. Delete the old outputs yourself when this is a problem. dapat cannot do it for you, because it is not the only owner of the files in a folder: other tools and people can put files next to the outputs.

### `FileGroupMatcher`: one match with a list of files

`FileGroupMatcher` is in `dapat/contrib`. Its pattern has a `*` or a `**`. It sends one matched artifact for each value of its vars, and the data of the match is the list of the files that fit, sorted by path. So `FileGroupMatcher` is a `Matcher<readonly FileArtifact[]>`.

```ts
import { FileGroupMatcher } from "dapat/contrib"

const pages = new FileGroupMatcher("site/<lang>/**/*.html")
```

With the files `site/en/index.html`, `site/en/blog/hello.html`, and `site/fr/index.html`, the scan sends two matches:

```text
{ vars: { lang: "en" }, data: [<site/en/blog/hello.html>, <site/en/index.html>] }
{ vars: { lang: "fr" }, data: [<site/fr/index.html>] }
```

#### The group pattern

- The rules of the [`FileMatcher` pattern](#the-pattern) apply, and the pattern must have a `*` or a `**`. A pattern with no glob throws: use `FileMatcher`.
- `*` matches any text in one part, but not `/`. Thus `*` never crosses a folder. In a part such as `*.html`, it matches the text before `.html`. It also matches a name that starts with `.`.
- `**` matches zero or more folders. It must be a whole part, as in `site/**/*.html`. `site/**/*.html` finds `site/a.html` and `site/x/y/b.html`.
- The last part must name files. A pattern that ends with `**` throws. Use `**/*` for every file under a folder.
- A var must be in a part before the first part with a `*` or `**`. `site/<lang>/**/*.html` is correct. `site/**/<slug>.html` and `site/<lang>-*/index.html` throw. The names that a glob matches are not vars. To use them, read them from the path of each file, for example with `path.relative`.
- `varNames` holds only the vars before the first glob. A pattern with no var, for example `notes/*.md`, has `varNames` `[]` and one match or none.

#### The group scan

For the parts before a `**`, the scan works as the scan of `FileMatcher`: it joins a part with no var and no `*` to the path with no read, and reads a folder only for a part with a var or a `*`. At a `**`, it takes every file under the folder, at any depth, as `FilesystemPrefix.list()` does. It follows symlinks, and it does not walk a link back to a folder above it again. Then it keeps the files that fit the whole pattern.

The scan sends one `found` for each group after it has read all the files, not one `found` for each file. The groups come in the order of their first file.

#### Group events during the run

A file is in the list of its group while the file has a match by the rules of `FileMatcher` ([Events during the run](#events-during-the-run)): the file is on disk, as far as the matcher knows, or a task declares it as an output. When a file gets or loses its match, the matcher sends the new list of its group:

| Change of the list | `FileGroupMatcher` sends |
| --- | --- |
| The first file of a group | `found` with a list of one file. `build.each` adds the tasks of the group. |
| A file is added to the list or removed from it | `found` with the new list. `build.each` replaces the tasks of the group in the same task group ([Matched artifact events](#matched-artifact-events-found-and-gone)). |
| The last file leaves the list | `gone`. `build.each` removes the tasks of the group. |

An event that does not change a list sends nothing. For example, the `produced` event of a file that a task declared sends nothing.

Each `ctx.produced` call is one step ([Steps of task changes](#steps-of-task-changes)). So a task that reports 1,000 files one at a time makes 1,000 lists, and the build replaces the task of the group 1,000 times. Give the task of the group the writer's `FilesystemPrefix` as an input too. Then each replaced task waits for the writer and does not run, so only the last task runs. A task that declares its files as outputs puts them all in one step, so the group gets one list. See [Limits](#13-limits) for the cost.

#### Example: one sitemap for each lang

```ts
import path from "node:path"
import { Task } from "dapat"
import { FileArtifact, FileGroupMatcher } from "dapat/contrib"

build.each({
  matchersByName: { source: new FileGroupMatcher("content/<lang>/*.md") },
  *tasks(vars, matched) {
    const sources = matched.source.data // readonly FileArtifact[], sorted by path
    const sitemap = new FileArtifact(`sitemaps/${vars.lang}.txt`)
    yield new Task({
      id: `sitemap:${vars.lang}`,
      inputs: sources,
      outputs: [sitemap],
      run: async () => {
        const lines: string[] = []
        for (const source of sources) {
          const slug = path.basename(source.path, ".md")
          lines.push(`${slug}.html`) // for example hello.html
        }
        await Bun.write(sitemap.path, `${lines.join("\n")}\n`)
      },
    })
  },
})
```

- The group reads the sources in `content/<lang>/`, not the HTML in `site/<lang>/`. dapat does not delete old outputs, so when you delete `content/en/about.md`, `site/en/about.html` stays on disk. A group of `site/<lang>/**/*.html` would still list it, and the sitemap would keep the deleted page ([Between runs](#between-runs)).
- The sitemap runs again when a source is added, edited, or deleted. A new list makes a new task with new inputs. An edit changes the stamp of a source.
- When you delete the last source of a lang, the list is empty. The matcher sends `gone`, and the sitemap task of that lang is not in the build. `sitemaps/<lang>.txt` stays on disk with the old pages. Delete it yourself when this is a problem. dapat cannot do it for you, because it is not the only owner of the files in a folder ([Between runs](#between-runs)).

[examples/file-pipeline.ts](examples/file-pipeline.ts) has this rule after the rule of the pages. Run it two times: the second run skips each task.

#### Groups in your own matcher

A matcher that does not read files can also send groups. It groups the things in its own code: its vars hold only the names of the group, and its data is a list of artifacts. It sends `found` with the new list each time the list changes, and `gone` when the list is empty.

### Matchers

A matcher is a subclass of `Matcher<D>`. `D` is the data of each matched artifact, for example `FileArtifact`, or `readonly FileArtifact[]` for a list. It has three members:

```ts
abstract class Matcher<D extends MatchedData = MatchedData> extends Emitter<MatchedArtifactEvent<D>> {
  abstract readonly varNames: readonly string[]
  abstract scan(signal: AbortSignal): Promise<void>
  receiveArtifactEvent(event: ArtifactEvent): void {}
}
```

- `varNames` are the names of the vars of each matched artifact. In the example, `["slug"]`.
- `scan` looks at the world now, and sends `found` for each thing that it finds. Disk reads and network calls go here. `signal` aborts when another scan fails, or when the build fails.
- `receiveArtifactEvent` gets each event of the build ([section 9](#9-subscribe-to-artifact-events)). It can send `found` for an output that a task declares or writes. It must be fast and do no I/O. The default does nothing, so the matches never change during a run.

A matcher sends events with `this.send(event)`. It knows nothing about the code that listens to it. One matcher can feed several `build.each` calls of one build. It still gets each build event one time. One `build.each` cannot use one matcher object under two names. A matcher belongs to the first build that uses it: give each `Build` its own matchers.

A matcher may send `found` again for the same thing. `build.each` ignores a `found` whose data has the same artifact ids, in the same order, as the current match. So a matcher can send `found` for the `promised` event and again for the `produced` event of one file. The task is made one time, and a task that rewrites its own input in place does not run again. One artifact and a list of one artifact are different data, so a change from one to the other replaces the tasks.

A change to the content of an artifact is the job of its stamp, not of the match: the next build runs the task again because the stamp changed. To force the tasks of a match to be made again, a matcher sends `gone` and then `found`.

A task that has finished does not run again in the same run when a task it waits for is replaced and writes its output again. The next build runs it again, because the stamp of its input changed. Plain tasks work the same way.

### Write your own matcher

Write a subclass of `Matcher` for things that `FileMatcher` cannot find, for example S3 objects or the rows of a table. This matcher finds the S3 objects `reports/<day>.json` in one bucket:

```ts
import { Matcher, type ArtifactEvent } from "dapat"
import { S3ObjectArtifact, type S3Client } from "dapat/contrib"

// Finds reports/<day>.json in one bucket.
class DailyReports extends Matcher<S3ObjectArtifact> {
  readonly varNames = ["day"]

  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {
    super()
  }

  async scan(): Promise<void> {
    const entries = await this.client.list(this.bucket, "reports/")
    for (const entry of entries) {
      this.foundKey(entry.key)
    }
  }

  // A task that declares or writes a report is also found, during the run.
  override receiveArtifactEvent(event: ArtifactEvent): void {
    if (event.kind === "promised" && event.output instanceof S3ObjectArtifact) {
      if (event.output.bucket === this.bucket) this.foundKey(event.output.key)
    }
    if (event.kind === "produced" && event.artifact instanceof S3ObjectArtifact) {
      if (event.artifact.bucket === this.bucket) this.foundKey(event.artifact.key)
    }
  }

  private foundKey(key: string): void {
    const match = /^reports\/([^/]+)\.json$/.exec(key)
    if (match === null) return
    const day = match[1]!
    const report = new S3ObjectArtifact(this.client, this.bucket, key)
    this.send({ kind: "found", matched: { vars: { day }, data: report } })
  }
}
```

This matcher sends `found` again for the `produced` event of a report that it found before. That does no harm: `build.each` ignores a `found` with the same artifact ids. It sends no `gone`. Thus a report that a task deletes, or that no task declares now, keeps its match until the next build. `FileMatcher` sends `gone` for these cases ([Events during the run](#events-during-the-run)).

### Matched artifacts

A matched artifact is one thing that a matcher found:

```ts
type Vars = Readonly<Record<string, string>>

type MatchedData = Artifact | readonly Artifact[]

type MatchedArtifact<D extends MatchedData = MatchedData> = {
  vars: Vars
  data: D
}
```

`vars` holds the values that name the thing, one for each name in `varNames`. `data` is the artifact that the task reads, or a list of artifacts. Its type comes from the matcher. In the example, `FileMatcher` is a `Matcher<FileArtifact>`, so `matched.post.data` is a `FileArtifact`, and it can go straight into `inputs`.

The vars of a matched artifact are also its key. Two matched artifacts with the same vars are the same match.

### Matched artifact events: `found` and `gone`

A matcher sends a `MatchedArtifactEvent`:

```ts
type MatchedArtifactEvent =
  | { kind: "found"; matched: MatchedArtifact }  // a new match, or a new version of the match with these vars
  | { kind: "gone"; vars: Vars }                 // the match with these vars is gone
```

| The matcher sends | `build.each` does |
| --- | --- |
| `found` with new vars | joins the match with the matches of the other matchers, and adds the tasks of each new joined set |
| `found` with known vars and new data | replaces the tasks of each joined set that holds the match ([section 8](#replacement)). The sets stay the same, because the vars stay the same. |
| `found` with known vars and the same artifact ids | nothing |
| `found` that changes one artifact to a list of one artifact, or back | replaces the tasks |
| `gone` | removes the tasks of each joined set that holds the match ([section 8](#removal)) |

For example, a matcher sends `found { slug: "a" }`, then `found { slug: "a" }` with a new file, then `gone { slug: "a" }`. `build.each` adds the tasks of `a`, replaces them, and then removes them. A `gone` with the right var names for a match that `build.each` does not know does nothing. A `gone` with wrong var names is a bug in the matcher, so `build.run()` rejects.

### The `build.each` config

```ts
build.each({
  matchersByName: { post: new FileMatcher("posts/<slug>.md") },
  *tasks(vars, matched) { ... },
})
```

- `matchersByName` names the matchers. The names are yours. `tasks` gets each matched artifact under the name of its matcher, as `matched.post`. With two or more matchers, they join on their shared var names ([Joins on shared var names](#joins-on-shared-var-names)).
- `required` (optional) names the matchers that each joined set must have a match of. If you leave it out, every matcher is required ([`required`](#required-matchers-that-a-set-can-do-without)).
- `tasks` gets the vars and the matched artifacts by name of one joined set. It returns the tasks for that set. Write it as a generator (`*tasks`), so it can yield no task, one task, or many tasks.

`tasks` can yield more than one task for a match:

```ts
*tasks(vars, matched) {
  const post = matched.post.data
  yield new Task({ id: `page:${vars.slug}`, inputs: [post], outputs: [new FileArtifact(`site/${vars.slug}.html`)], run: async () => {} })
  yield new Task({ id: `words:${vars.slug}`, inputs: [post], outputs: [new FileArtifact(`site/${vars.slug}.words`)], run: async () => {} })
}
```

Each joined set has one task group ([Task groups](#task-groups)). With one matcher, each match is a joined set. The label of the group is `build.each <number> <var name>=<var value> ...`, for example `build.each 1 slug=hello`. dapat counts the `build.each` calls from 1, in order. The vars are in the order of `vars` ([Joins on shared var names](#joins-on-shared-var-names)). A task id must be unique in the build. If two joined sets give one task id, or a match gives the id of a task that you added with `build.add`, `build.run()` rejects ([Errors in `build.each`](#errors-in-buildeach)). So put the vars in the task id, as `page:${vars.slug}` does.

Call `build.each` before the first `build.run()`. After that, it throws.

### Scans finish before tasks start

The first `build.run()` does these steps:

1. It sends a `promised` event for each output of each task that you added with `build.add`. Matchers get them, so `build.each` can make tasks for them.
2. It starts the scan of each matcher, all at the same time, and waits until every scan has returned.
3. It gives the build all the task changes of `build.each` since step 1, as one step ([`setTasksOfGroups`](#class-build)). A clash of two task ids is an error only if it is still there at this point. The build sends the `promised` events of the step, so the matchers get them now. The task changes that these events cause are one step for each pass over the event queue, until no change is left.
4. It starts the tasks.

No task starts during a scan. A scan that is still running could find a thing whose task writes the input of another task. A scan that never returns thus also makes no task of `build.each` exist.

A later `build.run()` on the same build does not scan again. A `build.run()` that you call while the scans of the first one still run waits for the same scans, and then starts the tasks.

### Matches during the run

When a task calls `ctx.produced(artifact)`, the build sends the `produced` event to each matcher. A matcher can send `found`, and `build.each` adds its tasks. All of this happens before `ctx.produced` returns.

This task splits a book into chapters. `build.each` makes one summary task for each chapter, while `split` runs:

```ts
build.add(
  new Task({
    id: "split",
    outputs: [new FilesystemPrefix("chapters")],
    run: async (ctx) => {
      for (let n = 0; n < 3; n++) {
        const chapter = new FileArtifact(`chapters/${n}.md`)
        await Bun.write(chapter.path, `chapter ${n}`)
        ctx.produced(chapter) // build.each adds summary:<n> before this returns
      }
    },
  }),
)

build.each({
  matchersByName: { chapter: new FileMatcher("chapters/<n>.md") },
  *tasks(vars, matched) {
    yield new Task({ id: `summary:${vars.n}`, inputs: [matched.chapter.data], run: async () => {} })
  },
})
```

When `split` returns, `summary:0`, `summary:1`, and `summary:2` exist. They run in the same `build.run()`. On the next build, the scan finds the chapters of the last run. Each summary task then waits for `split`, because the output `chapters` of `split` covers its input.

[examples/book-chapters.ts](examples/book-chapters.ts) is a program that you can run. It splits each `books/<book>.md` into `chapters/<book>/<n>.md`, and makes `summaries/<book>/<n>.txt` from each chapter. It prints a line when each summary task appears, between the lines of its split task. Run it two times: the second run skips each task.

### Errors in `build.each`

The `tasks` function and a matcher are part of your program, like a subscriber. A mistake in them makes `build.run()` reject ([Subscriber errors](#subscriber-errors)).

An error in `build.each` is fatal for the build, as a subscriber error is. The `send` of the matcher does not throw it, so a matcher that catches errors cannot hide it. An error outside `build.run()`, for example from the `promised` event of a `build.add` after the run, makes the next `build.run()` reject. After a fatal error, the build ignores matcher events, so it does not call `tasks` again.

| Where | Example | What you see |
| --- | --- | --- |
| `build.each` | `matchersByName` has no matcher | `build.each` throws |
| `build.each` | the required matchers do not form one connected group by shared var names | `build.each` throws, and names the matchers that do not connect |
| `build.each` | `required` is `[]` | `build.each` throws |
| `build.each` | `required` has a name that is not in `matchersByName` | `build.each` throws, and names it |
| `build.each` | one matcher object is under two names | `build.each` throws |
| `build.each` | you call it after `build.run()` | `build.each` throws |
| `build.each` | one of its matchers is used by another `Build` | `build.each` throws, and names the matcher |
| `new FileMatcher` | the `syntax` option is invalid, or the pattern has `*`, `**`, a `..` part, a `<` or `>` that does not enclose a valid var name, two vars with nothing between them, or no text | the constructor throws |
| `new FileGroupMatcher` | the pattern has no `*` or `**`, a var in or after the first part with a glob, a `**` at the end or inside a name, or one of the errors of `FileMatcher` other than the glob | the constructor throws |
| a scan | it throws, for example your own matcher reads a folder that does not exist | `build.run()` rejects at once, and no task runs. The other scans get an aborted `signal`. `build.run()` does not wait for them. |
| a matched artifact or a `gone` | its vars are not the `varNames` of its matcher | `build.run()` rejects |
| `tasks` | two matches give one task id | `build.run()` rejects with `task 'x' is in two groups: 'build.each 1 slug=a' and 'build.each 1 slug=b'` |
| `tasks` | it throws | `build.run()` rejects with that error |

Two limits remain:

- **A scan that never returns makes `build.run()` wait forever.** `build.run()` takes no signal, and the scan signal aborts only when the build fails.
- **A `build.each` that feeds itself while its tasks run is not bounded yet.** For example, a task reads `turns/<n>.txt` and writes `turns/<n+1>.txt`, and a matcher finds the file when the task calls `ctx.produced`. Each produced file makes a new task, and the run does not end. A task limit comes in a later version. A task that declares `turns/<n+1>.txt` as an output feeds the rule in one drain, and the limit of passes stops it ([The event queue](#the-event-queue)).

## 11. Built-in artifacts

The [API reference](#api-reference) gives the full details of each class.

### 11.1 Files: `FileArtifact`, `FilesystemPrefix`

A relative path resolves against the current working directory when you create the object.

To make tasks for each file that fits a pattern, use `FileMatcher` ([`FileMatcher`](#filematcher-one-match-for-each-file)). To make tasks for each list of files, use `FileGroupMatcher` ([`FileGroupMatcher`](#filegroupmatcher-one-match-with-a-list-of-files)).

| Class | Stamp | Value |
| --- | --- | --- |
| `new FileArtifact(path, { stamp })` | the SHA-256 of the bytes, or the modification time and size. `null` if the file is missing. | `read()` returns a `Uint8Array` |
| `new FilesystemPrefix(path, { stamp })` | SHA-256 of each relative path and the stamp of that file. A missing folder has the stamp of an empty list. | `list()` returns the absolute paths of all files, in all subfolders |

#### Time or hash

Both classes take the option `stamp: "hash" | "time"`. The default is `"hash"`.

- `"hash"`: the stamp of a file is the SHA-256 of its bytes. dapat reads each file in full. A file with the same bytes has the same stamp.
- `"time"`: the stamp of a file is its modification time in nanoseconds and its size. dapat reads no bytes.

`FilesystemPrefix` follows symlinks, in `stamp()` and in `list()`. A link to a file counts as that file, with the stamp of its target. A link to a folder is walked. A link back to a folder above it is not walked again. A link that cannot resolve adds no file: a broken link, a link to itself, two links that point at each other, or a link through a file. If the folder of the prefix is a broken link, dapat treats it as a missing folder: `list()` returns `[]`. If the folder of the prefix is a link loop, `stamp()` throws.

`"time"` stats up to 256 files at the same time. `"hash"` reads up to 8 files at the same time, and streams a file of 1 MB or more into the hash, so a large file does not fill the memory.

With `"hash"`, dapat reads a file at most one time in each process while the stat of the file does not change. The stat includes the device, the inode, the size, the modification time, and the change time. So many tasks that read one input, or one folder, pay for one hash. A new process reads each file again, so the stamp is always the hash of the bytes.

dapat uses a saved hash only when the modification time and the change time of the file are more than 2 seconds older than the stat that saved it. This rule comes from git. On a file system with coarse timestamps, two quick writes of the same size can keep every stat value. The rule sees these writes, because such a file is new, so dapat reads it again. The rule does not see a write that changes no stat value in a file that is older than 2 seconds, for example a write through a shared `mmap` ([section 13](#13-limits)).

`"hash"` is the default because a skip that depends on the bytes is correct more often. For example, a task that runs again and writes the same bytes to its output files does not make the tasks that read them run. `"time"` is much faster. These are measured times on Bun, with a cold cache and then a warm cache:

| Files | `"time"` | `"hash"` |
| --- | --- | --- |
| 400 text pages, 2 MB | 21–26 ms / 13–19 ms | 47–55 ms / 22–23 ms |
| 40 image files, 86 MB | 5–6 ms / 2–3 ms | 165–371 ms / 115–155 ms |
| 1 file, 287 MB | 2–3 ms / under 1 ms | 0.4–2 s / 0.4–0.6 s |

`"time"` has a cost. A rewrite with the same bytes, a `touch`, a `git checkout`, or a copy that changes the modification time and keeps the bytes changes the stamp. Then the task runs again. Set `stamp: "time"` only for large files that you do not rewrite, and only where a run is cheap. Do not use it for the inputs of a task that calls a paid model.

```ts
const video = new FileArtifact("raw/interview.mov", { stamp: "time" })
const frames = new FilesystemPrefix("raw/frames/", { stamp: "time" })
```

Older versions of dapat used `"time"` as the default. After an upgrade, every stamp of a file with the default stamp is different, so each task with such a file runs one time.

After the upgrade, a file that dapat cannot read makes the task fail, because the hash reads the bytes. For example, a file with no read permission in an input folder, an input file that the task only stats, or a key file that the task writes into its own output folder. With the old `"time"` default, these tasks did not fail. Use `stamp: "time"` for such files.

Older versions also had `directory()`, a folder artifact. Use `new FilesystemPrefix(path)` in its place, and call `list()` in place of `read()`. dapat stores a folder stamp under a different key, so each task that used `directory()` runs one time after the change.

### 11.2 S3: `S3ObjectArtifact`, `S3Prefix`, `S3Client`, `MemoryS3`

dapat does not include an AWS client. You give it an object that has these four methods:

```ts
interface S3Client {
  head(bucket: string, key: string): Promise<S3Head | null>
  get(bucket: string, key: string): Promise<Uint8Array>
  put(bucket: string, key: string, body: Uint8Array): Promise<S3Head>
  list(bucket: string, prefix: string): Promise<S3ListEntry[]>
}

interface S3ListEntry {
  key: string
  etag: string
}

interface S3Head {
  lastModified: Date
  etag: string
}
```

Write an adapter for the AWS SDK or for your own HTTP client. The adapter must obey these rules:

- `head` must return `null` when the object does not exist. Do not throw. A `null` tells dapat that an output is missing, so the task must run.
- `list` must return every object under the prefix, with its key and its `etag`. S3 `ListObjectsV2` returns at most 1000 objects in one response. Follow `ContinuationToken` until the response is not truncated, and return the objects from every page. If you return one page only, `S3Prefix` does not see a change on the other pages.
- `put` must return the `lastModified` and `etag` of the new object.

`MemoryS3` implements this interface in memory. Use it for tests.

| Class | Stamp | `read()` returns |
| --- | --- | --- |
| `S3ObjectArtifact(client, bucket, key)` | `etag` | `Uint8Array` |
| `S3Prefix(client, bucket, keyPrefix)` | SHA-256 of each key under the prefix and its `etag` | none |

## 12. Recipes

### 12.1 Force tasks to run again

To run every task again, clear the store before the build:

```ts
const store = new JsonStore(".dapat/state.json")
await store.clear()
const build = new Build({ store })
```

To run one task again, delete its record with `await store.delete(taskId)`. A task with no record always runs.

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

A task skips only when the store has a record for it. To skip unchanged tasks in CI, keep these items in the CI cache between runs:

- the store file, for example `.dapat/state.json`.
- the output files of the tasks.

A new checkout changes the modification time of each file. The default `stamp: "hash"` does not change when the bytes stay the same, so a task skips. With `stamp: "time"`, the stamp of each file changes, and every task with such a file input runs. In CI, do not use `stamp: "time"`. The ids of these artifacts are absolute paths. So check out the repo at the same path on each CI run. At a different path, the ids change, and every task runs. If the cache is empty, every task runs.

## 13. Limits

- **A task that skips sends no `produced` or `deleted` events.** This applies to its prefix outputs and to its declared outputs. A subscriber gets only the `promised` events of that task on the next build.
- **A task with an `IdPrefix` input or output runs on each build.** An `IdPrefix` cannot list what is under it, so its stamp is `null`. A skip could hide a change under it. To let the task skip, use a prefix that can stamp, for example `FilesystemPrefix` or `S3Prefix`, or write a prefix subclass with a `stamp()` method.
- **A `"time"` stamp misses an edit that keeps the size and the modification time.** Then the task skips. These cases do that:
  - Tools that copy the old modification time: `cp -p`, `rsync -t` (also `rsync -a`), and tar extraction.
  - File systems with coarse times: HFS+ keeps 1 second, and FAT and some network file systems keep 2 seconds. An edit inside that time that keeps the size is not seen. Most Linux file systems keep a few milliseconds or better.

  The default `"hash"` stamp sees all of these edits. Do not use `"time"` for files that such tools write, or for files that a program edits during the build.
- **A link to a folder above the prefix pulls that folder into the stamp.** If that folder holds the store file or the outputs of the task, the task runs on every build.
- **Many links to one folder are walked one time for each path.** The stamp then reads that folder many times. Only a link back to a folder above it is not walked again.
- **A task that writes into a folder that it reads runs again with no edits.** For example, a task reads `new FilesystemPrefix("pages/")` and writes `pages/index.html`. Each run writes `index.html`, so the stamp of `pages/` changes, and on the next build the input stamp differs from the record. With the default `"hash"` stamp, the task stops running once a run writes the same bytes as the run before. For example, if it writes the same bytes each time, it runs on builds 1 and 2 and skips from build 3. With `stamp: "time"`, each write gives `index.html` a new modification time, so the task runs on every build. Each build finishes, and the task runs at most one time in each build. dapat gives no warning. To let the task skip from build 2, put `index.html` next to `pages/`, not in it.
- **Two tasks that write into one folder run again with no edits.** For example, `split` writes `new FilesystemPrefix("out/")`, and `index` writes `out/index.html`. dapat records the stamp of `out/` when `split` ends. If `index` writes after that, the record of `split` is old on the next build. Each build finishes, and dapat gives no warning. With the default `"hash"` stamp, the tasks skip from build 3 when each run writes the same bytes. With `stamp: "time"`:
  - If `index` also reads a file that `split` writes, `index` waits for `split`. Then `split`, `index`, and a task that reads `out/` run on every build.
  - If the two writers do not wait for each other, the writer that ended first, and a task that reads `out/`, run one extra time on the next build. Which writer that is depends on which one ends first. Then the tasks skip. If both writers declare the whole folder, for example both write `new FilesystemPrefix("out/")`, they can take turns and run again on every build.

  To let all of these tasks skip from build 2, give each writer its own folder, for example `out/pages/` for `split` and `out/index.html` next to it, with no task that reads all of `out/`.
- **A prefix input that covers the store file runs on every build.** For example, a task reads `new FilesystemPrefix(".")`, and the store is `.dapat/state.json`. Each build writes the store, so the stamp of the prefix changes. Put the store outside the folders that tasks read, or read a narrower prefix.
- **In one process, a write that changes no stat value is not seen.** For example, a long-lived process writes to a file through a shared `mmap`, and the page is already dirty. The bytes change, but the size, the modification time, and the change time do not. `"time"` does not see this write. `"hash"` does not see it either when the file is older than 2 seconds, because dapat uses the saved hash. A new process always reads each file again, so the next process sees the write.
- **Only a missing path counts as missing.** `FileArtifact` returns a `null` stamp, and `FilesystemPrefix` returns the stamp of an empty list and lists no files, only for `ENOENT`. Every other error makes `stamp()` throw, so the task fails with that error, for example a permission error, or a file where a folder must be. In `"time"` mode, dapat reads only the metadata of a file. A file that the task cannot read still gets a stamp, and `read()` fails later.
- **The skip rule ignores the order and the repeats of the inputs.** The record keeps the stamps by id. So a task that ran with the inputs `[a, b]` skips with `[b, a]`, and a task that ran with `[a]` skips with `[a, a]`. If the result of a task depends on the order of its inputs, put the order in the task id, or force the task to run ([section 12.1](#121-force-tasks-to-run-again)).
- **A `FileMatcher` pattern needs text between two vars.** `FileMatcher` throws when two vars have nothing between them, for example `v/<lang><slug>.md`. A key such as `v/enintro.md` has more than one split. The error names the pattern and the two vars. Put text between the vars, for example `v/<lang>-<slug>.md`.
- **A `FileMatcher` pattern cannot have `*` or `**`.** Use one var for each part that changes, or `FileGroupMatcher` for a list of files.
- **A `FileGroupMatcher` pattern has vars only before the first glob.** The names that a glob matches are not vars. Read them from the path of each file.
- **A task that reports many files of one group one at a time replaces the task of the group one time for each file.** Each `ctx.produced` call is one step, and each step makes a new list and a new task with one input for each file. The cost thus grows as the square of the number of files. For example, one task that reports 2,000 files of `site/<lang>/**/*.html` takes about 1.0 s in all, about 0.4 s more than with no group rule, and 4,000 files take about 2.7 s. 2,000 tasks that each declare one file put all of them in one step, and make one sitemap task. Declare the files as outputs when you know their names.
- **A `FileMatcher` pattern cannot hold a `<` or `>` as text, or a `..` part.** A file name with `<` or `>` cannot fit a pattern.
- **A `FileMatcher` finds the old outputs of a task that is gone.** dapat does not delete old outputs, so the scan finds them on the next build ([Between runs](#between-runs)). Other tools and people can own files in the same folders, so dapat does not guess which files to delete.
- **A `FileMatcher` or a `FileGroupMatcher` does not see a change on disk during the run that no task reports.** It looks at the disk only in its scan. A file that another program writes during the run gets its match on the next build.
- **A var that comes twice in one segment can be slow on long names.** For example, `<a>-<b>-<c>-<a>` tries each split of the segment. A 255-character file name that almost matches takes about 10 ms. A 1000-character key can take seconds. Each segment without such a repeated var keeps its first split, so it stays fast.
- **A part with many `*` can be slow on long names.** Each `*` matches any text in the part, so a part such as `*a*a*a*a*b` tries many splits, and a long name that almost fits can take seconds. A part such as `*-*-*.jpg` stays fast.
- **Matches that come in separate steps after the scans can pass through a state in between.** For example, a file watcher sends one file at a time, or two tasks that write a page and its review end at different times. Then `build.each` can make a set with `matched.review === undefined` for a while, and later replace it. This is correct if each set gives its own task ids and outputs. It is not safe when the id or an output depends on a matcher that is not required being `undefined`, and other sets can give the same id. For example, the drafts rule gives `draft:${vars.lang}` for the page of a lang with no review. In the state in between, two pages of one lang have no review, so two sets give `draft:en`, and `build.run()` rejects. Or the id moves between sets in two steps, and its store record is deleted, so the task runs again on the next build. Two passes of one drain are separate steps too. For example, rule 1 promises the pages, and rule 1b promises the reviews only when it gets those page events. Then the drafts rule gets the pages in pass 1 and the reviews in pass 2, and it passes through the same state in between. The safe pattern: put every var of the required matchers in each task id and each output, for example `draft:${vars.lang}/${vars.slug}`.
- **A prefix class with its own `covers()` or `overlaps()` makes the build check outputs one by one.** The build finds producers in an index of the output ids. The index works only for the default rule: one id starts with the other. A class with its own rule can match any id, so the build checks it one by one:
  - As an input, a prefix whose class overrides `covers()` or `overlaps()` makes each look for producers check every output of the build.
  - As an output, a prefix whose class overrides `covers()` is checked by each look of each artifact input of the build. An override of `overlaps()` alone does not do this.

  So n such tasks cost about n². The build counts a class as custom when it overrides the method, also with the same rule. For example, with `bun bench/scheduler.ts custom-prefix`, n tasks that each read one prefix take 0.7 s for 4,000 tasks and 9.9 s for 16,000. The same tasks with `IdPrefix` take 0.14 s and 0.40 s (`shared-prefix`). `IdPrefix`, `FilesystemPrefix`, and `S3Prefix` use the default rule. Override `covers()` and `overlaps()` only when the region is not an id prefix.
- **A prefix input whose producers come one at a time costs about n².** For example, a task reads `out/`, and task k writes `out/k` and adds task k + 1 with `ctx.add` while it runs. The reader waits for task k. When task k ends, the reader looks for its producers again, finds task k + 1, and lists the k outputs under `out/` to do so. With `bun bench/scheduler.ts one-at-a-time`, 4,000 tasks take 0.9 s and 16,000 take 25 s. Without the reader, 16,000 tasks take 0.3 s. Add the producers in one step when you can, for example all of them before they end.
- **No timeout and no concurrency limit.** All ready tasks start at the same time. Add limits and timeouts in your task code ([section 12.2](#122-limit-parallel-work)), and use `ctx.signal` to stop work.
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
| `add(task: Task): void` | Adds a task. If a task with the same id exists, replaces it (see [section 8](#replacement)). If `run()` has started, sends a `promised` event for each declared output, and the task starts at once. Does not throw when a subscriber throws ([section 9](#subscriber-errors)). Throws if another task already declares one of its exact outputs, if the task declares one output twice, or if another task group has that id ([Task groups](#task-groups)). Throws before it changes anything. It is one step of its own, also while the build keeps a step open for `build.each` ([`setTasksOfGroups`](#class-build)). So during the scans of the first `run()`, `add` cannot see the sets of `build.each`, which wait in the open step. If it gives an id of such a set, the clash shows when the scans return, and `run()` rejects and names both groups. |
| `remove(id: string): void` | Removes a task. Aborts it if it is running and sends a `withdrawn` event for each declared output. Does not throw when a subscriber throws. Starts to delete its store record. Does not wait for the delete, but `run()` does. A delete error goes into `result.errors`. Does nothing if the id is not known. The other tasks of the same task group stay. |
| `subscribe(listener: (event: ArtifactEvent) => void): void` | From `Emitter`. Calls `listener` synchronously for each artifact event, in the order of the event queue. Does not replay earlier events. See [section 9](#9-subscribe-to-artifact-events). |
| `protected setTasksOfGroups(changes: readonly GroupTasks[]): void` | Makes the tasks of each group in `changes` its new tasks, in one step ([Task groups](#task-groups)). `GroupTasks` is `{ group: TaskGroup; tasks: readonly Task[] }`. Adds each new id, replaces each known id, and removes each id that a group had before and that no group of the step gets now. A task id can move from one group of the step to another group of the step. That is a replacement, as a known id in one group is: the task ends as `cancelled` with the reason `"replaced"` if it had not finished, and its store record stays. A removed task ends as `cancelled` with the reason `"removed"` if it had not finished, and its store record is deleted. Changes all state first, then puts the events on the queue: all `withdrawn` events of the step first, then the `promised` events, by id in list order. Throws and changes nothing if two groups of the step or another group have one id, if a group gets one id two times, if two tasks declare one exact output, or if a group is in `changes` two times. The checks use the state after the whole step. **An open step:** while the first `run()` scans, during each pass of a drain over the event queue, and during each matcher event that comes from outside a drain, the build keeps a step open. Then a call does not throw: its changes join the open step, a later change of a group replaces its earlier one, and the build applies the step when the scans return, when the pass ends, or when the event ends. The events of the applied step make the next pass of the drain. An error then is fatal for the build. `build.each` gives its changes here. `add` never joins an open step. A subclass of `Build` can call it with its own `new TaskGroup(label)`. |
| `each<M extends Record<string, AnyMatcher>, const R extends keyof M & string = keyof M & string>(config: TaskMaterializerConfig<M, R>): void` | Makes tasks for each joined set of matched artifacts ([section 10](#10-buildeach-tasks-for-each-matched-artifact)). TypeScript gets `R` from `required`. Subscribes to each matcher in `matchersByName`, joins their matches on shared var names, and gives the tasks of each joined set through `setTasksOfGroups`, with one task group for each set, labeled `build.each <number> <var name>=<var value> ...`. All the changes of one pass of a drain over the event queue are one step, and all the changes during the scans of the first `run()` are one step. The build sends each artifact event to `matcher.receiveArtifactEvent`, one time for each matcher. An error in `tasks` or in a matched artifact is fatal for the build, like a subscriber error. Throws if `matchersByName` has no matcher, if one matcher object is under two names, if `required` is empty or has a name that is not in `matchersByName`, if its required matchers do not form one connected group by shared var names, if `run()` has started, or if another `Build` uses a matcher. |
| `run(): Promise<Result>` | The first time, sends a `promised` event for each output of each task that is in the build, and then runs the scan of each matcher and waits for all of them. A call during the scans waits for the same scans. Then starts every task and resolves when every started task has finished. Does not reject when a task fails. Rejects with the first subscriber error, `build.each` error, scan error, or send-limit error of the build, at once if that error happened before the call ([section 9](#subscriber-errors)). After a scan error, no task starts. |

### `class TaskGroup`

```ts
new TaskGroup(label: string)
```

A group of tasks for `setTasksOfGroups` ([Task groups](#task-groups)). The object is the identity. `label` is only for error messages.

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

### `abstract class Prefix`

| Member | Description |
| --- | --- |
| `abstract readonly id: string` | The region. End it with a delimiter. |
| `stamp(): Promise<string \| null>` | A string that changes when anything under the prefix changes. An empty region has a real stamp. `null` when the prefix cannot tell what is under it; then each task that uses it runs. Default: `null`. A throw fails the task that dapat stamps the prefix for. See [Prefix stamps](#prefix-stamps). |
| `covers(artifact: Artifact): boolean` | Default: `artifact.id` equals or starts with `this.id`. An override costs more ([Limits](#13-limits)): as an input, the build checks every output; as an output, each artifact input checks this prefix. |
| `overlaps(other: Prefix): boolean` | Default: one id equals or starts with the other. An override costs more as an input only: the build checks every output ([Limits](#13-limits)). |

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
  inputStamps: Record<string, string | null>  // keyed by "artifact <id>" or "prefix <id>"
  outputStamps: Record<string, string | null>
}
```

`null` means that the artifact did not exist. A prefix with a `null` stamp has no key.

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

### `abstract class Matcher<D extends MatchedData = MatchedData>`

```ts
abstract class Matcher<D extends MatchedData = MatchedData> extends Emitter<MatchedArtifactEvent<D>> {
  abstract readonly varNames: readonly string[]
  abstract scan(signal: AbortSignal): Promise<void>
  receiveArtifactEvent(event: ArtifactEvent): void {}
}
```

| Member | Description |
| --- | --- |
| `varNames` | The var names of each matched artifact that the matcher sends. Each one must have exactly these vars. |
| `scan(signal)` | Looks at the world now and sends `found` for each thing that it finds. The first `build.run()` calls it, and waits for it before any task starts. `signal` aborts when another scan fails or when the build fails. |
| `receiveArtifactEvent(event)` | Gets each artifact event of the build. It can send `found` and `gone`. It must be fast and do no I/O. The default does nothing. |

A matcher belongs to one `Build`.

See [section 10](#10-buildeach-tasks-for-each-matched-artifact).

### `type Vars`, `type MatchedData`, `type MatchedArtifact`, and `type MatchedArtifactEvent`

```ts
type Vars = Readonly<Record<string, string>>

type MatchedData = Artifact | readonly Artifact[]

type MatchedArtifact<D extends MatchedData = MatchedData> = { vars: Vars; data: D }

type MatchedArtifactEvent<D extends MatchedData = MatchedData> =
  | { kind: "found"; matched: MatchedArtifact<D> }
  | { kind: "gone"; vars: Vars }
```

The vars of a matched artifact are its key. A `found` with known vars and new data replaces the match, a `found` with the same artifact ids in the same order does nothing, and a `gone` removes it. One artifact and a list of one artifact are different data. A `gone` with wrong var names makes `build.run()` reject. See [Matched artifacts](#matched-artifacts).

### `type TaskMaterializerConfig<M, R>`, `type MatchedByName<M, R>`, and `type JoinedVars<M, R>`

```ts
type TaskMaterializerConfig<M extends Record<string, AnyMatcher>, R extends keyof M & string = keyof M & string> = {
  matchersByName: M
  required?: readonly R[]
  tasks: (vars: JoinedVars<M, R>, matched: MatchedByName<M, R>) => Iterable<Task>
}

type JoinedVars<M extends Record<string, AnyMatcher>, R extends keyof M & string = keyof M & string> =
  [Exclude<keyof M, R>] extends [never] ? Vars : Readonly<Record<string, string | undefined>>

type MatchedByName<M extends Record<string, AnyMatcher>, R extends keyof M & string = keyof M & string> = {
  readonly [K in keyof M]: K extends R ? MatchedArtifact<DataOf<M[K]>> : MatchedArtifact<DataOf<M[K]>> | undefined
}
```

`R` is the names in `required`. If you leave `required` out, `R` is every name, so no matched artifact is `undefined`. A matcher that is not in `R` can be `undefined` in `matched`. It left-joins onto the matchers in `R`, after the earlier matchers that are not in `R`, in name order, on its ON vars. Each of its matches that agrees makes its own joined set. `JoinedVars` is `Vars` when every name is in `R`, else `Readonly<Record<string, string | undefined>>`. `required` must name at least one matcher. See [`required`](#required-matchers-that-a-set-can-do-without).

`AnyMatcher` is `Matcher<any>`: a matcher of any data type. Each matched artifact has the data type of its own matcher: `DataOf` reads `D` from the matcher type. `matchersByName` must have at least one entry, and its required matchers must form one connected group by shared var names. `tasks` gets the vars of one joined set, which hold the vars of all its matches (a var of a matcher with no match in the set is `undefined`), and each matched artifact under its matcher's name. See [The `build.each` config](#the-buildeach-config).

## Filesystem (`dapat/contrib`)

Relative paths are resolved against `process.cwd()` when you construct the artifact.

### `class FileArtifact extends Artifact<Uint8Array>`

```ts
new FileArtifact(path: string, opts?: { stamp?: "hash" | "time" })
```

| Member | Value |
| --- | --- |
| `path` | Absolute path |
| `id` | `file:<absolute path>` |
| `stampMode` | `"hash"` or `"time"`. Default `"hash"`. The constructor throws for any other value. |
| `stamp()` | `"hash"`: SHA-256 hex of the bytes. `"time"`: `<modification time in ns>:<size>`. Follows a symlink. `null` if the file is missing. Throws if the path is not a file, and for every other error. |
| `read()` | The bytes. Throws if the file is missing. |

### `class FilesystemPrefix extends Prefix`

```ts
new FilesystemPrefix(path: string, opts?: { stamp?: "hash" | "time" })
```

| Member | Value |
| --- | --- |
| `path` | Absolute path, ending with `/` |
| `id` | `file:<absolute path>/` |
| `stampMode` | `"hash"` or `"time"`. Default `"hash"`. |
| `stamp()` | SHA-256 of the sorted lines `<relative path>=<file stamp>` for every file under the path, at any depth. Each file stamp is as in `FileArtifact`. A missing folder has the stamp of an empty list. Never `null`. Throws if the path is a file, and for every other error. |
| `list()` | Absolute paths of every file under the folder, at any depth. Follows symlinks as `stamp()` does. A missing folder lists no files. Throws if the path is a file, and for every other error. |

### `class FileMatcher extends Matcher<FileArtifact>`

```ts
new FileMatcher(pattern: string, opts?: { stamp?: "hash" | "time"; syntax?: FilePatternSyntax })
```

| Member | Value |
| --- | --- |
| `pattern` | The pattern without `./`, for example `content/<lang>/<slug>.md`. |
| `root` | The absolute folder that the pattern is relative to: the working directory when you create the matcher, or `/` for an absolute pattern. |
| `varNames` | The vars of the pattern, in order. `templates/<lang>.html` gives `["lang"]`. |
| `scan(signal)` | Sends `found` for each file on disk that fits, in name order. Reads a folder only for a part with a var, and stats only symlinks and entries of unknown type. A link loop adds no file. A missing folder has no files. Follows symlinks. Throws for every other error. |
| `receiveArtifactEvent(event)` | `promised` and `produced` of a `FileArtifact` that fits send `found`. `deleted` sends `gone` unless a task still declares the file. `withdrawn` sends `gone` unless the file is on disk. |

The `stamp` option sets the stamp mode of each `FileArtifact` that the matcher sends. Default `"hash"`. The `syntax` option is `{ varStart?, varEnd?, anyName?, anyFolders? }`, with the defaults `<`, `>`, `*`, and `**`. It sets the markers of the pattern, and the error messages name these markers. With another `anyName` and `anyFolders`, a `*` is a literal and does not throw. See [The pattern](#the-pattern). The constructor throws for an invalid `syntax`, an empty pattern, a pattern with `*` or `**` (the message names `FileGroupMatcher`), a `..` part, a `<` or `>` that does not enclose a valid var name, and two vars with nothing between them. Each match is `{ vars, data: FileArtifact }`. See [`FileMatcher`](#filematcher-one-match-for-each-file).

### `class FileGroupMatcher extends Matcher<readonly FileArtifact[]>`

```ts
new FileGroupMatcher(pattern: string, opts?: { stamp?: "hash" | "time"; syntax?: FilePatternSyntax })
```

| Member | Value |
| --- | --- |
| `pattern` | The pattern without `./`, for example `site/<lang>/**/*.html`. |
| `root` | As for `FileMatcher`. |
| `varNames` | The vars of the pattern, in order. They are all in the parts before the first glob. `site/<lang>/**/*.html` gives `["lang"]`. |
| `scan(signal)` | Reads the files as `FileMatcher` does. At a `**`, takes every file under the folder, as `FilesystemPrefix.list()` does. After the whole scan, sends one `found` for each group, with its files sorted by path. Throws for every error other than a missing path. |
| `receiveArtifactEvent(event)` | A file gets and loses its match as in `FileMatcher`. Each change sends `found` with the new list of the group of the file, or `gone` when the list becomes empty. |

The `stamp` option sets the stamp mode of each `FileArtifact` that the matcher sends. Default `"hash"`. The `syntax` option sets the markers of the pattern, as for `FileMatcher`. The constructor throws for a pattern with no `*` or `**` (or no `anyName` or `anyFolders` of the syntax), a var in or after the first part with a glob, a `**` at the end, a `**` inside a name, and each other error of `FileMatcher`. Each match is `{ vars, data: readonly FileArtifact[] }`. See [`FileGroupMatcher`](#filegroupmatcher-one-match-with-a-list-of-files).

## S3 (`dapat/contrib`)

### `interface S3Client` and `interface S3Head`

See [section 11.2](#112-s3-s3objectartifact-s3prefix-s3client-memorys3).

### `class S3ObjectArtifact extends Artifact<Uint8Array>`

```ts
new S3ObjectArtifact(client: S3Client, bucket: string, key: string)
```

| Member | Value |
| --- | --- |
| `client`, `bucket`, `key` | The constructor arguments |
| `id` | `s3://<bucket>/<key>` |
| `stamp()` | `head().etag`. `null` if `head` returns `null`. |
| `read()` | `client.get(bucket, key)` |

### `class S3Prefix extends Prefix`

```ts
new S3Prefix(client: S3Client, bucket: string, keyPrefix: string)
```

`id` is `s3://<bucket>/<keyPrefix>/`. The constructor adds the trailing `/` if `keyPrefix` is not empty and does not end with `/`.

`stamp()` calls `client.list` one time for the objects under `<keyPrefix>/`. It returns the SHA-256 of the sorted lines `<key>=<etag>`. An empty prefix has the stamp of an empty list. It throws if `list` returns an entry without a string `key` and a string `etag`, for example the plain keys of an adapter for the older interface. Older versions took no `client`.

### `class MemoryS3 implements S3Client`

```ts
new MemoryS3()
```

Keeps objects in a `Map`. `put` sets the `etag` to the SHA-256 of the body. `put` also sets `lastModified` to a value that increases by at least 1 ms on each call. `get` throws for a missing object. `list` returns `{ key, etag }` for each object, sorted by key.

## Stores (`dapat/contrib`)

### `class JsonStore implements Store`

```ts
new JsonStore(path: string)
```

Keeps every record in one JSON file with the shape `{ "tasks": { "<taskId>": { "inputStamps": ..., "outputStamps": ... } } }`. Each stamp is a string or `null`. A missing file is the same as an empty store. `set` creates the parent directory.

### `class SqliteStore implements Store`

```ts
new SqliteStore(db: Database | string)
```

Given a path, it creates the parent folder of the path. It creates the table `dapat_task_state (task_id TEXT PRIMARY KEY, payload TEXT)` if it does not exist. `payload` is the record as JSON. `close()` closes the database only if the store opened it from a path.

### `MemoryStore`

The same class as the core `MemoryStore`.
