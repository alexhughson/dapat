# Write an artifact type

An **artifact type** is a class that extends `Artifact`. Write one when tasks read or write a value that dapat has no class for, such as a database row. On this page you write `JsonKey` for one key of a JSON file, and the `Prefix` class `JsonKeyPrefix` for the keys under `pages/`. Read part 1 of the [guide](guide.md) first.

## What you write

- Extend `Artifact` for one value: give it an `id`, a `stamp()` and a `read()`.
- Extend [`Prefix`](guide.md#folders-prefixes) for a group of artifacts: give it an `id` and a `stamp()`.
- Extend the class, not a plain object. The build tests each output with `instanceof`, so no task waits for a plain object, and `ctx.produced` throws for it.
- Only `stamp()` decides a skip. `covers` and `overlaps` decide the order of the tasks and which reports a task can make.

## Step 1: one key of a JSON file

Save this as `json-key.ts`. It holds `JsonKey`, and the helpers `load` and `writeKey` that the programs on this page use:

<!-- file: json-key.ts -->
```ts
import path from "node:path"
import { Artifact } from "dapat"

export async function load(file: string): Promise<Record<string, unknown>> {
  const exists = await Bun.file(file).exists()
  if (!exists) {
    return {} // a missing file has no keys
  }
  return await Bun.file(file).json()
}

export async function writeKey(file: string, key: string, value: unknown) {
  const doc = await load(file)
  doc[key] = value
  await Bun.write(file, JSON.stringify(doc))
}

export class JsonKey<T = unknown> extends Artifact<T> {
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
```

- The id is `json:<absolute path>#<key>`. It starts with `json:`, a fixed text that no other kind of value uses. The `#` ends the path, so a prefix for the keys of `data.json` does not cover the keys of `data.json.bak`. A task that reads `data.json` as a `FileArtifact` does not wait for the tasks that write its keys, because a file id starts with `file:`.
- `stamp()` returns the SHA-256 hash of `JSON.stringify(value)`, or `null` when the key is missing. For an input, the build compares a `null` stamp with the record, as it does any other stamp ([the skip rule](guide.md#the-skip-rule)). `stamp()` throws when the file is not valid JSON.
- `read()` returns the value, and throws when the key is missing.

This program shows that each key has its own stamp:

```ts
import { JsonKey, writeKey } from "./json-key"

const title = new JsonKey<string>("data.json", "title")
await writeKey("data.json", "title", "Hello World")
const first = await title.stamp()
await writeKey("data.json", "draft", true)
const second = await title.stamp()
await writeKey("data.json", "title", "Bye World")
const third = await title.stamp()
const id = title.id.replace(process.cwd(), ".") // print "." in place of the current folder
console.log(`id: ${id}`)
console.log(`same stamp after draft changed: ${first === second}`)
console.log(`same stamp after title changed: ${second === third}`)
```

<!-- output -->
```text
id: json:./data.json#title
same stamp after draft changed: true
same stamp after title changed: false
```

## Step 2: a prefix for keys with unknown names

`JsonKeyPrefix` extends `Prefix`. It stands for the keys of `data.json` that start with `pages/`. The task `split` writes one page key for each line of `book`, declares the prefix `pages` as its output, and [reports](guide.md#outputs-with-unknown-names) each page key. The task `make-index` reads `pages` and writes the page keys to the key `index`. The program imports `JsonKey`, `load` and `writeKey` from `json-key.ts`.

```ts
import path from "node:path"
import { Build, MemoryStore, Prefix, Task, type Context } from "dapat"
import { JsonKey, load, writeKey } from "./json-key"

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
  await writeKey("data.json", "index", keys)
}

async function split(ctx: Context) {
  const text = await book.read()
  const lines = text.split("\n")
  for (const [i, line] of lines.entries()) {
    const page = new JsonKey("data.json", `pages/${i + 1}`)
    await writeKey("data.json", page.key, line.trim())
    ctx.produced(page)
  }
}

async function runBuild(label: string, text: string) {
  await writeKey("data.json", "book", text)
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

- The id of `pages` is `json:<absolute path>#pages/`, which ends with a [delimiter](builtins.md#idprefix). The id of each page key starts with it, so `covers` of `pages` returns true for each page key, and `ctx.produced` does not throw.
- `stamp()` of `JsonKeyPrefix` returns the SHA-256 hash of the lines `<key>=<stamp of the key>`, in key order. So a changed value, a new key and a deleted key each give a new stamp. With no keys, `stamp()` returns the hash of an empty string, not `null`, so a task that reads an empty prefix can skip.

In build 1, `index` lists both page keys, although the program adds `make-index` first. `make-index` waits, because the output `pages` of `split` has the id of its input `pages`. In build 2, `book` changed, so `split` runs, but it trims the spaces and writes the same page values. So the stamps of `pages` and `index` equal the record of `make-index`, and it skips.

This `split` does not delete the page keys of an old, longer book. To delete them, delete each old key and report it with `ctx.deleted`, as `split` does in Outputs with unknown names in the guide.

## How the build uses your classes

The build connects outputs to inputs to find the [producers](guide.md#what-a-build-does) of a task. It also connects each `ctx.produced` and `ctx.deleted` to the outputs of the task. [One task](semantics.md#one-task) gives the order of these calls.

- Two artifacts connect when their ids are equal.
- For a prefix and an artifact, the `covers` of the prefix decides.
- For two prefixes, the `overlaps` of the prefix input decides.
- `covers` and `overlaps` get the artifacts and prefixes of every task, of any class. Make them fast, give the same result for the same ids, and check the class before you read a field that only your class has.
- A throw in `covers` or `overlaps` while a task looks for its producers leaves the task out of the `Result`, and `result.success` stays true. The throw is an unhandled rejection. Bun prints it, and the process exits with code 1 when it ends. A throw in `ctx.produced` or `ctx.deleted` fails the reporting task.
- The build calls no `exists`, `delete` or `list` method. A subclass can add one, as `FilesystemPrefix` adds `list()`. To delete a value, your task deletes it, then reports it with `ctx.deleted`.

Some prefixes do not compare the start of ids, such as a prefix for rows 100 to 199 of a table. For such a prefix, override `covers` and `overlaps`. Return `true` from `overlaps` when both prefixes can cover one id. An artifact input of any class waits for your prefix output when your `covers` returns true for it. A task whose prefix input has the default `overlaps`, such as an `IdPrefix`, waits for your prefix output only when one id starts with the other. To make such a task wait, give it an input of your own prefix class. With an override, n tasks that use such a prefix cost about n² ([Scheduling cost](semantics.md#scheduling-cost)), even when the override keeps the default rule.

## Checklist

- The `id` is the same in each process. It starts with a fixed text, such as `json:`, that no other kind of value uses. A prefix id starts with the same text as the artifacts that it covers, and ends with a delimiter, such as `/` ([IdPrefix](builtins.md#idprefix)).
- An artifact's `stamp()` returns the same string for the same value, and a different string when the value changes. It returns `null` only when the value is missing. It throws for every other error.
- A prefix stamp changes when a task or a person adds, deletes or changes an artifact that the prefix covers. Otherwise, the stamp stays the same. With no artifacts, it is still a string, not `null`. Return `null` only when the prefix cannot tell what it covers.
- `stamp()` is fast: with a store, the build stamps an artifact again for each task that declares it. Tasks that do not wait for each other can call it at the same time, so a cache in it must allow this.
- A prefix stamp does not include the store's records, such as the `dapat_task_state` table of a `SqliteStore` in the same database. Each `set` changes that table, so each task that uses the prefix runs on every build ([keep the store file out of task folders](guide.md#keep-the-store-file-out-of-task-folders)).
- Your task code writes each value completely in one operation, such as a temporary file and a rename. The samples on this page use a plain `Bun.write` to stay short. Tasks that write different keys of one file do not wait for each other. Make these writes wait for each other, as [`JsonStore`](../contrib/store/json.ts) does with a promise chain. If they do not, a later write can remove the change of an earlier one.

## Next

[Write a matcher](write-a-matcher.md) makes [`build.each`](guide.md#buildeach) find S3 objects. To keep the records in a database of your own, see [Write a store](builtins.md#write-a-store). To name an output of your type in `build.each`, write an [output template](build-each.md#output-templates) for it.
