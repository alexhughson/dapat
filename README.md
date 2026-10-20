# dapat

dapat is a build tool for TypeScript on Bun. As in `make`, you declare tasks, and each task names its inputs and its outputs. dapat then runs the tasks in the correct order, and it builds again only what changed.

Inspired by [doit](https://github.com/pydoit/doit)

Inputs and outputs can be files. They can also be S3 objects, database rows, or values in memory. dapat wraps each input and output in a subclass of `Artifact`. The subclass gives dapat a stamp: a string that changes when the thing changes, for example a hash. dapat includes artifact classes for files and S3 objects. For anything else, write a small subclass.

When you run a build, dapat does these things:

- **Order:** it starts a task only after the tasks that write its inputs have finished.
- **Skip:** it skips a task when each input and output has the same stamp as in the last run, and each output still exists. A task with no input always runs. This needs a store. By default, the file artifacts use the modification time and the size as stamps, because that is fast. Pass `{ stamp: "hash" }` to use a hash of the bytes. Then an edit that restores the old bytes does not cause a rebuild. A folder (`new FilesystemPrefix("pages")`) also has a stamp, so a new file in a folder that a task reads makes the task run.
- **Grow:** it adds tasks during the build. A subscriber (`build.subscribe`) gets a `promised` event for each output that a task declares, a `produced` event for each output that a task writes, a `deleted` event for each output that a task deletes, and a `withdrawn` event when the declaring task leaves the build. The subscriber can add the task that reads that output. dapat calls subscribers synchronously, so the new task exists before the writer continues. If a subscriber throws, `build.run()` rejects with that error.

```
Use dapat for data pipelines, generated files, and agent loops, where a step is expensive and must run again only when its inputs change.
```

```
Status: version 0.1.0. dapat is not published to a registry, and the API can change.
`build.each` makes tasks for each artifact that a matcher finds. With several matchers, it joins their matches on shared var names, like a database join. dapat has no built-in matchers yet.
```

```
dapat does not:
```

- give a command-line tool. You write a TypeScript program that calls the library.
- watch files for changes.
- limit how many tasks run at the same time.
- share a cache between machines.
- run on Node.js.
- write outputs for you. Each task writes its own outputs.



## Install

dapat runs on Bun only. Link it from a local checkout:

```sh
cd path/to/dapat && bun link
cd path/to/your-project && bun link dapat
```



## Example

```ts
import { Build, Task } from "dapat"
import { FileArtifact, JsonStore } from "dapat/contrib"

const src = new FileArtifact("in.txt")
const mid = new FileArtifact("mid.txt")
const out = new FileArtifact("out.txt")

const build = new Build({ store: new JsonStore(".dapat/state.json") })

build.add(
  new Task({
    id: "upper",
    inputs: [src],
    outputs: [mid],
    run: async () => {
      const text = new TextDecoder().decode(await src.read())
      await Bun.write(mid.path, text.toUpperCase())
    },
  }),
)

build.add(
  new Task({
    id: "wrap",
    inputs: [mid],
    outputs: [out],
    run: async () => {
      const text = new TextDecoder().decode(await mid.read())
      await Bun.write(out.path, `[${text}]`)
    },
  }),
)

const result = await build.run()
if (!result.success) {
  for (const [task, error] of result.failed) {
    console.error(`${task.id}: ${error.message}`)
  }
  for (const error of result.errors) {
    console.error(error.message)
  }
  process.exit(1)
}
```

`wrap` waits for `upper`, because `mid` is an output of `upper` and an input of `wrap`. Put `hello` into `in.txt`, and then run the script more than one time:

1. **First run.** Both tasks execute. `out.txt` contains `[HELLO]`.
2. **No change.** Both tasks skip.
3. **Change** `in.txt` **to** `bye`**.** Both tasks execute. `out.txt` contains `[BYE]`.
4. **Run** `touch in.txt`**.** The modification time changes, so the default stamp of `in.txt` changes. Both tasks run. With `new FileArtifact("in.txt", { stamp: "hash" })`, the bytes decide the stamp, and both tasks skip.

`build.run()` does not throw when a task fails. Always check `result.success`.

## What is in the package


| Import          | Contents                                                                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `dapat`         | the engine: `Build`, `Task`, `Artifact`, `Prefix`, `MemoryStore`, `Result`, `Emitter`, `Matcher`                                          |
| `dapat/contrib` | `FileArtifact`, `FilesystemPrefix` (a folder), `S3ObjectArtifact`, `S3Prefix`. Stores that write to JSON or SQLite. |




## Documentation

[DOCS.md](DOCS.md) explains each part of the library:

- how to write your own artifact
- how dapat finds dependencies
- the rule for when a task skips, and how to find out why a task ran
- failure, cancellation, and replacement of tasks
- subscribers for the outputs that tasks declare and write during the build, and their errors
- `build.each` and matchers, which make tasks for each artifact that a matcher finds
- recipes: force a rebuild, limit parallel work, run in CI
- known limits
- the full API reference

[examples/first-build.ts](examples/first-build.ts) is a runnable version of the example above. It keeps its state in `.dapat/state.json`, so a second run skips both tasks. Edit `in.txt` to see them run again. Run it from a folder that contains `in.txt`, with `bun run <path to dapat>/examples/first-build.ts`.



## Development

```sh
bun install
bun test
```

