# Recipes

Each section answers one how-to question about a build. Read part 1 of the [guide](guide.md) first.

## Find out why a task ran

The build does not say which [skip check](guide.md#the-store-and-the-skip-rule) failed. The function `whyRun` below makes the [skip checks](semantics.md#the-skip-check) in the order of the build and returns the reason for the first check that fails.

```ts
import { Build, MemoryStore, Task, isPrefix, type Store, type TaskState } from "dapat"
import { FileArtifact } from "dapat/contrib"

async function check(kind: string, refs: Task["inputs"], recorded: TaskState["inputStamps"]) {
  const keys = new Set<string>()
  for (const ref of refs) {
    const key = `${isPrefix(ref) ? "prefix" : "artifact"} ${ref.id}`
    keys.add(key)
    const stamp = await ref.stamp()
    if (stamp === null && kind === "output") return `output ${ref.id} has the stamp null`
    if (recorded[key] !== stamp) return `${kind} ${ref.id} changed`
  }
  if (Object.keys(recorded).length > keys.size) return `an ${kind} was removed`
  return null
}

async function whyRun(task: Task, store: Store) {
  if (task.inputs.length === 0) return "no inputs"
  for (const ref of task.inputs) {
    if (isPrefix(ref) && (await ref.stamp()) === null) return `input ${ref.id} has the stamp null`
  }
  const record = await store.get(task.id)
  if (record === null) return "no record"
  const inputReason = await check("input", task.inputs, record.inputStamps)
  if (inputReason !== null) return inputReason
  const outputReason = await check("output", task.outputs, record.outputStamps)
  return outputReason ?? "all checks pass"
}

const store = new MemoryStore()
const task = new Task({ id: "step", inputs: [new FileArtifact("in.txt")], run: async () => {} })
const build = new Build({ store })
build.add(task)
await Bun.write("in.txt", "a")
await build.run()
await Bun.write("in.txt", "b")
const reason = await whyRun(task, store)
console.log(reason.replace(process.cwd(), "."))
```

<!-- output -->
```text
input file:./in.txt changed
```

- Call `whyRun` before `build.run()`. After the run, the store holds the new [record](guide.md#what-a-build-does).
- When another task writes an input of this task, call `whyRun` first in the `run` function of this task. At that point the [producer](guide.md#what-a-build-does) has finished, and the record is still the old one.

## Force a rerun

To run one task again, call `await store.delete(task.id)` before `build.run()`. The tasks that read its outputs run again only when the stamps of those outputs change. To run every task again, call `await store.clear()`. It also deletes the records of tasks that are no longer in the build. For a [`JsonStore` or `SqliteStore`](builtins.md#stores), you can instead delete the store file before the program starts.

## Rerun when your code changes

The [skip checks](guide.md#the-store-and-the-skip-rule) look only at the inputs and outputs of a task. So a task skips after you change its code. To make it run, give it one more input whose stamp is the version of its code. In this program, that input is a `Value`, an [artifact type](write-an-artifact.md) that the program defines. Change the version each time you change the code:

```ts
import { Artifact, Build, MemoryStore, Task } from "dapat"

class Value extends Artifact<string> {
  constructor(readonly id: string, readonly value: string) { super() }
  async stamp() { return this.value }
  async read() { return this.value }
}

const store = new MemoryStore()
// Each pass is one build. Before the third build, the code of the task changes to v2.
for (const version of ["v1", "v1", "v2"]) {
  const build = new Build({ store })
  build.add(new Task({ id: "step", inputs: [new Value("code:step", version)], run: async () => {} }))
  const result = await build.run()
  const ran = result.executed.map((task) => task.id)
  const skipped = result.skipped.map((task) => task.id)
  console.log(`${version}: ran [${ran.join(" ")}] skipped [${skipped.join(" ")}]`)
}
```

<!-- output -->
```text
v1: ran [step] skipped []
v1: ran [] skipped [step]
v2: ran [step] skipped []
```

You can also add the file that holds the task code as an input: [`new FileArtifact(import.meta.path)`](builtins.md#files). Then the task runs on the next build after each change to that file. This includes a change to another task in the file. A change to a module that the file imports does not change the stamp of the file.

## Delete old outputs

An old output is a file that a task wrote in an earlier build and no task writes now. dapat deletes no file ([layout rules](guide.md#layout-rules)), so only your code can delete it. There are two cases:

- **A task writes fewer files in its folder output.** Its `run` function deletes each old file and reports it with `ctx.deleted`, as `split` does in build 3 of [Outputs with unknown names](guide.md#outputs-with-unknown-names).
- **No task in the build has the file as an output.** Examples are a task that your code no longer adds, and a [`build.each`](guide.md#buildeach) task whose matched file is gone. After `build.run()`, collect the tasks in [`result.executed`](guide.md#results-and-failure), `result.skipped` and the keys of `result.failed`. In a folder that only these tasks write, delete each file that no output of these tasks names or [covers](guide.md#folders-prefixes).

In the second case, a task that has the folder as an input runs again on the next build, because the folder stamp changed. Your code deletes some old outputs one build later. These are the outputs of a task that `build.each` made for an old output, or of a task that was [removed](guide.md#tasks-and-dependencies) after it ended.

## Limit parallel work

A **gate** is a function that lets at most `max` calls run at the same time. To limit a slow call in `run`, such as a video encode, pass it to a gate as a function. Here 12 tasks share `gate(4)`:

```ts
import { Build, Task } from "dapat"

function gate(max: number) {
  let free = max
  const waiting: Array<() => void> = []
  return async function <T>(work: () => Promise<T>) {
    if (free > 0) free -= 1
    else await new Promise<void>((resolve) => waiting.push(resolve))
    try {
      return await work()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else free += 1
    }
  }
}
let running = 0
let peak = 0
async function encode() {
  running += 1
  peak = Math.max(peak, running)
  await Bun.sleep(10) // the slow work
  running -= 1
}
const cpu = gate(4)
const build = new Build()
for (let i = 0; i < 12; i++) {
  build.add(new Task({ id: `encode:${i}`, run: () => cpu(encode) }))
}
await build.run()
console.log(`peak: ${peak}`)
```

<!-- output -->
```text
peak: 4
```

## Run in CI

A task skips in a CI job only when the job has the task's [record](guide.md#what-a-build-does) from an earlier job. Its output files must also have the stamps in that record. Use a `JsonStore` or a `SqliteStore` ([Stores](builtins.md#stores)). At the end of each job, save the store file (for example `.dapat/state.json`) and the output files in the CI cache. At the start of each job, restore them. When the cache is empty, every task runs.

- Check out the project at the same path in each job, because [file ids](builtins.md#files) are absolute paths.
- Keep the default hash stamps, because a checkout changes the mtime of every file ([Hash or time](builtins.md#hash-or-time)).

## Call a paid model

Make each model call one task. Its input is the prompt file, and its output is the answer file. With a `JsonStore` or a `SqliteStore`, the task skips and makes no call while the prompt and the answer do not change. The model name is not an input, so put it in the prompt file. Or add it as an input, like the `Value` in [Rerun when your code changes](#rerun-when-your-code-changes). To limit the calls that run at the same time, use a [gate](#limit-parallel-work).
