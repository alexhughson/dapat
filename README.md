# dapat

dapat is a build tool for TypeScript on Bun. As in `make`, you declare tasks, and each task names its inputs and its outputs. dapat then runs the tasks in the correct order, and it builds again only what changed.

Inspired by [doit](https://github.com/pydoit/doit)

Inputs and outputs can be files. They can also be S3 objects, database rows, or values in memory. dapat wraps each input and output in a subclass of `Artifact`. The subclass tells dapat how to find out if the thing changed, with a timestamp, a hash, or both. dapat includes artifact classes for files, S3 objects, and SQLite rows and tables. For anything else, write a small subclass.

When you run a build, dapat does these things:

- **Order:** it starts a task only after the tasks that write its inputs have finished.
- **Skip:** it skips a task when its inputs did not change since the last run and its outputs still exist. It compares content hashes, so an edit that restores the old bytes does not cause a rebuild.
- **Grow:** it adds tasks during the build. When a task writes a new output that a rule matches, dapat adds the task that reads that output.

```
Use dapat for data pipelines, generated files, and agent loops, where a step is expensive and must run again only when its inputs change.
```

```
Status: version 0.1.0. dapat is not published to a registry, and the API can change.
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
  process.exit(1)
}
```

`wrap` waits for `upper`, because `mid` is an output of `upper` and an input of `wrap`. Put `hello` into `in.txt`, and then run the script more than one time:

1. **First run.** Both tasks execute. `out.txt` contains `[HELLO]`.
2. **No change.** Both tasks skip.
3. **Change** `in.txt` **to** `bye`**.** Both tasks execute. `out.txt` contains `[BYE]`.
4. **Run** `touch in.txt`**.** The bytes do not change, so both tasks skip.

`build.run()` does not throw when a task fails. Always check `result.success`.

## Rules over many files

`FileBuild` creates one task for each file that matches a path template. When a task writes a file that another rule matches, `FileBuild` adds the next task during the same build.

```ts
import { Build } from "dapat"
import { FileBuild, FilePattern, JsonStore } from "dapat/contrib"

const build = new Build({ store: new JsonStore(".dapat/state.json") })
const files = new FileBuild(build, { root: "." })

files.rule({
  name: "upper",
  inputs: { src: new FilePattern("src/<name>.txt") },
  outputs: { out: new FilePattern("out/<name>.txt") },
  run: async (ctx) => {
    const text = new TextDecoder().decode(await ctx.file("src").read())
    await Bun.write(ctx.outputFile("out").path, text.toUpperCase())
  },
})

const result = await files.run()
```

`S3Pattern` does the same for S3 keys. One rule can mix files and S3 objects.

## What is in the package


| Import          | Contents                                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dapat`         | the engine: `Build`, `Task`, `Artifact`, `Prefix`, `MemoryStore`, `Result`                                                                                                           |
| `dapat/contrib` | `FileArtifact`, `DirectoryArtifact`, `S3ObjectArtifact`, `SqliteRowArtifact`, `SqliteTableArtifact`. Stores that write to JSON or SQLite. `FileBuild` for rules with path templates. |




## Documentation

[DOCS.md](DOCS.md) explains each part of the library:

- how to write your own artifact
- how dapat finds dependencies
- the exact rules for when a task skips, and how to find out why a task ran
- failure, cancellation, and replacement of tasks
- listeners for artifacts that a task writes during the build
- the `FileBuild` template syntax
- recipes: force a rebuild, limit parallel work, run in CI
- known limits
- the full API reference

The `[examples/](examples/)` folder has runnable programs. Run one with `bun run examples/<name>.ts`:

- `first-build.ts` is the example above. Run it from a directory that contains `in.txt`.
- `file-pipeline.ts` has two `FileBuild` rules in a chain.
- `s3-pages-screenshots.ts` splits S3 documents into pages and writes one file for each page.
- `agent-loop.ts` is an agent with more than one turn. Each turn writes the prompt for the next turn, and a rule matches it.
- `git-line-count.ts` counts text lines in every commit of a git repo; with its `SqliteStore`, a second run skips commits that already have stamps.



## Development

```sh
bun install
bun test
```

