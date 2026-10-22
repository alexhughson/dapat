# dapat

dapat is a build library for TypeScript, on Bun only, with ideas from [doit](https://github.com/pydoit/doit). You declare tasks, and each task names its inputs and its outputs. Inputs and outputs can be files, S3 objects, or any other value that you wrap in an [`Artifact` subclass](docs/write-an-artifact.md). Use dapat for data pipelines, generated sites and agent loops, where a task is slow or costs money. When a build runs, dapat does these three things:

- Order: when an output of task A is an input of task B, B starts after A finishes.
- Skip: a task [skips](docs/guide.md#the-store-and-the-skip-rule) only when each input and output has the same [stamp](docs/guide.md#what-a-build-does) as in the record of its last successful run. By default, the stamp of a file is a hash of its bytes ([hash or time](docs/builtins.md#hash-or-time)). A [store](docs/guide.md#what-a-build-does) keeps the records between builds, so a build without a store skips nothing.
- Tasks from files: [`build.each`](docs/guide.md#buildeach) makes a task for each file that fits a pattern, such as `posts/<slug>.md`. It also makes tasks for the files that other tasks in the same build declare or report as outputs.

## Install

dapat 0.1.0 is not on npm, and its API can change. Run `bun link` in a checkout of dapat. Then run `bun link dapat` in your project.

## Example

This program makes `out.txt` from `in.txt` in two tasks. Save it as `pipeline.ts` in a project that links dapat. Then run `bun pipeline.ts`.

```ts
import { Build, Task } from "dapat"
import { FileArtifact, JsonStore } from "dapat/contrib"

const src = new FileArtifact("in.txt")
const mid = new FileArtifact("mid.txt")
const out = new FileArtifact("out.txt")
// write in.txt only on the first run, so the edits in the table stay
const hasInput = await Bun.file(src.path).exists()
if (!hasInput) await Bun.write(src.path, "hello")
const build = new Build({ store: new JsonStore(".dapat/state.json") })

async function upper() {
  const text = await Bun.file(src.path).text()
  await Bun.write(mid.path, text.toUpperCase())
}
async function wrap() {
  const text = await Bun.file(mid.path).text()
  await Bun.write(out.path, `[${text}]`)
}
build.add(new Task({ id: "wrap", inputs: [mid], outputs: [out], run: wrap }))
build.add(new Task({ id: "upper", inputs: [src], outputs: [mid], run: upper }))
const result = await build.run()
const ran = result.executed.map((task) => task.id).sort()
const skipped = result.skipped.map((task) => task.id).sort()
console.log(`ran [${ran.join(" ")}] skipped [${skipped.join(" ")}]`)
for (const [task, error] of result.failed) console.error(`${task.id}: ${error.message}`)
process.exit(result.success ? 0 : 1)
```

The first run writes `[HELLO]` to `out.txt` and prints:
<!-- output -->
```text
ran [upper wrap] skipped []
```

The program adds `wrap` first, but `wrap` waits for `upper`, because `mid.txt` is an output of `upper` and an input of `wrap`. `build.run()` does not throw when a task fails, so check `result.success`.

Make each change in the table, in order. After each change, run the program again.

| Change | Ran | Skipped | Why |
| --- | --- | --- | --- |
| no change | – | `upper` `wrap` | no stamp changed |
| `touch in.txt` | – | `upper` `wrap` | the bytes of `in.txt` did not change, so its hash did not change |
| `printf HELLO > in.txt` | `upper` | `wrap` | `upper` writes the same bytes to `mid.txt` |
| `printf bye > in.txt` | `upper` `wrap` | – | `upper` writes new bytes to `mid.txt` |
| `rm out.txt` | `wrap` | `upper` | an output of `wrap` is missing |

## What dapat does not do

- It deletes no files. Old outputs stay on disk ([layout rules](docs/guide.md#layout-rules)).
- It does not watch files, and it has no command-line tool.
- It does not see changes to the code of a task ([recipe](docs/recipes.md#rerun-when-your-code-changes)).
- It does not limit how many tasks run at the same time ([recipe](docs/recipes.md#limit-parallel-work)).
- It does not copy outputs or stamps between machines.

## Documentation

Next, read part 1 of the [guide](docs/guide.md). It explains each call in the example. [docs/README.md](docs/README.md) lists every page by goal. It also lists the problems that show no clear error, with their causes. [examples/README.md](examples/README.md) lists the examples and how to run each one.

## Development

```sh
bun install
bun test
bun add -g typescript # the docs check needs tsc on your PATH
bun run docs:check
```
