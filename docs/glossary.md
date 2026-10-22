# Terms

This table gives the short meaning of each main term of the docs, and links to the section that defines the term.

| Term | Meaning | Defined in |
| --- | --- | --- |
| artifact | one thing that a task reads or writes, such as a file. Its id is a string, such as `file:/home/me/project/in.txt` | [Guide › What a build does](guide.md#what-a-build-does) |
| artifact type | a class that extends `Artifact`, for a value that dapat has no class for | [Write an artifact type](write-an-artifact.md) |
| build | one run of your tasks: make a new `Build`, add tasks, and call `run()` | [Guide › What a build does](guide.md#what-a-build-does) |
| covers | a prefix covers each artifact whose id starts with the prefix id | [Guide › Folders: prefixes](guide.md#folders-prefixes) |
| data | the artifact or the list of artifacts in a match, such as the `FileArtifact` of the file that a `FileMatcher` found | [Guide › build.each](guide.md#buildeach) |
| deadlock | the state in which no task runs and each task that has not finished waits for a producer. The waiting tasks then fail | [How a build works › The order rule](semantics.md#the-order-rule) |
| declare | a task declares the artifacts in its inputs and outputs | [Guide › What a build does](guide.md#what-a-build-does) |
| drain | the build sends the events of its queue to the subscribers, in one or more passes. A pass sends events until the queue is empty | [How a build works › The event queue](semantics.md#the-event-queue) |
| event | a message from the build about an output of a task: `promised`, `produced`, `deleted` or `withdrawn` | [Guide › Events](guide.md#events) |
| exact output | an output that is an artifact, not a prefix. Only one task can declare it | [Guide › Tasks and dependencies](guide.md#tasks-and-dependencies) |
| fatal error | an error that makes `run()` reject. After it, no more tasks start | [Guide › Results and failure](guide.md#results-and-failure) |
| finish | a task finishes in one of four ways: executed, skipped, failed or cancelled | [Guide › What a build does](guide.md#what-a-build-does) |
| `found` event | a matcher tells `build.each` that it added a match or changed the data of a match | [build.each › How build.each works](build-each.md#how-buildeach-works) |
| `gone` event | a matcher tells `build.each` that it removed a match | [build.each › How build.each works](build-each.md#how-buildeach-works) |
| joined set | one match of each matcher, with the same value for each var that two matches share | [Guide › build.each](guide.md#buildeach) |
| loop | a `build.each` in which each task writes the file that its matcher finds next, such as an agent loop | [build.each › Loops](build-each.md#loops) |
| match | one result of a matcher, with its vars and its data | [Guide › build.each](guide.md#buildeach) |
| matcher | an object that finds artifacts for `build.each`, such as a `FileMatcher` for the files that fit a pattern | [Guide › build.each](guide.md#buildeach) |
| old output | a file that a task wrote in an earlier build and that no task writes now. It stays on disk | [Guide › dapat deletes no file](guide.md#dapat-deletes-no-file) |
| one-task form | `build.each` with `name` and `run`, which makes one task for each joined set | [Guide › build.each](guide.md#buildeach) |
| open step | a step that still collects task changes. When it closes, the build checks the step rules | [How a build works › Steps](semantics.md#steps) |
| optional matcher | a matcher that `required` does not name. A joined set can have no match of it | [build.each › required](build-each.md#required) |
| outcome | how a task finished. A `Result` lists each task by its outcome | [Guide › Results and failure](guide.md#results-and-failure) |
| output template | names an output of each task with the vars of its joined set, such as `site/<slug>.html` | [Guide › build.each](guide.md#buildeach) |
| overlap | two prefixes overlap when the id of one starts with the id of the other, such as `pages/` and `pages/en/` | [Guide › Folders: prefixes](guide.md#folders-prefixes) |
| prefix | an input or an output that stands for a group of artifacts, such as the files in a folder | [Guide › Folders: prefixes](guide.md#folders-prefixes) |
| producer | another task that declares an input of the task as an output. The task waits for it | [Guide › What a build does](guide.md#what-a-build-does) |
| reason | why a task ran, such as `input-changed` | [Guide › The skip rule](guide.md#the-skip-rule) |
| record | the stamps of the inputs and outputs of a task from its last successful run | [Guide › What a build does](guide.md#what-a-build-does) |
| remove | `build.remove(id)` takes the task with that id out of the `Build` | [Guide › Tasks and dependencies](guide.md#tasks-and-dependencies) |
| replace | `build.add` with a task whose id is already in the `Build` replaces the old task | [Guide › Tasks and dependencies](guide.md#tasks-and-dependencies) |
| report | a call of `ctx.produced` or `ctx.deleted`: the task tells the build that it wrote or deleted an artifact | [Guide › Outputs with unknown names](guide.md#outputs-with-unknown-names) |
| scan | at the start of the first `run()` of a `Build`, each matcher finds the artifacts that exist now | [Guide › build.each](guide.md#buildeach) |
| send limit | the `sendLimit` option of `new Build`: the most events that subscribers cause in one pass, and the most passes in one drain | [How a build works › The send limit](semantics.md#the-send-limit) |
| skip | the build does not call the `run` function of a task, because the stamps of its inputs and outputs equal its record | [Guide › What a build does](guide.md#what-a-build-does) |
| skip rule | the five checks that decide whether a task skips | [Guide › The skip rule](guide.md#the-skip-rule) |
| stamp | a string that changes when the artifact changes, or `null` when the artifact is missing | [Guide › What a build does](guide.md#what-a-build-does) |
| stamp mode | which file changes give a new stamp: a hash stamp (SHA-256 of the bytes) or a time stamp (mtime and size) | [Guide › Artifacts and stamps](guide.md#artifacts-and-stamps) |
| step | a set of task changes that the build applies at one time. The step rules: each task id comes from one source only, and no exact output is declared twice | [How a build works › Steps](semantics.md#steps) |
| stopped run | the run of a task that a change replaces or removes after `run` starts and before the task finishes | [How a build works › Replacement and removal](semantics.md#replacement-and-removal) |
| store | an object that keeps one record for each task id between builds: a `MemoryStore`, `JsonStore`, `SqliteStore` or your own `Store` | [Guide › What a build does](guide.md#what-a-build-does) |
| subscriber | a function that you give to `build.subscribe`. The build calls it with each event | [Guide › Events](guide.md#events) |
| task | an id, inputs (the artifacts that it reads), outputs (the artifacts that it writes) and a `run` function | [Guide › What a build does](guide.md#what-a-build-does) |
| task group | a set of task ids that one call can replace as a whole, such as the tasks of one joined set | [How a build works › Subclass Build: setTasksOfGroups](semantics.md#subclass-build-settasksofgroups) |
| tasks form | `build.each` with `tasks()`, which returns the tasks of each joined set | [Guide › build.each](guide.md#buildeach) |
| vars | names with string values that a matcher gives each match, such as `{ lang: "en", slug: "hello" }` | [Guide › build.each](guide.md#buildeach) |
