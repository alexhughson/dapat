# build.each

This page gives the details of `build.each`, output templates, `FileMatcher` and `FileGroupMatcher`. Read [build.each](guide.md#buildeach) in the guide first. It defines the terms that this page uses.

## How build.each works

A matcher sends a **`found` event** when it adds a match or changes the data of a match. It sends a **`gone` event** when it removes a match. `build.each` and the matcher's own subscribers get these events, not the subscribers of the `Build`. `build.each` then adds, replaces or removes the tasks of each joined set that holds the match. A task that it replaces or removes before the task finishes is in `result.cancelled`. This tree shows what `build.each` does in a build:

```text
build.each(config)                            throws on a bad config, or after the first run() starts
first build.run()                             a later run() on this Build does not scan
├─ promised for each declared output          a declared file has a match before the scan
├─ all the matchers scan at the same time     if a scan throws, run() rejects; no task starts after the throw
│  └─ found event → tasks of its joined sets
├─ the last scan returns                      if a scan never returns, run() waits forever
├─ the build adds the tasks of all the sets
└─ the tasks start                            build.add tasks also wait for this, with one exception
during the run
└─ ctx.produced(file with no match) → produced → found event → its tasks → ctx.produced returns
```

[Matches during the run](#matches-during-the-run) gives the rules of the last row of the tree, and [the order rule](semantics.md#the-order-rule) gives the exception.

## The config

`build.each` takes one object, a [`TaskMaterializerConfig`](api.md#taskmaterializerconfig). Give `tasks`, or `name` and `run`, not both: `build.each` throws for both or neither.

| Field | What it holds |
| --- | --- |
| `matchersByName` | The matchers, by name. Give at least one, and a different matcher object for each name in this call |
| `required` | Optional. The names of the matchers that each joined set must have. If you leave it out, every matcher is required ([required](#required)) |
| `outputsByName` | Optional. [Output templates](#output-templates) by name. The build fills each one in with the vars of the set, and gives them to `tasks` or `run` as `outputs` |
| `name` and `run` | The [one-task form](#the-one-task-form): one task for each set. `name` is the start of each task id. `run({ vars, matched, outputs, ctx })` is the `run` function of the task |
| `tasks(vars, matched, outputs)` | The tasks form: returns the tasks of one set as an iterable, such as a generator or an array. It can return no task. Put each output of `outputs` in the `outputs` of the task that writes it. The build does not check this. `tasks` must be synchronous. An `async` function or an `async *` generator makes `run()` reject. To act on what a file holds, read the file in `run` |

- If a task of a joined set has the id or an exact output of another task in the `Build`, `run()` rejects. If that other task comes later, `build.add` throws. In the tasks form, put every var of the set in each task id. Give each task of one set its own id, such as `html:en/hello` and `words:en/hello`.
- `tasks()` can run more than one time for one set, for example when a file joins the list of a [FileGroupMatcher](#filegroupmatcher) match. During the scans, `tasks()` can also run for a set that a later `found` or `gone` event changes. The build drops those tasks before they start. So keep `tasks()` free of side effects, such as file writes.
- Several `build.each` calls of one `Build` can share one matcher object, and it scans one time. Make a new matcher for each `Build`, because `build.each` throws for a matcher that another `Build` uses.
- Error messages call a joined set a [task group](semantics.md#subclass-build-settasksofgroups) and name it by a label, such as `build.each 1 lang=en slug=hello` ([error messages](api.md#error-messages)).

## The one-task form

With `name` and `run`, the build makes exactly one task for each joined set:

```text
for each joined set
├─ id:      name + ":" + the var values in the order of vars, joined by "/"
│           such as page:en/hello; just name for a set with no vars
├─ inputs:  the data of each match, in matchersByName order; a list adds each of its artifacts
├─ outputs: the filled templates of outputsByName, in that order
└─ run:     (ctx) => run({ vars, matched, outputs, ctx })
```

- `vars` holds the vars of the matchers in `matchersByName` order, the vars of each matcher in `varNames` order (pattern order for `FileMatcher` and `FileGroupMatcher`), each var one time. So a new `matchersByName` order can change the order of the vars, and so the ids. A task with a new id has no record, so it runs again.
- A var with no value adds no part. So an optional match that comes or goes changes the id of its set ([required](#required) shows such ids).
- When two sets give one id, `run()` rejects with `is in two groups` ([error messages](api.md#error-messages)). A var with no value, or a var value with `/` from your own matcher, can cause this. Two `build.each` calls with one `name` can also cause it. Give each call its own `name`. For such joins, and for an input or an output that no matcher or template gives, use the [tasks form](#the-config).

## Output templates

An [output template](guide.md#buildeach) names an output of each joined set with the vars of the set. `FileTemplate` gives a `FileArtifact`, and `FolderTemplate` gives a `FilesystemPrefix`. Both come from `dapat/contrib`. Give them in `outputsByName`.

- `new FileTemplate(pattern, { stamp, syntax })` follows the [FileMatcher](#filematcher) rules, but the pattern has no `*` or `**`: an output names one path. For the book `owl`, `new FolderTemplate("out/<book>")` gives the folder `out/owl/`.
- Each var of a template must be a var of a matcher, or `build.each` throws. A var of an optional matcher is allowed: a set with no match of that matcher gets no task and no error.
- The `expand` of `FileTemplate` and `FolderTemplate` throws for a var value that is empty, `.` or `..`, or holds `/`, and then `run()` rejects ([a matched var can make an output template reject](limits.md#a-matched-var-can-make-an-output-template-reject)). It also throws for a bad `stamp`, because the constructor does not check it.
- Put every var of the set in each template path. When two sets fill a `FileTemplate` with one path, `run()` rejects with `duplicate output`. When they fill a `FolderTemplate` with one path, there is no error, and two tasks write one folder ([one task writes one folder](guide.md#one-task-writes-one-folder)).
- For an output of your own artifact type, write a class that implements [`ArtifactTemplate<YourType>`](api.md#artifacttemplate), with `varNames` and `expand(vars: Vars)`. Then `outputs.<name>` has your type. Give `vars` the type `Vars`, or `tsc` fails in strict mode. `build.each` does not check the var values, so check them in `expand`.

## FileMatcher

`new FileMatcher(pattern, { stamp, syntax })` makes one match for each file that fits `pattern`. Use it when each file gets its own tasks, such as one HTML page for each Markdown file. Each match's data is a [`FileArtifact`](builtins.md#files) with the matcher's `stamp` option: `"hash"` (the default) or `"time"` ([hash or time](builtins.md#hash-or-time)). Any other `stamp` value throws. `syntax` sets other pattern markers ([Names that hold markers](#names-that-hold-markers)).

| Pattern | File | Vars |
| --- | --- | --- |
| `content/<lang>/<slug>.md` | `content/en/hello.md` | `{ lang: "en", slug: "hello" }` |
| `content/<slug>.md` | `content/.draft.md` | `{ slug: ".draft" }` |
| `content/<slug>.md` | `content/.md` | no match: a var is never empty |
| `rel/v<major>.<minor>.json` | `rel/v1.2.3.json` | `{ major: "1.2", minor: "3" }` |
| `docs/<lang>/<lang>.md` | `docs/en/en.md` | `{ lang: "en" }` |
| `docs/<lang>/<lang>.md` | `docs/en/fr.md` | no match: the two values differ |

The pattern:

- A pattern has parts separated by `/`. By default, `<name>` marks a var. The name has ASCII letters, digits and `_`, and does not start with a digit.
- A var stands for one or more characters other than `/`.
- A part can mix text and vars. The first var takes as much text as it can, as long as the rest of the path still fits.
- The constructor drops `.` parts and empty parts. So `./a//<b>.md` is `a/<b>.md`, and only the file `a/b` fits `a/b/`, not the files in the folder `a/b`.
- The constructor resolves a relative pattern against the current folder. A later `process.chdir` does not change the files that the matcher finds.
- The constructor throws for a pattern that names no file, such as `""` or `.`. It also throws for a `<` or `>` outside a var, two vars with nothing between them, a `*` or `**`, a `..` part, or a bad `syntax`. [Error messages](api.md#error-messages) gives each text and its fix.

The scan:

- The matcher reads a folder only to list the names for a part with a var. So `content/<lang>/<slug>.md` reads `content` and each `content/<lang>` folder. When the last part has no var, the matcher only checks that the file exists.
- The matcher sends the `found` events for the files of each folder in name order, by UTF-16 code unit: `B.md`, then `_c.md`, then `a.md`.
- The matcher follows symlinks. A missing folder, a file where the pattern needs a folder, a link loop or a broken link gives no match and no error. Any other read error, such as a folder with no read permission, makes `run()` reject.

### Names that hold markers

`<`, `>`, `*` and `**` are markers anywhere in the pattern, also in the folder names of an absolute pattern. A folder `a<x>b` makes a var `x`, and a folder `a*b` makes a glob. For such a name, set other markers with the `syntax` option: `varStart`, `varEnd`, `anyName` and `anyFolders`, by default `<`, `>`, `*` and `**`. For example, `new FileMatcher("notes <old>/{lang}/{slug}.md", { syntax: { varStart: "{", varEnd: "}" } })` finds `notes <old>/en/hello.md` with the vars `{ lang: "en", slug: "hello" }`.

- Each marker that you leave out keeps its default. A default marker that the syntax replaces is a plain character. But `*` is a plain character only when `anyName` changes. So when only `anyFolders` changes, a `**` part is two `*` globs, and it stands for one folder level.
- Choose markers that no name in the pattern holds. The error messages name the markers of the syntax.

## FileGroupMatcher

`new FileGroupMatcher(pattern, { stamp, syntax })` makes one match for each value of its vars. The data of the match is a readonly list of its files: `FileArtifact` objects with the matcher's `stamp` option, sorted by the whole path, by UTF-16 code unit. Use it when one task reads many files, such as a task that writes a sitemap.

```ts
import { Build, Task } from "dapat"
import { FileGroupMatcher } from "dapat/contrib"

await Bun.write("content/en/hello.md", "Hello")
await Bun.write("content/en/about.md", "About")
await Bun.write("content/de/hallo.md", "Hallo")
const build = new Build()
build.each({
  matchersByName: { sources: new FileGroupMatcher("content/<lang>/*.md") },
  *tasks(vars, matched) {
    const sources = matched.sources.data // a readonly list of FileArtifact
    const names = sources.map((source) => source.path.split("/").pop())
    const run = async () => console.log(`sitemap:${vars.lang} lists ${names.join(" ")}`)
    yield new Task({ id: `sitemap:${vars.lang}`, inputs: sources, run })
  },
})
await build.run()
```

<!-- output -->
```text
sitemap:de lists hallo.md
sitemap:en lists about.md hello.md
```

- Write the pattern for the sources, such as `content/<lang>/*.md`, not for the outputs. A pattern such as `site/<lang>/*.html` also finds the output of a deleted source, because [dapat deletes no file](guide.md#dapat-deletes-no-file).
- The pattern follows the [FileMatcher](#filematcher) rules, and it must have a `*` or `**` (the `anyName` or `anyFolders` of its syntax). Vars can come only in the parts before the first part with a `*` or `**`. The constructor throws for other patterns ([error messages](api.md#error-messages)). A `*` or `**` makes no var, so read the other names from the path of each file.
- `*` stands for any text in one part, including empty text and a leading `.`. So the match of `notes/*.md` holds `notes/.md` and `notes/.draft.md`. A pattern with no var gives one match, or none when no file fits.
- `**` stands for zero or more folders, hidden folders too. So the match of `en` for `content/<lang>/**/*.md` holds `content/en/top.md` and `content/en/blog/hello.md`. `**` must be a whole part, and not the last part: for every file below `content`, write `content/**/*`. At a `**`, the scan reads every folder below it. So start the pattern with a fixed folder, such as `content/**/*.md`, not `**/*.md`.
- The matcher sends one `found` event for each list after the whole scan. During the run, each change to a list sends a `found` event with the new list, or a `gone` event when the list is empty ([matches during the run](#matches-during-the-run)).

## Joins

A [joined set](guide.md#buildeach) holds one match of each [required](#required) matcher. In each row, every matcher is required:

| Matchers | Files | Joined sets |
| --- | --- | --- |
| `pages/<lang>/<slug>.md`, `banners/<lang>/<banner>.png` | pages `en/hello`, `en/about`; banners `en/blue`, `en/red` | 4: each page with each banner, because the matchers share only `lang` |
| `templates/<lang>.html`, `authors/<slug>.txt`, `pages/<lang>/<slug>.md` | template `en`; author `hello`; pages `en/hello`, `en/about`, `de/hallo` | 1: `en/hello`. `en/about` has no author, and `de/hallo` has no template and no author |
| `content/<lang>/*.md` (a `FileGroupMatcher`), `templates/<lang>.html` | pages `en/hello`, `en/about`, `de/hallo`; template `en` | 1: `en`, with the list of the two `en` pages and the `en` template. `de` has no template |

The required matchers must all connect through shared var names, or `build.each` throws ([error messages](api.md#error-messages)). A chain is enough: in row 2, the template and author matchers share no var name, but each shares one with the page matcher. A matcher that `required` does not name is not part of the chain. A matcher with no var, such as `templates/site.html`, shares no var name. To give its match to every set, leave it out of `required`.

## required

When you give `required`, each matcher that it does not name is an **optional matcher**. A joined set can have no match of an optional matcher, as in an SQL LEFT JOIN. Use one for an input that a task does not need, such as a review of a page:

```ts
import { Build } from "dapat"
import { FileMatcher } from "dapat/contrib"

await Bun.write("pages/hello.md", "Hello")
await Bun.write("pages/about.md", "About")
await Bun.write("reviews/about.ann.txt", "OK")
await Bun.write("reviews/about.bob.txt", "Fix the typo")
const build = new Build()
build.each({
  name: "page",
  matchersByName: {
    page: new FileMatcher("pages/<slug>.md"),
    review: new FileMatcher("reviews/<slug>.<reviewer>.txt"),
  },
  required: ["page"],
  async run() {},
})
const result = await build.run()
const tasks = [...result.executed].sort((a, b) => a.id.localeCompare(b.id))
for (const task of tasks) {
  console.log(`${task.id.padEnd(16)}inputs: ${task.inputs.length}`)
}
```

<!-- output -->
```text
page:about/ann  inputs: 2
page:about/bob  inputs: 2
page:hello      inputs: 1
```

- The set of `hello` has no `review` match, so its task has one input, and its id has no reviewer part.
- Optional matchers join one after the other, in `matchersByName` order. The **ON vars** of an optional matcher are its var names that a required matcher or an earlier optional matcher has. For `review`, the ON var is `slug`. A match joins a set when it has the set's value for each ON var. An optional matcher with no ON vars, such as `tags/<tag>.txt`, joins each of its matches to each set.
- The order matters only when two optional matchers share a var name that no required matcher has. Then the later matcher joins only a set where the earlier one gave that var a value. For example, with `rating: new FileMatcher("ratings/<slug>.<reviewer>.txt")` after `review`, a rating joins only the set of the review by the same reviewer.
- With a literal `required`, as in the sample, TypeScript types `matched.review` as possibly `undefined`, and each var as `string | undefined`. For a `string`, read the var from a required match, such as `matched.page.vars.slug`. Do not give `required` a wider type, such as `("page" | "review")[]`. TypeScript then types `matched.review` as always there, but the set of `hello` has no `review` match. So code that reads `matched.review.vars` throws a TypeError. In the tasks form, `run()` then rejects. This can occur also when every page has a review, because `tasks()` can run for a page before the review matcher finds its review. In the one-task form, the task fails.

## Matches during the run

During the run, `FileMatcher` and `FileGroupMatcher` get the [events](guide.md#events) of the `Build`. So a file that a task declares or reports gets its tasks in the same `run()`. In this program, `write` reports `chapters/1.txt`:

```ts
import { Build, Task, type Context } from "dapat"
import { FileArtifact, FileMatcher, FilesystemPrefix } from "dapat/contrib"

async function write(ctx: Context) {
  const chapter = new FileArtifact("chapters/1.txt")
  await Bun.write(chapter.path, "Chapter 1")
  ctx.produced(chapter)
  console.log("ctx.produced returned")
  await Bun.sleep(10)
  console.log("write ends")
}

const build = new Build()
const chapters = new FilesystemPrefix("chapters")
build.add(new Task({ id: "write", outputs: [chapters], run: write }))
build.each({
  matchersByName: { chapter: new FileMatcher("chapters/<n>.txt") },
  *tasks(vars, matched) {
    console.log(`tasks() for chapter ${vars.n}`) // only to show the order
    const run = async () => console.log(`summary:${vars.n} runs`)
    yield new Task({ id: `summary:${vars.n}`, inputs: [matched.chapter.data], run })
  },
})
await build.run()
```

<!-- output -->
```text
tasks() for chapter 1
ctx.produced returned
write ends
summary:1 runs
```

- `summary:1` starts only when `write` finishes, because `write` declares the folder that holds the chapter.
- A `FileMatcher` gives a file a match while the file is on disk or a task declares it as an exact output. For the matcher, the file is on disk from the [scan](guide.md#buildeach) that finds it, or from a `produced` event for it, until a `deleted` event for it. A task declares the file from its `promised` event to its `withdrawn` event. So when a task declares a file and does not write it, `build.each` still makes the tasks that read the file, and they run ([declare a folder](guide.md#a-task-that-may-write-nothing-declares-a-folder)).
- The matcher uses only the events of a `FileArtifact` or a subclass. A `promised` event for a folder makes no match. So report each file that a task writes in a folder, or the file gets a match only at the next build's scan.
- A file that a task declares, or writes and reports, still gets its tasks in the next build after you delete it, because the task declares the file again, or runs again and reports it.
- `FileGroupMatcher` uses these rules for each file of a list. At each report that changes a list, `build.each` makes the tasks again for each joined set that holds the list. The new task [replaces](guide.md#tasks-and-dependencies) the old one, so `result.cancelled` can hold several tasks with one id. The build time grows with the square of the number of reports ([scale](limits.md#scale)). A declared file joins the list at its `promised` event, so its report does not make the tasks again.
- A task looks for its producers when it starts, and again when they all finish ([the order rule](semantics.md#the-order-rule)). So a task that reads the outputs of tasks that `build.each` adds during the run can start before they exist. For example, `index` reads `summaries/`, and `build.each` adds a `summary` task for each chapter that `split` reports. Give `index` the input `chapters/` too, the folder output of `split`. Then `index` waits for `split`, and then for each `summary` task.

## Loops

In a **loop**, each task of a `build.each` writes the file that its matcher finds next. Each task, with its input file, is one **turn**. Use a loop when you do not know the number of turns before the run, as in an agent loop. Each task reports its file with `ctx.produced`, so `build.each` makes the next task in the same `run()`. Here, `turn:<n>` takes `turns/<n>/t.txt` as its input and writes `turns/<n+1>/t.txt` while `n` is less than 3:

```ts
import { Build, Task, type Context } from "dapat"
import { FileArtifact, FileMatcher, FilesystemPrefix } from "dapat/contrib"

await Bun.write("turns/0/t.txt", "0")
const build = new Build()
build.each({
  matchersByName: { turn: new FileMatcher("turns/<n>/t.txt") },
  *tasks(vars, matched) {
    const n = Number(vars.n)
    const id = `turn:${n}`
    const nextFolder = new FilesystemPrefix(`turns/${n + 1}`)
    const nextFile = new FileArtifact(`turns/${n + 1}/t.txt`)
    async function run(ctx: Context) {
      if (n >= 3) {
        return // the stop condition: the last turn writes nothing
      }
      await Bun.write(nextFile.path, String(n + 1))
      ctx.produced(nextFile)
    }
    yield new Task({ id, inputs: [matched.turn.data], outputs: [nextFolder], run })
  },
})
const result = await build.run()
const ran = result.executed.map((task) => task.id).sort()
console.log(`ran [${ran.join(" ")}]`)
```

<!-- output -->
```text
ran [turn:0 turn:1 turn:2 turn:3]
```

- `turn:<n>` declares the folder `turns/<n+1>/`, not the file. With the file as an exact output, its `promised` event gives the file a match, so `build.each` adds the next task before any task runs. This repeats until the [send limit](semantics.md#the-send-limit) makes `run()` reject. The loop of the sample declares the folder, so the send limit does not stop it. So give every loop a maximum number of turns, as `n >= 3` does here.
- Give each turn its own folder. When every turn declares one shared folder, such as `steps/`, each task waits for the others. A build whose scan finds two or more turns then fails each task with `deadlock waiting for inputs of '<id>'`.
- The files of old turns stay, and each scan finds them. So when a loop ends at an earlier turn than in the last build, the later turns still get tasks. These tasks skip while their files do not change. To start a loop again from turn 0, delete the folders of turns 1 and up.
