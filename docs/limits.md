# Limits

This page gives the sizes at which a build gets slow, and the known issues of version 0.1.0, each with a workaround.

## Scale

dapat's own time, without the work of the tasks, grows about as the number of tasks ([Scheduling cost](semantics.md#scheduling-cost)). The last column gives the cause of each row that grows faster, and the fix. The table gives the shortest and longest time of several runs on a Linux VM with 4 cores of an Intel Xeon at 2.8 GHz and Bun 1.4.2, with tasks that do almost no work. Each time includes the `build.add` calls and `run()`. `bun bench/scheduler.ts <scenario> <n>` measures rows 1 and 2 (`flat`, `chain`), row 6 (`custom-prefix`, `shared-prefix`) and row 7 (`one-at-a-time`).

| Case | Time | Cause, and how to keep it fast |
| --- | --- | --- |
| independent tasks, with `MemoryStore` | 1,000 tasks: 22–38 ms. 8,000: 0.16–0.22 s. 32,000: 0.59–0.71 s | – |
| a chain in which each task reads the output of the task before it, with `MemoryStore` | 1,000 tasks: 32–50 ms. 8,000: 0.22–0.28 s. 32,000: 0.74–0.87 s | – |
| a chain from `build.each`, with `JsonStore`: one task reports each page of a book | 100 pages: 0.28–0.37 s. 400: 1.5 s. 1,000: 5.9–7.2 s (2.9–3.1 s when every task skips). With `SqliteStore`, 1,000 pages: 3.1–3.3 s (0.65–0.68 s) | `JsonStore` reads the whole file at each call, and writes it at each `set`. So its time grows about as the square of the number of tasks. Use [`SqliteStore`](builtins.md#stores) for a thousand tasks or more |
| 2,000 independent tasks, each reads and writes one file | `JsonStore`: 6.6–6.7 s. `SqliteStore`: 3.6–4.6 s | With `JsonStore`, the same cause |
| one task writes files into a folder and reports each one. One `FileGroupMatcher` match lists them | 2,000 files: 1.0–1.9 s. 4,000: 4.5–5.1 s | Each report makes the tasks of the match again ([Matches during the run](build-each.md#matches-during-the-run)). Declare the files as exact outputs when you know their names |
| n tasks that read the same prefix, whose class overrides `covers()` | 4,000 tasks: 0.60–0.77 s. 16,000: 10.7–11.2 s. With an `IdPrefix` in its place, 16,000: 0.35–0.39 s | Each time a task looks for its producers, it checks every output. Override `covers` and `overlaps` only for a prefix that does not compare id starts ([How the build uses your classes](write-an-artifact.md#how-the-build-uses-your-classes)) |
| one task reads a prefix, and each producer of the prefix adds the next one when it runs | 4,000 producers: 0.94–1.01 s. 16,000: 29.5–33.4 s | Each time the task looks for its producers, it lists the outputs under the prefix to find the next one. Add the producers together, such as in one loop |
| a pattern part with many `*` or vars, such as `*a*a*a*a*b` or `<v>a<w>a<x>a<y>a<z>b`, on a name of 200 `a` characters | about 5 s | The match tries each way to split the name between the markers. A part such as `*-*-*.jpg` stays fast |

## Known issues in 0.1.0

### A replacement does not wait for the old run

After a [replacement](guide.md#results-and-failure), the new task can start before the [stopped run](semantics.md#replacement-and-removal) of the old task returns. The stopped run can write its output after the new task does, so the old value stays. In `run`, return before each write when `ctx.signal.aborted` is true.

### `ctx` still sends events after `run` returns

After `run` returns, `ctx.produced` and `ctx.deleted` still send [events](guide.md#events). Use `ctx` only inside `run`, until `ctx.signal` aborts.

### A task can fail after its produced events

With a store, a task fails after its run when `store.set` or the `stamp()` of an output throws. The build has already sent its `produced` events. Act on `produced` only after `run()` resolves without the task in `result.failed`.

### A removal at a report can make `run()` wait forever

A subscriber or `build.each` can remove a producer at a [report](guide.md#outputs-with-unknown-names). When the reporting task then waits for a reader of that producer's output, `run()` never resolves, and dapat reports no deadlock ([the order rule](semantics.md#the-order-rule)). Do not make a reporting task wait for other tasks.

### A task change at the first `promised` events starts tasks before the scans

The first `run()` sends `promised` events before its scans. When a subscriber calls `build.add` or `build.remove` at one of them, every task that has not started starts immediately ([the order rule](semantics.md#the-order-rule)). So a task can run before the [`build.each`](build-each.md#how-buildeach-works) tasks that write its inputs. These events promise only the outputs of the tasks that you added before `run()`, so make such changes before you call `run()`.

### A throw in `covers` or `overlaps` leaves a task out of the `Result`

When the [`covers` or `overlaps`](write-an-artifact.md#how-the-build-uses-your-classes) of a prefix throws while a task looks for its producers ([One task](semantics.md#one-task)):

- The task never runs, and it is in no list of the `Result`. `result.success` stays true.
- A task that waits for it makes `run()` wait forever.
- Bun prints the throw as an unhandled rejection, and the process exits with code 1 when it ends.

Make `covers` and `overlaps` never throw. Check the class of the argument before you read a field of your class, and return `true` from a `catch`, so that the task waits.

### A matched var can make an output template reject

A var that shares its [part](build-each.md#filematcher) with other text can get the value `.` or `..`. For example, `content/<slug>.md` fits `content/...md` with the slug `..`. Then an [output template](build-each.md#output-templates) with that var, such as `new FileTemplate("site/<slug>.html")`, makes `run()` reject before a task runs. Keep such names out of the folders that a pattern reads.
