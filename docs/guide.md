# Guide

This page explains how a build orders tasks and decides which tasks to run. Part 1, which every user needs, covers files with known names, folders, and outputs with unknown names. Read part 2, from [Events](#events) on, before you use `build.each` or `build.subscribe`. Read the [README example](../README.md#example) first, because this page uses its program.

## What a build does

A **build** is one call of `run()` on a new `Build` object. Your program adds **tasks** to the `Build` object with `build.add`. A task has these fields:

- **id**: a string that names the task, such as `upper`.
- **inputs**: the things that the task reads.
- **outputs**: the things that the task writes.
- **run**: your function that reads the inputs and writes the outputs. The build calls it.

An **artifact** is one thing that a task reads or writes, such as a file, an S3 object, or a key in a JSON file. Each artifact also has an id, such as `file:/home/me/project/in.txt`. The build matches inputs to outputs by id. The **stamp** of an artifact is a string that changes when the artifact changes, or `null` when the artifact is missing.

A **producer** of an input is another task that has the input as an output. In the README program, `upper` is the producer of `mid.txt`.

A **store** is the object in the `store` option of `new Build`. It keeps one **record** for each task id. A record holds the stamps of the task's inputs and outputs from its last successful run. A task **skips** when it has an input, each output exists, and the current stamps of its inputs and outputs equal its record. Then the build does not call its `run` function. [The store and the skip rule](#the-store-and-the-skip-rule) gives the exact checks.

The README program does one build each time you start it. Its `JsonStore` keeps the records in `.dapat/state.json` between builds. The first two builds do this:

```text
build 1 (the store has no records)
├─ upper: stamp in.txt → no record → call run → stamp mid.txt → save record
└─ wrap:  wait for upper → stamp mid.txt → no record → call run → stamp out.txt → save record
build 2 (no file changed)
├─ upper: stamp in.txt and mid.txt → equal the record → skip
└─ wrap:  wait for upper → stamp mid.txt and out.txt → equal the record → skip
```

## Artifacts and stamps

Use a `FileArtifact` from `dapat/contrib` for one file. For an S3 object, use an [`S3ObjectArtifact`](builtins.md#s3). For other values, [write your own artifact type](write-an-artifact.md). This program prints the id and the stamp of a `FileArtifact`:

```ts
import { FileArtifact } from "dapat/contrib"

await Bun.write("in.txt", "hello")
const file = new FileArtifact("in.txt")
const stamp = await file.stamp()
console.log(`id: ${file.id.replace(process.cwd(), ".")}`) // the id holds the absolute path: print "." in place of the working directory
console.log(`stamp: ${stamp?.slice(0, 12)}`)
```

<!-- output -->
```text
id: file:./in.txt
stamp: 2cf24dba5fb0
```

`file.path` holds the absolute path, resolved against the working directory, and the id is `file:` plus that path. The build calls `stamp()` only when it has a store. The build never calls `read()`. Your task reads its inputs, for example with `Bun.file(file.path)`. The second argument of the constructor sets the **stamp mode**: which changes to a file give a new stamp. To choose a mode, see [Hash or time](builtins.md#hash-or-time).

| Mode | Stamp | After a `touch`, or a rewrite with the same bytes |
| --- | --- | --- |
| `{ stamp: "hash" }`, the default | a **hash stamp**: the SHA-256 hash of the bytes, in hex | the stamp does not change |
| `{ stamp: "time" }` | a **time stamp**: `<mtime in ns>:<size>`. dapat reads no bytes | the stamp changes |

## Tasks and dependencies

You make a task with `new Task({ id, inputs, outputs, run })`. `inputs` and `outputs` are optional arrays of artifacts or [prefixes](#folders-prefixes). `run` gets one argument, [`ctx`](#outputs-with-unknown-names), and returns a promise.

These rules decide when a task starts:

- dapat starts each task when every producer of its inputs has finished. So tasks that do not wait for each other can run at the same time. dapat does not limit how many tasks run ([Limit parallel work](recipes.md#limit-parallel-work)).
- The order of the `build.add` calls has no effect before the first `build.run()`. The README program adds `wrap` first, and `wrap` still waits for `upper`. For tasks that you add after the first `run()` starts, see [the order rule](semantics.md#the-order-rule).
- A task can read its own output. It does not wait for itself.
- When tasks wait for each other in a cycle, each one fails with `deadlock waiting for inputs of '<its own id>'`. For example, `a` reads an output of `b`, and `b` reads an output of `a`. A task that waits for a task of the cycle also fails with this message.

Only one task can have a given artifact as an output. When you add a task with another id and the same output, `build.add` throws `duplicate output '<artifact id>': claimed by '<first task>' and '<second task>'` ([error messages](api.md#error-messages)).

You can replace or remove a task before, during or after `build.run()`, also from a task with [`ctx.add` and `ctx.remove`](#outputs-with-unknown-names). To **replace** a task that you added, call `build.add` with a new task that has the same id. To **remove** a task, call `build.remove(id)`. When no task has that id, `build.remove` does nothing.

- The record of a replaced task stays. So the new task can skip, even when its `run` function is different.
- The build deletes the record of a removed task. Its output files stay on disk ([layout rules](#layout-rules)).
- [Replacement and removal](semantics.md#replacement-and-removal) tells what happens to an old task that is waiting or running.

## The store and the skip rule

A task can skip only when its `Build` has a [store](#what-a-build-does). `MemoryStore` from `dapat` keeps the records in memory, so each new process starts with no records. `new JsonStore(path)` and `new SqliteStore(path)` from `dapat/contrib` keep them in a file ([Stores](builtins.md#stores)). In this program, `copy` reads `in.txt`, and `note` has no inputs. Each build is a new `Build` with the same `MemoryStore`:

```ts
import { Build, MemoryStore, Task } from "dapat"
import { FileArtifact } from "dapat/contrib"

const src = new FileArtifact("in.txt")
const out = new FileArtifact("out.txt")
const log = new FileArtifact("log.txt")
const store = new MemoryStore()
const copy = async () => { await Bun.write(out.path, Bun.file(src.path)) }
const note = async () => { await Bun.write(log.path, "built\n") }

async function build(label: string) {
  const build = new Build({ store })
  build.add(new Task({ id: "copy", inputs: [src], outputs: [out], run: copy }))
  build.add(new Task({ id: "note", outputs: [log], run: note }))
  const result = await build.run()
  const ran = result.executed.map((task) => task.id).sort()
  const skipped = result.skipped.map((task) => task.id).sort()
  console.log(`${label.padEnd(20)}ran [${ran.join(" ")}] skipped [${skipped.join(" ")}]`)
}

await Bun.write("in.txt", "a")
await build("1. no record")
await build("2. nothing changed")
await Bun.write("out.txt", "edited by hand")
await build("3. out.txt edited")
```

<!-- output -->
```text
1. no record        ran [copy note] skipped []
2. nothing changed  ran [note] skipped [copy]
3. out.txt edited   ran [copy note] skipped []
```

The build checks a task after its producers finish. The task skips only when all of these checks pass:

1. The task has at least one input.
2. No input is a [prefix](#folders-prefixes) with the stamp `null`. A prefix stands for a group of artifacts, such as a folder.
3. The store has a record for the task id.
4. The inputs have the same ids and stamps as in the record.
5. No output has the stamp `null`.
6. The outputs have the same ids and stamps as in the record. In build 3, the stamp of `out.txt` is not the stamp in the record, so `copy` runs and writes the file again.

- A task runs on every build when it has no inputs, as `note`, or an [`IdPrefix`](#folders-prefixes) input or output (its stamp is always `null`). It also runs on every build when an exact output (an artifact, not a prefix) is missing after each run, such as a file that it does not write. A task with inputs and no outputs can skip.
- Only a successful run saves a record. A skipped or failed task keeps its old record. The record holds the input stamps from before the run, so an input that changes during the run makes the task run again on the next build.
- The checks do not look at the `run` function. To rerun a task when its code changes, see [Rerun when your code changes](recipes.md#rerun-when-your-code-changes). To find which check failed, see [Find out why a task ran](recipes.md#find-out-why-a-task-ran).

## Folders: prefixes

A **prefix** is an input or an output that stands for a group of artifacts, such as the files in a folder. A task that reads or writes a whole folder uses one, so that you do not name each file. `dapat/contrib` has [`FilesystemPrefix`](builtins.md#folders) for a folder and [`S3Prefix`](builtins.md#s3) for the S3 objects whose keys start with one string. A prefix has an id and a stamp. It **covers** each artifact whose id starts with the prefix id. Two prefixes **overlap** when the id of one starts with the id of the other, for example `new FilesystemPrefix("pages")` and `new FilesystemPrefix("pages/en")`.

In the folder `/home/me/project`, `new FilesystemPrefix("pages")` has the id `file:/home/me/project/pages/`. It covers every file under `pages/`, at any depth. Its stamp changes when a task or a person adds, changes or deletes a file under it. In this program, `copy` writes `pages/a.txt`. `index` has `pages` as its input, and it writes the number of files that [`pages.list()`](builtins.md#folders) returns:

```ts
import { Build, MemoryStore, Task } from "dapat"
import { FileArtifact, FilesystemPrefix } from "dapat/contrib"

await Bun.write("src/a.txt", "A")
const src = new FileArtifact("src/a.txt")
const page = new FileArtifact("pages/a.txt")
const pages = new FilesystemPrefix("pages")
const index = new FileArtifact("index.txt")
const store = new MemoryStore()

async function copy() {
  await Bun.write(page.path, Bun.file(src.path))
}

async function count() {
  const paths = await pages.list()
  await Bun.write(index.path, `${paths.length}`)
}

async function build(label: string) {
  const build = new Build({ store })
  build.add(new Task({ id: "index", inputs: [pages], outputs: [index], run: count }))
  build.add(new Task({ id: "copy", inputs: [src], outputs: [page], run: copy }))
  const result = await build.run()
  const ran = result.executed.map((task) => task.id).sort()
  const skipped = result.skipped.map((task) => task.id).sort()
  const text = await Bun.file(index.path).text()
  console.log(`${label.padEnd(20)} ran [${ran.join(" ")}] skipped [${skipped.join(" ")}] index.txt: ${text}`)
}

await build("1. no record")
await build("2. nothing changed")
await Bun.write("pages/b.txt", "B")
await build("3. pages/b.txt added")
```
<!-- output -->
```text
1. no record         ran [copy index] skipped [] index.txt: 1
2. nothing changed   ran [] skipped [copy index] index.txt: 1
3. pages/b.txt added ran [index] skipped [copy] index.txt: 2
```

- **As an input**, a prefix makes its task wait for each task with an output that the prefix covers or overlaps. In build 1, `index` waits for `copy`, so it counts 1 file, although the program adds `index` first.
- **As an output**, a prefix makes each task with an input that the prefix covers or overlaps wait for its task ([outputs with unknown names](#outputs-with-unknown-names)).
- **`IdPrefix(id)`** from `dapat` is a prefix with only an id: its `stamp()` always returns `null`. A task with an `IdPrefix` input or output runs on every build ([the skip rule](#the-store-and-the-skip-rule)). Use it when no file connects two tasks. For example, give `a` the output `new IdPrefix("mem:cache/")`, and give `b` the same prefix as an input. Then `b` waits for `a` ([IdPrefix](builtins.md#idprefix)).
- End a prefix id with a delimiter, such as `/`. `IdPrefix("mem:out")` also covers `mem:outgoing`, but `IdPrefix("mem:out/")` does not. `FilesystemPrefix` and `S3Prefix` add the `/` for you.

## Outputs with unknown names

Some tasks cannot name their outputs before they run. For example, `split` below writes one file for each chapter of a book. Such a task declares its folder as a [prefix](#folders-prefixes) output, here `new FilesystemPrefix("chapters")`. Its `run` function gets **`ctx`**, a `Context` from `dapat`. While it runs, the task **reports** each file: it calls `ctx.produced` for a file that it writes, and `ctx.deleted` for a file that it deletes. The build sends each report as an [event](#events) (part 2). During the run, [`build.each`](#buildeach) uses these events to add tasks for new files and to remove the tasks of deleted files.

```ts
import { readdir } from "node:fs/promises"
import { Build, MemoryStore, Task, type Context } from "dapat"
import { FileArtifact, FilesystemPrefix } from "dapat/contrib"
const book = new FileArtifact("book.txt")
const chapters = new FilesystemPrefix("chapters")
const store = new MemoryStore()
async function split(ctx: Context) {
  const text = await Bun.file(book.path).text()
  const parts = text.split("\n\n")
  const written = new Set<string>()
  for (const [i, part] of parts.entries()) {
    const chapter = new FileArtifact(`chapters/${i + 1}.txt`)
    await Bun.write(chapter.path, part)
    ctx.produced(chapter)
    written.add(chapter.path)
  }
  for (const path of await chapters.list()) {
    if (written.has(path)) continue
    await Bun.file(path).delete() // an old chapter
    ctx.deleted(new FileArtifact(path))
  }
}
async function build(label: string) {
  const build = new Build({ store })
  build.add(new Task({ id: "split", inputs: [book], outputs: [chapters], run: split }))
  const result = await build.run()
  const ran = result.executed.map((task) => task.id).sort()
  const names = await readdir("chapters")
  const files = names.sort().join(" ")
  console.log(`${label.padEnd(20)}ran [${ran.join(" ")}] chapters/: ${files}`)
}
await Bun.write("book.txt", "One.\n\nTwo.\n\nThree.")
await build("1. three chapters")
await build("2. nothing changed")
await Bun.write("book.txt", "One.\n\nTwo.")
await build("3. a shorter book")
```

<!-- output -->
```text
1. three chapters   ran [split] chapters/: 1.txt 2.txt 3.txt
2. nothing changed  ran [] chapters/: 1.txt 2.txt 3.txt
3. a shorter book   ran [split] chapters/: 1.txt 2.txt
```

- dapat deletes no file ([layout rules](#layout-rules)), and the record keeps one stamp for `chapters/`, not a list of files. So the task deletes the files that it no longer writes, and reports them. In build 3, `split` deletes `chapters/3.txt`.
- `ctx.produced` and `ctx.deleted` throw when the artifact is not an output of the task and no prefix output covers it. The message is `task '<id>' produced '<artifact id>', which no output covers` ([error messages](api.md#error-messages)).
- A task that reads `chapters/1.txt` waits until `split` ends, not until the report.
- `ctx` also has `signal`, `add` and `remove`. `ctx.signal` is an `AbortSignal`. It aborts when a replacement or removal stops the running task, or on a [fatal error](#results-and-failure). `ctx.add(task)` and `ctx.remove(id)` do the same as `build.add` and `build.remove`. Before a long task uses `ctx`, read [known issues 1 and 2](limits.md#known-issues-in-010).

## Results and failure

`build.run()` resolves with a **Result**, which lists the tasks by how they ended, in the order in which they finished. `result.success` is `true` when `result.failed` and `result.errors` are empty. `run()` does not reject when a task fails. In this program, `make-a` throws, `use-a` reads the output of `make-a`, and `other` has no inputs:

```ts
import { Build, Task } from "dapat"
import { FileArtifact } from "dapat/contrib"
async function fail() { throw new Error("disk full") }
const a = new FileArtifact("a.txt")
const build = new Build()
build.add(new Task({ id: "make-a", outputs: [a], run: fail }))
build.add(new Task({ id: "use-a", inputs: [a], run: async () => {} }))
build.add(new Task({ id: "other", run: async () => {} }))
const result = await build.run()
const ran = result.executed.map((task) => task.id).sort()
console.log(`success: ${result.success} ran [${ran.join(" ")}]`)
for (const [task, error] of result.failed) {
  console.log(`failed ${task.id}: ${error.message}`)
}
```
<!-- output -->
```text
success: false ran [other]
failed make-a: disk full
failed use-a: dependency of 'use-a' failed
```

| Field | What it holds |
| --- | --- |
| `executed`, `skipped` | the **executed** tasks, which ran to the end with no error, and the **skipped** tasks ([the skip rule](#the-store-and-the-skip-rule)) |
| `failed` | a `Map` from each **failed** task to its `Error`. A task fails when its `run` function throws, or when a producer of its inputs fails ([all causes](semantics.md#one-task)) |
| `cancelled` | the **cancelled** tasks: tasks that a [replacement or removal](#tasks-and-dependencies) stopped before they finished |
| `errors` | errors that belong to no task, such as a store error when the build deletes the record of a removed task ([all cases](api.md#error-messages)) |

- A failed task does not stop the other tasks, so `other` runs. The build does not call the `run` function of `use-a`. The error of `use-a` names `use-a`, not the task that threw ([known issue 6](limits.md#known-issues-in-010)). To find the cause, look in `result.failed` for a message that does not start with `dependency of`.
- `run()` rejects only for a **fatal error**: an error after which no more tasks start. Only `build.subscribe`, `build.each` and a [`Build` subclass](semantics.md#subclass-build-settasksofgroups) can cause one ([Fatal errors](semantics.md#fatal-errors)).
- Make a new `Build` for each build. A second `run()` on one `Build` does not run its finished tasks again, also when an input changed. Its `Result` holds the tasks and errors of every `run()` call.

---

**You can stop here.** Part 1 is enough for a build whose tasks you add with `build.add`. Read part 2 before you use `build.each` or `build.subscribe`. Read the [layout rules](#layout-rules) before a task writes in a folder that it reads or that another task writes. Before you ship the program, read [Before you ship](#before-you-ship).

## Events

An **event** tells that a task declared an output, wrote or deleted an artifact, or no longer declares an output. It has a `kind`, the `taskId` of its task, and an `output` or an `artifact`. A **subscriber** is a function that you give to `build.subscribe`. The build calls each subscriber with each event. Use a subscriber to log a build, or to add tasks when a task [reports](#outputs-with-unknown-names) a file. A file that another program writes or deletes gets no event ([layout rules](#layout-rules)). This program logs the events of one task. The task writes `out.txt` and does not call `ctx.produced`:

```ts
import { Build, Task } from "dapat"
import { FileArtifact } from "dapat/contrib"
const out = new FileArtifact("out.txt")
const build = new Build()
build.subscribe((event) => {
  const ref = "output" in event ? event.output : event.artifact
  const id = ref.id.replace(process.cwd(), ".")
  console.log(`${event.kind} ${id} by ${event.taskId}`)
})
build.add(new Task({ id: "write", outputs: [out], run: async () => { await Bun.write(out.path, "hello") } }))
await build.run()
build.remove("write")
```
<!-- output -->
```text
promised file:./out.txt by write
produced file:./out.txt by write
withdrawn file:./out.txt by write
```

| `kind` | The build sends it when | Field |
| --- | --- | --- |
| `promised` | a task declares the output: at the first `run()`, before any task starts, and later for each new output of an added task or a replacement | `output`, an artifact or a prefix |
| `produced` | a task calls `ctx.produced`, or its `run` returns with no error | `artifact` |
| `deleted` | a task calls `ctx.deleted` | `artifact` |
| `withdrawn` | a call removes the task, or a replacement does not declare the output | `output` |

- When `run` returns with no error, the build sends `produced` for each exact output that the task did not report. It sends one even for a file that the task did not write. It sends none of these for a prefix output, for a task that skips, or after a call replaces or removes the task ([the event rules](semantics.md#events)).
- Call `build.subscribe` before the first `run()`, so that the subscriber gets every event. The build calls the subscribers one at a time, in the order in which they subscribed ([the event queue](semantics.md#the-event-queue)). A subscriber that throws or returns a promise causes a [fatal error](#results-and-failure). So do not use an `async` function as a subscriber.
- Before `ctx.produced` returns, each subscriber gets the event, and each task that a subscriber adds is in the build. So a new task that reads the reported file waits for the task that reported it.

## build.each

`build.each` makes tasks from the artifacts that **matchers** find, so a new file gets its tasks with no code change. A matcher, such as `FileMatcher`, finds artifacts and gives each one **vars**: names with string values. `FileMatcher("content/<lang>/<slug>.md")` gives `content/en/hello.md` the vars `{ lang: "en", slug: "hello" }`. A **match** is the vars and the **data**: for a `FileMatcher`, the `FileArtifact` of the file. A [`FileGroupMatcher`](build-each.md#filegroupmatcher) gives a list of artifacts as its data. A **joined set** holds one match of each matcher (an [optional matcher](build-each.md#required) can have none), with one value for each var name that the matches share.

`build.each({ matchersByName, tasks })` calls `tasks(vars, matched)` for each joined set, and adds the tasks that `tasks()` returns (an iterable, such as a generator). `matched` holds each match under the name of its matcher. In this program, `page` and `template` share the var `lang`, so each page joins the template of its `lang`. `de/hallo` gets no task until a `de` template exists:

```ts
import { Build, MemoryStore, Task } from "dapat"
import { FileArtifact, FileMatcher } from "dapat/contrib"

await Bun.write("content/en/hello.md", "Hello")
await Bun.write("content/en/about.md", "About us")
await Bun.write("content/de/hallo.md", "Hallo")
await Bun.write("templates/en.html", "<main>{{body}}</main>")
const store = new MemoryStore()

async function build(label: string) {
  const build = new Build({ store })
  build.each({
    matchersByName: {
      page: new FileMatcher("content/<lang>/<slug>.md"),
      template: new FileMatcher("templates/<lang>.html"),
    },
    *tasks(vars, matched) {
      const page = matched.page.data
      const template = matched.template.data
      const html = new FileArtifact(`site/${vars.lang}/${vars.slug}.html`)
      const id = `page:${vars.lang}/${vars.slug}`
      async function run() {
        const layout = await Bun.file(template.path).text()
        const body = await Bun.file(page.path).text()
        await Bun.write(html.path, layout.replace("{{body}}", () => body))
      }
      yield new Task({ id, inputs: [page, template], outputs: [html], run })
    },
  })
  const result = await build.run()
  const ran = result.executed.map((task) => task.id).sort()
  const skipped = result.skipped.map((task) => task.id).sort()
  console.log(`${label.padEnd(26)} ran [${ran.join(" ")}] skipped [${skipped.join(" ")}]`)
}
await build("1. en template only")
await Bun.write("templates/de.html", "<main lang=de>{{body}}</main>")
await build("2. templates/de.html added")
```

<!-- output -->
```text
1. en template only        ran [page:en/about page:en/hello] skipped []
2. templates/de.html added ran [page:de/hallo] skipped [page:en/about page:en/hello]
```

- Put every var of the joined set in the task id, as `page:${vars.lang}/${vars.slug}` does. When two joined sets give one task id, `run()` rejects ([error messages](api.md#error-messages)).
- Each matcher **scans**: it finds the artifacts that exist now. The first `run()` starts every scan at the same time, and no task starts until every scan returns ([how build.each works](build-each.md#how-buildeach-works)). A later `run()` does not scan, and a matcher belongs to one `Build`. So for each build, make a new `Build` with new matchers, as `build(label)` does.
- A matcher sends **found** when it adds a match or changes its data, and **gone** when it removes a match. `build.each` then adds, replaces or removes the tasks of each joined set that holds the match. During the run, a `FileMatcher` hears the build's [events](#events). It sends found for a file that a task declares as an exact output or reports with `ctx.produced`, and the new tasks run in the same `run()`. It sends gone for a `ctx.deleted` report, unless a task declares the file as an exact output ([matches during the run](build-each.md#matches-during-the-run)).

## Layout rules

These rules say where tasks write files and which outputs they declare. The build does not check them. When a program breaks one, tasks run when nothing changed, or `run()` rejects.

**dapat does not own your folders.** Other programs and people also write in them. So dapat sends [events](#events) only for the outputs that tasks declare or report, and it deletes no file. After you delete `content/en/about.md` in the [build.each](#buildeach) program, the next build has no task `page:en/about`. `site/en/about.html` and the record of `page:en/about` stay. A task leaves a `Build` object by `build.remove`, by `ctx.remove`, or when its joined set is gone. Then dapat deletes its record, but not its files. A `FileMatcher` whose pattern fits an old output still finds it. To delete old outputs, see [the recipe](recipes.md#delete-old-outputs).

**One task writes one folder.** When a task declares a folder as its output, no other task writes in that folder. Many tasks can declare exact outputs in a folder that no task declares. Say task `a` declares the folder, and task `b` writes in it after `a` ends. The record of `a` then holds the folder stamp from before the write of `b`. So `a` runs again on the next build, and skips after that. With time stamps, when `b` also reads a file of the folder, every writer and reader of the folder runs on every build.

**A task that may write nothing declares a folder.** In this program, `exact` declares an exact output and `folder` declares a folder. Neither one writes. `index:hash` and `index:time` each write the same text, `a.md`, to `index.txt` in the folder that they read:

```ts
import { Build, MemoryStore, Task } from "dapat"
import { FileArtifact, FilesystemPrefix } from "dapat/contrib"

const src = new FileArtifact("in.txt")
const file = new FileArtifact("file.txt")
const folder = new FilesystemPrefix("folder")
const store = new MemoryStore()

async function build(label: string) {
  await Bun.sleep(20) // so that each write of index.txt gets a new mtime
  const build = new Build({ store })
  build.add(new Task({ id: "exact", inputs: [src], outputs: [file], run: async () => {} }))
  build.add(new Task({ id: "folder", inputs: [src], outputs: [folder], run: async () => {} }))
  for (const stamp of ["hash", "time"] as const) {
    const pages = new FilesystemPrefix(`pages-${stamp}`, { stamp })
    const index = new FileArtifact(`pages-${stamp}/index.txt`)
    const write = async () => { await Bun.write(index.path, "a.md") }
    build.add(new Task({ id: `index:${stamp}`, inputs: [pages], outputs: [index], run: write }))
  }
  const result = await build.run()
  const ran = result.executed.map((task) => task.id).sort()
  const skipped = result.skipped.map((task) => task.id).sort()
  console.log(`${label}: ran [${ran.join(" ")}] skipped [${skipped.join(" ")}]`)
}

for (const path of ["in.txt", "pages-hash/a.md", "pages-time/a.md"]) await Bun.write(path, "a")
for (const n of [1, 2, 3]) await build(`build ${n}`)
```

<!-- output -->
```text
build 1: ran [exact folder index:hash index:time] skipped []
build 2: ran [exact index:hash index:time] skipped [folder]
build 3: ran [exact index:time] skipped [folder index:hash]
```

An exact output that the task does not write has the stamp `null`, so `exact` runs on every build ([check 5](#the-store-and-the-skip-rule)). A missing or empty folder has a stamp ([Folders](builtins.md#folders)), so `folder` skips. When the task writes, it [reports each file](#outputs-with-unknown-names). In a [loop](build-each.md#loops), declare the folder of the next file as the output, not the file. With the file as an exact output, its `promised` event makes `build.each` add the next task before any task runs. This repeats until `run()` rejects ([error messages](api.md#error-messages)).

**Write an index next to the folder that it reads, not in it,** as `index` does in [Folders: prefixes](#folders-prefixes). A **self-feeding layout** is one where a task writes into a folder that it reads. dapat allows it and gives no error. With time stamps, each write gives `index.txt` a new mtime, so `index:time` runs on every build. With hash stamps, `index:hash` runs on builds 1 and 2, then skips. An index that lists itself runs on builds 1 to 3, then skips, because it writes new bytes in build 2.

**Keep the store file out of every folder that a task declares.** Each saved record changes the `JsonStore` or `SqliteStore` file, and so the stamp of the folder. Then each task that declares the folder runs on every build.

## Before you ship

1. Check `result.success`. If it is false, print each entry of `result.failed` and `result.errors` ([Results](#results-and-failure)). Then exit with code 1.
2. Give the `Build` a `JsonStore` or a `SqliteStore`. With no store no task skips, and a `MemoryStore` starts empty in each process. Keep the store file outside every folder that a task reads or writes ([layout rules](#layout-rules)).
3. Run the program two times, and change no file between the two runs. In the second run, every task must skip, except the tasks that [run on every build](#the-store-and-the-skip-rule) on purpose. If a task runs, see [Find out why a task ran](recipes.md#find-out-why-a-task-ran). The [layout rules](#layout-rules) show layouts that cause this.
4. Sort ids and paths before you print or compare them. A `Result` lists tasks in the order in which they finished, and `FilesystemPrefix.list()` returns paths in file-system order ([Results](#results-and-failure), [Folders](builtins.md#folders)).
5. File and folder ids are absolute paths. So after you move the project, each task with a file or folder input or output runs again ([Files](builtins.md#files)). In CI, check out at the same path ([Run in CI](recipes.md#run-in-ci)).
6. If you use `build.each`, keep its `tasks()` function free of side effects, such as file writes. `build.each` can call it more than one time for one [joined set](#buildeach) ([the config](build-each.md#the-config)).

## Next

- For details and edge cases, read [build.each](build-each.md), [Built-in artifacts and stores](builtins.md), [Recipes](recipes.md) and [Limits](limits.md). For each exact rule and export, read [How a build works](semantics.md) and [API reference](api.md).
- To write your own artifact type or matcher, follow [Write an artifact type](write-an-artifact.md) or [Write a matcher](write-a-matcher.md).
