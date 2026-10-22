# How a build works

This page gives the exact rules of a build: when it calls your code, sends events and applies task changes, and which errors are [fatal](#fatal-errors). Use it when you write an artifact type or a matcher, subclass `Build`, or debug a build. Read the [guide](guide.md) first: this page uses its terms.

## build.run()

```text
build.run()
├─ the first call only
│  ├─ mark the build as started; from now on it sends events
│  ├─ with matchers: open a step (Steps)
│  ├─ queue promised for each output of each task, then drain (The event queue)
│  └─ with matchers and no fatal error: start every scan at the same time
├─ any call, while the scans run: wait until every scan returns and the step closes, or until a fatal error
├─ a fatal error → reject with it; else start each task that has not started (One task)
├─ wait until no task waits or runs and no store.delete of a removed task is pending
└─ a fatal error → reject with it; else resolve with a Result of every outcome and error so far
```

Two calls at the same time both reject with the same error, or both resolve with `Result` objects that hold the same outcomes. A task that awaits the `run()` of its own build never ends, because that `run()` waits for the task.

## One task

[Error messages](api.md#error-messages) gives the text of each failure.

```text
the build starts a task
├─ wait until the current synchronous code ends
├─ look for the producers (The order rule)  ← can call covers() and overlaps() (Scheduling cost)
│  ├─ replaced, removed or fatal error      → end; a replaced or removed task is already cancelled
│  ├─ a producer failed                     → failed (dependency)
│  ├─ producers wait or run                 → wait until they end, then look again
│  ├─ a deadlock                            → look once more: failed (dependency) or failed (deadlock)
│  └─ none waits or runs                    → go on
├─ no store                                 → run; no stamp() calls, and the reason is no-store
├─ stamp() each input, one at a time        ← a throw fails the task, and it does not run
├─ the skip check (The skip check)          ← store.get, then stamp() of the outputs; a throw fails the task
│  ├─ replaced, removed or fatal error      → end, as in the wait
│  └─ every check passes                    → skipped: no produced events, no store.set
├─ run(ctx)                                 ← ctx.produced(a) and ctx.deleted(a) call covers(a) of the prefix outputs
├─ send produced for each exact output that the task did not report
├─ with a store and no fatal error          → stamp() each output, then store.set(id, record); a throw fails the task
└─ executed, with the reason of the first check that failed
```

- When `run` throws, the task fails with that error, even when the error is an `AbortError`. When an output `stamp()` or `store.set` throws, the task fails too ([known issue 3](limits.md#known-issues-in-010)).
- A [stopped run](#replacement-and-removal) ends as `cancelled`, even when it throws. An error that is not named `AbortError` goes to `result.errors`. The build saves no record unless the stop comes while `store.set` runs.

## The order rule

A task waits until each of its [producers](guide.md#what-a-build-does) has finished. For an artifact input, the producers are the task with an exact output of the same id, and each task whose [prefix](guide.md#folders-prefixes) output covers it. For a prefix input, the producers are each task whose exact output the prefix covers, and each task whose prefix output it overlaps. A task is never its own producer. With the default `covers` and `overlaps`, as in `IdPrefix`:

| Input of the task | Output of another task | The task waits |
| --- | --- | --- |
| artifact `mem:out/a` | prefix `mem:out/` | yes |
| artifact `mem:p` | prefix `mem:p/` | no |
| prefix `mem:a/b/` | artifact `mem:a/` | no |
| prefix `mem:out/` or `mem:out/sub/` | prefix `mem:out/` or `mem:out/sub/` | yes |

In a **look**, a task searches the current tasks for its producers. When none of them waits or runs, the task goes on. A failed producer makes it fail with `dependency of '<id>' failed`, where `<id>` is the id of the waiting task.

- Else the task waits for the producers that it found. It looks again when all of them have ended, or were replaced or removed. It fails immediately when one of them fails. A `ctx.produced` call does not end the wait.
- A task finds a producer that is added after its last look only at its next look. So a producer added later that fails makes the task fail only at that look, and not at all when the producer is removed before then.
- A subscriber can remove a task during the `ctx.produced` or `ctx.deleted` of a running task. Each task that reads an output of the removed task then waits for this reporting task to end. Then it looks again. If the reporting task fails, the reader fails with `dependency of '<id>' failed`. So a reporting task that then waits for such a reader never ends ([known issue 7](limits.md#known-issues-in-010)). After any other removal, the reader stops waiting for the removed task immediately.
- A **deadlock** is a state where no task runs and each task that has not ended waits for a producer. Then each waiting task looks once more. A task with a failed producer fails with `dependency of '<id>' failed`, and each other one with `deadlock waiting for inputs of '<id>'`. The build does not check for a deadlock while subscribers get the events of a change, because a subscriber can still change the tasks.

| You add the task | The task starts |
| --- | --- |
| before the first `run()`, or during the scans of the first `run()` | when the first [`run()`](#buildrun) starts its tasks, after the scans |
| at any other time, even after `run()` resolves, unless the build has a [fatal error](#fatal-errors) | immediately, with no new `run()` call. The next `run()` waits for it and puts it in its `Result` |

Exception: the first `run()` sends `promised` before its scans. When a subscriber changes the tasks with `build.add` or `build.remove` at one of these events, each task that has not started starts immediately. Such a task looks for its producers before the scans add their tasks, so it can miss them.

A task that starts immediately first looks for its producers when the synchronous code that added it ends. So it waits for a producer that the same code adds after it. It can miss a producer that the code adds after an `await`.

## The skip check

The [guide](guide.md#the-store-and-the-skip-rule) gives the six skip checks and the reason of each. These are the exact rules:

- With a store, the build calls `stamp()` one time for each entry in `inputs`, in order, before check 1.
- Check 2 comes before the [`store.get`](builtins.md#write-a-store) of check 3. So a prefix input whose stamp is `null` gives `input-unstamped` also in the first build. An artifact input whose stamp is `null` passes check 2, so a missing input file does not, by itself, make the task run.
- Check 3: a record counts as no record when `inputStamps` or `outputStamps` is not an object whose values are strings or `null`.
- Check 4 compares the input ids first (`input-ids-changed`), then the stamp of each input in declared order (`input-changed`, with the first input that differs). So the order of the inputs, and an input declared two times, do not change the decision.
- Checks 5 and 6 go output by output, in declared order. The build stamps the output. The first of these cases that holds gives the reason:
  1. A prefix has the stamp `null`: `output-unstamped`.
  2. The record has no key for the output: `output-ids-changed`. So a new output that does not exist yet gives this reason.
  3. An artifact has the stamp `null`: `output-missing`.
  4. The stamp differs from the record: `output-changed`.
- After the last output, a record with more output keys gives `output-ids-changed`.
- The `id` of a reason is the id of the input or output, not its record key (`artifact <id>`).

## Events

The [guide](guide.md#events) tells when the build sends each kind of event. For each output of a task id, the order is `promised`, then any number of `produced` and `deleted`. When a change drops the output, `withdrawn` comes last, and no event follows until a task with that id declares the output again. For a prefix output, the `produced` and `deleted` events are for the artifacts under it. Each kind has these extra rules:

- `promised`: an output of a replacement is new when no output of the old task has its kind (artifact or prefix) and id. So a new object with the same kind and id gets no `promised`.
- `withdrawn`: a prefix output gets one event, not one for each artifact under it. The build sends each `withdrawn` when the change applies, not when the old run ends.
- `produced`: after `run` returns, the build sends its [`produced` events](guide.md#events) in declared order, each in a [drain](#the-event-queue) of its own. So a subscriber can replace or remove the task between two of these events, and then the build sends no more of them. The task finishes only after these events. So when a subscriber adds a task that reads one of these outputs, the new task waits for this task. No event takes back a `produced` that a failed task sent.

## The event queue

Each [subscriber](guide.md#events) gets each event that the build sends after it subscribes. All subscribers get the events in one order. Each build has one first-in, first-out queue of events. `build.add` and `build.remove` change the tasks first. Then they put the events of the change at the end of the queue. `ctx.produced` and `ctx.deleted` put one event there. Each of these calls then starts a **drain** if none is in progress. A drain sends each event of the queue to every subscriber, one at a time, in one or more **passes**. A pass sends events until the queue is empty. When a listener on `ctx.signal` changes tasks, the events of its change come after the events of the change that aborted the signal. In this trace, subscribers S1 and S2 subscribed in that order, and S1 replaces task `t` so that `t` declares `y` instead of `x`:

```text
S1 gets promised x by t  → S1 replaces t; queue: withdrawn x, promised y
S2 gets promised x by t    (out of date: t no longer declares x)
S1 gets withdrawn x by t
S2 gets withdrawn x by t   (the correction)
S1 gets promised y by t
S2 gets promised y by t
```

## Steps

A **step** is a set of task changes ([adds, replacements and removals](guide.md#tasks-and-dependencies)) that the build applies at one time. An **open step** still collects changes. An open step lets `build.each` change the tasks of many [joined sets](guide.md#buildeach) together. When the step closes, the build checks the two **step rules** on the tasks as they are after the whole step. Only one joined set, or `build.add`, gives each task id. No [exact output](guide.md#tasks-and-dependencies) has two declarations ([error messages](api.md#error-messages)). A broken rule is then a [fatal error](#fatal-errors).

| A step is open during | It closes |
| --- | --- |
| the first `run()` of a build with `build.each`, from its start | when every scan has returned |
| each pass of a drain, when no other step is open | at the end of the pass |
| a `found` or `gone` event that a matcher sends when no step is open, for example from a file watcher | when `build.each` has handled it, and each `found` and `gone` event sent while it handled it |

When the step of a pass changes tasks, the events of those changes make the next pass.

- When a joined set changes two times in one step, the later change replaces the earlier one. So a joined set that the scans make and then remove adds no task.
- `build.add` and `build.remove` never join an open step. Each call is a step of its own, so it throws and changes nothing when it breaks a rule. It checks the rules against the tasks that the build has now, not against the changes of the open step. A clash with those changes is a fatal error when the step closes.
- In one step, an output can move from one task to another, and a task id from one joined set to another. A moved task id is a [replacement](#replacement-and-removal), so it keeps its store record. Every `withdrawn` of the step comes before any `promised`, so a moved output gives `withdrawn x by a`, then `promised x by b`.

## The send limit

The **send limit**, the `sendLimit` option of `new Build`, stops a subscriber or a `build.each` that adds tasks with no end. The default is `SEND_LIMIT`, which is 10,000. When a count would go over the limit, `run()` rejects with a [fatal error](#fatal-errors) whose message starts with `send limit:` ([error messages](api.md#error-messages)):

| Count | The build fails when | A usual cause |
| --- | --- | --- |
| events that subscribers cause in one pass, not counting the events in the queue when the pass starts | the count reaches the limit, and more events wait | a subscriber that adds a task for each `promised`, where each new task declares a new output |
| passes in one drain | the drain needs more passes than the limit | a [loop](build-each.md#loops) whose task declares its next file as an exact output, not that file's folder ([layout rules](guide.md#layout-rules)) |

The send limit does not stop a [loop](build-each.md#loops) whose task declares the folder of its next file and reports the file with `ctx.produced`. Each such call starts a drain of its own, and each drain counts from zero.

## Fatal errors

`run()` rejects with a [fatal error](guide.md#results-and-failure) in each of these cases. [Error messages](api.md#error-messages) gives the text.

- A subscriber, such as a matcher's [`receiveArtifactEvent`](write-a-matcher.md#what-you-write), throws or returns a promise.
- One of the two counts of the [send limit](#the-send-limit) would go over it.
- A scan throws.
- [`tasks()`](build-each.md#the-config) throws or returns no iterable.
- The `expand` of an [output template](build-each.md#output-templates) throws.
- A matcher sends vars whose names are not exactly its [`varNames`](write-a-matcher.md#what-you-write).
- An [open step](#steps) breaks a step rule when it closes.

The build keeps the first fatal error and ignores later ones. It clears the event queue and drops the changes of the open step. It aborts the `signal` of each `scan` with the fatal error, and the `ctx.signal` of each running task with an `AbortError`. The build then starts no task and no `store.set`. A `store.set` that already runs still writes its record. The build sends no later event, and `build.each` handles no later `found` or `gone` event.

- The call whose events led to the error, such as `ctx.produced` or `build.add`, does not throw. Its change stays. A later `build.add` throws only when it breaks a [step rule](#steps), as before the error.
- A `run()` in progress rejects with the error after each running task returns. Exception: a fatal error during the scans of the first `run()` makes each `run()` in progress reject immediately. Each `run()` called after the error rejects immediately with the same `Error` object.

## Replacement and removal

`build.add`, `build.remove`, `build.each` and [`setTasksOfGroups`](#subclass-build-settasksofgroups) can [replace or remove](guide.md#tasks-and-dependencies) a task. A **stopped run** is the run of a task that a change replaces or removes after `run` starts and before the task finishes. This table gives what happens to the old task:

| The old task | Replace | Remove |
| --- | --- | --- |
| `run` has not started | The build [cancels](guide.md#results-and-failure) it immediately | The build cancels it immediately |
| `run` has started, and the task has not finished | `ctx.signal` aborts. The build cancels the task after `run` returns, even when `run` succeeds | `ctx.signal` aborts. The build cancels the task immediately, and `build.run()` waits until `run` returns |
| The task has finished | Its outcome stays | Its outcome stays |

- `ctx.signal` aborts with an `AbortError`. [One task](#one-task) tells what happens when a stopped run throws.
- In each row, a removal deletes the task's store record with `store.delete`. An error from `store.delete` goes to `result.errors`. A replacement keeps the record.
- After the stop, `ctx.produced` and `ctx.deleted` of the old run do nothing. [Known issue 1](limits.md#known-issues-in-010) tells what the old run can still change.
- The same `Task` object, added again after it finished, waits, skips or runs as a new task does. The `Result` lists it one time, with its last outcome, at the place of its first finish.

## build.each internals

The artifact ids of a match are the `id` of its data, or the ids of its list, in order.

| The matcher sends | `build.each` |
| --- | --- |
| a `found` event from a required matcher, with var values that no current match has | keeps the match, joins it, and makes the tasks of each new joined set: `tasks()`, or the one task of `run` |
| a `found` event with the var values of a current match and other artifact ids | replaces the match. For each set that holds it, makes its tasks again and replaces them. The set stays |
| a `found` event with the var values and artifact ids of a current match, or a `gone` event with var values that no current match has | does nothing, even when the data of the `found` event is a new object |
| a `gone` event from a required matcher, with the var values of a current match | removes each set that holds the match, with its tasks |

- An [optional matcher](build-each.md#required) can send a `found` event with new var values, or a `gone` event of a current match. Then `build.each` takes each set of required matches with the same values for the vars that the optional matcher shares with the required matchers. It joins the optional matchers to each of these sets again. It makes the tasks of each new or changed joined set and removes each old one that it does not make again. So when the last review of a page is gone, the set with no review comes back.
- A `found` or `gone` event that comes while `build.each` handles another one, for example from `tasks()` or a subscriber, waits until that one ends.

## Subclass Build: setTasksOfGroups

A **task group** is a set of task ids that one call can replace as a whole. `build.each` makes one group for each [joined set](guide.md#buildeach), and `build.add` puts each id in a group of its own. Each task id is in one group. A **`TaskGroup`** object, `new TaskGroup(label)`, stands for one group. Two objects with the same label are two groups. In a subclass of `Build`, the protected method **`setTasksOfGroups(changes)`** takes `GroupTasks` objects, `{ group, tasks }`. It makes each `tasks` the whole task list of its group. The changes join the open [step](#steps). With no open step, the call is a step of its own.

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

The build keeps an index of the output ids of all tasks. For each input, a look for producers costs the length of its id plus the outputs that it finds, not the number of tasks. A task looks when it starts, and again each time all the producers that it waits for have ended. The deadlock check costs the same at any size, and a change starts only its new tasks. So dapat's own time grows about as the number of tasks ([Scale](limits.md#scale)). Two cases cost about n²:

- A prefix class that overrides `covers()` or `overlaps()`. As an input, each look checks every output of the build. As an output that overrides `covers()`, each look of each artifact input checks it.
- A prefix input whose producers come one at a time. Each look lists the outputs under the prefix to find the next producer.
