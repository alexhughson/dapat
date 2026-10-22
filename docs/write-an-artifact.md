# Write an artifact type

An **artifact type** is a class that extends `Artifact` or `Prefix`. Write one when tasks read or write a value that dapat has no class for, such as a database row. On this page you write `JsonKey` for one key of a JSON file, and `JsonKeyPrefix` for the keys under `pages/`. [The store](#the-store) gives the contract for a store of your own. Read part 1 of the [guide](guide.md) first.

## What you write

Extend `Artifact` for one value. Extend [`Prefix`](guide.md#folders-prefixes) for the values whose ids start with one id, such as the keys under `pages/`. Both classes come from `"dapat"`:

| Member | `Artifact` | `Prefix` |
| --- | --- | --- |
| `id` | abstract | abstract |
| `stamp()` | abstract. Return `null` when the value is missing | default: `null`, so each task that uses the prefix runs on every build ([the skip rule](guide.md#the-store-and-the-skip-rule)) |
| `read()` | abstract. Only your task code calls it | – |
| `covers(a)` | – | default: `a.id` starts with `this.id` |
| `overlaps(p)` | – | default: `p.id` starts with `this.id`, or the reverse |

`covers` and `overlaps` decide only the order of the tasks and which reports a task can make. Of these methods, only `stamp()` decides a skip. The record keeps one stamp for a whole prefix ([outputs with unknown names](guide.md#outputs-with-unknown-names)).

- The build calls no `exists`, `delete` or `list` method. A subclass can add one, as `FilesystemPrefix` adds `list()`. To delete a value, your task deletes it, then [reports](guide.md#outputs-with-unknown-names) it with `ctx.deleted`.
- The build matches outputs with inputs to find the [producers](guide.md#what-a-build-does) of a task. It also matches each `ctx.produced` and `ctx.deleted` with the outputs of the task. Two artifacts match when their ids are equal. For a prefix and an artifact, it calls `covers` of the prefix. For two prefixes, it calls `overlaps` of the prefix input. It calls them again each time a waiting task checks its producers. So make them fast, and make them give the same result for the same ids.
- `covers` and `overlaps` get the artifacts and prefixes of every task, of any class. Check the class before you read a field that only your class has. Do not throw: a throw while a task waits for its producers is an unhandled rejection, and that task is in no list of the `Result`.
- Extend the class. A plain object with the same members type-checks, but the build tests each input and output with `instanceof`. For a plain-object output, the tasks that read it do not wait, two tasks can declare it, and `ctx.produced` throws for it.

## Step 1: one key of a JSON file

In this step you write `JsonKey`, which extends `Artifact`. In the program, the task `make-slug` reads the key `title` and writes the key `slug`. Each key has its own stamp. So `make-slug` skips in build 2, although its run in build 1 changed `data.json`.

- The id is `json:<absolute path>#<key>`. It starts with `json:`, a fixed text that no other kind of value uses. The `#` ends the path, so a prefix for the keys of `data.json` does not cover the keys of `data.json.bak`. A `FileArtifact` or `FilesystemPrefix` id starts with `file:`. So a task that reads `data.json` as a file does not wait for the tasks that write its keys. Declare each key that a task reads as a `JsonKey` input.
- `stamp()` returns the SHA-256 hash of `JSON.stringify(value)`, or `null` when the key is missing. A `null` output stamp makes the task run, so if a person deletes `slug`, the next build runs `make-slug`. The build compares a `null` input stamp with the record, as it does any other stamp ([skip checks 2 and 4](semantics.md#the-skip-check)). `stamp()` throws when the file is not valid JSON, and the task fails.
- `read()` returns the value, and throws when the key is missing.

```ts
import path from "node:path"
import { Artifact, Build, MemoryStore, Task, type TaskState } from "dapat"

const calls: string[] = [] // stamp(), get, run and set add to it, in call order

async function load(file: string): Promise<Record<string, unknown>> {
  const exists = await Bun.file(file).exists()
  if (!exists) return {} // a missing file has no keys
  return await Bun.file(file).json()
}

class JsonKey<T = unknown> extends Artifact<T> {
  readonly file: string
  readonly id: string
  constructor(file: string, readonly key: string) {
    super()
    this.file = path.resolve(file) // "data.json" and "./data.json" give one id
    this.id = `json:${this.file}#${key}`
  }
  async stamp() {
    const doc = await load(this.file)
    let stamp: string | null = null
    if (Object.hasOwn(doc, this.key)) {
      stamp = Bun.SHA256.hash(JSON.stringify(doc[this.key]), "hex")
    }
    calls.push(`stamp ${this.key} ${stamp?.slice(0, 8) ?? null}`) // trace only
    return stamp
  }
  async read() {
    const doc = await load(this.file)
    if (!Object.hasOwn(doc, this.key)) throw new Error(`missing ${this.id}`)
    return doc[this.key] as T
  }
}

class LoggingStore extends MemoryStore {
  override async get(taskId: string) {
    calls.push("get")
    return await super.get(taskId)
  }
  override async set(taskId: string, state: TaskState) {
    calls.push("set")
    await super.set(taskId, state)
  }
}

const store = new LoggingStore()
const title = new JsonKey<string>("data.json", "title")
const slug = new JsonKey("data.json", "slug")

async function makeSlug() {
  calls.push("run")
  const text = await title.read()
  const doc = await load("data.json")
  doc.slug = text.toLowerCase().replaceAll(" ", "-")
  await Bun.write("data.json", JSON.stringify(doc))
}

async function runBuild(label: string) {
  const build = new Build({ store })
  build.add(new Task({ id: "make-slug", inputs: [title], outputs: [slug], run: makeSlug }))
  await build.run()
  const trace = calls.splice(0)
  console.log(`${label.padEnd(16)}${trace.join(", ")}`)
}

await Bun.write("data.json", JSON.stringify({ title: "Hello World" }))
await runBuild("1. no record")
await runBuild("2. no change")
await Bun.write("data.json", JSON.stringify({ title: "Bye World", slug: "hello-world" }))
await runBuild("3. new title")
```

<!-- output -->
```text
1. no record    stamp title 07cf5509, get, run, stamp slug 058df09e, set
2. no change    stamp title 07cf5509, get, stamp slug 058df09e
3. new title    stamp title 737a860c, get, run, stamp slug af55aa8e, set
```

In build 3, the stamp of `title` differs. So the build runs the task, and does not stamp `slug` first. [How the build uses your classes](#how-the-build-uses-your-classes) gives the full order of calls.

## Step 2: a prefix for keys with unknown names

In this step you extend `Prefix`. `JsonKeyPrefix` stands for the keys of `data.json` that start with `pages/`. The task `split` writes one page key for each line of `book`: `pages/1`, `pages/2`, and so on. It declares the prefix `pages` as its output and [reports](guide.md#outputs-with-unknown-names) each page key. The task `make-index` reads `pages` and writes the page keys, sorted as strings, to the key `index`. `load` and `JsonKey` are as in step 1, without `calls`. `writeKey` reads `data.json` and writes it back, so two tasks must not run it at the same time ([checklist](#checklist)).

- The id of `pages` is `json:<absolute path>#pages/`, which ends with a [delimiter](guide.md#folders-prefixes). The id of each page key starts with it, so `covers` of `pages` returns true for each page key, and `ctx.produced` does not throw.
- `stamp()` of `JsonKeyPrefix` returns the SHA-256 hash of the lines `<key>=<stamp of the key>`, in key order. So a changed value, a new key and a deleted key each give a new stamp. With no keys, `stamp()` returns the hash of an empty string, not `null`, so a task that reads an empty prefix can skip. `keys()` is your own method. The build does not call it.

```ts
import path from "node:path"
import { Artifact, Build, MemoryStore, Prefix, Task, type Context } from "dapat"

async function load(file: string): Promise<Record<string, unknown>> {
  const exists = await Bun.file(file).exists()
  if (!exists) return {} // a missing file has no keys
  return await Bun.file(file).json()
}

async function writeKey(key: string, value: unknown) {
  const doc = await load("data.json")
  doc[key] = value
  await Bun.write("data.json", JSON.stringify(doc))
}

class JsonKey<T = unknown> extends Artifact<T> {
  readonly file: string
  readonly id: string
  constructor(file: string, readonly key: string) {
    super()
    this.file = path.resolve(file) // "data.json" and "./data.json" give one id
    this.id = `json:${this.file}#${key}`
  }
  async stamp() {
    const doc = await load(this.file)
    if (!Object.hasOwn(doc, this.key)) return null
    return Bun.SHA256.hash(JSON.stringify(doc[this.key]), "hex")
  }
  async read() {
    const doc = await load(this.file)
    if (!Object.hasOwn(doc, this.key)) throw new Error(`missing ${this.id}`)
    return doc[this.key] as T
  }
}

class JsonKeyPrefix extends Prefix {
  readonly file: string
  readonly id: string
  constructor(file: string, readonly keyPrefix: string) {
    super()
    this.file = path.resolve(file)
    this.id = `json:${this.file}#${keyPrefix}`
  }
  async keys() {
    const doc = await load(this.file)
    const keys: string[] = []
    for (const key of Object.keys(doc)) {
      if (key.startsWith(this.keyPrefix)) keys.push(key)
    }
    return keys.sort()
  }
  async stamp() {
    const doc = await load(this.file) // one read for all keys
    const lines: string[] = []
    for (const key of Object.keys(doc).sort()) {
      if (!key.startsWith(this.keyPrefix)) continue
      const stamp = Bun.SHA256.hash(JSON.stringify(doc[key]), "hex") // as in JsonKey
      lines.push(`${key}=${stamp}`)
    }
    return Bun.SHA256.hash(lines.join("\n"), "hex")
  }
}

const store = new MemoryStore()
const book = new JsonKey<string>("data.json", "book")
const pages = new JsonKeyPrefix("data.json", "pages/")
const index = new JsonKey<string[]>("data.json", "index")

async function makeIndex() {
  const keys = await pages.keys()
  await writeKey("index", keys)
}

async function split(ctx: Context) {
  const text = await book.read()
  const lines = text.split("\n")
  for (const [i, line] of lines.entries()) {
    const page = new JsonKey("data.json", `pages/${i + 1}`)
    await writeKey(page.key, line.trim())
    ctx.produced(page)
  }
}

async function runBuild(label: string, text: string) {
  await writeKey("book", text)
  const build = new Build({ store })
  build.add(new Task({ id: "make-index", inputs: [pages], outputs: [index], run: makeIndex }))
  build.add(new Task({ id: "split", inputs: [book], outputs: [pages], run: split }))
  const result = await build.run()
  const ran = result.executed.map((task) => task.id).sort()
  const skipped = result.skipped.map((task) => task.id).sort()
  const keys = await index.read()
  console.log(`${label.padEnd(16)}ran [${ran.join(" ")}] skipped [${skipped.join(" ")}] index: ${keys.join(" ")}`)
}

await runBuild("1. no record", "Call me Ishmael.\nSome years ago.")
await runBuild("2. spaces added", "Call me Ishmael.   \nSome years ago.")
await runBuild("3. a new line", "Call me Ishmael.\nSome years ago.\nNever mind how long.")
```

<!-- output -->
```text
1. no record    ran [make-index split] skipped [] index: pages/1 pages/2
2. spaces added ran [split] skipped [make-index] index: pages/1 pages/2
3. a new line   ran [make-index split] skipped [] index: pages/1 pages/2 pages/3
```

1. In build 1, `index` lists both page keys, although the program adds `make-index` first. `make-index` waits, because [`overlaps`](#what-you-write) of its input `pages` returns true for the output `pages` of `split`.
2. In build 2, the stamp of `book` changed, so `split` runs. It trims the spaces and writes the same page keys. So the stamps of `pages` and `index` equal the stamps in the record of `make-index`, and it skips.
3. In build 3, `split` writes `pages/3`. The stamp of `pages` changes, so `make-index` runs.

To delete the page keys of an old, longer book, do as `split` does in [outputs with unknown names](guide.md#outputs-with-unknown-names).

## A prefix that does not compare id starts

Some prefixes do not compare the start of ids, such as a prefix for rows 100 to 199 of a table. For such a prefix, override `covers` and `overlaps`. Return `true` from `overlaps` when both prefixes can cover one id. To compare two prefixes, the build calls `overlaps` of the input, not of the output ([What you write](#what-you-write)). So a task whose input has the default `overlaps`, such as an `IdPrefix`, waits for your prefix output only when one id starts with the other. To make a task wait for your prefix output, give the task an input of your own prefix class.

## How the build uses your classes

The build calls your methods and your store in this order. The check numbers are those of [the skip check](semantics.md#the-skip-check).

```text
for each task: wait for its producers  ← the build calls covers() and overlaps() each time the task looks for them
├─ no store → run, with no stamp() calls
├─ stamp each input, one at a time  ← here and in checks 3–6, a throw fails the task, and it does not run
├─ checks 1–2: no inputs, or a prefix input whose stamp is null → run, with no store.get
├─ checks 3–4: store.get(task id): no record, or the input ids or stamps differ → run
├─ checks 5–6: stamp each output; at the first null or difference → run
├─ all stamps equal the record → skip, and the task ends: no produced events, no store.set
├─ run(ctx)  ← at each ctx.produced(a) or ctx.deleted(a), the build calls covers(a) of your prefix outputs
├─ a produced event for each exact output that the task did not report
└─ stamp each output, then store.set(task id, record)  ← a throw fails the task after its run
```

With a store, the build keeps no stamps between tasks. It stamps an artifact or a prefix for each task that declares it. In [step 2](#step-2-a-prefix-for-keys-with-unknown-names) it stamps `pages` for `split`, as an output, and again for `make-index`, as an input. So make `stamp()` fast. Tasks that do not wait for each other can call `stamp()` of one artifact at the same time. A cache in `stamp()` must allow this.

## The store

To keep records where no [built-in store](builtins.md#stores) can, such as in Redis, write a class that implements [`Store`](api.md#store). A record is a [`TaskState`](api.md#store) with two maps, `inputStamps` and `outputStamps`. In each map, a key is `artifact <id>` or `prefix <id>`, and its value is a stamp. Only an artifact stamp can be `null`, because the build leaves out a prefix whose stamp is `null`. After step 2, the record of `make-index` is:

```text
{"inputStamps":{"prefix json:/…/data.json#pages/":"<hash>"},"outputStamps":{"artifact json:/…/data.json#index":"<hash>"}}
```

The build calls the store at these times:

| Method | The build calls it |
| --- | --- |
| `get(taskId)` | in skip check 3, after the input stamps ([tree](#how-the-build-uses-your-classes)) |
| `set(taskId, state)` | after each successful run, unless the build has a [fatal error](semantics.md#fatal-errors) |
| `delete(taskId)` | when a task [leaves the `Build`](guide.md#layout-rules), but not when a task is replaced. The current `run()`, or the next one, waits for the call and puts its error in [`result.errors`](guide.md#results-and-failure) |
| `clear()` | never |

- `get` returns `null` for a task id with no record. Otherwise it returns the keys and values that `set` got, `null` values too. When a stamp in the record is not a string or `null`, the build treats the record as missing, and the task runs.
- The build can call the store for several tasks at the same time. It can also call `delete` while a `set` for the same id runs. Do the writes in the order of the calls, as [`JsonStore`](../contrib/store/json.ts) does with a promise chain.

## Checklist

- Each class extends `Artifact` or `Prefix`, not a plain object ([What you write](#what-you-write)).
- The `id` is the same in each process. It starts with a fixed text, such as `json:`, that no other kind of value uses. A prefix id starts with the same text as the artifacts that it covers, and ends with a delimiter, such as `/` ([prefixes](guide.md#folders-prefixes)).
- An artifact's `stamp()` returns the same string for the same value, and a different string when the value changes. It returns `null` only when the value is missing. It throws for every other error.
- A prefix stamp changes when a task or a person adds, deletes or changes an artifact that the prefix covers. Otherwise, the stamp stays the same. One way is a hash of the sorted lines `<key>=<stamp>`, as in step 2. With no artifacts, it is still a string, not `null`. Return `null` only when the prefix cannot tell what it covers.
- If your prefix does not compare the start of ids, override both `covers` and `overlaps` ([a prefix that does not compare id starts](#a-prefix-that-does-not-compare-id-starts)).
- `covers` and `overlaps` are fast, give the same result for the same ids, and never throw.
- A prefix stamp does not include the store's records, such as the `dapat_task_state` table of a `SqliteStore` in the same database. Each `set` changes that table, so each task that uses the prefix runs on every build ([layout rules](guide.md#layout-rules)).
- Your task code writes each value completely in one operation, so a `stamp()` never reads half a value. For a file, write a temporary file, then rename it. The samples on this page use a plain `Bun.write` to stay short.
- Tasks that write different keys of one file do not wait for each other. When each write reads the whole file and writes it back, a later write can remove the change of an earlier one. dapat gives no error. Make the writes to one file wait for each other, as [`JsonStore`](../contrib/store/json.ts) does with a promise chain.
- A task that writes artifacts with unknown names declares a prefix that covers their ids ([outputs with unknown names](guide.md#outputs-with-unknown-names)). No other task writes artifacts under that prefix ([layout rules](guide.md#layout-rules)).

## Next

[Write a matcher](write-a-matcher.md) uses `JsonKey` again: its matcher finds the keys of a JSON file, and [`build.each`](guide.md#buildeach) makes a task for each key.
