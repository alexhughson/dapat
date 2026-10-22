# Write a matcher

Write a matcher when `FileMatcher` and `FileGroupMatcher` cannot find your artifacts, such as S3 objects, JSON keys or database rows. Extend `Matcher<D>` from `"dapat"`, where `D` is the data of each match: one artifact, or a [list](#lists) ([members](api.md#matcher)). In [step 1](#step-1-find-the-objects-in-a-scan), `S3Pages` finds the page objects of an [S3](builtins.md#s3) bucket in its scan. In [step 2](#step-2-receive-the-events-of-the-build), its subclass `LiveS3Pages` also sends events for the objects that tasks report. Read [build.each](guide.md#buildeach) in the guide first.

## What you write

- `varNames`: the var names of each match.
- `scan(signal)`: finds the artifacts that exist now, and sends a [`found` event](build-each.md#how-buildeach-works) for each match.
- `receiveArtifactEvent(event)`: gets each [event](guide.md#events) of the `Build`. Override it to send `found` and `gone` events for the artifacts that tasks report.
- `send(event)`: a protected method that gives one `found` or `gone` event to each `build.each` that uses the matcher.

## Step 1: find the objects in a scan

The scan of `S3Pages` lists the keys under `pages/` with `client.list`, and calls `update` for each key. For a key `pages/<slug>.md`, `update` sends a `found` event with the var `slug` and an `S3ObjectArtifact` as data. When `exists` is false, it sends a `gone` event, for step 2. `S3Pages` parses the key with a `RegExp`, because dapat exports no pattern parser. The program after the module uses the [one-task form](guide.md#buildeach) with a `FileTemplate` output, and `MemoryS3` in place of a bucket. Save this module as `s3-pages.ts`:

<!-- file: s3-pages.ts -->
```ts
import { Matcher } from "dapat"
import { S3ObjectArtifact, type S3Client } from "dapat/contrib"

// the slug of a key such as "pages/intro.md", or null for any other key
function slugOf(key: string): string | null {
  const match = /^pages\/([^/]+)\.md$/.exec(key)
  return match?.[1] ?? null
}

export class S3Pages extends Matcher<S3ObjectArtifact> {
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
  protected update(key: string, exists: boolean) {
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
```

```ts
import { Build, MemoryStore } from "dapat"
import { FileTemplate, MemoryS3 } from "dapat/contrib"
import { S3Pages } from "./s3-pages"

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

`slugOf` gives no match to `pages/img/logo.png`. In build 2, `faq` is new and `usage` has a new etag, so their tasks run. Each `Build` starts with no matches, so a scan sends only `found` events. A key that is gone from the bucket needs no `gone` event, because its task is not in the build. Its old output file and record stay ([dapat deletes no file](guide.md#dapat-deletes-no-file)).

## Step 2: receive the events of the `Build`

The default `receiveArtifactEvent` does nothing, so an object that a task writes during the run gets its tasks only in the next build. `LiveS3Pages` extends `S3Pages` and overrides `receiveArtifactEvent`. So `build.each` makes and removes tasks for the page objects that tasks report during the run. In this program, `curate` writes new text to `pages/intro.md`, adds `pages/faq.md`, and reports both:

```ts
import { Build, Task, type ArtifactEvent, type Context } from "dapat"
import { FileTemplate, MemoryS3, S3ObjectArtifact, S3Prefix } from "dapat/contrib"
import { S3Pages } from "./s3-pages"

class LiveS3Pages extends S3Pages {
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
}

const s3 = new MemoryS3()
await s3.put("site", "pages/intro.md", Buffer.from("Hello"))

const build = new Build()
build.each({
  name: "html",
  matchersByName: { page: new LiveS3Pages(s3, "site") },
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
ran [curate html:faq html:intro]
out/intro.html: Hi
```

- `LiveS3Pages` turns each `produced` event into a `found` event, and each `deleted` event into a `gone` event, for a key `pages/<slug>.md` of its bucket. The `found` event for `intro` has the vars and artifact id of the match from the scan, so it changes nothing ([each case](semantics.md#buildeach-internals)).
- `curate` declares an `S3Prefix` that covers each page key, so it can [report](guide.md#outputs-with-unknown-names) them. `html:intro` waits for `curate`, so `out/intro.html` holds the new text. `html:faq` runs in the same `run()`.
- `MemoryS3` has no delete method, so this program deletes no object. With your own S3 client, a task deletes the object, then reports it with `ctx.deleted`. Then `LiveS3Pages` sends a `gone` event, and `build.each` removes the task of the key. The build [cancels](guide.md#results-and-failure) that task if it has not finished.
- `LiveS3Pages` ignores `promised` and `withdrawn` events. So a key that a task declares as an exact output gets its task only at its `produced` event. This event comes when the task reports the key, or when its `run` function returns. `FileMatcher` instead gives a declared file a match from its `promised` event to its `withdrawn` event ([matches during the run](build-each.md#matches-during-the-run)).

## Send from a watcher

`send` is protected, so other code, such as a file watcher, cannot call it. Give your matcher a public method, such as `changed(key, exists)`, that calls `update`. The build adds the tasks of each `found` event before `send` returns. After the scans of the first `run()`, these tasks start immediately, even after `run()` resolves ([the order rule](semantics.md#the-order-rule)). To wait for them, call `run()` again on the same `Build`. This `run()` does not scan, and its `Result` also holds the tasks of earlier runs.

## Lists

Use a list when one task reads many artifacts, as with [FileGroupMatcher](build-each.md#filegroupmatcher). Then `D` is a list, such as `readonly S3ObjectArtifact[]`.

- Put the artifacts with the same var values into one list, in one fixed order, such as sorted by id. The same ids in another order are new data, so `build.each` makes the tasks of the [joined set](guide.md#buildeach) again.
- In `scan`, send one `found` event for each list. When an artifact gets or loses its match, send a `found` event with the new list. When a list becomes empty, send a `gone` event: a `found` event with `[]` makes tasks for an empty list.
- The [one-task form](build-each.md#the-one-task-form) makes each artifact of the list an input. In `tasks()`, give the list as the `inputs` of a task.

## Checklist

- Set `varNames` in the class or the constructor: `build.each` reads it when you call `build.each`. Send vars with exactly these names, or `run()` rejects. Give each var a string value. dapat does not check it, and a number `1` does not [join](build-each.md#joins) with a string `"1"`.
- Send data whose id stays the same for the same key, file or row ([artifact checklist](write-an-artifact.md#checklist)). A new id makes the task run again, in the same run and in the next build.
- Send a `gone` event only when an artifact loses its match, not for each `withdrawn` event ([step 2](#step-2-receive-the-events-of-the-build)).
- Keep `receiveArtifactEvent` synchronous, with no I/O and no throw. The build calls it inside the call that sends the event, such as `ctx.produced`. A throw or a returned promise is a [fatal error](semantics.md#fatal-errors).
- Set up the state of the matcher in its fields or its constructor, not in `scan`. The first `run()` sends the `promised` events of the tasks in the `Build` before it calls `scan`.
- Make the matcher find the inputs of its tasks, not their outputs, unless you want a [loop](build-each.md#loops). The matcher also gets the events of the tasks that its `build.each` makes.
- Make `scan` return after it sends the current matches. If it can hang, make it throw after a timeout, or `run()` waits forever.
- In `scan`, check `signal.aborted` after each I/O call: after a fatal error, the build ignores each `found` event.
- Make a new matcher for each `Build`. `build.each` throws for a matcher that another `Build` uses.

## Next

[How a build works](semantics.md) tells when each event reaches your matcher, when its tasks start, and which errors are fatal. [API reference](api.md#matcher) lists each member of `Matcher` and the text of [each error message](api.md#error-messages).
