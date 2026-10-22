# dapat documentation

Run the [README example](../README.md#example) first. For complete programs, see the [examples](../examples/README.md).

## Pages

| Goal | Page | Read it when |
| --- | --- | --- |
| Write a first build | [Guide](guide.md), part 1 | you start: it defines the terms that the other pages use |
| Write a pipeline | [Guide](guide.md#events), part 2 | you use `build.each` or `build.subscribe`, or a task writes in a folder that it reads or that another task writes |
| | [build.each](build-each.md) | you need the pattern rules, a task with files from two or more matchers, an optional input, or a [loop](build-each.md#loops), where each task writes the file from which `build.each` makes the next task |
| | [Built-in artifacts and stores](builtins.md) | you choose a stamp mode or a store, or use folders or S3 |
| Do a common job | [Recipes](recipes.md) | you want to find why a task ran, force a rerun, rerun after a code change, delete old outputs, limit parallel work, run in CI, or call a paid model |
| Check the limits | [Limits](limits.md) | you design a large build, or you want the known issues |
| Extend dapat | [Write an artifact type](write-an-artifact.md) | a task reads or writes a value that is not a file or an S3 object, or you write a store |
| | [Write a matcher](write-a-matcher.md) | `build.each` must find artifacts that are not files |
| Look up a rule or an export | [How a build works](semantics.md) | you need the exact rules for order, skips, events and fatal errors, or you subclass `Build` |
| | [API reference](api.md) | you look up an export or the exact text of an error |

## Symptoms with no error message

For an error message, find its text in [Error messages](api.md#error-messages).

| Symptom | Cause | See |
| --- | --- | --- |
| A task runs on every build | The `Build` has no store, or each process or each `Build` makes a new `MemoryStore`.<br>The task has no inputs, a prefix with the stamp `null` (such as an `IdPrefix`), or an [exact output](guide.md#tasks-and-dependencies) that is missing after its run.<br>With time stamps, the task writes a file that it reads. | [The skip rule](guide.md#the-store-and-the-skip-rule), [Layout rules](guide.md#layout-rules) |
| A task never runs, and `result.cancelled` lists it | A `build.add` or `ctx.add` with the same id replaced it. Or `build.remove`, `ctx.remove` or `build.each` removed it before it started. | [Tasks and dependencies](guide.md#tasks-and-dependencies) |
| A task skips after you change its code | The skip rule does not look at the `run` function. | [Rerun when your code changes](recipes.md#rerun-when-your-code-changes) |
| A task that reads or writes a folder runs on every build, or on one or two extra builds | Another task writes in the task's output folder.<br>The task writes in a folder that it reads.<br>The store file is in a folder that the task reads or writes. | [Layout rules](guide.md#layout-rules) |
| Every task with a file input or output runs after you move the project, or in CI | After a move: file ids are absolute paths, so they no longer match the records.<br>In CI: the job does not restore the store file or the outputs.<br>In CI with time stamps: the checkout changes every time stamp. | [Files](builtins.md#files), [Run in CI](recipes.md#run-in-ci) |
| An old output stays on disk, and `build.each` makes a task for it | dapat deletes no file. The next scan finds the old output when a pattern fits it. | [Layout rules](guide.md#layout-rules), [Delete old outputs](recipes.md#delete-old-outputs) |
| Task `b` runs before task `a`, which writes its input | No output of `a` is the file or a prefix that covers it.<br>The output of `a` is a plain object, not an `Artifact` or a `Prefix`.<br>After `run()` starts the tasks, your code adds `b`, awaits, and then adds `a`. | [Tasks and dependencies](guide.md#tasks-and-dependencies), [What you write](write-an-artifact.md#what-you-write), [The order rule](semantics.md#the-order-rule) |
| `run()` never resolves | A matcher's scan does not return.<br>A task awaits the `run()` of its own build. | [How build.each works](build-each.md#how-buildeach-works), [build.run()](semantics.md#buildrun) |
| A second `run()` on one `Build` runs no finished task, makes no task for a new file, and lists earlier tasks in its `Result` | A `Build` starts each task one time and scans only in its first `run()`. | [Results and failure](guide.md#results-and-failure), [How build.each works](build-each.md#how-buildeach-works) |
| A `build.each` task is missing | No match of a required matcher has the same values as the other matches for their shared vars.<br>A task writes a file in its output folder and does not report it with `ctx.produced`. The file gets its task only at the next build's scan. | [Joins](build-each.md#joins), [Matches during the run](build-each.md#matches-during-the-run) |
