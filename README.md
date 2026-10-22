# dapat

dapat is a build library for TypeScript, on Bun only, with ideas from [doit](https://github.com/pydoit/doit). You declare tasks and their inputs and outputs: files, folders, S3 objects, or any other value, with an [artifact type](docs/write-an-artifact.md) of your own. Use dapat for data pipelines, generated sites and agent loops, where a task is slow or costs money. When a build runs, dapat does three things:

- Order: when an output of task A is an input of task B, B runs after A finishes.
- Skip: a task with inputs [skips](docs/guide.md#the-skip-rule) only when each input and output has the same [stamp](docs/guide.md#what-a-build-does) as at its last successful run. A store keeps these stamps between builds. By default, the stamp of a file is a hash of its bytes ([hash or time](docs/guide.md#artifacts-and-stamps)).
- Tasks from files: [`build.each`](docs/guide.md#buildeach) makes a task for each file that fits a pattern, such as `posts/<slug>.md`. It also makes tasks for the files that other tasks in the same build declare or [report](docs/guide.md#outputs-with-unknown-names) as outputs.

## Install

dapat needs Bun. It is tested with Bun 1.4.2. dapat 0.1.0 is not on npm, and its API can change. Clone the repository with `git clone https://github.com/alexhughson/dapat`. Run `bun link` in that folder. If your project has no `package.json`, run `bun init` in it first. Then run `bun link dapat` in your project. A project that runs `tsc` also needs `@types/bun`: run `bun add -d @types/bun`.

## Example

This program makes `out.txt` from `in.txt` in two tasks. `dapat` holds the core: `Build`, `Task`, `Artifact`, `Prefix`, `Matcher` and `MemoryStore`. `dapat/contrib` holds the classes for files, folders and S3, the file stores and the file matchers. Save the program as `pipeline.ts` in your project. Then run `bun pipeline.ts`.

```ts
import { Build, Task } from "dapat"
import { FileArtifact, JsonStore } from "dapat/contrib"

const src = new FileArtifact("in.txt")
const mid = new FileArtifact("mid.txt")
const out = new FileArtifact("out.txt")
// write in.txt only when it is missing, so that your later edits stay
const hasInput = await Bun.file(src.path).exists()
if (!hasInput) {
  await Bun.write(src.path, "hello")
}
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
for (const [task, error] of result.failed) {
  console.error(`${task.id}: ${error.message}`)
}
process.exit(result.success ? 0 : 1)
```

The first run writes `[HELLO]` to `out.txt` and prints:
<!-- output -->
```text
ran [upper wrap] skipped []
```

The program adds `wrap` first, but `wrap` waits for `upper`, because `mid.txt` is an output of `upper` and an input of `wrap`. `build.run()` does not reject when a task fails, so check `result.success`.

Make each change in the table, in order. Run the program after each one.

| Change | Ran | Skipped | Why |
| --- | --- | --- | --- |
| no change | – | `upper` `wrap` | no stamp changed |
| `touch in.txt` | – | `upper` `wrap` | `in.txt` has the same bytes and so the same hash |
| `printf HELLO > in.txt` | `upper` | `wrap` | `upper` writes the same bytes to `mid.txt` |
| `printf bye > in.txt` | `upper` `wrap` | – | `upper` writes new bytes to `mid.txt` |
| `rm out.txt` | `wrap` | `upper` | an output of `wrap` is missing |

## What dapat does not do

- It deletes no output file, so old outputs stay on disk ([dapat deletes no file](docs/guide.md#dapat-deletes-no-file)).
- It does not watch files, and it has no command-line tool.
- It cannot run one task by name. To run some tasks, add only those tasks and the tasks that they wait for.
- It does not see changes to a task's code ([Rerun when your code changes](docs/recipes.md#rerun-when-your-code-changes)).
- It does not limit how many tasks run at the same time ([Limit parallel work](docs/recipes.md#limit-parallel-work)).
- It does not copy outputs or stamps between machines.

## Documentation

Next, read part 1 of the [guide](docs/guide.md). [docs/README.md](docs/README.md) lists every page by goal and defines the core terms. [Troubleshooting](docs/troubleshooting.md) lists problems that give no error message. [examples/README.md](examples/README.md) lists the examples.

## Development

Run `bun install`. Then run `bun test`. The docs check needs `tsc` on your PATH, so run `bun add -g typescript` one time. Then run `bun run docs:check`. When you add an example, add its row to the table in [examples/README.md](examples/README.md).
