# Guide

This page defines the terms of dapat and shows how a build orders and skips tasks. Part 1 is about tasks that you add with `build.add`. Part 2 starts at [build.each](#buildeach) and explains `build.each` and events. Read the [README example](../README.md#example) first, because this page uses its program.

## What a build does

An **artifact** is one thing that a task reads or writes, such as a file, an S3 object or a key in a JSON file. Its id is a string, such as `file:/home/me/project/in.txt`. Two artifacts with the same id are the same artifact.

You make a **task** with `new Task({ id, inputs, outputs, run })`:

- `id`: a string that names the task, such as `upper`.
- `inputs`: the artifacts that the task reads.
- `outputs`: the artifacts that the task writes.
- `run`: your async function that reads the inputs and writes the outputs.

A task **declares** the artifacts in its `inputs` and `outputs`. A **build** is one run of your tasks: make a new `Build`, add tasks with `build.add`, and call `run()`. In a build, each task **finishes** in one of four ways: executed, skipped, failed or cancelled ([Results and failure](#results-and-failure)).

A **producer** of an input is another task that declares the input as an output. A task runs only after each producer of its inputs finishes. In the README program, `upper` is the producer of `mid.txt`, so `wrap` waits for `upper`. The program adds `wrap` first: the order of the `build.add` calls before `run()` has no effect ([the order rule](semantics.md#the-order-rule)).

The **stamp** of an artifact is a string that changes when the artifact changes, or `null` when the artifact is missing. A **store** keeps one **record** for each task id between builds: the stamps of the task's inputs and outputs from its last successful run. When a task **skips**, the build does not call its `run` function. A task skips only when it has inputs and the current stamps of its inputs and outputs equal its record ([the skip rule](#the-skip-rule)). After a successful run of a task, the build stamps its outputs and saves a new record.

## The skip rule

`new Build({ store })` takes the store. `MemoryStore` from `dapat` keeps the records in memory, so each new process starts with no records. `JsonStore` and `SqliteStore` from `dapat/contrib` keep them in a file ([Stores](builtins.md#stores)). In this program, each build uses a new `Build` with the same `MemoryStore`, and prints how `copy` finished:

```ts
import { Build, MemoryStore, Task } from "dapat"
import { FileArtifact } from "dapat/contrib"

const src = new FileArtifact("in.txt")
const out = new FileArtifact("out.txt")
const store = new MemoryStore()

async function copy() {
  await Bun.write(out.path, Bun.file(src.path))
}

async function runBuild(label: string) {
  const build = new Build({ store })
  build.add(new Task({ id: "copy", inputs: [src], outputs: [out], run: copy }))
  const result = await build.run()
  for (const [task, outcome] of result.outcomes) {
    let reason = ""
    if (outcome.type === "executed") {
      reason = ` (${outcome.reason.kind})`
    }
    console.log(`${label.padEnd(20)}${task.id} ${outcome.type}${reason}`)
  }
}

await Bun.write("in.txt", "a")
await runBuild("1. no record")
await runBuild("2. nothing changed")
await Bun.write("in.txt", "b")
await runBuild("3. in.txt edited")
await Bun.write("out.txt", "edited by hand")
await runBuild("4. out.txt edited")
```

<!-- output -->
```text
1. no record        copy executed (no-record)
2. nothing changed  copy skipped
3. in.txt edited    copy executed (input-changed)
4. out.txt edited   copy executed (output-changed)
```

The **skip rule** is five checks, which the build makes after the producers of the task finish. At the first check that fails, the task runs, and `result.outcomes` gives the **reason** that the table names for that check. With no store, every task runs, with the reason `no-store`.

| # | The task skips only when | Otherwise the reason is |
| --- | --- | --- |
| 1 | the task has at least one input | `no-inputs` |
| 2 | no input is a group of artifacts (a [prefix](#folders-prefixes)) with the stamp `null` | `input-unstamped` |
| 3 | the store has a record for the task id | `no-record` |
| 4 | the inputs have the same ids and stamps as in the record | `input-ids-changed`, `input-changed` |
| 5 | the outputs have the same ids and stamps as in the record, and no output stamp is `null` | `output-unstamped`, `output-ids-changed`, `output-missing`, `output-changed` |

The skip rule does not look at the `run` function ([Rerun when your code changes](recipes.md#rerun-when-your-code-changes)). It also does not look at a file that the task reads but does not declare. [The skip rule: exact checks](semantics.md#the-skip-rule-exact-checks) gives each check in full.

## Artifacts and stamps

Use a `FileArtifact` from `dapat/contrib` for one file. For an S3 object, use an [`S3ObjectArtifact`](builtins.md#s3). For another value, [write an artifact type](write-an-artifact.md). The second argument of `new FileArtifact(path, { stamp })` sets the **stamp mode**. The mode decides which file changes give a new stamp ([Hash or time](builtins.md#hash-or-time)).

| Mode | Stamp | After a `touch`, or a rewrite with the same bytes |
| --- | --- | --- |
| `{ stamp: "hash" }`, the default | a **hash stamp**: the SHA-256 hash of the bytes, in hex | the stamp does not change |
| `{ stamp: "time" }` | a **time stamp**: `<mtime in ns>:<size>`. dapat reads no bytes | the stamp changes |

## Folders: prefixes

A **prefix** is an input or an output that stands for a group of artifacts, such as the files in a folder. A prefix **covers** each artifact whose id starts with the prefix id. Two prefixes **overlap** when the id of one starts with the id of the other, such as `pages/` and `pages/en/`.

- As an input, a prefix makes its task wait for each task with an output that the prefix covers or overlaps. Each of these tasks is a producer of the prefix.
- As an output, a prefix makes its task a producer of each input that the prefix covers or overlaps.

For a folder, use a [`FilesystemPrefix`](builtins.md#folders) from `dapat/contrib`. `new FilesystemPrefix("chapters")` covers each file under `chapters/`, at any depth. Its stamp changes when a task or a person adds, changes or deletes a file under it. Its `list()` returns the absolute path of each of these files. To make one task wait for another when no file connects them, use an [`IdPrefix`](builtins.md#idprefix).

## Outputs with unknown names

Some tasks cannot name their outputs before they run, such as `split` below, which writes one file for each chapter of a book. Such a task declares its folder as a prefix output, here `chapters`. Its `run` function gets **`ctx`**, a `Context` from `dapat`. The task **reports** each file that it writes with `ctx.produced`, and each file that it deletes with `ctx.deleted`. The build sends each report as an [event](#events), so that [`build.each`](#buildeach) can add tasks for a reported file in the same `run()`. `count` has `chapters` as its input, so it waits until `split` finishes:

```ts
import { Build, MemoryStore, Task, type Context } from "dapat"
import { FileArtifact, FilesystemPrefix } from "dapat/contrib"

const book = new FileArtifact("book.txt")
const chapters = new FilesystemPrefix("chapters")
const count = new FileArtifact("count.txt")
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
  const old = existing.filter((path) => !written.has(path)) // chapters of a longer book
  for (const path of old) {
    await Bun.file(path).delete()
    ctx.deleted(new FileArtifact(path))
  }
}

async function countChapters() {
  const paths = await chapters.list()
  await Bun.write(count.path, String(paths.length))
}

async function runBuild(label: string) {
  const build = new Build({ store })
  build.add(new Task({ id: "count", inputs: [chapters], outputs: [count], run: countChapters }))
  build.add(new Task({ id: "split", inputs: [book], outputs: [chapters], run: split }))
  const result = await build.run()
  const ran = result.executed.map((task) => task.id).sort()
  const skipped = result.skipped.map((task) => task.id).sort()
  const counted = await Bun.file(count.path).text()
  console.log(`${label.padEnd(20)}ran [${ran.join(" ")}] skipped [${skipped.join(" ")}] count.txt: ${counted}`)
}

await Bun.write("book.txt", "One.\n\nTwo.\n\nThree.")
await runBuild("1. three chapters")
await runBuild("2. nothing changed")
await Bun.write("book.txt", "One.\n\nTwo.")
await runBuild("3. a shorter book")
```

<!-- output -->
```text
1. three chapters   ran [count split] skipped [] count.txt: 3
2. nothing changed  ran [] skipped [count split] count.txt: 3
3. a shorter book   ran [count split] skipped [] count.txt: 2
```

dapat [deletes no file](#dapat-deletes-no-file), so `split` deletes the chapters that it no longer writes, and reports them.

## Results and failure

`build.run()` resolves with a **Result**, which lists each task by its **outcome**: how it finished. Tasks that do not wait for each other run at the same time, and the lists are in finish order. `result.success` is `true` when `result.failed` and `result.errors` are empty. In this program, `make-a` throws, `use-a` reads the output of `make-a`, and `other` has no inputs:

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

To **replace** a task, call `build.add` with a new task that has the same id. `build.add` gives no warning when it replaces a task, so give each task its own id. To **remove** a task, call `build.remove(id)` ([Replacement and removal](semantics.md#replacement-and-removal)).

| Field | What it holds |
| --- | --- |
| `executed`, `skipped` | the **executed** tasks, which ran to the end with no error, and the skipped tasks |
| `failed` | a `Map` from each **failed** task to its `Error`. A task fails when its `run` function throws, or when a producer of its inputs fails ([all causes](semantics.md#one-task)) |
| `cancelled` | the **cancelled** tasks: tasks that a replacement or a removal took out of the `Build` before they ran to the end |
| `outcomes` | a `Map` from each task of the lists above to its outcome: `executed` with a reason, `skipped`, `failed` with its `Error`, or `cancelled` with `replaced` or `removed` |
| `errors` | errors that belong to no task, from a replacement or a removal ([all cases](api.md#error-messages)) |

- A failed task does not stop the other tasks. The build does not call the `run` function of `use-a`, and its error names `use-a`, not `make-a`. To find the cause, look in `result.failed` for a message that does not start with `dependency of`.
- `run()` rejects only for a **fatal error**: an error after which no more tasks start. A subscriber or a `build.each` call can cause one ([Fatal errors](semantics.md#fatal-errors)).

## Layout rules

An **exact output** is an output that is an artifact, not a prefix. Only one task can declare a given exact output: when a task with another id declares it too, `build.add` throws. The rules below say where tasks write files, and the build does not check them. [Self-feeding and shared folders](semantics.md#self-feeding-and-shared-folders) shows what happens, build by build, when a program breaks one.

### dapat deletes no file

dapat deletes no output file, because other programs and people also write in your folders. So an **old output** stays on disk: a file that a task wrote in an earlier build and that no task writes now. For example, when the book in [Outputs with unknown names](#outputs-with-unknown-names) gets shorter, `chapters/3.txt` is an old output, and `count` would still count it. So `split` deletes it. To delete old outputs, see [the recipe](recipes.md#delete-old-outputs).

### One task writes one folder

Only the task that declares a folder as its output should write in that folder. If another task writes in it, the tasks that declare or read the folder can run again on the next build. With time stamps, they can run on every build. Give each task its own folder, or declare exact outputs in a folder that no task declares.

### A task that may write nothing declares a folder

When a task may write nothing, declare a folder as its output, not an exact output. An exact output that the task does not write has the stamp `null`, so the task runs on every build. A missing or empty folder has a stamp, so with a folder output the task can skip.

### Write an index next to its folder

An index is a file that lists a folder. Write it next to the folder, not in it. When a task writes in a folder that it reads, each run that changes the folder makes the task run again on the next build. With time stamps, it runs on every build. For example, `count` writes `count.txt` next to `chapters/` in [Outputs with unknown names](#outputs-with-unknown-names).

### Keep the store file out of task folders

Keep the `JsonStore` or `SqliteStore` file out of every folder that a task reads or writes. Each saved record changes the store file, which changes the stamp of the folder, so each task that has the folder as an input or an output runs on every build. Put the store file in a folder of its own, such as `.dapat/`.

## Before you ship

1. If `result.success` is false, print `result.failed` and `result.errors` ([Results](#results-and-failure)), and exit with code 1. When `run()` rejects, also exit with code 1: Bun does this for you when you do not catch the error.
2. Use a `JsonStore` or a `SqliteStore`, and [keep its file out of task folders](#keep-the-store-file-out-of-task-folders).
3. Run the program twice with no change. In the second run, each task must skip, except a task with no inputs or with an [`IdPrefix`](builtins.md#idprefix) input or output. For each task that runs, `result.outcomes` gives the [reason](#the-skip-rule).
4. Sort ids and paths before you print or compare them. `result.executed` and `result.skipped` are in finish order, and the `list()` of a `FilesystemPrefix` is in file-system order.
5. Keep the project at one path, in CI too, because file ids are absolute paths ([Files](builtins.md#files)).

---

You can stop here. Part 1 is enough for a build whose tasks you add with `build.add`. Part 2 explains events and `build.each`, which makes tasks from files.

## build.each

`build.each` makes tasks from the files that fit your patterns, so a new file gets its tasks with no code change. This program makes `site/<lang>/<slug>.html` from each page `content/<lang>/<slug>.md` and the template `templates/<lang>.html` of its language. In build 1, `de/hallo` has no template, so it gets no task:

```ts
import { Build, MemoryStore } from "dapat"
import { FileMatcher, FileTemplate } from "dapat/contrib"

await Bun.write("content/en/hello.md", "Hello")
await Bun.write("content/en/about.md", "About us")
await Bun.write("content/de/hallo.md", "Hallo")
await Bun.write("templates/en.html", "<main>{{body}}</main>")
const store = new MemoryStore()

async function runBuild(label: string) {
  const build = new Build({ store })
  build.each({
    name: "page",
    matchersByName: {
      page: new FileMatcher("content/<lang>/<slug>.md"),
      template: new FileMatcher("templates/<lang>.html"),
    },
    outputsByName: { html: new FileTemplate("site/<lang>/<slug>.html") },
    async run({ matched, outputs }) {
      const layout = await Bun.file(matched.template.data.path).text()
      const body = await Bun.file(matched.page.data.path).text()
      const html = layout.split("{{body}}").join(body)
      await Bun.write(outputs.html.path, html)
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

The program shows each part of `build.each`:

- A **matcher** finds artifacts: `new FileMatcher("content/<lang>/<slug>.md")` finds each page file.
- A matcher gives each artifact **vars**, which are names with string values: `content/en/hello.md` gets `{ lang: "en", slug: "hello" }`.
- A **match** is one result of a matcher: its vars and its **data**. For a `FileMatcher`, the data is the `FileArtifact` of the file, such as `matched.page.data`.
- A **joined set** holds one match of each matcher, and two matches in it have the same value for each var that both have. Here `page` and `template` share `lang`, so each page joins the template of its language.
- The **one-task form**, `build.each({ name, matchersByName, outputsByName, run })`, makes one task for each joined set. The task id is `name`, a `:`, and the var values joined by `/`, such as `page:en/hello`. The task inputs are the data of each match.
- An **output template** in `outputsByName` names an output of each task with the vars of its set: `new FileTemplate("site/<lang>/<slug>.html")` gives `page:en/hello` the output `site/en/hello.html`.
- `run` gets `{ vars, matched, outputs, ctx }`. `matched` and `outputs` hold each match and each output under its name, such as `matched.template` and `outputs.html`.
- To make more than one task for each set, use the **tasks form**: give `tasks(vars, matched, outputs)` in place of `name` and `run` ([the config](build-each.md#the-config)).

Call `build.each` before `run()`. When `run()` starts, it **scans**: each matcher finds the artifacts that exist now. A file that a task declares or reports also gets its tasks in the same `run()` ([matches during the run](build-each.md#matches-during-the-run)).

## Events

An **event** is a message from the build about an output of a task. A **subscriber** is a function that you give to `build.subscribe`, and the build calls it with each event. Use a subscriber to log a build, for example `build.subscribe((event) => console.log(event.kind, event.taskId))`. These two kinds tell what each task declares and writes:

| `kind` | The build sends it when | Field |
| --- | --- | --- |
| `promised` | a task declares the output: at the start of `run()`, and later for each new output of a task that is added or replaced | `output`, an artifact or a prefix |
| `produced` | a task calls `ctx.produced`, or its `run` returns with no error: one event for each exact output that it did not report | `artifact` |

The build also sends `deleted` for each `ctx.deleted` call, and `withdrawn` when a task no longer declares an output ([Events](semantics.md#events)). A file that another program writes or deletes gets no event.

- Call `build.subscribe` before `run()`, so that the subscriber gets every event.
- A subscriber must be synchronous. A subscriber that throws or returns a promise, such as an `async` function, causes a [fatal error](#results-and-failure).

## Next

For a pipeline, read [build.each](build-each.md) and [Built-in artifacts and stores](builtins.md) next. To read or write a value that is not a file, read [Write an artifact type](write-an-artifact.md). [The docs index](README.md) lists every page, [Terms](glossary.md) gives the meaning of the main terms, and the [examples](../examples/README.md) are complete programs.
