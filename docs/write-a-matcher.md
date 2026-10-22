# Write a matcher

Write a [matcher](guide.md#buildeach) when `FileMatcher` cannot find your artifacts, such as JSON keys, S3 objects or database rows. In [step 1](#step-1-find-the-keys-in-a-scan), the matcher `PageKeys` finds the page keys of a JSON file in its scan. In [step 2](#step-2-hear-the-builds-events), it also hears the build's events. Then it sends a found or a gone when a task adds or deletes a key. First read [build.each](build-each.md), and [step 1 of Write an artifact type](write-an-artifact.md#step-1-one-key-of-a-json-file) for the `JsonKey` class that this page uses.

## What you write

Extend `Matcher` from `"dapat"`. `D` is the type of the data of each match: one artifact, or a [list](#lists) of artifacts. `build.each` gives `matched.<name>.data` this type.

<!-- no-run -->
```ts
type Vars = Readonly<Record<string, string>> // var name → value
abstract class Matcher<D extends Artifact | readonly Artifact[]> {
  abstract readonly varNames: readonly string[]
  abstract scan(signal: AbortSignal): Promise<void>
  receiveArtifactEvent(event: ArtifactEvent): void
  protected send(event:
    | { kind: "found"; matched: { vars: Vars; data: D } }
    | { kind: "gone"; vars: Vars }): void
}
```

- `varNames` holds the var names of each match. Set it in the class or the constructor. `build.each` reads it when you call `build.each`, to plan the [joins](build-each.md#joins). Each found and gone must have exactly these names, or `run()` rejects.
- `scan(signal)` finds the artifacts that exist now, and sends a found for each match. The first `run()` calls each scan one time, before any task starts ([how build.each works](build-each.md#how-buildeach-works)). If your scan can hang, make it throw after a timeout, or `run()` waits forever ([limits](limits.md#stamps-and-matchers)).
  - `signal` aborts only on a [fatal error](guide.md#results-and-failure), such as a throw from another scan. If your scan throws, that is a fatal error too: `run()` rejects, and no task runs.
- `receiveArtifactEvent(event)` gets each [event](guide.md#events) of the build, in the order that the build sends them. Override it to send found or gone when a task declares, produces, deletes or stops declaring an artifact ([step 2](#step-2-hear-the-builds-events)). The default does nothing, so an artifact that a task makes during the run gets its tasks only in the next build.
  - The build calls it as a [subscriber](guide.md#events), inside the call that sends the event, such as `ctx.produced`. So keep it synchronous, with no I/O and no throw.
- `send(event)` gives one found or gone to each `build.each` that uses the matcher. `build.each` calls `tasks()` for each new or changed set before `send` returns.
  - A found with the vars and artifact ids of a current match changes nothing. A gone for vars with no match changes nothing ([each case](semantics.md#buildeach-internals)).

## Step 1: find things in a scan

`PageKeys` finds each key `pages/<page>` of a JSON file. Its scan loads the file and sends a found for each such key, with the var `page` and a `JsonKey` as data. Check `signal.aborted` after each I/O call. After a [fatal error](semantics.md#fatal-errors), the build ignores each found, so the check only stops work that has no effect.

The program repeats `load` and `JsonKey` from [step 1 of Write an artifact type](write-an-artifact.md#step-1-one-key-of-a-json-file), without the `calls` log. Here `JsonKey.file` holds the absolute path. Before build 2, the program removes `pages/usage` from `data.json` and adds `pages/faq`.

```ts
import path from "node:path"
import { Artifact, Build, Matcher, MemoryStore, Task } from "dapat"
import { FileArtifact } from "dapat/contrib"
async function load(file: string): Promise<Record<string, unknown>> {
  if (!(await Bun.file(file).exists())) return {} // a missing file has no keys
  return await Bun.file(file).json()
}
class JsonKey<T = unknown> extends Artifact<T> {
  readonly file: string
  readonly id: string
  constructor(file: string, readonly key: string) {
    super()
    this.file = path.resolve(file)
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
class PageKeys extends Matcher<JsonKey<string>> {
  readonly varNames = ["page"]
  constructor(readonly file: string) { super() }
  async scan(signal: AbortSignal) {
    const doc = await load(this.file)
    if (signal.aborted) return // a fatal error happened during the load
    for (const key of Object.keys(doc)) {
      if (!key.startsWith("pages/")) continue
      const vars = { page: key.slice("pages/".length) }
      const data = new JsonKey<string>(this.file, key)
      this.send({ kind: "found", matched: { vars, data } })
    }
  }
}
const store = new MemoryStore()
async function build(label: string) {
  const build = new Build({ store })
  build.each({
    matchersByName: { page: new PageKeys("data.json") },
    *tasks(vars, matched) {
      const source = matched.page.data
      const html = new FileArtifact(`out/${vars.page}.html`)
      const run = async () => {
        const text = await source.read()
        await Bun.write(html.path, `<p>${text}</p>`)
      }
      yield new Task({ id: `html:${vars.page}`, inputs: [source], outputs: [html], run })
    },
  })
  const result = await build.run()
  const ran = result.executed.map((task) => task.id).sort()
  const skipped = result.skipped.map((task) => task.id).sort()
  console.log(`${label}: ran [${ran.join(" ")}] skipped [${skipped.join(" ")}]`)
}
await Bun.write("data.json", JSON.stringify({ title: "Docs", "pages/intro": "Hello", "pages/usage": "Run it" }))
await build("build 1")
await Bun.write("data.json", JSON.stringify({ title: "Docs", "pages/intro": "Hello", "pages/faq": "Ask" }))
await build("build 2")
```

<!-- output -->
```text
build 1: ran [html:intro html:usage] skipped []
build 2: ran [html:faq] skipped [html:intro]
```

Each `Build` starts with no matches. So a scan sends only founds, and `pages/usage` needs no gone. Build 2 has no task `html:usage`, but its output file and its record stay ([layout rules](guide.md#layout-rules)).

## Step 2: hear the build's events

`PageKeys` now overrides `receiveArtifactEvent`. So `build.each` makes and removes tasks for the page keys that tasks declare, report and delete during the run. The program repeats `load` and `JsonKey` from [step 1](#step-1-find-things-in-a-scan).

- `PageKeys` uses the match rule of `FileMatcher` ([matches during the run](build-each.md#matches-during-the-run)). A key has a match while it is in the file, as far as the matcher knows, or while a task declares it. So do not send a gone for each `withdrawn` or `deleted` event. The key can still be in the file, or a task can still declare it.
- `curate` declares an [`IdPrefix`](builtins.md#idprefix) that covers each page key, so it can [report](guide.md#outputs-with-unknown-names) them. It changes `pages/intro`, adds `pages/faq` and deletes `pages/old`, and it reports each change.

```ts
import path from "node:path"
import { Artifact, Build, IdPrefix, Matcher, Task, type ArtifactEvent } from "dapat"
import { FileArtifact } from "dapat/contrib"

async function load(file: string): Promise<Record<string, unknown>> {
  if (!(await Bun.file(file).exists())) return {} // a missing file has no keys
  return await Bun.file(file).json()
}

class JsonKey<T = unknown> extends Artifact<T> {
  readonly file: string
  readonly id: string
  constructor(file: string, readonly key: string) {
    super()
    this.file = path.resolve(file)
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

class PageKeys extends Matcher<JsonKey<string>> {
  readonly varNames = ["page"]
  readonly file: string
  private inFile = new Set<string>() // keys from the scan and produced events, minus deleted events
  private declared = new Set<string>() // keys from promised events, minus withdrawn events
  constructor(file: string) {
    super()
    this.file = path.resolve(file)
  }
  async scan(signal: AbortSignal) {
    const doc = await load(this.file)
    if (signal.aborted) return // a fatal error happened during the load
    for (const key of Object.keys(doc)) {
      this.inFile.add(key)
      this.update(key)
    }
  }
  override receiveArtifactEvent(event: ArtifactEvent) {
    const output = "output" in event ? event.output : event.artifact
    if (!(output instanceof JsonKey)) return // such as the IdPrefix of curate
    if (output.file !== this.file) return // a key of another file
    if (event.kind === "promised") this.declared.add(output.key)
    if (event.kind === "withdrawn") this.declared.delete(output.key)
    if (event.kind === "produced") this.inFile.add(output.key)
    if (event.kind === "deleted") this.inFile.delete(output.key)
    this.update(output.key)
  }
  private update(key: string) {
    if (!key.startsWith("pages/")) return
    const vars = { page: key.slice("pages/".length) }
    const hasMatch = this.inFile.has(key) || this.declared.has(key)
    if (hasMatch) {
      const data = new JsonKey<string>(this.file, key)
      this.send({ kind: "found", matched: { vars, data } })
      return
    }
    this.send({ kind: "gone", vars })
  }
}

await Bun.write("data.json", JSON.stringify({ "pages/intro": "Hello", "pages/old": "Bye" }))
const build = new Build()
build.each({
  matchersByName: { page: new PageKeys("data.json") },
  *tasks(vars, matched) {
    const source = matched.page.data
    const html = new FileArtifact(`out/${vars.page}.html`)
    const run = async () => { await Bun.write(html.path, `<p>${await source.read()}</p>`) }
    yield new Task({ id: `html:${vars.page}`, inputs: [source], outputs: [html], run })
  },
})
const pages = new IdPrefix(`json:${path.resolve("data.json")}#pages/`) // covers each page key
build.add(new Task({ id: "curate", outputs: [pages], run: async (ctx) => {
  await Bun.write("data.json", JSON.stringify({ "pages/intro": "Hi", "pages/faq": "Ask" }))
  ctx.produced(new JsonKey("data.json", "pages/intro"))
  ctx.produced(new JsonKey("data.json", "pages/faq"))
  ctx.deleted(new JsonKey("data.json", "pages/old"))
} }))
const result = await build.run()
const ran = result.executed.map((task) => task.id).sort()
const cancelled = result.cancelled.map((task) => task.id).sort()
console.log(`ran [${ran.join(" ")}] cancelled [${cancelled.join(" ")}]`)
```

<!-- output -->
```text
ran [curate html:faq html:intro] cancelled [html:old]
```

For the report of `pages/intro`, `PageKeys` sends a found with the same id, so it changes nothing. `html:intro` waits for `curate`, because the prefix of `curate` covers `pages/intro`. The reports of `pages/faq` and `pages/old` add and remove a task before `ctx.produced` or `ctx.deleted` returns. `html:faq` runs in the same `run()`. `html:old` waits for `curate` when it is removed, so it is [cancelled](guide.md#results-and-failure).

```text
curate calls ctx.produced(pages/faq)
└─ PageKeys.receiveArtifactEvent(produced) → send(found faq) → build.each adds html:faq
curate calls ctx.deleted(pages/old)
└─ PageKeys.receiveArtifactEvent(deleted) → send(gone old) → build.each removes html:old
```

## Send from a watcher

`send` is protected, so other code, such as a file watcher, cannot call it. Give your matcher a public method that changes `inFile` and calls `update`, as `receiveArtifactEvent` does in [step 2](#step-2-hear-the-builds-events). After the scans of the first `run()`, `build.each` adds the tasks of each found at once. They start with no new `run()` call, also after `run()` resolves ([the order rule](semantics.md#the-order-rule)). Call `run()` again to wait for them. Its `Result` also holds the tasks of earlier runs ([results](guide.md#results-and-failure)).

## Lists

Use a list when one task reads many artifacts, as with [FileGroupMatcher](build-each.md#filegroupmatcher). Then `D` is a list, such as `readonly JsonKey[]`, and each found carries the whole list.

- Put the artifacts with the same var values into one list. In `scan`, send one found for each list.
- When an artifact gets or loses its match ([step 2](#step-2-hear-the-builds-events)), send a found with the new list.
- Send each list in one fixed order, for example sorted by id. The same ids in another order are new data, so `tasks()` runs again for the [joined set](guide.md#buildeach).
- When a list becomes empty, send a gone. A found with `[]` makes tasks for an empty list.

## Checklist

- Send vars with exactly the names in `varNames`, or `run()` rejects. Give each var a string value, because dapat does not check it.
- Send data whose id stays the same for the same key, file or row ([artifact checklist](write-an-artifact.md#checklist)). A new id makes the task run again: in the next build, and in the same run after a repeated found.
- Send a gone only when an artifact loses its match, not for each `deleted` or `withdrawn` event ([step 2](#step-2-hear-the-builds-events)).
- Keep `receiveArtifactEvent` synchronous, with no I/O and no throw.
- Make `scan` return after it sends the current matches. To save work, check `signal.aborted` after slow I/O.
- A task that reports artifacts that your matcher finds declares an output that covers them ([outputs with unknown names](guide.md#outputs-with-unknown-names)).
- Parse keys or object names with your own code, for example a `RegExp`. dapat exports no pattern parser ([imports](api.md#imports)).
- Make a new matcher for each `Build`. If two `Build` objects use one matcher, `build.each` of the second `Build` throws.

## Next

[How a build works](semantics.md) tells when each event reaches your matcher, when its tasks start, and which errors are fatal. [API](api.md#matcher) lists each member of `Matcher` and the text of [each error message](api.md#error-messages).
