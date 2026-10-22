# Guide

This page explains how a build orders tasks and decides which tasks to run. Part 1, which every user needs, covers files with known names, folders, and outputs with unknown names. Part 2, from [Events](#events) on, covers `build.subscribe`, `build.each`, the [layout rules](#layout-rules) for shared folders, and a checklist for every program. Read the [README example](../README.md#example) first, because this page uses its program.

## What a build does

A **build** is one call of `run()` on a new `Build` object. Your program adds **tasks** to the `Build` object with `build.add`. A task has these fields:

- **id**: a string that names the task, such as `upper`.
- **inputs**: the things that the task reads.
- **outputs**: the things that the task writes.
- **run**: your function that reads the inputs and writes the outputs. The build calls it.

An **artifact** is one thing that a task reads or writes, such as a file, an S3 object, or a key in a JSON file. Each artifact also has an id, such as `file:/home/me/project/in.txt`. The build matches inputs to outputs by id. The **stamp** of an artifact is a string that changes when the artifact changes, or `null` when the artifact is missing.

A **producer** of an input is another task that has the input as an output. In the README program, `upper` is the producer of `mid.txt`.

A **store** keeps one **record** for each task id between builds. You give it in the `store` option of `new Build`. A record holds the stamps of the task's inputs and outputs from its last successful run. A task **skips** when it has an input and the current stamps of its inputs and outputs equal its record. An output with the stamp `null` always makes the task run. When a task skips, the build does not call its `run` function. [The store and the skip rule](#the-store-and-the-skip-rule) gives the exact checks.

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
const id = file.id.replace(process.cwd(), ".") // print "." in place of the current folder
console.log(`id: ${id}`)
console.log(`stamp: ${stamp?.slice(0, 12)}`)
```

<!-- output -->
```text
id: file:./in.txt
stamp: 2cf24dba5fb0
```

`file.path` holds the absolute path, resolved against the current folder, and the id is `file:` plus that path. Your task reads its inputs, for example with `Bun.file(file.path)`. The second argument of the constructor sets the **stamp mode**: which changes to a file give a new stamp. To choose a mode, see [Hash or time](builtins.md#hash-or-time).

| Mode | Stamp | After a `touch`, or a rewrite with the same bytes |
| --- | --- | --- |
| `{ stamp: "hash" }`, the default | a **hash stamp**: the SHA-256 hash of the bytes, in hex | the stamp does not change |
| `{ stamp: "time" }` | a **time stamp**: `<mtime in ns>:<size>`. dapat reads no bytes | the stamp changes |

## Tasks and dependencies

You make a task with `new Task({ id, inputs, outputs, run })`. `inputs` and `outputs` are optional arrays of artifacts or [prefixes](#folders-prefixes) (groups of artifacts, such as the files in a folder). `run` gets one argument, [`ctx`](#outputs-with-unknown-names), and returns a promise.

These rules decide when a task starts:

- The build starts each task when every producer of its inputs has finished. So tasks that do not wait for each other can run at the same time. dapat does not limit how many tasks run ([Limit parallel work](recipes.md#limit-parallel-work)).
- Before the first `run()`, the order of the `build.add` calls has no effect ([the order rule](semantics.md#the-order-rule) covers tasks that you add later).
- A task can read its own output. It does not wait for itself. It can run again on later builds ([self-feeding layout](#layout-rules)).
- When tasks wait for each other in a cycle, each one fails with `deadlock waiting for inputs of '<id>'`, where `<id>` is its own id ([error messages](api.md#error-messages)).

An **exact output** is an output that is an artifact, not a [prefix](#folders-prefixes). Only one task can have a given exact output. When you add a task with another id and the same exact output, `build.add` throws ([error messages](api.md#error-messages)).

To **replace** a task, call `build.add` with a new task that has the same id. `build.add` gives no error, so give each task its own id unless you want to replace it. To **remove** a task, call `build.remove(id)`. [Replacement and removal](semantics.md#replacement-and-removal) gives the rules for records and for tasks that wait or run.

## The store and the skip rule

A task can skip only when its `Build` has a [store](#what-a-build-does). `MemoryStore` from `dapat` keeps the records in memory, so each new process starts with no records. `new JsonStore(path)` and `new SqliteStore(path)` from `dapat/contrib` keep them in a file ([Stores](builtins.md#stores)). Keep the store file out of every folder that a task reads or writes ([layout rules](#layout-rules)). In this program, `copy` reads `in.txt`, and `note` has no inputs. Each build is a new `Build` with the same `MemoryStore`:

```ts
import { Build, MemoryStore, Task } from "dapat"
import { FileArtifact } from "dapat/contrib"

const src = new FileArtifact("in.txt")
const out = new FileArtifact("out.txt")
const log = new FileArtifact("log.txt")
const store = new MemoryStore()

async function copy() {
  await Bun.write(out.path, Bun.file(src.path))
}

async function note() {
  await Bun.write(log.path, "built\n")
}

async function runBuild(label: string) {
  const build = new Build({ store })
  build.add(new Task({ id: "copy", inputs: [src], outputs: [out], run: copy }))
  build.add(new Task({ id: "note", outputs: [log], run: note }))
  const result = await build.run()
  const ran = result.executed.map((task) => task.id).sort()
  const skipped = result.skipped.map((task) => task.id).sort()
  console.log(`${label.padEnd(20)}ran [${ran.join(" ")}] skipped [${skipped.join(" ")}]`)
}

await Bun.write("in.txt", "a")
await runBuild("1. no record")
await runBuild("2. nothing changed")
await Bun.write("out.txt", "edited by hand")
await runBuild("3. out.txt edited")
```

<!-- output -->
```text
1. no record        ran [copy note] skipped []
2. nothing changed  ran [note] skipped [copy]
3. out.txt edited   ran [copy note] skipped []
```

The build checks a task after its producers finish. The task skips only when all of these checks pass:

1. The task has at least one input.
2. No input is a [prefix](#folders-prefixes) with the stamp `null`.
3. The store has a record for the task id.
4. The inputs have the same ids and stamps as in the record.
5. No output has the stamp `null`.
6. The outputs have the same ids and stamps as in the record. In build 3, the stamp of `out.txt` is not the stamp in the record, so `copy` runs and writes the file again.

- A task runs on every build when it has no inputs, such as `note`, or when it has an [`IdPrefix`](#folders-prefixes) input or output. It also runs on every build when an exact output is missing after each run, such as a file that it does not write. A task with inputs and no outputs can skip.
- Only a successful run saves a record. A skipped or failed task keeps its old record. The record holds the input stamps from before the run. So when an input changes during the run, the task runs again on the next build.
- The checks do not look at the `run` function. To rerun a task when its code changes, see [Rerun when your code changes](recipes.md#rerun-when-your-code-changes). To find which check failed, see [Find out why a task ran](recipes.md#find-out-why-a-task-ran).

## Folders: prefixes

A **prefix** is an input or an output that stands for a group of artifacts, such as the files in a folder. `dapat/contrib` has [`FilesystemPrefix`](builtins.md#folders) for a folder and [`S3Prefix`](builtins.md#s3) for the S3 objects whose keys start with one string. A prefix has an id and a stamp. It **covers** each artifact whose id starts with the prefix id. Two prefixes **overlap** when the id of one starts with the id of the other, for example `new FilesystemPrefix("pages")` and `new FilesystemPrefix("pages/en")`.

In the folder `/home/me/project`, `new FilesystemPrefix("pages")` has the id `file:/home/me/project/pages/`. It covers every file under `pages/`, at any depth. Its stamp changes when a task or a person adds, changes or deletes a file under it. A missing folder has the same stamp as an empty folder, not `null`. As with a `FileArtifact`, a second argument such as `{ stamp: "time" }` sets the [stamp mode](#artifacts-and-stamps) of these files. [`pages.list()`](builtins.md#folders) returns the absolute path of each of these files, in file-system order. Sort them when the order matters, for example before you join the files. In this program, `copy` writes `pages/a.txt`. `index` has `pages` as its input, and it writes the number of files that `pages.list()` returns:

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

async function runBuild(label: string) {
  const build = new Build({ store })
  build.add(new Task({ id: "index", inputs: [pages], outputs: [index], run: count }))
  build.add(new Task({ id: "copy", inputs: [src], outputs: [page], run: copy }))
  const result = await build.run()
  const ran = result.executed.map((task) => task.id).sort()
  const skipped = result.skipped.map((task) => task.id).sort()
  const text = await Bun.file(index.path).text()
  console.log(`${label.padEnd(22)}ran [${ran.join(" ")}] skipped [${skipped.join(" ")}] index.txt: ${text}`)
}

await runBuild("1. no record")
await runBuild("2. nothing changed")
await Bun.write("pages/b.txt", "B")
await runBuild("3. pages/b.txt added")
```

<!-- output -->
```text
1. no record          ran [copy index] skipped [] index.txt: 1
2. nothing changed    ran [] skipped [copy index] index.txt: 1
3. pages/b.txt added  ran [index] skipped [copy] index.txt: 2
```

- **As an input**, a prefix makes its task wait for each task with an output that the prefix covers or overlaps. In build 1, `index` waits for `copy`, so it counts 1 file, although the program adds `index` first. Each of these tasks is a [producer](#what-a-build-does) of the prefix.
- **As an output**, a prefix makes other tasks wait for its task. These are the tasks with an input that the prefix covers or overlaps ([outputs with unknown names](#outputs-with-unknown-names)). Its task is a producer of each of these inputs.
- **`IdPrefix(id)`** from `dapat` is a prefix with only an id: its `stamp()` always returns `null`. A task with an `IdPrefix` input or output runs on every build ([the skip rule](#the-store-and-the-skip-rule)). Use it when no file connects two tasks. For example, give `a` the output `new IdPrefix("mem:cache/")`, and give `b` the same prefix as an input. Then `b` waits for `a` ([IdPrefix](builtins.md#idprefix)).
- End a prefix id with a delimiter, such as `/`. `IdPrefix("mem:out")` also covers `mem:outgoing`, but `IdPrefix("mem:out/")` does not. `FilesystemPrefix` and `S3Prefix` add the `/` for you.

## Outputs with unknown names

Some tasks cannot name their outputs before they run. For example, `split` below writes one file for each chapter of a book. Such a task declares its folder as a [prefix](#folders-prefixes) output, here `new FilesystemPrefix("chapters")`. Its `run` function gets **`ctx`**, a `Context` from `dapat`. While it runs, the task **reports** each file: it calls `ctx.produced` for a file that it writes, and `ctx.deleted` for a file that it deletes. The build sends each report as an [event](#events), so that [`build.each`](#buildeach) can add or remove tasks during the run (part 2). A report changes no task order and no skip.

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
  const existing = await chapters.list()
  for (const path of existing) {
    if (written.has(path)) continue
    await Bun.file(path).delete() // an old chapter
    ctx.deleted(new FileArtifact(path))
  }
}

async function runBuild(label: string) {
  const build = new Build({ store })
  build.add(new Task({ id: "split", inputs: [book], outputs: [chapters], run: split }))
  const result = await build.run()
  const ran = result.executed.map((task) => task.id).sort()
  const skipped = result.skipped.map((task) => task.id).sort()
  const names = await readdir("chapters")
  const files = names.sort().join(" ")
  console.log(`${label.padEnd(20)}ran [${ran.join(" ")}] skipped [${skipped.join(" ")}] chapters/: ${files}`)
}

await Bun.write("book.txt", "One.\n\nTwo.\n\nThree.")
await runBuild("1. three chapters")
await runBuild("2. nothing changed")
await Bun.write("book.txt", "One.\n\nTwo.")
await runBuild("3. a shorter book")
```

<!-- output -->
```text
1. three chapters   ran [split] skipped [] chapters/: 1.txt 2.txt 3.txt
2. nothing changed  ran [] skipped [split] chapters/: 1.txt 2.txt 3.txt
3. a shorter book   ran [split] skipped [] chapters/: 1.txt 2.txt
```

- dapat deletes no file ([layout rules](#layout-rules)), and the record keeps one stamp for `chapters/`, not a list of files. So the task deletes the files that it no longer writes, and reports them. In build 3, `split` deletes `chapters/3.txt`.
- `ctx.produced` and `ctx.deleted` throw when the artifact is not an output of the task and no prefix output covers it ([error messages](api.md#error-messages)).
- A task that reads `chapters/1.txt` waits until `split` ends, not until the report.
- `ctx` also has `signal`, `add` and `remove` ([Context](api.md#task)).

## Results and failure

`build.run()` resolves with a **Result**, which lists each task by its **outcome** (how it ended), in the order in which the tasks finished. `result.success` is `true` when `result.failed` and `result.errors` are empty. `run()` does not reject when a task fails. In this program, `make-a` throws, `use-a` reads the output of `make-a`, and `other` has no inputs:

```ts
import { Build, Task } from "dapat"
import { FileArtifact } from "dapat/contrib"

async function fail() {
  throw new Error("disk full")
}

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
| `executed`, `skipped` | the **executed** tasks, which ran to the end with no error, and the skipped tasks ([the skip rule](#the-store-and-the-skip-rule)) |
| `failed` | a `Map` from each **failed** task to its `Error`. A task fails when its `run` function throws, or when a producer of its inputs fails ([all causes](semantics.md#one-task)) |
| `cancelled` | the **cancelled** tasks: tasks that a [replacement or removal](#tasks-and-dependencies) stopped before they finished |
| `errors` | errors that belong to no task. Only a replacement or a removal can cause one, such as a store error when the build deletes the record of a removed task ([all cases](api.md#error-messages)) |

- A failed task does not stop the other tasks, so `other` runs. The build does not call the `run` function of `use-a`. The error of `use-a` names `use-a`, not the task that threw ([known issue 6](limits.md#known-issues-in-010)). To find the cause, look in `result.failed` for a message that does not start with `dependency of`.
- `run()` rejects only for a **fatal error**: an error after which no more tasks start. Only `build.subscribe`, `build.each` and a [`Build` subclass](semantics.md#subclass-build-settasksofgroups) can cause one ([Fatal errors](semantics.md#fatal-errors)).
- Make a new `Build` for each build. A second `run()` on one `Build` does not run its finished tasks again, even when an input changed. Its `Result` holds the tasks and errors of every `run()` call.

---

**You can stop here.** Part 1 is enough for a build whose tasks you add with `build.add`. Read the [layout rules](#layout-rules) before a task writes in a folder that it reads or that another task writes. Before you ship the program, read [Before you ship](#before-you-ship).

## Events

An **event** is a message from the build. It says that a task declares an output, writes or deletes an artifact, or stops declaring an output. It has a `kind`, the `taskId` of its task, and an `output` or an `artifact`. A **subscriber** is a function that you give to `build.subscribe`. The build calls each subscriber with each event. Use a subscriber to log a build, or to add tasks when a task [reports](#outputs-with-unknown-names) a file. A file that another program writes or deletes gets no event ([layout rules](#layout-rules)). This program logs the events of one task. The task writes `out.txt` and does not call `ctx.produced`:

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

async function write() {
  await Bun.write(out.path, "hello")
}

build.add(new Task({ id: "write", outputs: [out], run: write }))
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
| `withdrawn` | `build.remove`, `ctx.remove` or `build.each` removes the task, or a replacement does not declare the output | `output` |

- When `run` returns with no error, the build sends `produced` for each exact output that the task did not report. It sends one even for a file that the task did not write. A prefix output and a skipped task get none ([the event rules](semantics.md#events)).
- Call `build.subscribe` before the first `run()`, so that the subscriber gets every event. The build calls the subscribers one at a time, in the order in which they subscribed ([the event queue](semantics.md#the-event-queue)). A subscriber that throws or returns a promise causes a [fatal error](#results-and-failure). So do not use an `async` function as a subscriber.
- Before `ctx.produced` returns, each subscriber gets the event, and each task that a subscriber adds is in the build. So a new task that reads the reported file waits for the task that reported it.

## build.each

`build.each` makes tasks from the artifacts that **matchers** find, so a new file gets its tasks with no code change. A matcher, such as `FileMatcher`, finds artifacts and gives each one **vars**: names with string values. `FileMatcher("content/<lang>/<slug>.md")` gives `content/en/hello.md` the vars `{ lang: "en", slug: "hello" }`. A **match** is the vars and the **data**: for a `FileMatcher`, the `FileArtifact` of the file. A [`FileGroupMatcher`](build-each.md#filegroupmatcher) gives a list of artifacts as its data. A **joined set** holds one match of each matcher. An [optional matcher](build-each.md#required) can have no match in the set. When two matches share a var name, they have the same value for it.

`build.each({ matchersByName, tasks })` calls `tasks(vars, matched)` for each joined set, and adds the tasks that `tasks()` returns (an iterable, such as a generator). `matched` holds each match under the name of its matcher. `vars` holds the vars of all these matches, such as `lang` and `slug`. In this program, `page` and `template` share the var `lang`, so each page joins the template of its `lang`. `de/hallo` gets no task until a `de` template exists:

```ts
import { Build, MemoryStore, Task } from "dapat"
import { FileArtifact, FileMatcher } from "dapat/contrib"

await Bun.write("content/en/hello.md", "Hello")
await Bun.write("content/en/about.md", "About us")
await Bun.write("content/de/hallo.md", "Hallo")
await Bun.write("templates/en.html", "<main>{{body}}</main>")
const store = new MemoryStore()

async function runBuild(label: string) {
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
        // a function, so that "$&" in the body stays as it is
        await Bun.write(html.path, layout.replace("{{body}}", () => body))
      }
      yield new Task({ id, inputs: [page, template], outputs: [html], run })
    },
  })
  const result = await build.run()
  const ran = result.executed.map((task) => task.id).sort()
  const skipped = result.skipped.map((task) => task.id).sort()
  console.log(`${label.padEnd(28)}ran [${ran.join(" ")}] skipped [${skipped.join(" ")}]`)
}
await runBuild("1. en template only")
await Bun.write("templates/de.html", "<main lang=de>{{body}}</main>")
await runBuild("2. templates/de.html added")
```

<!-- output -->
```text
1. en template only         ran [page:en/about page:en/hello] skipped []
2. templates/de.html added  ran [page:de/hallo] skipped [page:en/about page:en/hello]
```

- Put every var of the joined set in the task id, as `page:${vars.lang}/${vars.slug}` does. When two joined sets give one task id, `run()` rejects ([error messages](api.md#error-messages)).
- Each matcher **scans**: it finds the artifacts that exist now. The first `run()` starts every scan at the same time, and no task starts until every scan returns ([how build.each works](build-each.md#how-buildeach-works)). A later `run()` does not scan, and a matcher belongs to one `Build`. So for each build, make a new `Build` with new matchers, as `runBuild(label)` does.
- A matcher sends **found** when it adds a match or changes its data, and **gone** when it removes a match. `build.each` then adds, replaces or removes the tasks of each joined set that holds the match. During the run, a `FileMatcher` or `FileGroupMatcher` also gets the build's [events](#events). So a file that a task declares or reports gets its tasks in the same `run()` ([matches during the run](build-each.md#matches-during-the-run)).

## Layout rules

These rules say where tasks write files and which outputs they declare. The build does not check them. When a program breaks one, tasks run when nothing changed, tasks fail, or `run()` rejects.

**dapat does not own your folders.** Other programs and people also write in them. So the build sends [events](#events) only for the outputs that tasks declare or report, and it deletes no file. After you delete `content/en/about.md` in the [build.each](#buildeach) program, the next build does not add the task `page:en/about`. So `site/en/about.html` stays on disk, and the record of `page:en/about` stays in the store. A task can also leave a `Build` object that has it: by `build.remove`, by `ctx.remove`, or when a matcher of that `Build` sends gone. Then the build deletes its record, but not its files. A `FileMatcher` whose pattern fits an old output still finds it. To delete old outputs, see [the recipe](recipes.md#delete-old-outputs).

**One task writes one folder.** When a task declares a folder as its output, no other task writes in that folder. Many tasks can declare exact outputs in a folder that no task declares. When a program breaks this rule, tasks run when nothing changed. For example, task `a` declares the folder. Task `b` reads an output of `a`, and then it writes in the folder. The record of `a` holds the folder stamp from before the write of `b`. With hash stamps, `a` runs again on the next build, and then it skips. With time stamps, `a`, `b` and each task that reads the folder run on every build.

This program shows the next two rules. `exact` declares an exact output and `folder` declares a folder, and neither one writes. `index:hash` and `index:time` each write the same list of names, `a.md`, to `index.txt` in the folder that they read:

```ts
import { Build, MemoryStore, Task } from "dapat"
import { FileArtifact, FilesystemPrefix } from "dapat/contrib"

const src = new FileArtifact("in.txt")
const file = new FileArtifact("file.txt")
const folder = new FilesystemPrefix("folder")
const store = new MemoryStore()

async function runBuild(label: string) {
  await Bun.sleep(20) // so that each write of index.txt gets a new mtime
  const build = new Build({ store })
  build.add(new Task({ id: "exact", inputs: [src], outputs: [file], run: async () => {} }))
  build.add(new Task({ id: "folder", inputs: [src], outputs: [folder], run: async () => {} }))
  for (const stamp of ["hash", "time"] as const) {
    const pages = new FilesystemPrefix(`pages-${stamp}`, { stamp })
    const index = new FileArtifact(`pages-${stamp}/index.txt`)
    async function write() {
      await Bun.write(index.path, "a.md")
    }
    build.add(new Task({ id: `index:${stamp}`, inputs: [pages], outputs: [index], run: write }))
  }
  const result = await build.run()
  const ran = result.executed.map((task) => task.id).sort()
  const skipped = result.skipped.map((task) => task.id).sort()
  console.log(`${label.padEnd(9)}ran [${ran.join(" ")}] skipped [${skipped.join(" ")}]`)
}

for (const path of ["in.txt", "pages-hash/a.md", "pages-time/a.md"]) await Bun.write(path, "a")
for (const n of [1, 2, 3]) await runBuild(`build ${n}`)
```

<!-- output -->
```text
build 1  ran [exact folder index:hash index:time] skipped []
build 2  ran [exact index:hash index:time] skipped [folder]
build 3  ran [exact index:time] skipped [folder index:hash]
```

**A task that may write nothing declares a folder.** An exact output that the task does not write has the stamp `null`, so `exact` runs on every build ([check 5](#the-store-and-the-skip-rule)). A missing or empty folder has a stamp ([Folders](builtins.md#folders)), so `folder` skips. When the task writes a file, report it with [`ctx.produced`](#outputs-with-unknown-names), so that a matcher finds it in the same `run()`. In a [loop](build-each.md#loops), give each turn its own folder, such as `turns/<n+1>/`. Declare that folder as the output, not the file. With the file as an exact output, its `promised` event makes `build.each` add the next task before any task runs. This repeats until `run()` rejects ([error messages](api.md#error-messages)).

**Write an index next to the folder that it reads, not in it,** as `index` does in [Folders: prefixes](#folders-prefixes). A **self-feeding layout** is one where a task writes a file or a folder that it reads. dapat allows it and gives no error. With time stamps, each write gives `index.txt` a new mtime, so `index:time` runs on every build. With hash stamps, `index:hash` runs on builds 1 and 2, then skips: its first record holds the folder stamp from before `index.txt` existed. An index that also writes its own name, such as `a.md index.txt`, runs on builds 1 to 3, then skips. Build 2 adds `index.txt` to the list, so it writes new bytes. A task that reads and writes one file runs on every build with time stamps. With hash stamps, it runs again on the build after each run that changes the file.

**Keep the store file out of every folder that a task reads or writes.** Each saved record changes the `JsonStore` or `SqliteStore` file, and so the stamp of the folder. Then each task that has the folder as an input or an output runs on every build.

## Before you ship

1. If `result.success` is false, print `result.failed` and `result.errors` ([Results](#results-and-failure)). Then exit with code 1. When `run()` rejects, the program must also exit with code 1. Bun does this when you do not catch the error.
2. Use a `JsonStore` or a `SqliteStore`. Keep its file out of every folder that a task reads or writes ([layout rules](#layout-rules)).
3. Run the program two times with no change. In the second run, each task must skip, except a task that [runs on every build](#the-store-and-the-skip-rule) on purpose or a task in a [self-feeding layout](#layout-rules) ([Find out why a task ran](recipes.md#find-out-why-a-task-ran)).
4. Sort ids and paths before you print or compare them.
5. Keep the project at one path, in CI too, because file ids are absolute paths ([Files](builtins.md#files), [Run in CI](recipes.md#run-in-ci)).
6. Keep `tasks()` of a `build.each` synchronous and free of side effects, such as file writes ([the config](build-each.md#the-config)).

## Next

- For details and edge cases, read [build.each](build-each.md), [Built-in artifacts and stores](builtins.md), [Recipes](recipes.md) and [Limits](limits.md).
- For complete programs, see the [examples](../examples/README.md). [file-pipeline.ts](../examples/file-pipeline.ts) makes one page for each source and one sitemap for each `lang`.
- To write your own artifact type or matcher, follow [Write an artifact type](write-an-artifact.md) or [Write a matcher](write-a-matcher.md).
- To look up an exact rule or an export, use [How a build works](semantics.md) and [API reference](api.md).
