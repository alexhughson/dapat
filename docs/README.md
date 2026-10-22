# dapat documentation

Run the [README example](../README.md#example) first. For complete programs, see the [examples](../examples/README.md).

## Pages

| Goal | Page | Read it when |
| --- | --- | --- |
| Write a first program | [Guide](guide.md), part 1 | you start: it defines the terms that the other pages use |
| Write a pipeline | [Guide](guide.md#buildeach), part 2 | you use `build.subscribe` or `build.each`, or tasks share a folder |
| | [build.each](build-each.md) | you write a pattern or an output template, join matchers, or write a loop, such as an agent loop |
| | [Built-in artifacts and stores](builtins.md) | you choose a stamp mode or a store, use folders or S3, or [write a store](builtins.md#write-a-store) |
| Do a common job | [Recipes](recipes.md) | you force a rerun, rerun after a code change, delete old outputs, limit parallel work, run in CI, or call a paid model |
| Fix a problem | [Troubleshooting](troubleshooting.md) | a task runs, skips, waits or is missing when you do not expect it, and there is no error message |
| Check the limits | [Limits](limits.md) | you plan thousands of tasks, or you look for a known issue |
| Extend dapat | [Write an artifact type](write-an-artifact.md) | a task reads or writes a value that is not a file or an S3 object |
| | [Write a matcher](write-a-matcher.md) | `build.each` must find artifacts that are not files |
| Look up a rule or an export | [How a build works](semantics.md) | you need the exact rules for order, skips, events and fatal errors, or you subclass `Build` |
| | [API reference](api.md) | you look up an export or the exact text of an error |

## Terms

| Defined in | Term | Definition |
| --- | --- | --- |
| [What a build does](guide.md#what-a-build-does) | artifact | one thing that a task reads or writes, such as a file. It has an id, such as `file:/home/me/project/in.txt` |
| | task, declare | an id, inputs (the artifacts that it reads), outputs (the artifacts that it writes) and a `run` function. A task declares the artifacts in its inputs and outputs |
| | build | one run of the tasks of one `Build`: make a new `Build`, add tasks, call `run()` one time |
| | finish | a task finishes in one of four ways: executed, skipped, failed or cancelled |
| | producer | another task that declares an input of the task as an output. The task waits for it |
| | stamp | a string that changes when the artifact changes, or `null` when the artifact is missing |
| | store, record | the store keeps one record for each task id: the stamps of its inputs and outputs from its last successful run |
| | skip | the build does not call the `run` function, because the current stamps equal the record of the task |
| [Artifacts and stamps](guide.md#artifacts-and-stamps) | stamp mode | which changes to a file give a new stamp: a hash stamp (SHA-256 of the bytes) or a time stamp (mtime and size) |
| [Tasks and dependencies](guide.md#tasks-and-dependencies) | exact output | an output that is an artifact, not a prefix. Only one task can declare it |
| | replace, remove | `build.add` with the id of a task replaces that task. `build.remove(id)` removes it |
| [The skip rule](guide.md#the-skip-rule) | skip rule, reason | the five checks that decide a skip. The reason, such as `input-changed`, tells why a task ran |
| [Folders: prefixes](guide.md#folders-prefixes) | prefix, covers | an input or an output for a group of artifacts, such as a folder. It covers each artifact whose id starts with its id |
| [Outputs with unknown names](guide.md#outputs-with-unknown-names) | report | a call of `ctx.produced` or `ctx.deleted`: the task tells the build that it wrote or deleted an artifact |
| [Results and failure](guide.md#results-and-failure) | outcome | how a task finished. A `Result` lists each task by its outcome |
| | fatal error | an error that makes `run()` reject. After it, no more tasks start |
| [build.each](guide.md#buildeach) | matcher, scan | finds artifacts for `build.each`, such as the files that fit a pattern. At its start, `run()` scans: each matcher finds the artifacts that exist now |
| | match, vars | one artifact or list that a matcher found, with its vars: names with string values |
| | joined set | one match of each matcher, with the same values for shared var names |
| | one-task form, tasks form | the one-task form (`name` and `run`) makes one task for each joined set. The tasks form (`tasks()`) returns the tasks of each set |
| | output template | names an output of each joined set with its vars, such as `site/<slug>.html` |
| [Events](guide.md#events) | event, subscriber | a message from the build about an output: `promised`, `produced`, `deleted` or `withdrawn`. A subscriber is a function that gets each event |
| [How build.each works](build-each.md#how-buildeach-works) | found event, gone event | a matcher tells `build.each` that a match is new or changed, or that it is gone |
| [dapat deletes no file](guide.md#dapat-deletes-no-file) | old output | a file that a task wrote in an earlier build and no task writes now |
| [Replacement and removal](semantics.md#replacement-and-removal) | stopped run | the run of a task that a change replaces or removes after `run` starts and before the task finishes |
