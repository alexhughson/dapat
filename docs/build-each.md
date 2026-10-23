# build.each

This page gives the details of `build.each`, output templates, `FileMatcher` and `FileGroupMatcher`. Read [build.each](guide.md#buildeach) in the guide first, because it defines the terms that this page uses.

## How build.each works

- A matcher sends a **`found` event** when it adds a match or changes the data of a match, and a **`gone` event** when it removes a match. Only `build.each` and the matcher's own subscribers get these events, not the subscribers of the `Build`.
- At each of these events, `build.each` adds, replaces or removes the tasks of each joined set that holds the match. A task that it replaces or removes before the task finishes is in `result.cancelled`.

This tree shows what `build.each` does in a build. [Matches during the run](#matches-during-the-run) gives the rules of its last row. As a [known issue](limits.md#a-task-change-at-the-first-promised-events-starts-tasks-before-the-scans), a task change at the first `promised` events starts the `build.add` tasks before the scans.

```text
build.each(config)                            throws on a bad config, or after the first run() starts
first build.run()                             a later run() on this Build does not scan
├─ promised for each declared output          a declared file has a match before the scan
├─ all the matchers scan at the same time     if a scan throws, run() rejects; no task starts after the throw
│  └─ found event → tasks of its joined sets
├─ the last scan returns
├─ the build adds the tasks of all the sets
└─ the tasks start                            build.add tasks also wait for this
during the run
└─ ctx.produced(file with no match) → produced → found event → its tasks → ctx.produced returns
```

## The config

`build.each` takes one object, a [`TaskMaterializerConfig`](api.md#taskmaterializerconfig). Give `tasks`, or `name` and `run`, not both: `build.each` throws for both or neither.

| Field | What it holds |
| --- | --- |
| `matchersByName` | The matchers, by name. Give at least one, and a different matcher object for each name in this call |
| `required` | Optional. The names of the matchers that each joined set must have. If you leave it out, every matcher is required ([required](#required)) |
| `outputsByName` | Optional. [Output templates](#output-templates) by name. The build fills each one in with the vars of the set, and gives them to `tasks` or `run` as `outputs` |
| `name` and `run` | The [one-task form](#the-one-task-form): one task for each set. `name` is the start of each task id, and `run({ vars, matched, outputs, ctx })` is the `run` function of the task |
| `tasks(vars, matched, outputs)` | The tasks form: returns the tasks of one set as an iterable, such as a generator or an array, which can be empty. The build does not add `outputs` to the tasks, so put each one in the `outputs` of the task that writes it. `tasks` must be synchronous: an `async` function or an `async *` generator makes `run()` reject. To act on what a file holds, read the file in the `run` of a task |

- A task of a joined set must not have the id or an exact output of another task in the `Build`. When it does, `run()` rejects, or `build.add` throws if it adds the other task later. In the tasks form, put every var of the set in each task id, and give each task of one set its own id, such as `html:en/hello` and `words:en/hello`.
- Keep `tasks()` free of side effects, such as file writes, because it can run more than once for one set, for example when a file joins the list of a [FileGroupMatcher](#filegroupmatcher) match.
- Several `build.each` calls of one `Build` can share one matcher object, and it scans once. Make a new matcher for each `Build`, because `build.each` throws for a matcher that another `Build` uses.
- Error messages call a joined set a [task group](semantics.md#subclass-build-settasksofgroups) and name it by a label, such as `build.each 1 lang=en slug=hello` for the first call ([error messages](api.md#error-messages)).

## The one-task form

With `name` and `run`, the build makes exactly one task for each joined set, as this tree shows. For a task with an input or an output that no matcher or template gives, use the [tasks form](#the-config).

```text
for each joined set
├─ id:      name + ":" + the var values joined by "/", such as page:en/hello
│           just name for a set with no vars
├─ inputs:  the data of each match, in matchersByName order; a list adds each of its artifacts
├─ outputs: the filled templates of outputsByName, in that order
└─ run:     (ctx) => run({ vars, matched, outputs, ctx })
```

- The id lists the var values in the order of `vars`: the matchers in `matchersByName` order, and the vars of each matcher in its `varNames` order, which is pattern order for `FileMatcher`. A var that two matchers share comes once. When you reorder `matchersByName`, the ids can change, and a task with a new id runs again, because it has no record.
- A var of an optional matcher with no match adds no part, so the id changes when such a match comes or goes ([required](#required) shows such ids).
- When two sets give one id, `run()` rejects with `is in two groups` ([error messages](api.md#error-messages)). Two `build.each` calls with one `name` can cause this, so give each call its own `name`.

Edge cases:
- A var with no value, or a var value with `/` from your own matcher, can also give two sets one id: the values `x/y` and `z` give the same id as `x` and `y/z`. Use the tasks form for such joins.

## Output templates

An [output template](guide.md#buildeach) names an output of each joined set with the vars of the set. `FileTemplate` gives a `FileArtifact`, and `FolderTemplate` gives a `FilesystemPrefix`. Both come from `dapat/contrib`, take `(pattern, { stamp, syntax })` and follow the [FileMatcher](#filematcher) rules, but the pattern has no `*` or `**`, because an output names one path. For the book `owl`, `new FolderTemplate("out/<book>")` gives the folder `out/owl/`. Give the templates in `outputsByName`.

- Each var of a template must be a var of a matcher, or `build.each` throws. A var of an optional matcher is allowed, and a set with no match of that matcher gets no task.
- Put every var of the set in each template path: when two sets fill a `FileTemplate` with one path, `run()` rejects with `duplicate output`, and when they fill a `FolderTemplate` with one path, two tasks write one folder with no error ([one task writes one folder](guide.md#one-task-writes-one-folder)).
- `expand` throws for a var value that is empty, `.` or `..`, or holds `/`, and then `run()` rejects ([a matched var can make an output template reject](limits.md#a-matched-var-can-make-an-output-template-reject)).
- For an output of your own artifact type, write a class that implements [`ArtifactTemplate<YourType>`](api.md#artifacttemplate), with `varNames` and `expand(vars: Vars)`. Then `outputs.<name>` has your type. `build.each` does not check the var values, so check them in `expand`.

## FileMatcher

`new FileMatcher(pattern, { stamp, syntax })` makes one match for each file that fits `pattern`, with the [`FileArtifact`](builtins.md#files) of the file as its data. Use it when each file gets its own tasks, such as one HTML page for each Markdown file. `stamp` is `"hash"` (the default) or `"time"` ([hash or time](builtins.md#hash-or-time)), and any other value throws. `syntax` sets other markers ([names that hold markers](#names-that-hold-markers)).

- By default, `<name>` marks a var. The name has ASCII letters, digits and `_`, and does not start with a digit. A var stands for one or more characters other than `/`, and a part between two `/` can mix text and vars, as in `v<major>.<minor>.json`.
- The constructor resolves a relative pattern against the current folder. It throws for a pattern that names no file, such as `""` or `.`, and for a `<` or `>` outside a var, two vars with nothing between them, a `*` or `**`, a `..` part, or a bad `syntax`. [Error messages](api.md#error-messages) gives each text and its fix.
- The scan follows symlinks and reads a folder only for a part with a var, so `content/<lang>/<slug>.md` reads `content` and each `content/<lang>` folder. A missing folder, a broken link or a link loop gives no match and no error, but any other read error, such as a folder with no read permission, makes `run()` reject.

| Pattern | File | Vars |
| --- | --- | --- |
| `content/<lang>/<slug>.md` | `content/en/hello.md` | `{ lang: "en", slug: "hello" }` |
| `content/<slug>.md` | `content/.draft.md` | `{ slug: ".draft" }` |
| `content/<slug>.md` | `content/.md` | no match: a var is never empty |
| `rel/v<major>.<minor>.json` | `rel/v1.2.3.json` | `{ major: "1.2", minor: "3" }` |
| `docs/<lang>/<lang>.md` | `docs/en/en.md` | `{ lang: "en" }` |
| `docs/<lang>/<lang>.md` | `docs/en/fr.md` | no match: the two values differ |

Edge cases:
- In a part with two vars, the first var takes as much text as it can while the rest of the path still fits, as in row 4.
- The constructor drops `.` parts and empty parts, so `./a//<b>.md` is `a/<b>.md`, and `a/b/` fits only the file `a/b`, not the files in the folder `a/b`.

### Names that hold markers

`<`, `>`, `*` and `**` are markers anywhere in the pattern, also in the folder names of an absolute pattern: a folder `a<x>b` makes a var `x`, and a folder `a*b` makes a glob. For such a name, set other markers with the `syntax` option: `varStart`, `varEnd`, `anyName` and `anyFolders`, by default `<`, `>`, `*` and `**`. For example, `new FileMatcher("notes <old>/{lang}/{slug}.md", { syntax: { varStart: "{", varEnd: "}" } })` finds `notes <old>/en/hello.md` with the vars `{ lang: "en", slug: "hello" }`.

- Each marker that you leave out keeps its default, and each default marker that you replace is a plain character. The exception is `**` when you change only `anyFolders`: `*` is still the `anyName` marker, so a `**` part is two `*` globs and stands for one folder level.
- Choose markers that no name in the pattern holds.

## FileGroupMatcher

`new FileGroupMatcher(pattern, { stamp, syntax })` makes one match for each value of its vars that has files, such as one match for each `lang` of `content/<lang>/*.md`. A pattern with no var gives one match at most. The data of the match is a readonly list of its files, sorted by path: `FileArtifact` objects with the `stamp` of the matcher. Use it when one task reads many files, such as a task that writes a sitemap.

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
- The pattern follows the [FileMatcher](#filematcher) rules, and it must have a `*` or `**`. Vars can come only in the parts before the first part with a `*` or `**`, and the constructor throws for other patterns ([error messages](api.md#error-messages)). A `*` or `**` makes no var, so read the other names from the path of each file.
- `*` stands for any text in one part. `**` stands for zero or more folders, so the match of `en` for `content/<lang>/**/*.md` holds `content/en/top.md` and `content/en/blog/hello.md`. `**` must be a whole part, and not the last part: for every file below `content`, write `content/**/*`.
- At a `**`, the scan reads every folder below it, so start the pattern with a fixed folder, such as `content/**/*.md`, not `**/*.md`.

Edge cases:
- `*` also stands for empty text and a leading `.`, and `**` also stands for hidden folders: the match of `notes/*.md` holds `notes/.md` and `notes/.draft.md`.
- The list is sorted by UTF-16 code unit, so `B.md` comes before `_c.md`, and `_c.md` before `a.md`.

## Joins

A [joined set](guide.md#buildeach) holds one match of each [required](#required) matcher. In each row, every matcher is required:

| Matchers | Files | Joined sets |
| --- | --- | --- |
| `pages/<lang>/<slug>.md`, `banners/<lang>/<banner>.png` | pages `en/hello`, `en/about`; banners `en/blue`, `en/red` | 4: each page with each banner, because the matchers share only `lang` |
| `templates/<lang>.html`, `authors/<slug>.txt`, `pages/<lang>/<slug>.md` | template `en`; author `hello`; pages `en/hello`, `en/about`, `de/hallo` | 1: `en/hello`. `en/about` has no author, and `de/hallo` has no template and no author |
| `content/<lang>/*.md` (a `FileGroupMatcher`), `templates/<lang>.html` | pages `en/hello`, `en/about`, `de/hallo`; template `en` | 1: `en`, with the list of the two `en` pages and the `en` template. `de` has no template |

- The required matchers must all connect through shared var names, or `build.each` throws ([error messages](api.md#error-messages)). A chain of required matchers is enough: in row 2, the template and author matchers share no var name, but each shares one with the page matcher.
- A matcher with no var, such as `templates/site.html`, shares no var name. To give its match to every set, leave it out of `required`.

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
- `matched.review` may be `undefined`, as in the set of `hello`. TypeScript types it as possibly `undefined`, and each var of `vars` as `string | undefined`, so read a var from a required match, such as `matched.page.vars.slug`, to get a `string`.
- The **ON vars** of an optional matcher are its var names that a required matcher or an earlier optional matcher has. A match joins a set when it has the set's value for each ON var. For `review`, the ON var is `slug`. An optional matcher with no ON vars, such as `tags/<tag>.txt`, joins each of its matches to each set.

Edge cases:
- Optional matchers join in `matchersByName` order. When two of them share a var name that no required matcher has, the later one joins only a set where the earlier one gave that var a value. For example, a matcher `rating: new FileMatcher("ratings/<slug>.<reviewer>.txt")` after `review` joins only the set of the review by the same reviewer.
- Do not give `required` a wider type, such as `("page" | "review")[]`: TypeScript then types `matched.review` as always there, but in the set of `hello` it is `undefined`, and `matched.review.vars` throws a TypeError. In `tasks()`, this can occur even when every page has a review, because `tasks()` can get a page before the scan finds its review.

## Matches during the run

During the run, `FileMatcher` and `FileGroupMatcher` also get the [events](guide.md#events) of the `Build`, so a file that a task declares or reports gets its tasks in the same `run()`. In this program, `write` reports `chapters/1.txt`:

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
- A `FileMatcher` gives a file a match, and a `FileGroupMatcher` puts it in a list, while the file is on disk or a task declares it as an exact output. For the matcher, a file is on disk from its `produced` event, or the [scan](guide.md#buildeach) that finds it, until its `deleted` event. A task declares the file from its `promised` event until its `withdrawn` event. When a task declares a file and does not write it, `build.each` still makes the tasks that read the file, and they run ([declare a folder](guide.md#a-task-that-may-write-nothing-declares-a-folder)).
- The matcher uses only the events of a `FileArtifact` or a subclass, so a `promised` event for a folder makes no match. Report each file that a task writes in a folder, or the file gets a match only at the scan of the next build.
- A task looks for its producers when it starts, and again when they all finish ([the order rule](semantics.md#the-order-rule)). A task that reads the outputs of tasks that `build.each` adds during the run can therefore start before those tasks exist. For example, `index` reads `summaries/`, and `build.each` adds a `summary` task for each chapter that `split` reports. Give `index` the input `chapters/` too, the folder output of `split`: `index` then waits for `split`, and then for each `summary` task.

Edge cases:
- Each report that changes the list of a `FileGroupMatcher` makes new tasks for its sets, which [replace](guide.md#results-and-failure) the old ones: `result.cancelled` can then hold several tasks with one id, and the build time grows with the square of the number of reports ([scale](limits.md#scale)). A declared file joins the list at its `promised` event, so its report changes nothing.

## Loops

In a **loop**, each task of a `build.each` writes the file that its matcher finds next. Each task, with its input file, is one **turn**. Use a loop when you do not know the number of turns before the run, as in an agent loop. Each task reports its file with `ctx.produced`, and `build.each` then makes the next task in the same `run()`. Here, `turn:<n>` takes `turns/<n>/t.txt` as its input and writes `turns/<n+1>/t.txt` while `n` is less than 3:

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

- `turn:<n>` declares the folder `turns/<n+1>/`, not the file. An exact output would give the next file a match at its `promised` event, before any task runs, so `build.each` would add turns until the [send limit](semantics.md#the-send-limit) makes `run()` reject. The send limit does not stop a loop with a folder output, so give every loop a maximum number of turns, as `n >= 3` does here.
- Give each turn its own folder. With one shared folder, such as `steps/`, each turn waits for the others, so once a scan finds two or more turns, as in the next build, each task fails with `deadlock waiting for inputs of '<id>'`.
- The files of old turns stay, and each scan finds them: when a loop stops at an earlier turn than in the last build, the later turns still get tasks, which skip while their files do not change. To start a loop again from turn 0, delete the folders of turns 1 and up.
