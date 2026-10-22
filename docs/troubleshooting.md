# Troubleshooting

This page lists problems that give no error message. Each row gives one cause, and a row with no symptom gives another cause of the symptom above it. For an error message, find its text in [Error messages](api.md#error-messages). For a task that runs when you expect a skip, print its reason from `result.outcomes` ([the skip rule](guide.md#the-skip-rule)).

| Symptom | Cause | Fix |
| --- | --- | --- |
| A task runs on every build | The `Build` has no store | Give `new Build` a `store` option |
| | Each process or each `Build` makes a new `MemoryStore` | Share one store, or use a [`JsonStore` or `SqliteStore`](builtins.md#stores) |
| | The task has no inputs | Give it an input, such as the file that it reads |
| | An input or an output is a prefix with the stamp `null`, such as an `IdPrefix` | Use a `Prefix` subclass that has a `stamp()` ([IdPrefix](builtins.md#idprefix)) |
| | An exact output is missing after each run | [Declare the folder](guide.md#a-task-that-may-write-nothing-declares-a-folder) |
| | With time stamps, the task writes a file in a folder that it reads | [Write the file next to the folder](guide.md#write-an-index-next-to-its-folder) |
| A task that reads or writes a folder runs on one or two extra builds, or on every build | Another task writes in its output folder | Give each folder [one writer](guide.md#one-task-writes-one-folder) |
| | The task writes in a folder that it reads | Write the file next to the folder, not in it |
| | The store file is in a folder that the task reads or writes | [Move the store file](guide.md#keep-the-store-file-out-of-task-folders) |
| | After the task starts, another task reports a file, and `build.each` adds tasks for it that write in the folder | Give the task the folder output of the reporting task as an input too ([matches during the run](build-each.md#matches-during-the-run)) |
| Each task with a file input or output runs after you move the project | File ids are absolute paths, so they no longer match the records | Keep the project at one path ([Files](builtins.md#files)) |
| Each task with a file input or output runs in CI | The job does not restore the store file and the outputs | Save and restore them ([Run in CI](recipes.md#run-in-ci)) |
| | The tasks use time stamps, and the checkout changes the mtime of each file | Use hash stamps ([Hash or time](builtins.md#hash-or-time)) |
| A task skips after you change its code | The skip rule does not look at the `run` function | Add an input for the code version ([Rerun when your code changes](recipes.md#rerun-when-your-code-changes)) |
| A task never runs, and `result.cancelled` lists it | Before it started, a new task with the same id replaced it. Its reason is `replaced` | Give each task its own id ([Tasks and dependencies](guide.md#tasks-and-dependencies)) |
| | A `build.remove` call, or a `gone` event at `build.each`, removed it. Its reason is `removed` | Find the `build.remove` call or the match that is gone ([How build.each works](build-each.md#how-buildeach-works)) |
| An old output stays on disk, and `build.each` makes a task for it | [dapat deletes no file](guide.md#dapat-deletes-no-file), so the scan finds the old output | [Delete old outputs](recipes.md#delete-old-outputs), or write a pattern that fits no output |
| Task `b` runs before task `a`, which writes its input | No output of `a` is the file or a prefix that covers it | Declare the file or its folder as an output of `a` |
| | The output of `a` is a plain object, not an `Artifact` or a `Prefix` | Extend `Artifact` or `Prefix` ([What you write](write-an-artifact.md#what-you-write)) |
| | After `run()` starts the tasks, your code adds `b`, awaits, and then adds `a` | Add `a` before the `await` ([the order rule](semantics.md#the-order-rule)) |
| | `a` is a `build.each` task for a file that another task reports after `b` starts | Give `b` the folder output of the reporting task as an input too |
| `run()` never resolves | A matcher's scan does not return | Make the scan throw after a timeout ([Write a matcher](write-a-matcher.md#checklist)) |
| | A task awaits the `run()` of its own `Build` | Do not await `run()` in a task ([build.run()](semantics.md#buildrun)) |
| | When a task reports a file, `build.each` removes another task. The reporting task then waits for a task that reads an output of the removed task | Do not make a reporting task wait for other tasks ([a removal at a report](limits.md#a-removal-at-a-report-can-make-run-wait-forever)) |
| A second `run()` on one `Build` runs no finished task and finds no new file | A `Build` starts each task one time, and only its first `run()` scans | Make a new `Build` for each build ([What a build does](guide.md#what-a-build-does)) |
| A `build.each` task is missing | No match of a required matcher has the same values for the shared vars | Check the vars of each matcher ([Joins](build-each.md#joins)) |
| | A task writes a file in its output folder and does not report it | Report the file with `ctx.produced` ([Outputs with unknown names](guide.md#outputs-with-unknown-names)) |
| | An output template uses a var of an optional matcher, and the set has no match of it | Name the output with the vars of the required matchers ([Output templates](build-each.md#output-templates)) |
