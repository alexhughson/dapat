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

- The build calls no `exists`, `delete` or `list` method. A subclass can add one, as `FilesystemPrefix` adds `list()`. To delete a value, your task deletes it, then [reports](guide.md#outputs-with-unknown-names) it with `ctx.deleted`.
- The build compares ids to find the [producers](guide.md#what-a-build-does) of a task, and to check each `ctx.produced` and `ctx.deleted`. To compare a prefix with an artifact, it calls `covers` of the prefix. To compare two prefixes, it calls `overlaps` of the prefix input. It calls them again each time a waiting task checks its producers. So make them fast, and make them give the same result for the same ids.
- If your prefix does not compare the start of ids, override `overlaps` as well as `covers`. Return `true` when both prefixes can cover one id. The build calls your `overlaps` only when your prefix is the input. When your prefix is an output, the `overlaps` of the prefix input decides.
- Do not use a plain object. It type-checks as an `Artifact` or a `Prefix`, but the build tests each input and output with `instanceof`. As an output, the build ignores it: the tasks that read it do not wait, two tasks can declare it, and `ctx.produced` throws for it. As an input in the shape of a `Prefix`, it counts as an artifact. So its task does not wait for the tasks that write artifacts under it.

## Step 1: one key of a JSON file

In this step you write `JsonKey`, which extends `Artifact`. In the program, the task `make-slug` reads the key `title` and writes the key `slug`. Each key has its own stamp. So `make-slug` skips in build 2, although its run in build 1 changed `data.json`.

- The id is `json:<absolute path>#<key>`. It starts with `json:`, a name for the class. A `FilesystemPrefix` id starts with `file:`, so it never covers a `JsonKey`.
- `stamp()` returns the SHA-256 hash of `JSON.stringify(value)`, or `null` when the key is missing. A `null` output stamp makes the task run, so if a person deletes `slug`, the next build runs `make-slug`. `stamp()` throws when the file is not valid JSON, and the task fails.
- `read()` returns the value, and throws when the key is missing.

```ts
import path from "node:path"
import { Artifact, Build, MemoryStore, Task, type TaskState } from "dapat"

const calls: string[] = [] // stamp(), run and set add to it, in call order

async function load(file: string): Promise<Record<string, unknown>> {
  if (!(await Bun.file(file).exists())) return {} // a missing file has no keys
  return await Bun.file(file).json()
}

class JsonKey<T = unknown> extends Artifact<T> {
  readonly id: string
  constructor(readonly file: string, readonly key: string) {
    super()
    this.id = `json:${path.resolve(file)}#${key}` // "data.json" and "./data.json" give one id
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

async function build(label: string) {
  const build = new Build({ store })
  build.add(new Task({ id: "make-slug", inputs: [title], outputs: [slug], run: makeSlug }))
  await build.run()
  console.log(`${label.padEnd(16)}${calls.splice(0).join(", ")}`)
}

await Bun.write("data.json", JSON.stringify({ title: "Hello World" }))
await build("1. no record")
await build("2. no change")
await Bun.write("data.json", JSON.stringify({ title: "Bye World", slug: "hello-world" }))
await build("3. new title")
```

<!-- output -->
```text
1. no record    stamp title 07cf5509, run, stamp slug 058df09e, set
2. no change    stamp title 07cf5509, stamp slug 058df09e
3. new title    stamp title 737a860c, run, stamp slug af55aa8e, set
```

1. In build 1, the store has no record, so the task runs.
2. In build 2, all stamps equal the record. So the task [skips](guide.md#the-store-and-the-skip-rule), and the build calls no `set`.
3. In build 3, the stamp of `title` differs. So the build runs the task, and does not stamp `slug` first. [How the build uses your classes](#how-the-build-uses-your-classes) gives the full order of calls.

## Step 2: a prefix for keys with unknown names

In this step you extend `Prefix`. `JsonKeyPrefix` stands for the keys of `data.json` that start with `pages/`. The task `split` writes one page key for each line of `book`: `pages/1`, `pages/2`, and so on. It declares the prefix `pages` as its output and [reports](guide.md#outputs-with-unknown-names) each page key. The task `make-index` reads `pages` and writes the page keys, sorted as strings, to the key `index`. `load` and `JsonKey` are as in step 1, without `calls`.

- The id of `pages` is `json:<absolute path>#pages/`, which ends with a [delimiter](guide.md#folders-prefixes). The id of each page key starts with it, so `covers` of `pages` returns true for each page key, and `ctx.produced` does not throw.
- `stamp()` of `JsonKeyPrefix` returns the SHA-256 hash of the lines `<key>=<stamp of the key>`, in key order. dapat exports no helper for this hash, so write these lines yourself. With no keys, `stamp()` returns the hash of an empty string, not `null`, so a task that reads an empty prefix can skip. `keys()` is your own method, as `list()` is for `FilesystemPrefix`. The build does not call it.

```ts
import path from "node:path"
import { Artifact, Build, MemoryStore, Prefix, Task, type Context } from "dapat"
async function load(file: string): Promise<Record<string, unknown>> {
  if (!(await Bun.file(file).exists())) return {} // a missing file has no keys
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
    return Object.hasOwn(doc, this.key) ? Bun.SHA256.hash(JSON.stringify(doc[this.key]), "hex") : null
  }
  async read() {
    const doc = await load(this.file)
    if (!Object.hasOwn(doc, this.key)) throw new Error(`missing ${this.id}`)
    return doc[this.key] as T
  }
}
class JsonKeyPrefix extends Prefix {
  readonly id: string
  constructor(readonly file: string, readonly keyPrefix: string) {
    super()
    this.id = `json:${path.resolve(file)}#${keyPrefix}`
  }
  async keys() {
    const doc = await load(this.file)
    return Object.keys(doc).filter((name) => name.startsWith(this.keyPrefix)).sort()
  }
  async stamp() {
    const lines: string[] = []
    for (const key of await this.keys()) {
      const stamp = await new JsonKey(this.file, key).stamp()
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
async function build(label: string, text: string) {
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
await build("1. no record", "Call me Ishmael.\nSome years ago.")
await build("2. spaces added", "Call me Ishmael.   \nSome years ago.")
await build("3. a new line", "Call me Ishmael.\nSome years ago.\nNever mind how long.")
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
4. This `split` does not delete the page keys of an old, longer book. To delete them, `split` deletes each page key in `pages.keys()` that it did not write, and reports it with `ctx.deleted` ([outputs with unknown names](guide.md#outputs-with-unknown-names)).

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

With a store, the build keeps no stamps between tasks. It stamps an artifact or a prefix for each task that declares it. In [step 2](#step-2-a-prefix-for-keys-with-unknown-names) it stamps `pages` for `split`, as an output, and again for `make-index`, as an input. So make `stamp()` fast.

## The store

To keep records where no [built-in store](builtins.md#stores) can, such as in Redis, write a class that implements [`Store`](api.md#store). A record is a [`TaskState`](api.md#store) with two maps, `inputStamps` and `outputStamps`. In each map, a key is `artifact <id>` or `prefix <id>`, and its value is a stamp. Only an artifact stamp can be `null`, because the build leaves out a prefix whose stamp is `null`. The build calls the store at these times:

| Method | The build calls it |
| --- | --- |
| `get(taskId)` | in skip check 3, after the input stamps ([tree](#how-the-build-uses-your-classes)) |
| `set(taskId, state)` | after each successful run |
| `delete(taskId)` | when a task [leaves the `Build`](guide.md#layout-rules), also when `tasks()` of a `build.each` no longer returns its id. Not on a replace. The current `run()`, or the next one, waits for the call and puts its error in [`result.errors`](guide.md#results-and-failure) |
| `clear()` | never |

- `get` returns `null` for a task id with no record. Otherwise it returns the keys and values that `set` got, `null` values too. When a stamp in the record is not a string or `null`, the build treats the record as missing, and the task runs.
- The build can call the store for several tasks at the same time. It can also call `delete` while a `set` for the same id runs. Do the writes in the order of the calls, as `JsonStore` does.

## Checklist

- Each class extends `Artifact` or `Prefix`, not a plain object ([What you write](#what-you-write)).
- The `id` is the same in each process. It starts with a fixed text, such as `json:`, that no other kind of value uses. A prefix id starts with the same text as the artifacts that it covers, and ends with a delimiter, such as `/` ([prefixes](guide.md#folders-prefixes)).
- An artifact's `stamp()` returns the same string for the same value, and a different string when the value changes. It returns `null` only when the value is missing. It throws for every other error.
- A prefix stamp is a hash of the sorted ids and stamps of the artifacts that it covers. With none, it is still a string, not `null`. Return `null` only when the prefix cannot tell what it covers.
- If your prefix does not compare the start of ids, override both `covers` and `overlaps`.
- Your task code writes each value all at once, for example to a temporary file and then a rename. Then a `stamp()` never reads half a value. The samples on this page use a plain `Bun.write` to stay short.
- A task that writes artifacts with unknown names declares a prefix that covers their ids ([outputs with unknown names](guide.md#outputs-with-unknown-names)).

## Next

[Write a matcher](write-a-matcher.md) uses `JsonKey` again: its matcher finds the keys of a JSON file, and [`build.each`](guide.md#buildeach) makes a task for each key.
