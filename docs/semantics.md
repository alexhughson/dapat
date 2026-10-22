# How a build works

This page gives the exact rules of a build: when it calls your code, sends events and applies task changes, and which errors are [fatal](#fatal-errors). Use it when you write an artifact type or a matcher, subclass `Build`, or debug a build. Read the [guide](guide.md) first: this page uses its terms, such as matcher, scan, report and record.

## Terms

| Term | Meaning |
| --- | --- |
| **step** | A set of task changes (adds, [replacements and removals](guide.md#tasks-and-dependencies)) that the build applies at one time ([Steps](#steps)). An **open step** still collects changes |
| **drain** | In a drain, the build sends each event of the [queue](#the-event-queue) to every [subscriber](guide.md#events), one at a time, in one or more passes |
| **pass** | One round of a drain, in which the build sends events until the queue is empty. When no step is open, the pass opens a step and closes it at its end. When that step changes tasks, the events of those changes make the next pass |
| **wake** | A time when the build makes each waiting task check its [producers](guide.md#what-a-build-does) again ([The order rule](#the-order-rule)) |
| **send limit** | The `sendLimit` option of `new Build`: a cap on events and passes ([The send limit](#the-send-limit)) |
| **stopped run** | The run of a task when a change replaces or removes the task after `run` starts and before the task finishes |

## build.run()

```text
build.run()
├─ the first call only
│  ├─ mark the build as started; from now on it sends events
│  ├─ with matchers: open a step
│  ├─ queue promised for each output of each task, then drain
│  └─ with matchers and no fatal error: start every scan at the same time
├─ any call, while the scans run: wait until every scan returns and the step closes, or until a fatal error
├─ a fatal error → reject with it; else start each task that has not started (One task)
├─ wait until no task waits or runs and no store.delete of a removed task is pending
└─ a fatal error → reject with it; else resolve with a Result of every outcome and error so far
```

Two calls at the same time end the same way. Both reject with the same error, or both resolve with `Result` objects that hold the same outcomes. A task that awaits the `run()` of its own build never ends, because that `run()` waits for the task.

## One task

[The order rule](#the-order-rule) and [the skip check](#the-skip-check) give the exact rules for the wait and the skip. [Error messages](api.md#error-messages) gives the text of each failure.

```text
the build starts a task
├─ wait until the current synchronous code ends
├─ wait for the producers, and check again on each wake
│  ├─ the task is replaced or removed  → end; it is already cancelled
│  ├─ the build has a fatal error      → end, with no outcome
│  ├─ a producer failed                → failed (dependency)
│  ├─ no producer waits or runs        → go on
│  └─ no task runs and no waiting task can go on → failed (deadlock)
├─ with a store: stamp the inputs, then the skip check
│  ├─ replaced, removed or fatal error → end, as in the wait
│  ├─ a stamp or store.get throws      → failed with that error
│  └─ the task can skip                → skipped; its record stays as it was
├─ run(ctx), then send produced for each exact output that the task did not report
├─ with a store and no fatal error: stamp the outputs, then store.set(id, record)
└─ executed
```

- When `run` throws, the task fails with that error, even when the error is an `AbortError`. When an output `stamp()` or `store.set` throws, the task fails too, after the build sent its `produced` events ([known issue 3](limits.md#known-issues-in-010)).
- A [stopped run](#terms) ends as `cancelled`, even when it throws. An error that is not named `AbortError` goes to `result.errors`. The build saves no record unless the stop comes while `store.set` runs.

## The order rule

A task waits until each of its [producers](guide.md#what-a-build-does) has finished. For an artifact input, the producers are the task with an exact output of the same id, and each task whose [prefix](guide.md#folders-prefixes) output covers it. For a prefix input, the producers are each task whose exact output the prefix covers, and each task whose prefix output it overlaps. A task is never its own producer. [What you write](write-an-artifact.md#what-you-write) tells which object's `covers` or `overlaps` the build calls. With the default `covers` and `overlaps`, as in `IdPrefix`:

| Input of the task | Output of another task | The task waits |
| --- | --- | --- |
| artifact `mem:out/a` | prefix `mem:out/` | yes |
| artifact `mem:p` | prefix `mem:p/` | no |
| prefix `mem:a/b/` | artifact `mem:a/` | no |
| prefix `mem:out/` or `mem:out/sub/` | prefix `mem:out/` or `mem:out/sub/` | yes |
| prefix `mem:out` | artifact `mem:outgoing` | yes ([end a prefix id with a delimiter](guide.md#folders-prefixes)) |

A [wake](#terms) comes when a task finishes, when a change adds, [replaces or removes](guide.md#tasks-and-dependencies) a task, and on a fatal error. At each wake, a waiting task looks for its producers among the current tasks:

- A producer that waits or runs makes the task wait for the next wake. A `ctx.produced` call does not end the wait.
- A producer that is executed or skipped counts as finished. A producer that failed makes the task fail immediately ([One task](#one-task)).
- When a change replaces a producer, the task waits for the new task only when the new task is also a producer. When a change removes a producer, the task stops waiting for it.
- A **deadlock** is a state where no task runs and each waiting task has a producer that also waits. Then each waiting task fails.

| You add the task | The task starts |
| --- | --- |
| before the first `run()`, or during the scans of the first `run()` | when the first [`run()`](#buildrun) starts its tasks, after the scans |
| at any other time, even after `run()` resolves, unless the build has a [fatal error](#fatal-errors) | immediately, with no new `run()` call. The next `run()` waits for it and puts it in its `Result` |

Exception: before its scans, the first `run()` of a build with `build.each` sends `promised` for the tasks that you added. When a subscriber adds, replaces or removes a task at one of these events, each task that has not started starts while the scans run.

A task that starts immediately first checks its producers when the synchronous code that added it ends. So it waits for a producer that the same code adds after it. It can miss a producer that the code adds after an `await`.

## The skip check

This list gives the six [skip checks](guide.md#the-store-and-the-skip-rule) in full, numbered as in the guide. With a store, the build calls `stamp()` one time for each entry in `inputs`, then makes the checks in order. At the first check that fails, the build stops checking and the task runs. For one task, the build calls `stamp()` of each output at most two times: in check 5, and after a successful run.

1. The task has at least one input.
2. No input is a prefix whose stamp is `null`. An artifact input whose stamp is `null` passes this check, so a missing input file does not, by itself, make the task run.
3. [`store.get(task id)`](write-an-artifact.md#the-store) returns a record. A record counts as no record when `inputStamps` or `outputStamps` is not an object whose values are strings or `null`.
4. The input stamps now and in the record have the same keys and values. So the order of the inputs, and an input declared two times, have no effect.
5. For the next output in declared order, the build calls `stamp()`. The stamp is not `null`.
6. The stamp equals the value for that output in the record. The build repeats checks 5 and 6 for each output. After the last output, the record has no other output keys.

For example, a task reads `mem:src` (stamp `a`) and an `IdPrefix`. It declares the output `mem:out` but does not write it. After its run, `store.set` gets this record. The `IdPrefix` has no key, and `mem:out` has the value `null`:

```text
{"inputStamps":{"artifact mem:src":"a"},"outputStamps":{"artifact mem:out":null}}
```

An artifact and a prefix with the same id have different keys.

## Events

The [guide](guide.md#events) tells when the build sends each kind of event. For each output of a task id, the order is `promised`, then any number of `produced` and `deleted`. When a change drops the output, `withdrawn` comes last. For a prefix output, the `produced` and `deleted` events are for the artifacts under it. After `withdrawn`, no event for that output and task id comes until a task with that id declares the output again. Each kind has these extra rules:

- `promised`: an output of a replacement is new when no output of the old task has its kind (artifact or prefix) and id. The build does not compare objects. So when a replacement declares a new object with the same kind and id, the build sends no `promised` for it.
- `withdrawn`: a prefix output gets one event, not one for each artifact under it. The build sends each `withdrawn` when the change applies. It does not wait for the old run to end.
- `produced`: after `run` returns, the build sends its [`produced` events](guide.md#events) in declared order, each in a [drain](#terms) of its own. So a subscriber can replace or remove the task between two of these events, and then the build sends no more of them. The task finishes only after these events. So when a subscriber adds a task that reads one of these outputs, the new task waits for this task. No event takes back a `produced` that a failed task sent.

## The event queue

Each subscriber gets each event that the build sends after it subscribes. All subscribers get the events in one order. Each build has one first-in, first-out queue of events. `build.add`, `build.remove`, `ctx.add` and `ctx.remove` change the tasks first. Then they put the events of the change at the end of the queue. `ctx.produced` and `ctx.deleted` put one event there. Each of these calls starts a [drain](#terms) if none is in progress. When a listener on `ctx.signal` changes tasks, the events of its change come after the events of the change that aborted the signal. In this trace, subscribers S1 and S2 subscribed in that order, and S1 replaces task `t` so that `t` declares `y` instead of `x`:

```text
S1 gets promised x by t  → S1 replaces t; queue: withdrawn x, promised y
S2 gets promised x by t    (out of date: t no longer declares x)
S1 gets withdrawn x by t
S2 gets withdrawn x by t   (the correction)
S1 gets promised y by t
S2 gets promised y by t
```

## Steps

An open [step](#terms) lets `build.each` change the tasks of many [joined sets](guide.md#buildeach) together. When the step closes, the build checks the two **step rules** on the tasks as they are after the whole step. Only one joined set, or `build.add`, gives each task id. No [exact output](guide.md#tasks-and-dependencies) has two declarations ([error messages](api.md#error-messages)). A broken rule is then a [fatal error](#fatal-errors).

| A step is open during | It closes |
| --- | --- |
| the first `run()` of a build with `build.each`, from its start | when every scan has returned |
| each pass of a drain, when no other step is open | at the end of the pass |
| a found or gone that a matcher sends when no step is open, for example from a file watcher | when `build.each` has handled it, and each found or gone sent while it handled it |

- The task changes of `build.each` join the open step. When a joined set changes two times in one step, the later change replaces the earlier one. So a joined set that the scans make and then remove adds no task.
- `build.add`, `build.remove`, `ctx.add` and `ctx.remove` never join an open step. Each call is a step of its own, so it throws and changes nothing when it breaks a rule. It checks the rules against the tasks that the build has now, not against the changes of the open step. A clash with those changes is a fatal error when the step closes.
- In one step, an output can move from one task to another, and a task id from one joined set to another. A moved task id is a [replacement](#replacement-and-removal), so it keeps its store record. Every `withdrawn` of the step comes before any `promised`, so a moved output gives `withdrawn x by a`, then `promised x by b`.

## The send limit

The [send limit](#terms) stops a subscriber or a `build.each` that adds tasks with no end. The default is `SEND_LIMIT`, which is 10,000. When you give `sendLimit`, it must be a positive integer, or `new Build` throws. When a count would go over the limit, `run()` rejects with a [fatal error](#fatal-errors) whose message starts with `send limit:` ([error messages](api.md#error-messages)):

| Count | The build fails when | A usual cause |
| --- | --- | --- |
| events that subscribers cause in one pass, not counting the events in the queue when the pass starts | the count reaches the limit, and more events wait | a subscriber that adds a task for each `promised`, where each new task declares a new output |
| passes in one drain | the drain needs more passes than the limit | a [loop](build-each.md#loops) whose task declares its next file as an exact output, not that file's folder ([layout rules](guide.md#layout-rules)) |

The send limit does not stop a [loop](build-each.md#loops) whose task declares the folder of its next file and reports the file with `ctx.produced`. Each such call starts a drain of its own, and each drain counts from zero.

## Fatal errors

`run()` rejects with a [fatal error](guide.md#results-and-failure) in each of these cases. [Error messages](api.md#error-messages) gives the text.

- A subscriber throws or returns a promise. A matcher's [`receiveArtifactEvent`](write-a-matcher.md#what-you-write) is a subscriber too.
- One of the two counts of the [send limit](#the-send-limit) would go over it.
- A scan throws, [`tasks()`](build-each.md#the-config) throws or returns no iterable, or a matcher sends vars whose names are not exactly its [`varNames`](write-a-matcher.md#what-you-write).
- An [open step](#steps) breaks a step rule when it closes.

The build keeps the first fatal error and ignores later ones. It clears the event queue and drops the changes of the open step. It aborts the `signal` of each `scan`, with the fatal error as the reason. It aborts the `ctx.signal` of each running task, with an `AbortError` as the reason. The build then starts no task and no `store.set`. A `store.set` that already runs still writes its record. The build sends no later event, and `build.each` handles no later found or gone.

- The call whose events led to the error, such as `ctx.produced` or `build.add`, does not throw. Its change stays. A later `build.add` throws only when it breaks a [step rule](#steps), as before the error. The task that it adds never starts.
- A `run()` in progress rejects with the error after each running task returns. Each `run()` called after the error rejects immediately with the same `Error` object.

## Replacement and removal

A [replacement or removal](guide.md#tasks-and-dependencies) comes from `build.add`, `build.remove`, `ctx.add` or `ctx.remove`. `build.each` and `setTasksOfGroups` make them when they change the tasks of a joined set or a [task group](#subclass-build-settasksofgroups). This table gives what happens to the old task:

| The old task | Replace | Remove |
| --- | --- | --- |
| `run` has not started | The build [cancels](guide.md#results-and-failure) it immediately. Its `run` never starts | The build cancels it immediately |
| `run` has started, and the task has not finished | `ctx.signal` aborts. The build cancels the task after `run` returns, even when `run` succeeds | `ctx.signal` aborts. The build cancels the task immediately, and `build.run()` waits until `run` returns |
| The task has finished | Its outcome stays | Its outcome stays |

- `ctx.signal` aborts with an error named `AbortError` as its reason. [One task](#one-task) tells what happens when a [stopped run](#terms) throws.
- In each row, a removal deletes the task's store record with `store.delete`. An error from `store.delete` goes to `result.errors`. A replacement keeps the record.
- After the stop, `ctx.produced` and `ctx.deleted` of the old run do nothing. [Known issues 1 and 2](limits.md#known-issues-in-010) tell what the old run can still change.
- The same `Task` object, added again after it finished, waits, skips or runs as a new task does. The `Result` lists it one time, with its last outcome.

## build.each internals

This table gives what `build.each` does with each found and gone. The artifact ids of a match are the `id` of its data, or the ids of its list, in order.

| The matcher sends | `build.each` |
| --- | --- |
| found from a required matcher, with var values that no current match has | keeps the match, joins it, and calls `tasks()` for each new joined set |
| found with the var values of a current match and other artifact ids | replaces the match. For each set that holds it, calls `tasks()` again and replaces the set's tasks. The set stays |
| found with the var values and artifact ids of a current match, or gone with var values that no current match has | does nothing, even when the found data is a new object |
| gone from a required matcher, with the var values of a current match | removes each set that holds the match, with its tasks |

- An [optional matcher](build-each.md#required) can send a found with new var values, or a gone of a current match. Then `build.each` takes each set of required matches with the same values for the vars that the optional matcher shares with the required matchers. It joins the optional matchers to each of these sets again. It calls `tasks()` for each new or changed joined set and removes each old one that it does not make again. So when the last review of a page is gone, the set with no review comes back.
- A found or gone that comes while `build.each` handles another one, for example from `tasks()` or a subscriber, waits until that one ends.
- In the [label](build-each.md#the-config) of a joined set, the number counts the `build.each` calls of the `Build` that did not throw, from 1. The vars come in `matchersByName` order, then in `varNames` order.

## Subclass Build: setTasksOfGroups

A **task group** is a set of task ids that one call can replace as a whole. `build.each` makes one group for each [joined set](guide.md#buildeach), and `build.add` puts each id in a group of its own. Each task id is in one group. A **`TaskGroup`** object, `new TaskGroup(label)`, stands for one group. Two objects with the same label are two groups. The label shows only in error messages. In a subclass of `Build`, the protected method **`setTasksOfGroups(changes)`** takes `GroupTasks` objects, `{ group, tasks }`. It makes each `tasks` the whole task list of its group. The changes join the open [step](#terms). With no open step, the call is a step of its own.

```ts
import { Build, MemoryStore, Task, TaskGroup } from "dapat"
import { FileArtifact } from "dapat/contrib"

class PageBuild extends Build {
  setGroup(group: TaskGroup, tasks: Task[]): void {
    this.setTasksOfGroups([{ group, tasks }])
  }
}

await Bun.write("in.txt", "hello")
const input = new FileArtifact("in.txt")
const store = new MemoryStore()
const build = new PageBuild({ store })
const pages = new TaskGroup("pages")

async function plan(ids: string[]) {
  const ran: string[] = []
  const tasks: Task[] = []
  for (const id of ids) {
    const run = async () => {
      ran.push(id)
    }
    tasks.push(new Task({ id, inputs: [input], run }))
  }
  build.setGroup(pages, tasks)
  await build.run()
  ran.sort()
  console.log(`plan [${ids.join(" ")}] ran [${ran.join(" ")}]`)
}

await plan(["page:a", "page:b"])
await plan(["page:a", "page:c"])
console.log("record of page:b:", await store.get("page:b"))
```

<!-- output -->
```text
plan [page:a page:b] ran [page:a page:b]
plan [page:a page:c] ran [page:c]
record of page:b: null
```

- The build adds each new id, such as `page:c`. It replaces each id that the groups of the step had before and give again, such as `page:a`. The new task keeps the store record, and `in.txt` did not change, so it skips. The build removes each id that the groups of the step had before and do not give now, such as `page:b`. It deletes the record, not the files ([layout rules](guide.md#layout-rules)).
- In an [open step](#steps), for example in a subscriber, the call never throws. Its changes wait until the step closes, and a later list for a group replaces the earlier one. A broken rule is then a [fatal error](#fatal-errors).
- With no open step, the call throws and changes nothing when it names a group or an id two times, or breaks a [step rule](#steps) ([error messages](api.md#error-messages)).

## Scheduling cost

At each [wake](#terms), the build goes through every task to start the ones that have not started. Each waiting task looks for its producers again. For an artifact input, it goes through every prefix output. For a prefix input, it goes through every exact output and every prefix output. When no task runs and a waiting task still has an unfinished producer, the build goes through every task to look for a [deadlock](#the-order-rule). A build with more tasks has more wakes, and each wake costs more. So the time grows faster than the number of tasks ([Scale](limits.md#scale) gives the times).
