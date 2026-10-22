# Limits

This page gives the sizes at which a build gets slow, and the known issues of version 0.1.0, each with a workaround. [Layout rules](guide.md#layout-rules) gives the folder rules that the build does not check. The things that dapat does not do are in the [README](../README.md#what-dapat-does-not-do).

## Scale

dapat's own time, without the work of the tasks, grows about as the number of tasks. It grows faster with `JsonStore`, with `FileGroupMatcher` reports, and in the last two rows. The notes under the table and [Scheduling cost](semantics.md#scheduling-cost) give the causes. The table gives the shortest and longest time of several runs on one machine with Bun 1.4.2, with tasks that do almost no work. Each time includes the `build.add` calls and `run()`.

| Build | Time |
| --- | --- |
| independent tasks, `MemoryStore` | 1,000 tasks: 22–38 ms. 8,000: 0.16–0.22 s. 32,000: 0.59–0.71 s |
| a chain, `MemoryStore`: each task reads the output of the task before it | 1,000 tasks: 32–50 ms. 8,000: 0.22–0.28 s. 32,000: 0.74–0.87 s |
| a chain from `build.each`, with [`JsonStore`](builtins.md#stores): one task reports each page of a book | 100 pages: 0.28–0.37 s. 400: 1.5 s. 1,000: 5.9–7.2 s (2.9–3.1 s when every task skips). With `SqliteStore`, 1,000 pages: 3.1–3.3 s (0.65–0.68 s) |
| 2,000 independent tasks, each reads and writes one file | `JsonStore`: 6.6–6.7 s. `SqliteStore`: 3.6–4.6 s |
| one task writes files into a folder and reports each one. One [`FileGroupMatcher`](build-each.md#filegroupmatcher) match lists them | 2,000 files: 1.0–1.9 s. 4,000: 4.5–5.1 s |
| n tasks that read the same prefix, whose class overrides `covers()` | 4,000 tasks: 0.60–0.77 s. 16,000: 10.7–11.2 s. With an `IdPrefix` in its place, 16,000: 0.35–0.39 s |
| one task reads a prefix, and each producer of the prefix adds the next one when it runs | 4,000 producers: 0.94–1.01 s. 16,000: 29.5–33.4 s |

- With `JsonStore`, the time grows about as the square of the number of tasks ([Stores](builtins.md#stores) gives the cause).
- With `FileGroupMatcher`, each report makes the tasks of the match again. So the time grows about as the square of the number of reports ([Matches during the run](build-each.md#matches-during-the-run)).
- `bun bench/scheduler.ts <scenario> <n>` measures rows 1, 2, 6 and 7, with a `MemoryStore`. Their scenarios are `flat`, `chain`, `custom-prefix` and `one-at-a-time`. `shared-prefix` gives the `IdPrefix` time in row 6.

To keep a build fast:

- Use `SqliteStore` for a build with a thousand tasks or more.
- Declare the files as exact outputs when you know their names. Then a `FileGroupMatcher` gets them in one [step](semantics.md#steps).
- Add the producers of a prefix input together, such as in one loop. Do not add each one when the one before it runs.
- Override `covers` and `overlaps` only for a prefix that does not compare id starts ([write an artifact type](write-an-artifact.md#a-prefix-that-does-not-compare-id-starts)).

## Stamps and matchers

- With a store, the [hash stamp](builtins.md#hash-or-time) of a 128 MiB file takes about 0.5 s. So 20 tasks that read such a file in the 2 s after its write take about 10 s.
- A pattern [part](build-each.md#filematcher) with many `*` or vars is slow on a long name that fails only at its end. Examples are `*a*a*a*a*b` in a `FileGroupMatcher` and `<v>a<w>a<x>a<y>a<z>b` in a `FileMatcher`. A name of 200 `a` characters takes about 5 s. A part such as `*-*-*.jpg` stays fast.
- `run()` takes no `AbortSignal`, so a [scan](guide.md#buildeach) that never returns makes `run()` wait forever. If the scan of [your own matcher](write-a-matcher.md) can hang, make it throw after a timeout.

## Known issues in 0.1.0

1. **A [replacement](guide.md#tasks-and-dependencies) does not wait for the old run.** The old run can write its output after the new task does, so the old value stays. Before each write, return when `ctx.signal.aborted` is true.
2. **After `run` returns, `ctx.produced` and `ctx.deleted` still send [events](guide.md#events).** Use `ctx` only inside `run`, until `ctx.signal` aborts.
3. **With a store, a task fails after its run when `store.set` or an output's `stamp()` throws.** The build has already sent its `produced` [events](guide.md#events). Act on `produced` only after `run()` resolves without the task in `result.failed`.
4. **A plain object is not an artifact.** An object with `id`, `stamp` and `read` type-checks, but the tasks that read it do not wait for the task that writes it. Use a subclass of `Artifact` or `Prefix` ([what you write](write-an-artifact.md#what-you-write)).
5. **`dependency of '<id>' failed` names the waiting task, not the task that failed.** Find the cause in `result.failed` ([Error messages](api.md#error-messages)).
6. **A `FileMatcher` or `FileGroupMatcher` keeps the [match](build-each.md#matches-during-the-run) of a declared [exact output](guide.md#tasks-and-dependencies) when its task does not write the file or deletes it.** Then the tasks that read the file run while it is missing. Declare the folder instead ([layout rules](guide.md#layout-rules)).
7. **A task whose [report](guide.md#outputs-with-unknown-names) makes a subscriber remove a producer, and that then waits for a reader of that producer's output, waits forever.** The reader waits until the reporting task ends ([the order rule](semantics.md#the-order-rule)), so `run()` never resolves and dapat reports no deadlock. Do not make a reporting task wait for other tasks.
8. **A var that shares its [part](build-each.md#filematcher) with other text can be `.` or `..`, and an [output template](build-each.md#output-templates) with that var makes `run()` reject.** For example, `content/<slug>.md` fits `content/...md` with the slug `..`, so `new FileTemplate("site/<slug>.html")` makes `run()` reject before a task runs. Keep such names out of the folders that a pattern reads.
