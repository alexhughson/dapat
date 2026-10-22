# Limits

This page gives the sizes at which a build gets slow, and the known issues of version 0.1.0, each with a workaround. [Layout rules](guide.md#layout-rules) gives the folder rules that the build does not check. The things that dapat does not do are in the [README](../README.md#what-dapat-does-not-do).

## Scale

dapat's own time, without the work of the tasks, grows faster than the number of tasks ([Scheduling cost](semantics.md#scheduling-cost) gives the cause). The table gives the shortest and longest time of several runs on one machine with bun 1.4.2, with tasks that do almost no work.

| Build | Time |
| --- | --- |
| independent tasks, no store | 1,000 tasks: 23–35 ms. 4,000: 75–125 ms. 8,000: 0.25–0.54 s |
| a chain, no store: each task reads the output of the task before it | 500 tasks: 0.18–0.35 s. 1,000: 1.0–2.1 s. 1,500: 2.9–5.3 s |
| a chain from `build.each`, with [`JsonStore`](builtins.md#stores): one task reports each page of a book | 100 pages: 0.45–0.69 s. 200: 1.2–2.2 s. 400: 6.3–11 s (4.8–9.6 s when every task skips) |
| 2,000 independent tasks, each reads and writes one file | `JsonStore`: 4.9–8.4 s. `SqliteStore`: 2.4–3.4 s |
| one task writes files into a folder and reports each one. One [`FileGroupMatcher`](build-each.md#filegroupmatcher) match lists them | 2,000 files: 0.4–1.3 s. 4,000: 1.5–3.0 s |

- In a chain of n tasks, the time grows between n² and n³. A task that skips still adds this time.
- With `JsonStore`, the time grows about as the square of the number of tasks ([Stores](builtins.md#stores) gives the cause).
- With `FileGroupMatcher`, each report runs `tasks()` again ([Matches during the run](build-each.md#matches-during-the-run)).

To keep a build fast:

- Keep a build to a few hundred tasks that wait for each other.
- Put small items into one task: one task for each chapter, not one for each sentence.
- Use `SqliteStore` for a build with a thousand tasks or more.

## Stamps and matchers

- With a store, the [hash stamp](builtins.md#hash-or-time) of a 128 MiB file takes about 0.5 s. So 20 tasks that read such a file in the 2 s after its write take about 10 s.
- In a `FileGroupMatcher` pattern, a [part](build-each.md#filematcher) with many `*`, such as `*a*a*a*a*b`, is slow on a long name that fails only at its end. A name of 200 `a` characters takes about 6 s. A part such as `*-*-*.jpg` stays fast.
- `run()` takes no `AbortSignal`, so a [scan](guide.md#buildeach) that never returns makes `run()` wait forever. If the scan of [your own matcher](write-a-matcher.md) can hang, make it throw after a timeout.

## Known issues in 0.1.0

1. **A [replacement](guide.md#tasks-and-dependencies) does not wait for the old run.** The old run can write its output after the new task does, so the old value stays. Before each write, return when `ctx.signal.aborted` is true.
2. **The `ctx` calls of a task still take effect after the task stops.** After a replacement or removal, `ctx.add` and `ctx.remove` still change the build. After `run` returns, `ctx.produced` and `ctx.deleted` still send [events](guide.md#events). Use `ctx` only inside `run`, until `ctx.signal` aborts.
3. **With a store, a task fails after its run when `store.set` or an output's `stamp()` throws.** The build has already sent its `produced` [events](guide.md#events). Act on `produced` only after `run()` resolves without the task in `result.failed`.
4. **A plain object is not an artifact.** An object with `id`, `stamp` and `read` type-checks, but the tasks that read it do not wait for the task that writes it. Use a subclass of `Artifact` or `Prefix` ([what you write](write-an-artifact.md#what-you-write)).
5. **One `Build` object is for one build.** Its `Result` holds the tasks and errors of every `run()` call ([Results and failure](guide.md#results-and-failure)). After the first `run()` starts its tasks, a task that you add starts immediately ([the order rule](semantics.md#the-order-rule)). For each new build, make a new `Build`.
6. **`dependency of '<id>' failed` names the waiting task, not the task that failed.** Find the cause in `result.failed` ([Error messages](api.md#error-messages)).
7. **The `inputs` and `outputs` of [`TaskInit`](api.md#task) take mutable arrays.** A readonly list, such as the data of a `FileGroupMatcher` match, fails tsc with TS4104. Spread it: `inputs: [...matched.pages.data]`.
8. **A `FileMatcher` or `FileGroupMatcher` keeps the [match](build-each.md#matches-during-the-run) of a declared [exact output](guide.md#tasks-and-dependencies) when its task does not write the file or deletes it.** Then the tasks that read the file run while it is missing. Declare the folder instead ([layout rules](guide.md#layout-rules)).
