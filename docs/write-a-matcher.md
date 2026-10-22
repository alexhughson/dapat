# Write a matcher

Write a [matcher](guide.md#buildeach) when `FileMatcher` and `FileGroupMatcher` cannot find your artifacts, such as S3 objects, JSON keys or database rows. In [step 1](#step-1-find-the-objects-in-a-scan), the matcher `S3Pages` finds the page objects of an [S3](builtins.md#s3) bucket in its scan. In [step 2](#step-2-get-the-builds-events), it also sends a `found` or `gone` event when a task reports an object. First read [build.each](guide.md#buildeach) in the guide, then [how build.each works](build-each.md#how-buildeach-works) and [matches during the run](build-each.md#matches-during-the-run).

## What you write

Extend `Matcher` from `"dapat"`. `D` is the type of the data of each match: one artifact, or a [list](#lists) of artifacts ([members](api.md#matcher)).

- `varNames` holds the var names of each match. Set it in the class or the constructor: `build.each` reads it when you call `build.each`. Each `found` and `gone` event must have exactly these names, or `run()` rejects.
- `scan(signal)` finds the artifacts that exist now, and sends a `found` event for each match. The first `run()` calls each scan one time, before any `build.each` task starts ([how build.each works](build-each.md#how-buildeach-works)). If your scan can hang, make it throw after a timeout, or `run()` waits forever ([limits](limits.md#stamps-and-matchers)).
  - `signal` aborts only on a [fatal error](guide.md#results-and-failure), such as a throw from another scan. If your scan throws, `run()` rejects, and no task starts after the throw.
- `receiveArtifactEvent(event)` gets each [event](guide.md#events) of the build. Override it to send a `found` or `gone` event when a task changes an artifact ([step 2](#step-2-get-the-builds-events)). The default does nothing, so an artifact that a task makes during the run gets its tasks only in the next build.
  - The build calls it as a [subscriber](guide.md#events), inside the call that sends the event, such as `ctx.produced`. So keep it synchronous, with no I/O and no throw. A throw, or a returned promise such as from an `async` override, is a [fatal error](semantics.md#fatal-errors): `run()` rejects.
  - The first `run()` sends the `promised` events of the tasks already in the build before it calls `scan`. So set up the state of your matcher in its fields or its constructor, not in `scan`.
- `send(event)` gives one `found` or `gone` event to each `build.each` that uses the matcher. `build.each` makes the tasks of each new or changed joined set. The build adds them when the open [step](semantics.md#steps) closes. For a send from a watcher, this is before `send` returns.
  - A `found` event with the vars and artifact ids of a current match changes nothing. So does a `gone` event for vars with no match ([each case](semantics.md#buildeach-internals)).

## Step 1: find the objects in a scan

The scan of `S3Pages` lists the keys under `pages/` with `client.list`. It sends a `found` event for each key `pages/<slug>.md`, with the var `slug` and an `S3ObjectArtifact` as data. It parses the key with a `RegExp`, because dapat exports no pattern parser. Check `signal.aborted` after each I/O call. This only saves work: after a [fatal error](semantics.md#fatal-errors), the build ignores each `found` event. The program uses the [one-task form](guide.md#buildeach) with a `FileTemplate` output, and `MemoryS3` in place of a bucket:

```ts
import { Build, Matcher, MemoryStore } from "dapat"
import { FileTemplate, MemoryS3, S3ObjectArtifact, type S3Client } from "dapat/contrib"

// the slug of a key such as "pages/intro.md", or null for any other key
function slugOf(key: string): string | null {
  const match = /^pages\/([^/]+)\.md$/.exec(key)
  return match?.[1] ?? null
}

class S3Pages extends Matcher<S3ObjectArtifact> {
  readonly varNames = ["slug"]
  constructor(readonly client: S3Client, readonly bucket: string) {
    super()
  }
  async scan(signal: AbortSignal) {
    const entries = await this.client.list(this.bucket, "pages/")
    if (signal.aborted) {
      return // a fatal error happened during the list
    }
    for (const entry of entries) {
      const slug = slugOf(entry.key)
      if (slug === null) {
        continue
      }
      const data = new S3ObjectArtifact(this.client, this.bucket, entry.key)
      this.send({ kind: "found", matched: { vars: { slug }, data } })
    }
  }
}

const s3 = new MemoryS3()
const store = new MemoryStore()

async function runBuild(label: string) {
  const build = new Build({ store })
  build.each({
    name: "html",
    matchersByName: { page: new S3Pages(s3, "site") },
    outputsByName: { html: new FileTemplate("out/<slug>.html") },
    async run({ matched, outputs }) {
      const bytes = await matched.page.data.read()
      await Bun.write(outputs.html.path, bytes)
    },
  })
  const result = await build.run()
  const ran = result.executed.map((task) => task.id).sort()
  const skipped = result.skipped.map((task) => task.id).sort()
  console.log(`${label}: ran [${ran.join(" ")}] skipped [${skipped.join(" ")}]`)
}

await s3.put("site", "pages/intro.md", Buffer.from("Hello"))
await s3.put("site", "pages/usage.md", Buffer.from("Run it"))
await s3.put("site", "pages/img/logo.png", Buffer.from("PNG"))
await runBuild("build 1")
await s3.put("site", "pages/faq.md", Buffer.from("Ask"))
await s3.put("site", "pages/usage.md", Buffer.from("Run it now"))
await runBuild("build 2")
```

<!-- output -->
```text
build 1: ran [html:intro html:usage] skipped []
build 2: ran [html:faq html:usage] skipped [html:intro]
```

`slugOf` gives no match to `pages/img/logo.png`. In build 2, `faq` is new and `usage` has a new etag, so their tasks run. Each `Build` starts with no matches, so a scan sends only `found` events. A key that is gone from the bucket needs no `gone` event, because its task is not in the build. The output file and record of its old task stay ([layout rules](guide.md#layout-rules)).

## Step 2: get the build's events

`S3Pages` now overrides `receiveArtifactEvent`. So `build.each` makes and removes tasks for the page objects that tasks report during the run. In this program, `curate` writes new text to `pages/intro.md`, adds `pages/faq.md`, and reports both. `subscribe` prints each event that `S3Pages` sends.

```ts
import { Build, Matcher, Task, type ArtifactEvent, type Context } from "dapat"
import { FileTemplate, MemoryS3, S3ObjectArtifact, S3Prefix, type S3Client } from "dapat/contrib"

// the slug of a key such as "pages/intro.md", or null for any other key
function slugOf(key: string): string | null {
  const match = /^pages\/([^/]+)\.md$/.exec(key)
  return match?.[1] ?? null
}

class S3Pages extends Matcher<S3ObjectArtifact> {
  readonly varNames = ["slug"]
  constructor(readonly client: S3Client, readonly bucket: string) {
    super()
  }
  async scan(signal: AbortSignal) {
    const entries = await this.client.list(this.bucket, "pages/")
    if (signal.aborted) {
      return // a fatal error happened during the list
    }
    for (const entry of entries) {
      this.update(entry.key, true)
    }
  }
  override receiveArtifactEvent(event: ArtifactEvent) {
    if (event.kind !== "produced" && event.kind !== "deleted") {
      return // promised and withdrawn: see the rules below the program
    }
    const object = event.artifact
    if (!(object instanceof S3ObjectArtifact) || object.bucket !== this.bucket) {
      return // such as a file, or an object in another bucket
    }
    this.update(object.key, event.kind === "produced")
  }
  private update(key: string, exists: boolean) {
    const slug = slugOf(key)
    if (slug === null) {
      return
    }
    if (exists) {
      const data = new S3ObjectArtifact(this.client, this.bucket, key)
      this.send({ kind: "found", matched: { vars: { slug }, data } })
    } else {
      this.send({ kind: "gone", vars: { slug } })
    }
  }
}

const s3 = new MemoryS3()
await s3.put("site", "pages/intro.md", Buffer.from("Hello"))
const pages = new S3Pages(s3, "site")
pages.subscribe((event) => {
  const vars = event.kind === "found" ? event.matched.vars : event.vars
  console.log(`${event.kind} ${vars.slug}`) // each found and gone event, in send order
})

const build = new Build()
build.each({
  name: "html",
  matchersByName: { page: pages },
  outputsByName: { html: new FileTemplate("out/<slug>.html") },
  async run({ matched, outputs }) {
    const bytes = await matched.page.data.read()
    await Bun.write(outputs.html.path, bytes)
  },
})

async function curate(ctx: Context) {
  const texts = { intro: "Hi", faq: "Ask" }
  for (const [slug, text] of Object.entries(texts)) {
    const object = new S3ObjectArtifact(s3, "site", `pages/${slug}.md`)
    await s3.put(object.bucket, object.key, Buffer.from(text))
    ctx.produced(object)
  }
}

const allPages = new S3Prefix(s3, "site", "pages") // covers each page key
build.add(new Task({ id: "curate", outputs: [allPages], run: curate }))
const result = await build.run()
const ran = result.executed.map((task) => task.id).sort()
console.log(`ran [${ran.join(" ")}]`)
const intro = await Bun.file("out/intro.html").text()
console.log(`out/intro.html: ${intro}`)
```

<!-- output -->
```text
found intro
found intro
found faq
ran [curate html:faq html:intro]
out/intro.html: Hi
```

- `S3Pages` turns each `produced` event into a `found` event, and each `deleted` event into a `gone` event. It does this only for a key `pages/<slug>.md` of its bucket. The second `found intro` has the vars and artifact id of a current match, so it changes nothing.
- `curate` declares an `S3Prefix` that covers each page key, so it can [report](guide.md#outputs-with-unknown-names) them. `html:intro` waits for `curate`, so `out/intro.html` holds the new text. `html:faq` runs in the same `run()`.
- `MemoryS3` has no delete method, so this program deletes no object. With your own S3 client, a task deletes the object, then reports it with `ctx.deleted`. Then `S3Pages` sends a `gone` event, and `build.each` removes the task of the key. The build [cancels](guide.md#results-and-failure) that task if it has not finished.
- `S3Pages` ignores `promised` and `withdrawn` events. So a key that a task declares as an exact output gets its task at its `produced` event: when the task reports it, or when the task ends. `FileMatcher` instead gives a declared file a match from its `promised` event to its `withdrawn` event ([matches during the run](build-each.md#matches-during-the-run), [known issue 6](limits.md#known-issues-in-010)).

## Send from a watcher

`send` is protected, so other code, such as a file watcher, cannot call it. Give your matcher a public method, such as `changed(key, exists)`, that calls the `update` method of [step 2](#step-2-get-the-builds-events). After the scans of the first `run()`, the tasks of each `found` event start immediately, even after `run()` resolves ([the order rule](semantics.md#the-order-rule)). Call `run()` again to wait for them. Its `Result` also holds the tasks of earlier runs ([results](guide.md#results-and-failure)).

When a `found` or `gone` event causes a [fatal error](semantics.md#fatal-errors), such as wrong var names, `send` does not throw. The `run()` in progress, or the next `run()`, rejects with the error.

## Lists

Use a list when one task reads many artifacts, as with [FileGroupMatcher](build-each.md#filegroupmatcher). Then `D` is a list, such as `readonly S3ObjectArtifact[]`.

- Put the artifacts with the same var values into one list. In `scan`, send one `found` event for each list.
- When an artifact gets or loses its match ([step 2](#step-2-get-the-builds-events)), send a `found` event with the new list.
- Send each list in one fixed order, for example sorted by id. The same ids in another order are new data, so `build.each` makes the tasks of the [joined set](guide.md#buildeach) again.
- When a list becomes empty, send a `gone` event. A `found` event with `[]` makes tasks for an empty list.
- The [one-task form](build-each.md#the-one-task-form) makes each artifact of the list an input. In `tasks()`, give the list as the `inputs` of a task.

## Checklist

- Send vars with exactly the names in `varNames`, or `run()` rejects. Give each var a string value. dapat does not check it, and a number `1` does not [join](build-each.md#joins) with a string `"1"`.
- Send data whose id stays the same for the same key, file or row ([artifact checklist](write-an-artifact.md#checklist)). A new id makes the task run again, in the same run and in the next build.
- Send a `gone` event only when an artifact loses its match, not for each `withdrawn` event ([step 2](#step-2-get-the-builds-events)).
- Keep `receiveArtifactEvent` synchronous, with no I/O and no throw.
- Make the matcher find the inputs of its tasks, not their outputs, unless you want a [loop](build-each.md#loops). The matcher also gets the events of the tasks that its `build.each` makes.
- Make `scan` return after it sends the current matches.
- A task that reports artifacts that your matcher finds declares an output that covers them ([outputs with unknown names](guide.md#outputs-with-unknown-names)).
- Make a new matcher for each `Build`. `build.each` throws for a matcher that another `Build` uses.

## Next

[How a build works](semantics.md) tells when each event reaches your matcher, when its tasks start, and which errors are fatal. [API reference](api.md#matcher) lists each member of `Matcher` and the text of [each error message](api.md#error-messages).
