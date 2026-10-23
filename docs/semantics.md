# How a build works

This page gives the exact rules of a build: when it calls your code, sends events and applies task changes, and which errors are [fatal](#fatal-errors). Use it when you write an artifact type or a matcher, subclass `Build`, or debug a build. Read the [guide](guide.md) first: this page uses its terms.

## build.run()

```text
build.run()
├─ the first call only
│  ├─ mark the Build as started; from now on it sends events
│  ├─ with matchers: open a step (Steps)
│  ├─ queue promised for each output of each task, then drain (The event queue)
│  └─ with matchers and no fatal error: start every scan at the same time
├─ any call, while the scans run: wait until every scan returns and the step closes, or until a fatal error
├─ a fatal error → reject with it; else start each task that has not started (One task)
├─ wait until no task waits or runs and no store.delete of a removed task is pending
└─ a fatal error → reject with it; else resolve with a Result of every outcome and error so far
```

Two `run()` calls at the same time both reject with the same error, or both resolve with `Result` objects that hold the same outcomes. A task that awaits the `run()` of its own `Build` never finishes, because that `run()` waits for the task.

## One task

```text
the build starts a task
├─ wait until the current synchronous code ends
├─ look for the producers (The order rule)      ← can call covers() and overlaps() (Scheduling cost)
│  ├─ replaced, removed or fatal error          → stop; a replaced or removed task is already cancelled
│  ├─ a producer failed                         → failed (dependency)
│  ├─ producers wait or run                     → wait until they finish, then look again
│  ├─ a deadlock                                → look once more: failed (dependency) or failed (deadlock)
│  └─ none waits or runs                        → go on
├─ no store                                     → run; no stamp() calls, and the reason is no-store
├─ stamp() each input, one at a time            ← a throw fails the task, and it does not run
├─ the skip rule (The skip rule: exact checks)  ← store.get, then stamp() of the outputs; a throw fails the task
│  ├─ replaced, removed or fatal error          → stop, as in the wait
│  └─ every check passes                        → skipped: no produced events, no store.set
├─ run(ctx)                                     ← ctx.produced(a) and ctx.deleted(a) call covers(a) of the prefix outputs
├─ send produced for each exact output that the task did not report
├─ with a store and no fatal error              → stamp() each output, then store.set(id, record); a throw fails the task
└─ executed, with the reason of the first check that failed
```

- When `covers` or `overlaps` throws while the task looks for its producers, the task never finishes ([a known issue](limits.md#a-throw-in-covers-or-overlaps-leaves-a-task-out-of-the-result)).
- When `run` throws, the task fails with that error, even when the error is an `AbortError`. When an output `stamp()` or `store.set` throws, the task fails too ([a task can fail after its produced events](limits.md#a-task-can-fail-after-its-produced-events)).
- The task of a [stopped run](#replacement-and-removal) finishes as `cancelled`, even when `run` throws, and a thrown error whose name is not `AbortError` goes to `result.errors`. The build saves no record unless the stop comes while `store.set` runs.

## The order rule

A task waits until each of its [producers](guide.md#what-a-build-does) has finished. A task is never its own producer. This table gives, for each kind of input and output, when another task is a producer. Its examples use the default [`covers` and `overlaps`](guide.md#folders-prefixes), as in `IdPrefix`:

| Input of the task | Output of another task | The other task is a producer when | Example |
| --- | --- | --- | --- |
| artifact | artifact | the two ids are equal | `mem:a` waits for `mem:a`, but `mem:a/b` does not wait for `mem:a` |
| artifact | prefix | `output.covers(input)` returns true | `mem:out/a` waits for `mem:out/`, but `mem:p` does not wait for `mem:p/` |
| prefix | artifact | `input.covers(output)` returns true | `mem:a/b/` does not wait for `mem:a/` |
| prefix | prefix | `input.overlaps(output)` returns true | `mem:out/` waits for `mem:out/sub/`, and the other way around |

A task looks for its producers among the current tasks.

| When the task looks for its producers, it finds | Then |
| --- | --- |
| a producer that failed | the task fails with `dependency of '<id>' failed`, where `<id>` is the id of the waiting task |
| no producer that waits or runs | the task goes on |
| producers that wait or run | the task waits for them. When one of them fails, the task fails immediately. When each has finished, or was replaced or removed, the task looks for its producers again |

A producer's `ctx.produced` call does not end the wait.

| A task is removed | Each task that reads one of its outputs |
| --- | --- |
| during a [report](guide.md#outputs-with-unknown-names) of a running task | waits until the reporting task finishes, then looks for its producers again. When the reporting task fails, the reader fails with `dependency of '<id>' failed` |
| at any other time | stops waiting for the removed task immediately |

A reporting task that waits for such a reader never finishes ([a removal at a report can make run() wait forever](limits.md#a-removal-at-a-report-can-make-run-wait-forever)).

- A waiting task finds a producer that is added in the meantime only when it looks for its producers again. If that producer fails, the task fails only at its next look. If the producer is removed before that look, the task does not fail.
- A **deadlock** is the state in which no task runs and each task that has not finished waits for a producer. Then each waiting task looks for its producers once more: a task with a failed producer fails with `dependency of '<id>' failed`, and each other task fails with `deadlock waiting for inputs of '<id>'`. The build does not check for a deadlock while subscribers get the events of a change, because a subscriber can still change the tasks.

| You add the task | The task starts |
| --- | --- |
| before the first `run()`, or during the scans of the first `run()` | when the first [`run()`](#buildrun) starts its tasks, after the scans |
| at any other time, even after `run()` resolves, unless the `Build` has a [fatal error](#fatal-errors) | immediately, with no new `run()` call. The next `run()` waits for it and puts it in its `Result` |

Exception: the first `run()` sends `promised` events before its scans start. When a subscriber calls `build.add` or `build.remove` at one of these events, every task that has not started starts immediately. These tasks look for their producers before the scans add their tasks, so they can miss them ([a known issue](limits.md#a-task-change-at-the-first-promised-events-starts-tasks-before-the-scans)).

A task that starts immediately looks for its producers only after the synchronous code that added it ends. So it waits for a producer that the same code adds after it, but it can miss one that the code adds after an `await`.

## The skip rule: exact checks

These rules add to the five checks of [the skip rule](guide.md#the-skip-rule):

- With a store, the build calls `stamp()` once for each entry in `inputs`, in order, before check 1.
- Check 2 comes before the [`store.get`](builtins.md#write-a-store) of check 3, so a prefix input with the stamp `null` gives `input-unstamped` even when the task has no record. An artifact input with the stamp `null` passes check 2, so a missing input file does not, by itself, make the task run.
- Check 3: a record counts as no record when `inputStamps` or `outputStamps` is not an object whose values are strings or `null`.
- Check 4 compares the input ids first (`input-ids-changed`), then the stamp of each input in declared order (`input-changed`, with the first input that differs). So neither the order of the inputs nor an input declared twice changes whether the task skips.
- Check 5 stamps the outputs one at a time, in declared order, and stops at the first output where one of these cases holds. The first case that holds gives the reason:
  1. A prefix has the stamp `null`: `output-unstamped`.
  2. The record has no key for the output: `output-ids-changed`, even when the output does not exist yet.
  3. An artifact has the stamp `null`: `output-missing`.
  4. The stamp differs from the record: `output-changed`.
- After the last output, a record with extra output keys gives `output-ids-changed`.
- A skipped or failed task keeps its old record. A new record holds the input stamps from before the run, so when an input changes during the run, the task runs again on the next build. A task with inputs and no outputs can skip.

## Self-feeding and shared folders

This section shows what happens, build by build, when a program breaks a [layout rule](guide.md#layout-rules). A **self-feeding** task writes a file or a folder that it reads. In this program, `exact` declares an exact output and `folder` declares a folder, but neither one writes anything. `index:hash` and `index:time` each write `index.txt`, which lists `a.md`, into the folder that they read:

```ts
import { Build, MemoryStore, Task } from "dapat"
import { FileArtifact, FilesystemPrefix } from "dapat/contrib"

const src = new FileArtifact("in.txt")
const file = new FileArtifact("file.txt")
const folder = new FilesystemPrefix("folder")
const store = new MemoryStore()

async function writeNothing() {}

async function runBuild(label: string) {
  await Bun.sleep(20) // so that each write of index.txt gets a new mtime
  const build = new Build({ store })
  build.add(new Task({ id: "exact", inputs: [src], outputs: [file], run: writeNothing }))
  build.add(new Task({ id: "folder", inputs: [src], outputs: [folder], run: writeNothing }))
  for (const stamp of ["hash", "time"] as const) {
    const pages = new FilesystemPrefix(`pages-${stamp}`, { stamp })
    const index = new FileArtifact(`pages-${stamp}/index.txt`)
    async function write() {
      await Bun.write(index.path, "a.md")
    }
    build.add(new Task({ id: `index:${stamp}`, inputs: [pages], outputs: [index], run: write }))
  }
  const result = await build.run()
  const ran = result.executed.map((task) => task.id).sort()
  const skipped = result.skipped.map((task) => task.id).sort()
  console.log(`${label.padEnd(9)}ran [${ran.join(" ")}] skipped [${skipped.join(" ")}]`)
}

await Bun.write("in.txt", "a")
await Bun.write("pages-hash/a.md", "a")
await Bun.write("pages-time/a.md", "a")
await runBuild("build 1")
await runBuild("build 2")
await runBuild("build 3")
```

<!-- output -->
```text
build 1  ran [exact folder index:hash index:time] skipped []
build 2  ran [exact index:hash index:time] skipped [folder]
build 3  ran [exact index:time] skipped [folder index:hash]
```

- `exact` breaks the rule [a task that may write nothing declares a folder](guide.md#a-task-that-may-write-nothing-declares-a-folder). Its exact output has the stamp `null`, so `exact` runs on every build, from build 2 on with the reason `output-missing`. A missing or empty folder has a stamp, so `folder` skips.
- `index:hash` and `index:time` break the rule [write an index next to its folder](guide.md#write-an-index-next-to-its-folder). With time stamps, each write gives `index.txt` a new mtime, so `index:time` runs on every build.
- With hash stamps, a self-feeding task runs again on the build after each run that changes the file or the folder that it reads. `index:hash` runs again on build 2, because its first record holds the folder stamp from before `index.txt` existed. Build 2 writes the same bytes, so build 3 skips. An index that also lists `index.txt` writes new bytes in build 2, so it runs on build 3 too. On each extra run, the reason is `input-changed`, with the id of the folder.
- A shared folder breaks the rule [one task writes one folder](guide.md#one-task-writes-one-folder). For example, task `a` declares a folder, and task `b` reads an output of `a` and then writes in that folder. The record of `a` holds the folder stamp from before `b` wrote. With hash stamps, `a` runs again on the next build and skips after that, and a task that reads the folder and does not wait for `b` can also run once more. With time stamps, `a`, `b` and each task that reads the folder run on every build.

## Events

The [guide](guide.md#events) tells when the build sends `promised` and `produced`. It also sends `deleted` (field `artifact`) for each `ctx.deleted` call, and `withdrawn` (field `output`) for each output of a removed task and each output that a replacement drops. Each event has the `taskId` of its task. For each output of a task id, the order is `promised`, then any number of `produced` and `deleted`. When a change drops the output, `withdrawn` comes last, and no event follows until a task with that id declares the output again. For a prefix output, the `produced` and `deleted` events are for the artifacts under it. Each kind has these extra rules:

- `promised`: a replacement gets it for each output that the old task did not declare. An output with the same kind (artifact or prefix) and id as an old output is not new, even when it is a new object.
- `withdrawn`: a prefix output gets one event, not one for each artifact under it. The build sends each `withdrawn` when the change applies, not when the old `run` returns.
- `produced`: after `run` returns, the build sends a `produced` event for each exact output that the task did not report, even when the task did not write the file; a prefix output gets none. It sends these events in declared order, each in a [drain](#the-event-queue) of its own, so a subscriber can replace or remove the task between two of them, and then the build sends no more of them. The task finishes only after these events, so when a subscriber adds a task that reads one of these outputs, the new task waits for this task. No event takes back a `produced` that a failed task sent.
- `ctx.produced` and `ctx.deleted` return only after every subscriber has the event, and each task that a subscriber adds is then in the `Build`. So a new task that reads the reported file waits for the task that reported it.

## The event queue

Each [subscriber](guide.md#events) gets each event that the build sends after it subscribes, and all subscribers get the events in the same order. Each `Build` has one first-in, first-out queue of events. A task change, such as `build.add` or `build.remove`, first changes the tasks and then puts its events at the end of the queue; `ctx.produced` and `ctx.deleted` put one event there. Each of these calls then starts a **drain**, unless one is in progress. A drain sends the events of the queue one at a time, each to every subscriber, in one or more **passes**, and a pass sends events until the queue is empty. When a listener on `ctx.signal` changes tasks, the events of its change come after the events of the change that aborted the signal. In this trace, subscribers S1 and S2 subscribed in that order, and S1 replaces task `t` so that `t` declares `y` instead of `x`:

```text
S1 gets promised x by t  → S1 replaces t; queue: withdrawn x, promised y
S2 gets promised x by t    (out of date: t no longer declares x)
S1 gets withdrawn x by t
S2 gets withdrawn x by t   (the correction)
S1 gets promised y by t
S2 gets promised y by t
```

## Steps

A **step** is a set of task changes ([adds, replacements and removals](guide.md#results-and-failure)) that the build applies at one time. An **open step** still collects changes, so that `build.each` can change the tasks of many [joined sets](guide.md#buildeach) together. When the step closes, the build checks the two **step rules** against the tasks as they are after the whole step: each task id comes from one source only, one joined set or `build.add`, and no exact output is declared twice ([error messages](api.md#error-messages)). A broken rule is then a [fatal error](#fatal-errors).

| A step is open during | It closes |
| --- | --- |
| the first `run()` of a `Build` that has `build.each` calls, from its start | when every scan has returned |
| each pass of a drain, when no other step is open | at the end of the pass |
| a `found` or `gone` event that a matcher sends when no step is open, for example from a file watcher | when `build.each` has handled it and each `found` or `gone` event sent in the meantime |

When the step of a pass changes tasks, the events of those changes make the next pass.

- When a joined set changes twice in one step, the later change replaces the earlier one, so a joined set that the scans make and then remove adds no task.
- `build.add` and `build.remove` never join an open step: each call is a step of its own. `build.add` throws and changes nothing when it breaks a rule, and it checks the rules against the tasks that the `Build` has now, not against the open step. A clash with the open step is a fatal error when that step closes.
- In one step, an output can move from one task to another, and a task id from one joined set to another. A moved task id is a [replacement](#replacement-and-removal), so it keeps its store record. Every `withdrawn` of the step comes before any `promised`, so a moved output gives `withdrawn x by a`, then `promised x by b`.

## The send limit

The **send limit**, the `sendLimit` option of `new Build`, ends a build in which a subscriber or a `build.each` keeps adding tasks forever. The default is `SEND_LIMIT`, which is 10,000. When a count would go over the limit, `run()` rejects with a [fatal error](#fatal-errors) whose message starts with `send limit:` ([error messages](api.md#error-messages)):

| Count | The build fails when | A usual cause |
| --- | --- | --- |
| events that subscribers cause in one pass, not counting the events in the queue when the pass starts | the count reaches the limit, and more events wait | a subscriber that adds a task for each `promised`, where each new task declares a new output |
| passes in one drain | the drain needs more passes than the limit | a [loop](build-each.md#loops) whose task declares its next file as an exact output, not that file's folder ([declare a folder](guide.md#a-task-that-may-write-nothing-declares-a-folder)) |

The send limit does not stop a loop whose task declares the folder of its next file and reports the file with `ctx.produced`, because each `ctx.produced` call starts a drain of its own, and each drain counts from zero.

## Fatal errors

`run()` rejects with a [fatal error](guide.md#results-and-failure) in each of these cases. [Error messages](api.md#error-messages) gives the text.

- A subscriber, such as a matcher's [`receiveArtifactEvent`](write-a-matcher.md#what-you-write), throws or returns a promise.
- One of the two counts of the [send limit](#the-send-limit) would go over it.
- A scan throws.
- [`tasks()`](build-each.md#the-config) throws or returns no iterable.
- The `expand` of an [output template](build-each.md#output-templates) throws.
- A matcher sends vars whose names are not exactly its `varNames`.
- An [open step](#steps) breaks a step rule when it closes.

The `Build` keeps the first fatal error and ignores later ones. It clears the event queue and drops the changes of the open step. It aborts the `signal` of each `scan` with the fatal error, and the `ctx.signal` of each running task with an `AbortError`. The `Build` then starts no task and no `store.set`. A `store.set` that has already started still writes its record. The `Build` sends no later event, and `build.each` handles no later `found` or `gone` event.

- The call whose events led to the error, such as `ctx.produced` or `build.add`, does not throw. Its change stays. A later `build.add` throws only when it breaks a step rule, as before the error.
- A `run()` in progress rejects with the error after each running task returns. Exception: a fatal error during the scans of the first `run()` makes each `run()` in progress reject immediately. Each `run()` called after the error rejects immediately with the same `Error` object.

## Replacement and removal

`build.add`, `build.remove`, `build.each` and [`setTasksOfGroups`](#subclass-build-settasksofgroups) can [replace or remove](guide.md#results-and-failure) a task. A **stopped run** is the run of a task that a change replaces or removes after `run` starts and before the task finishes. This table gives what happens to the old task:

| The old task | Replace | Remove |
| --- | --- | --- |
| `run` has not started | The build [cancels](guide.md#results-and-failure) it immediately | The build cancels it immediately |
| `run` has started, and the task has not finished | `ctx.signal` aborts. The build cancels the task after `run` returns, even when `run` succeeds | `ctx.signal` aborts. The build cancels the task immediately, and `build.run()` waits until `run` returns |
| The task has finished | Its outcome stays | Its outcome stays |

- `ctx.signal` aborts with an `AbortError`. [One task](#one-task) tells what happens when a stopped run throws.
- In each row, a removal deletes the task's store record with `store.delete`. An error from `store.delete` goes to `result.errors`. A replacement keeps the record.
- After the stop, `ctx.produced` and `ctx.deleted` of the old run do nothing. The known issue [a replacement does not wait for the old run](limits.md#a-replacement-does-not-wait-for-the-old-run) tells what the old run can still change.
- The same `Task` object, added again after it finished, waits, skips or runs as a new task does. The `Result` lists it once, with its last outcome, at the place of its first finish.

## build.each internals

The artifact ids of a match are the `id` of its data or, when the data is a list, the ids of the list in order.

| The matcher sends | `build.each` |
| --- | --- |
| a `found` event from a required matcher, with var values that no current match has | keeps the match, joins it, and makes the tasks of each new joined set: `tasks()`, or the one task of `run` |
| a `found` event with the var values of a current match and other artifact ids | replaces the match. For each set that holds it, makes its tasks again and replaces them. The set stays |
| a `found` event with the var values and artifact ids of a current match, or a `gone` event with var values that no current match has | does nothing, even when the data of the `found` event is a new object |
| a `gone` event from a required matcher, with the var values of a current match | removes each set that holds the match, with its tasks |

- When an [optional matcher](build-each.md#required) sends a `found` event with new var values, or a `gone` event for a current match, `build.each` joins the optional matchers again to each set of required matches that has the same values as the event for the vars that the optional matcher shares with the required matchers. It makes the tasks of each new or changed joined set and removes each old one that it does not make again. For example, when the last review of a page is gone, the set with no review comes back.
- A `found` or `gone` event that comes while `build.each` handles another one, for example from `tasks()` or a subscriber, waits until that one ends.

## Subclass Build: setTasksOfGroups

A **task group** is a set of task ids that one call can replace as a whole. `build.each` makes one group for each [joined set](guide.md#buildeach), and `build.add` puts each id in a group of its own. Each task id is in one group. Each `TaskGroup` object, made with `new TaskGroup(label)`, is one group, so two objects with the same label are two groups. In a subclass of `Build`, the protected method `setTasksOfGroups(changes)` takes `GroupTasks` objects, `{ group, tasks }`, and makes each `tasks` the whole task list of its `group`. The changes join the open [step](#steps). With no open step, the call is a step of its own.

- The build adds each id that it does not have and replaces each id that it has. A replacement keeps the store record, so it can skip. It removes each id that a group of the step had before and that no group of the step gives now, and deletes its record but not its files ([dapat deletes no file](guide.md#dapat-deletes-no-file)). For example, when the group `pages` gives `page:a` and `page:b`, and then `page:a` and `page:c`, the build replaces `page:a`, adds `page:c` and removes `page:b`.
- In an open step, for example in a subscriber, the call never throws. Its changes wait until the step closes, and a later list for a group replaces the earlier one. A broken rule is then a [fatal error](#fatal-errors).
- With no open step, the call throws and changes nothing when it names a group or an id twice, or breaks a step rule ([error messages](api.md#error-messages)).

## Scheduling cost

Each `Build` keeps an index of the output ids of its tasks. When a task looks for its producers, each input costs the length of its id plus the number of outputs found, not the number of tasks. A task looks for its producers when it starts, and again each time all the producers that it waits for have finished. The deadlock check costs the same at any size, and a change starts only its new tasks, so dapat's own time grows about linearly with the number of tasks ([Scale](limits.md#scale)). Two cases cost about n²:

- A prefix class that overrides `covers()` or `overlaps()`. Each time a task with such a prefix input looks for its producers, the build checks every output of the `Build`. Each time a task looks for the producers of an artifact input, the build checks every prefix output whose class overrides `covers()`.
- A prefix input whose producers each add the next one when they run. Each time the task looks for its producers, the build lists all the outputs under the prefix to find the next one.
