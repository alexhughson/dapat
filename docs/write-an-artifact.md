# Write an artifact type

An **artifact type** is a class that extends `Artifact`. Write one when tasks read or write a value that dapat has no class for, such as a database row. On this page you write `JsonKey` for one key of a JSON file, and the `Prefix` class `JsonKeyPrefix` for the keys under `pages/`. Read part 1 of the [guide](guide.md) first.

## What you write

Extend `Artifact` for one value. Extend [`Prefix`](guide.md#folders-prefixes) for a group of artifacts, usually the artifacts whose ids start with one id. Both classes come from `"dapat"`:

| Member | `Artifact` | `Prefix` |
| --- | --- | --- |
| `id` | abstract | abstract |
| `stamp()` | abstract. Return `null` when the value is missing | default: `null`, so each task that uses the prefix runs on every build ([the skip rule](guide.md#the-store-and-the-skip-rule)) |
| `read()` | abstract. Only your task code calls it | – |
| `covers(a)` | – | default: `a.id` starts with `this.id` |
| `overlaps(p)` | – | default: `p.id` starts with `this.id`, or the reverse |

`covers` and `overlaps` decide only the order of the tasks and which reports a task can make. Of these methods, only `stamp()` decides a skip.

- Extend the class. The build tests each input and output with `instanceof`, so the tasks that read a plain object do not wait for the task that writes it ([How the build uses your classes](#how-the-build-uses-your-classes)).
- Make `covers` and `overlaps` fast, and make them give the same result for the same ids. They get the artifacts and prefixes of every task, of any class. Check the class before you read a field that only your class has. Do not throw.
- The build calls no `exists`, `delete` or `list` method. A subclass can add one, as `FilesystemPrefix` adds `list()`. To delete a value, your task deletes it, then [reports](guide.md#outputs-with-unknown-names) it with `ctx.deleted`.

## Step 1: one key of a JSON file

`JsonKey` extends `Artifact`. The task `make-slug` reads the key `title` and writes the key `slug`. Each key has its own stamp. So `make-slug` skips in builds 2 and 3, although `data.json` changed before each of them.

- The id is `json:<absolute path>#<key>`. It starts with `json:`, a fixed text that no other kind of value uses. The `#` ends the path, so a prefix for the keys of `data.json` does not cover the keys of `data.json.bak`. A `FileArtifact` or `FilesystemPrefix` id starts with `file:`. So a task that reads `data.json` as a file does not wait for the tasks that write its keys. Declare each key that a task reads as a `JsonKey` input.
- `stamp()` returns the SHA-256 hash of `JSON.stringify(value)`, or `null` when the key is missing. For an output, a `null` stamp makes the task run. For an input, the build compares a `null` stamp with the record, as it does any other stamp ([the skip rule](guide.md#the-store-and-the-skip-rule)). `stamp()` throws when the file is not valid JSON.
- `read()` returns the value, and throws when the key is missing.

```ts
import path from "node:path"
import { Artifact, Build, MemoryStore, Task } from "dapat"

async function load(file: string): Promise<Record<string, unknown>> {
  const exists = await Bun.file(file).exists()
  if (!exists) {
    return {} // a missing file has no keys
  }
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
    if (!Object.hasOwn(doc, this.key)) {
      return null
    }
    return Bun.SHA256.hash(JSON.stringify(doc[this.key]), "hex")
  }
  async read() {
    const doc = await load(this.file)
    if (!Object.hasOwn(doc, this.key)) {
      throw new Error(`missing ${this.id}`)
    }
    return doc[this.key] as T
  }
}

const store = new MemoryStore()
const title = new JsonKey<string>("data.json", "title")
const slug = new JsonKey("data.json", "slug")

async function makeSlug() {
  const text = await title.read()
  const doc = await load("data.json")
  doc.slug = text.toLowerCase().replaceAll(" ", "-")
  await Bun.write("data.json", JSON.stringify(doc))
}

async function runBuild(label: string) {
  const build = new Build({ store })
  build.add(new Task({ id: "make-slug", inputs: [title], outputs: [slug], run: makeSlug }))
  const result = await build.run()
  const ran = result.executed.map((task) => task.id).sort()
  const skipped = result.skipped.map((task) => task.id).sort()
  console.log(`${label.padEnd(16)}ran [${ran.join(" ")}] skipped [${skipped.join(" ")}]`)
}

await Bun.write("data.json", JSON.stringify({ title: "Hello World" }))
await runBuild("1. no record")
await runBuild("2. no change")
await Bun.write("data.json", JSON.stringify({ title: "Hello World", slug: "hello-world", draft: true }))
await runBuild("3. other key")
await Bun.write("data.json", JSON.stringify({ title: "Bye World", slug: "hello-world" }))
await runBuild("4. new title")
```

<!-- output -->
```text
1. no record    ran [make-slug] skipped []
2. no change    ran [] skipped [make-slug]
3. other key    ran [] skipped [make-slug]
4. new title    ran [make-slug] skipped []
```

## Step 2: a prefix for keys with unknown names

`JsonKeyPrefix` extends `Prefix`. It stands for the keys of `data.json` that start with `pages/`. The task `split` writes one page key for each line of `book`: `pages/1`, `pages/2`, and so on. It declares the prefix `pages` as its output and [reports](guide.md#outputs-with-unknown-names) each page key. The task `make-index` reads `pages` and writes the page keys to the key `index`. `load` and `JsonKey` are as in step 1. `writeKey` reads `data.json` and writes it back, so two tasks must not run it at the same time ([checklist](#checklist)).

- The id of `pages` is `json:<absolute path>#pages/`, which ends with a [delimiter](guide.md#folders-prefixes). The id of each page key starts with it, so `covers` of `pages` returns true for each page key, and `ctx.produced` does not throw.
- `stamp()` of `JsonKeyPrefix` returns the SHA-256 hash of the lines `<key>=<stamp of the key>`, in key order. So a changed value, a new key and a deleted key each give a new stamp. With no keys, `stamp()` returns the hash of an empty string, not `null`, so a task that reads an empty prefix can skip.

```ts
import path from "node:path"
import { Artifact, Build, MemoryStore, Prefix, Task, type Context } from "dapat"

async function load(file: string): Promise<Record<string, unknown>> {
  const exists = await Bun.file(file).exists()
  if (!exists) {
    return {} // a missing file has no keys
  }
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
    if (!Object.hasOwn(doc, this.key)) {
      return null
    }
    return Bun.SHA256.hash(JSON.stringify(doc[this.key]), "hex")
  }
  async read() {
    const doc = await load(this.file)
    if (!Object.hasOwn(doc, this.key)) {
      throw new Error(`missing ${this.id}`)
    }
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
    const keys = Object.keys(doc).filter((key) => key.startsWith(this.keyPrefix))
    return keys.sort()
  }
  async stamp() {
    const doc = await load(this.file) // one read for all keys
    const keys = Object.keys(doc).filter((key) => key.startsWith(this.keyPrefix))
    const lines: string[] = []
    for (const key of keys.sort()) {
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

1. In build 1, `index` lists both page keys, although the program adds `make-index` first. `make-index` waits, because the output `pages` of `split` has the id of its input `pages` ([How the build uses your classes](#how-the-build-uses-your-classes)).
2. In build 2, `book` changed, so `split` runs. It trims the spaces, so it writes the same values to the same page keys. So the stamps of `pages` and `index` equal the record of `make-index`, and it skips.

To delete the page keys of an old, longer book, do as `split` does in [outputs with unknown names](guide.md#outputs-with-unknown-names).

## How the build uses your classes

The build connects outputs to inputs to find the [producers](guide.md#what-a-build-does) of a task. It also connects each `ctx.produced` and `ctx.deleted` to the outputs of the task:

- Two artifacts connect when their ids are equal.
- For a prefix and an artifact, the `covers` of the prefix decides.
- For two prefixes, the `overlaps` of the prefix input decides.

A throw in `covers` or `overlaps` while a task looks for its producers leaves the task out of the `Result`, and `result.success` stays true. The throw is an unhandled rejection. Bun prints it, and the process exits with code 1 when it ends. A throw in `ctx.produced` or `ctx.deleted` fails the reporting task.

A plain-object input counts as an artifact, even when it has `covers`. A plain-object output gets no `produced` event, and the tasks that read it do not wait. Two tasks can declare it, and `ctx.produced` throws for it.

[One task](semantics.md#one-task) gives the order in which the build calls your methods and the store. Two rules follow from it:

- With a store, the build stamps an artifact or a prefix again for each task that declares it. In [step 2](#step-2-a-prefix-for-keys-with-unknown-names), it stamps `pages` for `split` and again for `make-index`. So make `stamp()` fast.
- Tasks that do not wait for each other can call `stamp()` of one artifact at the same time. A cache in `stamp()` must allow this.

## A prefix that does not compare id starts

Some prefixes do not compare the start of ids, such as a prefix for rows 100 to 199 of a table. For such a prefix, override `covers` and `overlaps`. Return `true` from `overlaps` when both prefixes can cover one id. An artifact input of any class waits for your prefix output when your `covers` returns true for it. For a prefix input, the build calls `overlaps` of the input, not of the output ([How the build uses your classes](#how-the-build-uses-your-classes)). So a task whose input has the default `overlaps`, such as an `IdPrefix`, waits for your prefix output only when one id starts with the other. To make such a task wait, give it an input of your own prefix class. With an override, n tasks that use such a prefix cost about n² ([Scheduling cost](semantics.md#scheduling-cost)), even when the override keeps the default rule.

## Checklist

- Each class extends `Artifact` or `Prefix`, not a plain object ([What you write](#what-you-write)).
- The `id` is the same in each process. It starts with a fixed text, such as `json:`, that no other kind of value uses. A prefix id starts with the same text as the artifacts that it covers, and ends with a delimiter, such as `/` ([prefixes](guide.md#folders-prefixes)).
- An artifact's `stamp()` returns the same string for the same value, and a different string when the value changes. It returns `null` only when the value is missing. It throws for every other error.
- A prefix stamp changes when a task or a person adds, deletes or changes an artifact that the prefix covers. Otherwise, the stamp stays the same. With no artifacts, it is still a string, not `null`. Return `null` only when the prefix cannot tell what it covers.
- `covers` and `overlaps` are fast, give the same result for the same ids, and never throw. Override both only when your prefix does not compare the start of ids, because an override costs more time ([a prefix that does not compare id starts](#a-prefix-that-does-not-compare-id-starts)).
- A prefix stamp does not include the store's records, such as the `dapat_task_state` table of a `SqliteStore` in the same database. Each `set` changes that table, so each task that uses the prefix runs on every build ([layout rules](guide.md#layout-rules)).
- Your task code writes each value completely in one operation, so a `stamp()` never reads half a value. For a file, write a temporary file, then rename it. The samples on this page use a plain `Bun.write` to stay short.
- Tasks that write different keys of one file do not wait for each other. When each write reads the whole file and writes it back, a later write can remove the change of an earlier one. dapat gives no error. Make the writes to one file wait for each other, as [`JsonStore`](../contrib/store/json.ts) does with a promise chain.
- A task that writes artifacts with unknown names declares a prefix that covers their ids ([outputs with unknown names](guide.md#outputs-with-unknown-names)). No other task writes artifacts under that prefix ([layout rules](guide.md#layout-rules)).

## Next

[Write a matcher](write-a-matcher.md) makes [`build.each`](guide.md#buildeach) find S3 objects, with a matcher of your own. To keep the records in a database of your own, see [Write a store](builtins.md#write-a-store). To name an output of your type in `build.each`, write an [output template](build-each.md#output-templates) for it.
