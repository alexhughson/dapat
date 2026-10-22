# build.each

This page gives the details of `build.each`, `FileMatcher` and `FileGroupMatcher`. Read [build.each](guide.md#buildeach) in the guide first. It defines matcher, var, match, data, joined set, scan, found and gone.

## How build.each works

The tree shows the steps of `build.each` in order, from the call to the next build. The right column gives the rule of each step.

```text
build.each(config)                            throws on a bad config, or after the first run() starts
first build.run()                             a later run() on this Build does not scan
├─ promised for each output of each task      a declared file has a match before the scan
│  already in the build
├─ all the matchers scan at the same time     if a scan throws, run() rejects; no task runs
│  └─ a found → tasks(vars, matched) for each joined set that it makes or changes
├─ the last scan returns                      if a scan never returns, run() waits forever
├─ the build adds the tasks of all the sets   run() rejects on a shared id or exact output
└─ the tasks start                            not even a build.add task starts before this
during the run
└─ ctx.produced(file with no match) → produced → found → tasks() → ctx.produced returns
next build
└─ new Build, new matchers → a new scan
```

[Matches during the run](#matches-during-the-run) gives the rules of `during the run`. [Between builds](#between-builds) gives the rules of `next build`.

## The config

`build.each` takes one object with three fields.

| Field | What it holds |
| --- | --- |
| `matchersByName` | The matchers, by name. Give at least one, and a different matcher object for each name in this call |
| `required` | Optional. The names of the matchers that each joined set must have. If you leave it out, every matcher is required ([required](#required)) |
| `tasks(vars, matched)` | Returns the tasks of one joined set as an iterable, such as a generator or an array. It can return no task |

- If a task of a joined set has the id or an exact output of another task in the Build, `run()` rejects. Put every var of the set in each task id. Give each task of one set its own id, such as `html:en/hello` and `words:en/hello`.
- `tasks()` can run more than one time for one set, for example when a file joins the list of a [FileGroupMatcher](#filegroupmatcher) match. During the scans, `tasks()` can also run for a set that a later found or gone changes. The build drops those tasks before they start. So keep `tasks()` free of side effects, such as file writes.
- Several `build.each` calls of one Build can share one matcher object, and it scans one time.

The build gives each joined set a label: the number of the `build.each` call, then the vars of the set, such as `build.each 1 lang=en slug=hello`. Error messages name a set by its label and call it a group ([error messages](api.md#error-messages)).

## FileMatcher

`new FileMatcher(pattern, { stamp })` makes one match for each file that fits `pattern`. Use it when each file gets its own tasks, such as one HTML page for each Markdown file. The [vars](guide.md#buildeach) of the match come from the path of the file. Each match's data is a [`FileArtifact`](builtins.md#files) with the matcher's `stamp` option: `"hash"` (the default) or `"time"` ([hash or time](builtins.md#hash-or-time)). Any other `stamp` value throws.

| Pattern | File | Vars |
| --- | --- | --- |
| `content/<lang>/<slug>.md` | `content/en/hello.md` | `{ lang: "en", slug: "hello" }` |
| `content/<slug>.md` | `content/.draft.md` | `{ slug: ".draft" }` |
| `content/<slug>.md` | `content/.md` | no match: a var is never empty |
| `rel/v<major>.<minor>.json` | `rel/v1.2.3.json` | `{ major: "1.2", minor: "3" }` |
| `docs/<lang>/<lang>.md` | `docs/en/en.md` | `{ lang: "en" }` |
| `docs/<lang>/<lang>.md` | `docs/en/fr.md` | no match: the two values differ |

The pattern:

- A pattern has parts separated by `/`. In a pattern, `<name>` marks a var. The name has ASCII letters, digits and `_`, and does not start with a digit.
- A var matches one or more characters other than `/`, including a leading `.`.
- A part can mix text and vars. The first var takes as much text as it can, as long as the rest of the path still fits.
- A var that comes twice must have the same value in both places.
- The constructor drops `.` parts and empty parts. So `./a//<b>.md` is `a/<b>.md`, and `a/b/` matches the file `a/b`, not the files in the folder `a/b`.
- The constructor resolves a relative pattern against the current folder. A later `process.chdir` does not change the files that the matcher finds.

The constructor throws for these patterns ([error messages](api.md#error-messages) gives the text):

| Pattern | Why it throws |
| --- | --- |
| `""`, `.` or `/` | The pattern is empty, or has only `.` and `/`. |
| `a/<b` or `<my-var>` | A `<` or `>` is outside a var. |
| `<a><b>` | Two vars have nothing between them. |
| `posts/*.md` | `*` and `**` are not allowed. For one match with a list of files, use [FileGroupMatcher](#filegroupmatcher). |
| `../a/<b>.md` | A `..` part is not allowed. For a folder above the current folder, make the pattern absolute with `path.resolve`. |

The scan:

- The matcher reads a folder only to list the names for a part with a var. So `content/<lang>/<slug>.md` reads `content` and each `content/<lang>` folder. When the last part has no var, the matcher only checks that the file exists.
- The matcher sends found for the files of each folder in name order, by UTF-16 code unit: `B.md`, then `_c.md`, then `a.md`.
- The matcher follows symlinks. A missing folder, a file where the pattern needs a folder, a link loop or a broken link gives no match and no error. Any other read error, such as a folder with no read permission, makes `run()` reject.

## FileGroupMatcher

`FileMatcher` makes one match for each file. `new FileGroupMatcher(pattern, { stamp })` makes one match for each value of its vars, and the data of the match is the list of its files. Use it when one task reads many files, such as a task that writes a sitemap.

```ts
import { Build, Task } from "dapat"
import { FileGroupMatcher } from "dapat/contrib"

for (const name of ["en/hello", "en/about", "de/hallo"]) await Bun.write(`content/${name}.md`, name)
const build = new Build()
build.each({
  matchersByName: { sources: new FileGroupMatcher("content/<lang>/*.md") },
  *tasks(vars, matched) {
    const inputs = [...matched.sources.data] // a copy: inputs takes a mutable array
    const names = inputs.map((source) => source.path.split("/").pop())
    const run = async () => console.log(`sitemap:${vars.lang} lists ${names.join(" ")}`)
    yield new Task({ id: `sitemap:${vars.lang}`, inputs, run })
  },
})
await build.run()
```

<!-- output -->
```text
sitemap:de lists hallo.md
sitemap:en lists about.md hello.md
```

- The data is a readonly list of `FileArtifact` objects with the matcher's `stamp` option, sorted by path (by UTF-16 code unit, as for FileMatcher). Spread it into `inputs`, as the sample does ([known issues](limits.md#known-issues-in-010)).
- The pattern follows the [FileMatcher](#filematcher) rules, and it must have a `*` or `**`. Vars can come only in the parts before the first part with a `*` or `**`. The constructor throws for other patterns ([error messages](api.md#error-messages)). A `*` or `**` makes no var, so read the other names from the path of each file, as the sample does with `source.path`.
- `*` matches any text in one part, including empty text and a leading `.`. So the match of `notes/*.md` holds `notes/.md` and `notes/.draft.md`. A pattern with no var gives one match, or none when no file fits.
- `**` matches zero or more folders, hidden folders too. So the match of `en` for `content/<lang>/**/*.md` holds `content/en/top.md` and `content/en/blog/hello.md`. `**` must be a whole part, and not the last part: for every file below `content`, write `content/**/*`.
- The matcher sends one found for each list after the whole scan. During the run, each change to a list sends found with the new list, or gone when the list is empty ([matches during the run](#matches-during-the-run)).

## Joins

A [joined set](guide.md#buildeach) holds one match of each [required](#required) matcher. In each row, every matcher is required:

| Matchers | Files | Joined sets |
| --- | --- | --- |
| `pages/<lang>/<slug>.md`, `banners/<lang>/<banner>.png` | pages `en/hello`, `en/about`; banners `en/blue`, `en/red` | 4: each page with each banner, because the matchers share only `lang` |
| `templates/<lang>.html`, `authors/<slug>.txt`, `pages/<lang>/<slug>.md` | template `en`; author `hello`; pages `en/hello`, `en/about`, `de/hallo` | 1: `en/hello`. `en/about` has no author, and `de/hallo` has no template and no author |
| `templates/<lang>.html`, `authors/<slug>.txt` | – | `build.each` throws: the two matchers share no var name |

The required matchers must all connect through shared var names, or `build.each` throws ([error messages](api.md#error-messages)). A chain is enough: in row 2, the template and author matchers share no var name, but each shares one with the page matcher. A matcher that [`required`](#required) does not name is not part of the chain.

## required

When you give [`required`](#the-config), each matcher that it does not name is an **optional matcher**. A joined set can have no match of an optional matcher, as in an SQL LEFT JOIN. Use one for an input that a task does not need, such as a review of a page:

```ts
import { Build, Task } from "dapat"
import { FileMatcher } from "dapat/contrib"

await Bun.write("pages/hello.md", "Hello")
await Bun.write("pages/about.md", "About")
await Bun.write("reviews/about.ann.txt", "OK")
await Bun.write("reviews/about.bob.txt", "Fix the typo")
const build = new Build()
build.each({
  matchersByName: {
    page: new FileMatcher("pages/<slug>.md"),
    review: new FileMatcher("reviews/<slug>.<reviewer>.txt"),
  },
  required: ["page"],
  *tasks(vars, matched) {
    const inputs = [matched.page.data]
    if (matched.review !== undefined) inputs.push(matched.review.data)
    const id = `page:${vars.slug}:${vars.reviewer ?? "-"}`
    yield new Task({ id, inputs, run: async () => {} })
  },
})
const result = await build.run()
const ran = result.executed.map((task) => task.id).sort()
console.log(`ran [${ran.join(" ")}]`)
```

<!-- output -->
```text
ran [page:about:ann page:about:bob page:hello:-]
```

`about` gets one set for each review. The set of `hello` has no `review` key in `matched` and no `reviewer` key in `vars`.

- Optional matchers join one after the other, in `matchersByName` order. The **ON vars** of an optional matcher are its var names that a required matcher or an earlier optional matcher has. For `review`, the ON var is `slug`. A match joins a set when it has the set's value for each ON var. An optional matcher with no ON vars, such as `tags/<tag>.txt`, joins each of its matches to each set.
- The order matters only when two optional matchers share a var name that no required matcher has. Add `rating: new FileMatcher("ratings/<slug>.<reviewer>.txt")` after `review` in the sample. Its ON vars are `slug` and `reviewer`, so a rating joins only the set of the review by the same reviewer. `hello` has no `reviewer` value, so even `ratings/hello.dan.txt` does not join it. Put `rating` before `review`, and a review joins only a set with a rating by the same reviewer: with no ratings, no set gets a review.
- With a literal `required`, as in the sample, TypeScript types `matched.review` as possibly `undefined`, and each var, even `vars.slug`, as `string | undefined`. For a `string`, read the var from a required match: `matched.page.vars.slug`. If `required` is a variable of type `("page" | "review")[]`, TypeScript treats every matcher as required. Then `matched.review.data` type-checks, but `run()` can reject with a TypeError even when each page has a review. During the scans, `tasks()` can run for a page before the review matcher finds its review ([the config](#the-config)).

## Matches during the run

During the run, `FileMatcher` and `FileGroupMatcher` hear the build's [events](guide.md#events). So a file that a task declares or reports gets its tasks in the same `run()`. In this program, `write` reports `chapters/1.txt`, and `build.each` makes the task `summary:1` for it:

```ts
import { Build, Task } from "dapat"
import { FileArtifact, FileMatcher, FilesystemPrefix } from "dapat/contrib"
const build = new Build()
const chapters = new FilesystemPrefix("chapters")
build.add(new Task({ id: "write", outputs: [chapters], run: async (ctx) => {
  const chapter = new FileArtifact("chapters/1.txt")
  await Bun.write(chapter.path, "Chapter 1")
  ctx.produced(chapter)
  console.log("ctx.produced returned")
  await Bun.sleep(10)
  console.log("write ends")
} }))
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

- `build.each` adds `summary:1` before `ctx.produced` returns. `summary:1` starts only when `write` ends, because `write` declares the folder that holds the chapter.
- A `FileMatcher` gives a file a match when the [scan](guide.md#buildeach) finds the file or a `produced` event comes for it. A `deleted` event ends the match. A `promised` event for a folder makes no match. So report each file that a task writes in a folder, or the file gets a match only at the next build's scan.
- A file also has a match while a task declares it as an exact output, from the `promised` event to the `withdrawn` event. So the file has a match before it exists. A `deleted` event does not end this match ([known issue 8](limits.md#known-issues-in-010)).
- `FileGroupMatcher` uses these rules for each file of a list. At each report that changes a list, `build.each` runs `tasks()` again for each joined set that holds the list. The new task [replaces](guide.md#tasks-and-dependencies) the old one, so `result.cancelled` can hold several tasks with one id. The build time grows with the square of the number of reports ([scale](limits.md#scale)). A declared file joins the list at its `promised` event, so its report does not run `tasks()` again.

## Loops

In a **loop**, each task of a `build.each` writes the file that its matcher finds next. Each task, with its input file, is one **turn**. Use a loop when you do not know the number of turns before the run, as in an agent loop. Each task reports its file with `ctx.produced`, so `build.each` makes the next task in the same `run()`. Here, `step:<n>` takes `turns/<n>/t.txt` as its input and writes `turns/<n+1>/t.txt` while `n` is less than 3:

```ts
import { Build, Task } from "dapat"
import { FileArtifact, FileMatcher, FilesystemPrefix } from "dapat/contrib"
await Bun.write("turns/0/t.txt", "0")
const build = new Build()
build.each({
  matchersByName: { turn: new FileMatcher("turns/<n>/t.txt") },
  *tasks(vars, matched) {
    const n = Number(vars.n)
    const id = `step:${n}`
    const nextFolder = new FilesystemPrefix(`turns/${n + 1}`)
    const nextFile = new FileArtifact(`turns/${n + 1}/t.txt`)
    yield new Task({ id, inputs: [matched.turn.data], outputs: [nextFolder], run: async (ctx) => {
      if (n >= 3) return // the stop condition: the last turn writes nothing
      await Bun.write(nextFile.path, String(n + 1))
      ctx.produced(nextFile)
    } })
  },
})
const result = await build.run()
const ran = result.executed.map((task) => task.id).sort()
console.log(`ran [${ran.join(" ")}]`)
```

<!-- output -->
```text
ran [step:0 step:1 step:2 step:3]
```

- `step:<n>` declares the folder `turns/<n+1>/`, not the file. With the file as an exact output, `run()` rejects before any task runs ([layout rules](guide.md#layout-rules)).
- dapat does not stop a loop that goes through `ctx.produced`, and the [send limit](semantics.md#the-send-limit) does not count its turns. Give every loop a maximum number of turns, as `n >= 3` does here.

## Between builds

A matcher belongs to the first `Build` whose `build.each` uses it, so give each new `Build` new matchers. The new matchers scan again.

- A deleted file that no task declares or writes gets no gone. The scan does not find it, so its tasks are not in the build. Their outputs and records stay ([layout rules](guide.md#layout-rules)).
- A deleted file that a task declares, or writes and reports, still has its tasks in the build. The task declares the file again, or runs again and reports it.
- The files of old turns stay, and each scan finds them. So when a loop ends at an earlier turn than in the last build, the later turns still get tasks, which skip while their files do not change. To start a loop again from turn 0, delete the folders of turns 1 and up.

## Errors

[Error messages](api.md#error-messages) gives the text of each error, and [fatal errors](semantics.md#fatal-errors) gives what the build does after a fatal error. `build.each` throws when:
- the call comes after the first `run()` starts
- `matchersByName` is empty, gives one matcher object two names, or holds a matcher that belongs to another `Build` ([between builds](#between-builds))
- `required` is empty or names a matcher that is not in `matchersByName`, or the required matchers fall into two groups that share no var name ([joins](#joins))

`run()` rejects with a [fatal error](guide.md#results-and-failure) when:
- a task of a joined set has the id or an exact output of another task ([the config](#the-config))
- `tasks()` or a scan throws, `tasks()` returns no iterable, or a matcher sends vars whose names are not exactly its [`varNames`](write-a-matcher.md#what-you-write)
- a loop task declares the file of the next turn as an exact output ([loops](#loops))
