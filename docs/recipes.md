# Recipes

Read part 1 of the [guide](guide.md) first. Read [part 2](guide.md#buildeach) before the recipes that use `build.each`.

## Force a rerun

To run one task again, call `await store.delete(task.id)` before `build.run()`. The tasks that read its outputs run again only when the stamps of those outputs change. To run every task again, call `await store.clear()`. For a [`JsonStore` or `SqliteStore`](builtins.md#stores), you can instead delete the store file before the program starts.

## Rerun when your code changes

The [skip rule](guide.md#the-skip-rule) does not look at the code of a task. To rerun it after a code change, give it one more input whose stamp is the version of its code. In this program, that input is a `Value`, an [artifact type](write-an-artifact.md) that the program defines. Change the version each time you change the code:

```ts
import { Artifact, Build, MemoryStore, Task } from "dapat"

class Value extends Artifact<string> {
  constructor(readonly id: string, readonly value: string) {
    super()
  }
  async stamp() {
    return this.value
  }
  async read() {
    return this.value
  }
}

const store = new MemoryStore()
// Three builds. The code of the task changes to v2 before the third build.
for (const version of ["v1", "v1", "v2"]) {
  const build = new Build({ store })
  const code = new Value("code:step", version)
  build.add(new Task({ id: "step", inputs: [code], run: async () => {} }))
  const result = await build.run()
  const ran = result.executed.map((task) => task.id).sort()
  const skipped = result.skipped.map((task) => task.id).sort()
  console.log(`${version}: ran [${ran.join(" ")}] skipped [${skipped.join(" ")}]`)
}
```

<!-- output -->
```text
v1: ran [step] skipped []
v1: ran [] skipped [step]
v2: ran [step] skipped []
```

You can also add the file that holds the task code as an input: [`new FileArtifact(import.meta.path)`](builtins.md#files). Then the task runs again after each change to that file, even a change to another task in it. A change to a module that the file imports does not make the task run.

## Delete old outputs

[dapat deletes no file](guide.md#dapat-deletes-no-file), so only your code can delete an old output. There are two cases:

- A task writes fewer files in its folder output. Its `run` function deletes each old file and reports it with `ctx.deleted`, as `split` does in build 3 of [Outputs with unknown names](guide.md#outputs-with-unknown-names).
- No task in the build has the file as an output. Examples are a task that your code no longer adds, and a [`build.each`](guide.md#buildeach) task whose matched file is gone. After `build.run()`, collect the tasks in [`result.executed`](guide.md#results-and-failure), `result.skipped` and the keys of `result.failed`. In a folder that only these tasks write, delete each file that no output of these tasks names or [covers](guide.md#folders-prefixes).

In this program, only the `page` tasks write in `site`. The program deletes `content/about.md` before build 2:

```ts
import { Build, MemoryStore, isPrefix } from "dapat"
import { FileArtifact, FileMatcher, FileTemplate, FilesystemPrefix } from "dapat/contrib"

await Bun.write("content/hello.md", "Hello")
await Bun.write("content/about.md", "About")
const site = new FilesystemPrefix("site")
const store = new MemoryStore()

async function runBuild(label: string) {
  const build = new Build({ store })
  build.each({
    name: "page",
    matchersByName: { page: new FileMatcher("content/<slug>.md") },
    outputsByName: { html: new FileTemplate("site/<slug>.html") },
    async run({ matched, outputs }) {
      await Bun.write(outputs.html.path, Bun.file(matched.page.data.path))
    },
  })
  const result = await build.run()
  const tasks = [...result.executed, ...result.skipped, ...result.failed.keys()]
  const outputs = tasks.flatMap((task) => task.outputs)
  const paths = await site.list()
  paths.sort()
  for (const path of paths) {
    const file = new FileArtifact(path)
    const named = outputs.some((output) => output.id === file.id)
    const covered = outputs.some((output) => isPrefix(output) && output.covers(file))
    if (!named && !covered) {
      await Bun.file(path).delete()
      console.log(`${label}: deleted ${path.replace(process.cwd(), ".")}`)
    }
  }
}

await runBuild("1")
await Bun.file("content/about.md").delete()
await runBuild("2")
```

<!-- output -->
```text
2: deleted ./site/about.html
```

Each deletion changes the folder's stamp, so each task that reads the folder runs on the next build.

## Limit parallel work

A **gate** is a function that lets at most `max` calls run at the same time. To limit a slow call in `run`, such as a video encode, pass it to a gate as a function. Here 12 tasks share `gate(4)`, so at most 4 encodes run at the same time:

```ts
import { Build, Task } from "dapat"

function gate(max: number) {
  let free = max
  const waiting: Array<() => void> = []
  return async function <T>(work: () => Promise<T>) {
    if (free > 0) {
      free -= 1
    } else {
      await new Promise<void>((resolve) => waiting.push(resolve))
    }
    try {
      return await work()
    } finally {
      const next = waiting.shift()
      if (next) {
        next()
      } else {
        free += 1
      }
    }
  }
}
const encode = () => Bun.sleep(10) // the slow work
const cpu = gate(4)
const build = new Build()
for (let i = 0; i < 12; i++) {
  build.add(new Task({ id: `encode:${i}`, run: () => cpu(encode) }))
}
await build.run()
```

## Run in CI

A task skips in a CI job only when the job has the task's [record](guide.md#what-a-build-does) from an earlier job, and its output files have the stamps in that record. So use a `JsonStore` or a `SqliteStore` ([Stores](builtins.md#stores)), and keep the store file and the output files in the CI cache. In GitHub Actions, the `actions/cache` step restores the folders in `path`, and it saves them at the end of a job that succeeds. For a program `pipeline.ts` that keeps its store in `.dapat/` and writes its outputs in `site/`, add these steps to the job:

```yaml
- uses: actions/checkout@v7
- uses: oven-sh/setup-bun@v2
- uses: actions/cache@v6
  with:
    path: |
      .dapat
      site
    key: dapat-${{ github.job }}-${{ github.run_id }}-${{ github.run_attempt }}
    restore-keys: dapat-${{ github.job }}-
- run: bun pipeline.ts
```

- The `key` is new in each job. A saved cache never changes, so with a fixed `key`, every job gets the records of the first job.
- When no cache has the `key`, as in each job here, the step restores the newest cache whose key starts with `restore-keys`.
- Check out the project at the same path in each job, because [file ids](builtins.md#files) are absolute paths. Keep the default hash stamps, because a checkout changes the mtime of every file ([Hash or time](builtins.md#hash-or-time)).

## Call a paid model

Make each model call one task. Its input is the prompt file, and its output is the answer file. With a `JsonStore` or a `SqliteStore`, the task skips and makes no call while the prompt and the answer do not change. Put the model name in the prompt file, or add it as an input, like the `Value` in [Rerun when your code changes](#rerun-when-your-code-changes). To limit the calls that run at the same time, use a [gate](#limit-parallel-work). [examples/book/](../examples/book/README.md) works this way: each scene and each image is one task. Each prompt is an artifact whose stamp is a hash of its text.
