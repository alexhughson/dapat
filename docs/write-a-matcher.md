# Write a matcher

Write a [matcher](guide.md#buildeach) when `FileMatcher` and `FileGroupMatcher` cannot find your artifacts, such as JSON keys, S3 objects or database rows. In [step 1](#step-1-find-the-keys-in-a-scan), the matcher `PageKeys` finds the page keys of a JSON file in its scan. In [step 2](#step-2-get-the-builds-events), it also sends a found or a gone when a task declares or reports a key. First read [build.each](build-each.md), and [step 1 of Write an artifact type](write-an-artifact.md#step-1-one-key-of-a-json-file) for the `JsonKey` class that this page uses.

## What you write

Extend `Matcher` from `"dapat"`. `D` is the type of the data of each match: one artifact, or a [list](#lists) of artifacts.

<!-- no-run -->
```ts
type Vars = Readonly<Record<string, string>> // var name → value
type MatchedData = Artifact | readonly Artifact[]
type MatchedArtifactEvent<D> =
  | { kind: "found"; matched: { vars: Vars; data: D } }
  | { kind: "gone"; vars: Vars }
abstract class Matcher<D extends MatchedData = MatchedData> extends Emitter<MatchedArtifactEvent<D>> {
  abstract readonly varNames: readonly string[]
  abstract scan(signal: AbortSignal): Promise<void>
  receiveArtifactEvent(event: ArtifactEvent): void
  // from Emitter: subscribe(listener), and the protected send(event)
}
```

- `varNames` holds the var names of each match. Set it in the class or the constructor: `build.each` reads it when you call `build.each`. Each found and gone must have exactly these names, or `run()` rejects.
- `scan(signal)` finds the artifacts that exist now, and sends a found for each match. The first `run()` calls each scan one time, before any task starts ([how build.each works](build-each.md#how-buildeach-works)). If your scan can hang, make it throw after a timeout, or `run()` waits forever ([limits](limits.md#stamps-and-matchers)).
  - `signal` aborts only on a [fatal error](guide.md#results-and-failure), such as a throw from another scan. If your scan throws, `run()` rejects, and no task runs.
- `receiveArtifactEvent(event)` gets each [event](guide.md#events) of the build. Override it to send found or gone at an event ([step 2](#step-2-get-the-builds-events)). The default does nothing, so an artifact that a task makes during the run gets its tasks only in the next build.
  - The build calls it as a [subscriber](guide.md#events), inside the call that sends the event, such as `ctx.produced`. So keep it synchronous, with no I/O and no throw. A throw, or a returned promise such as from an `async` override, is a [fatal error](semantics.md#fatal-errors): `run()` rejects.
  - The first `run()` sends the `promised` events of the tasks already in the build before it calls `scan`. So set up the state of your matcher in its fields or its constructor, not in `scan`.
- `send(event)` gives one found or gone to each `build.each` that uses the matcher. `build.each` calls `tasks()` for each new or changed set before `send` returns.
  - A found with the vars and artifact ids of a current match, or a gone for vars with no match, changes nothing ([each case](semantics.md#buildeach-internals)).

## Step 1: find the keys in a scan

The scan of `PageKeys` sends a found for each key `pages/<page>` of a JSON file, with the var `page` and a `JsonKey` as data. Check `signal.aborted` after each I/O call. This only saves work: after a [fatal error](semantics.md#fatal-errors), the build ignores each found.

The program repeats `load` and `JsonKey` from [step 1 of Write an artifact type](write-an-artifact.md#step-1-one-key-of-a-json-file), without the `calls` log.

```ts
import path from "node:path"
import { Artifact, Build, Matcher, MemoryStore, Task } from "dapat"
import { FileArtifact } from "dapat/contrib"

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

async function runBuild(label: string) {
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
await runBuild("build 1")
await Bun.write("data.json", JSON.stringify({ title: "Docs", "pages/intro": "Hello", "pages/faq": "Ask" }))
await runBuild("build 2")
```

<!-- output -->
```text
build 1: ran [html:intro html:usage] skipped []
build 2: ran [html:faq] skipped [html:intro]
```

Each `Build` starts with no matches. So a scan sends only founds, and `pages/usage` needs no gone. The output file and record of `html:usage` stay ([layout rules](guide.md#layout-rules)).

## Step 2: get the build's events

`PageKeys` now overrides `receiveArtifactEvent`. So `build.each` makes and removes tasks for the page keys that tasks declare or report during the run. The program repeats `load` and `JsonKey` from [step 1](#step-1-find-the-keys-in-a-scan).

- A key has a match from the scan or a `produced` event until a `deleted` event. It also has a match from a `promised` event until a `withdrawn` or `deleted` event. So do not send a gone for each `withdrawn` event, because the key can still be in the file. This is the rule of `FileMatcher` ([matches during the run](build-each.md#matches-during-the-run)), but `FileMatcher` keeps the match of a declared file after a `deleted` event ([known issue 8](limits.md#known-issues-in-010)).
- `curate` declares an [`IdPrefix`](builtins.md#idprefix) that covers each page key, so it can [report](guide.md#outputs-with-unknown-names) them.

```ts
import path from "node:path"
import { Artifact, Build, IdPrefix, Matcher, Task, type ArtifactEvent, type Context } from "dapat"
import { FileArtifact } from "dapat/contrib"

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
  private declared = new Set<string>() // keys from promised events, minus withdrawn and deleted events
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
    const ref = "output" in event ? event.output : event.artifact
    if (!(ref instanceof JsonKey)) return // such as the IdPrefix of curate
    if (ref.file !== this.file) return // a key of another file
    if (event.kind === "promised") this.declared.add(ref.key)
    if (event.kind === "withdrawn") this.declared.delete(ref.key)
    if (event.kind === "produced") this.inFile.add(ref.key)
    if (event.kind === "deleted") {
      this.inFile.delete(ref.key)
      this.declared.delete(ref.key) // FileMatcher keeps this match (known issue 8)
    }
    this.update(ref.key)
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
const pageKeys = new PageKeys("data.json")
pageKeys.subscribe((event) => {
  const vars = event.kind === "found" ? event.matched.vars : event.vars
  console.log(`${event.kind} ${vars.page}`) // each found and gone, in send order
})
const build = new Build()
build.each({
  matchersByName: { page: pageKeys },
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
async function curate(ctx: Context) {
  await Bun.write("data.json", JSON.stringify({ "pages/intro": "Hi", "pages/faq": "Ask" }))
  ctx.produced(new JsonKey("data.json", "pages/intro"))
  ctx.produced(new JsonKey("data.json", "pages/faq"))
  ctx.deleted(new JsonKey("data.json", "pages/old"))
}
const pages = new IdPrefix(`json:${path.resolve("data.json")}#pages/`) // covers each page key
build.add(new Task({ id: "curate", outputs: [pages], run: curate }))
const result = await build.run()
const ran = result.executed.map((task) => task.id).sort()
const cancelled = result.cancelled.map((task) => task.id).sort()
console.log(`ran [${ran.join(" ")}] cancelled [${cancelled.join(" ")}]`)
```

<!-- output -->
```text
found intro
found old
found intro
found faq
gone old
ran [curate html:faq html:intro] cancelled [html:old]
```

The second `found intro` comes from the report of `pages/intro`. It has the same id, so it changes nothing. `html:intro` waits for `curate`, because the prefix of `curate` covers `pages/intro`. `html:faq` runs in the same `run()`. When `build.each` removes `html:old`, the task still waits for `curate`. So the build [cancels](guide.md#results-and-failure) it.

## Send from a watcher

`send` is protected, so other code, such as a file watcher, cannot call it. Give your matcher a public method that changes `inFile` and calls `update`, as in [step 2](#step-2-get-the-builds-events). The tasks of a found sent before the first `run()`, or during its scans, start when the first `run()` starts its tasks. After the scans, `build.each` adds the tasks of each found immediately. They start with no new `run()` call, even after `run()` resolves ([the order rule](semantics.md#the-order-rule)). Call `run()` again to wait for them. Its `Result` also holds the tasks of earlier runs ([results](guide.md#results-and-failure)).

When a found or gone causes a [fatal error](semantics.md#fatal-errors), such as wrong var names, `send` does not throw. The `run()` in progress, or the next `run()`, rejects with the error.

## Lists

Use a list when one task reads many artifacts, as with [FileGroupMatcher](build-each.md#filegroupmatcher). Then `D` is a list, such as `readonly JsonKey[]`.

- Put the artifacts with the same var values into one list. In `scan`, send one found for each list.
- When an artifact gets or loses its match ([step 2](#step-2-get-the-builds-events)), send a found with the new list.
- Send each list in one fixed order, for example sorted by id. The same ids in another order are new data, so `tasks()` runs again for the [joined set](guide.md#buildeach).
- When a list becomes empty, send a gone. A found with `[]` makes tasks for an empty list.
- In `tasks()`, spread the list into `inputs`: `[...matched.<name>.data]` ([known issue 7](limits.md#known-issues-in-010)).

## Checklist

- Send vars with exactly the names in `varNames`, or `run()` rejects. Give each var a string value. dapat does not check it, and a number `1` does not [join](build-each.md#joins) with a string `"1"`.
- Send data whose id stays the same for the same key, file or row ([artifact checklist](write-an-artifact.md#checklist)). A new id makes the task run again, in the same run and in the next build.
- Send a gone only when an artifact loses its match, not for each `withdrawn` event ([step 2](#step-2-get-the-builds-events)).
- Keep `receiveArtifactEvent` synchronous, with no I/O and no throw.
- Make the matcher find the inputs of its tasks, not their outputs, unless you want a [loop](build-each.md#loops). The matcher also gets the events of the tasks that its `build.each` makes.
- Make `scan` return after it sends the current matches.
- A task that reports artifacts that your matcher finds declares an output that covers them ([outputs with unknown names](guide.md#outputs-with-unknown-names)).
- Parse keys or object names with your own code, for example a `RegExp`. dapat exports no pattern parser ([imports](api.md#imports)).
- Make a new matcher for each `Build`. `build.each` throws for a matcher that another `Build` uses.

## Next

[How a build works](semantics.md) tells when each event reaches your matcher, when its tasks start, and which errors are fatal. [API reference](api.md#matcher) lists each member of `Matcher` and the text of [each error message](api.md#error-messages).
