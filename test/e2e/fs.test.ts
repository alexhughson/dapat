import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Build, Matcher, Task } from "../../src/index"
import { FileArtifact, FilesystemPrefix } from "../../contrib/fs"
import { JsonStore, SqliteStore } from "../../contrib/store"

const temps: string[] = []

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dapat-fs-"))
  temps.push(dir)
  return dir
}

describe("filesystem artifacts", () => {
  test("copies a file and skips on the next run with JsonStore", async () => {
    const root = await tempDir()
    const srcPath = path.join(root, "src", "a.txt")
    const outPath = path.join(root, "out", "a.txt")
    await mkdir(path.dirname(srcPath), { recursive: true })
    await writeFile(srcPath, "hello")

    const store = new JsonStore(path.join(root, "state.json"))
    let runs = 0

    const runOnce = async () => {
      const src = new FileArtifact(srcPath)
      const out = new FileArtifact(outPath)
      const build = new Build({ store })
      build.add(
        new Task({
          id: "copy",
          inputs: [src],
          outputs: [out],
          run: async () => {
            runs += 1
            await mkdir(path.dirname(outPath), { recursive: true })
            await writeFile(outPath, await src.read())
          },
        }),
      )
      return build.run()
    }

    const first = await runOnce()
    expect(first.executed.length).toBe(1)
    expect(await Bun.file(outPath).text()).toBe("hello")
    expect(runs).toBe(1)

    const second = await runOnce()
    expect(second.skipped.length).toBe(1)
    expect(runs).toBe(1)

    await writeFile(srcPath, "hello world")
    const third = await runOnce()
    expect(third.executed.length).toBe(1)
    expect(await Bun.file(outPath).text()).toBe("hello world")
    expect(runs).toBe(2)
  })

  test("a JsonStore record in the old shape makes the task run and write a new record", async () => {
    const root = await tempDir()
    const srcPath = path.join(root, "a.txt")
    const outPath = path.join(root, "b.txt")
    const statePath = path.join(root, "state.json")
    await writeFile(srcPath, "hello")
    await writeFile(outPath, "hello")
    const src = new FileArtifact(srcPath)
    const out = new FileArtifact(outPath)
    // The file shape that dapat wrote before one stamp per artifact.
    const oldFile = {
      tasks: {
        copy: {
          inputStamps: { [src.id]: { order: "1", content: await src.stamp() } },
          outputStamps: { [out.id]: { order: "2", content: await out.stamp() } },
        },
      },
    }
    await writeFile(statePath, JSON.stringify(oldFile))
    let runs = 0

    const runOnce = async () => {
      const build = new Build({ store: new JsonStore(statePath) })
      build.add(
        new Task({
          id: "copy",
          inputs: [src],
          outputs: [out],
          run: async () => {
            runs += 1
            await writeFile(outPath, await src.read())
          },
        }),
      )
      return build.run()
    }

    const first = await runOnce()
    expect(first.executed.length).toBe(1)
    const written = await Bun.file(statePath).json()
    expect(written.tasks.copy).toEqual({
      inputStamps: { [`artifact ${src.id}`]: await src.stamp() },
      outputStamps: { [`artifact ${out.id}`]: await out.stamp() },
    })

    const second = await runOnce()
    expect(second.skipped.length).toBe(1)
    expect(runs).toBe(1)
  })

  test("a folder listing waits for writers and reruns when the folder changes", async () => {
    const root = await tempDir()
    const outDir = path.join(root, "out")
    const zipPath = path.join(root, "bundle.txt")
    await mkdir(outDir, { recursive: true })

    // A task with no input always runs, so each writer reads a seed file.
    const seedPath = path.join(root, "seed.txt")
    await writeFile(seedPath, "seed")
    const store = new SqliteStore(path.join(root, "state.sqlite"))
    let writes = 0
    let zips = 0

    const runOnce = async () => {
      const foo = new FileArtifact(path.join(outDir, "foo.txt"))
      const bar = new FileArtifact(path.join(outDir, "bar.txt"))
      const listing = new FilesystemPrefix(outDir)
      const zip = new FileArtifact(zipPath)
      const build = new Build({ store })
      build.add(
        new Task({
          id: "write-foo",
          inputs: [new FileArtifact(seedPath)],
          outputs: [foo],
          run: async () => {
            writes += 1
            await writeFile(foo.path, "foo")
          },
        }),
      )
      build.add(
        new Task({
          id: "write-bar",
          inputs: [new FileArtifact(seedPath)],
          outputs: [bar],
          run: async () => {
            writes += 1
            await writeFile(bar.path, "bar")
          },
        }),
      )
      build.add(
        new Task({
          id: "zip",
          inputs: [listing],
          outputs: [zip],
          run: async () => {
            zips += 1
            const names = await listing.list()
            names.sort()
            const parts: string[] = []
            for (const filePath of names) {
              parts.push(await Bun.file(filePath).text())
            }
            await writeFile(zipPath, parts.join("+"))
          },
        }),
      )
      return build.run()
    }

    const first = await runOnce()
    expect(first.success).toBe(true)
    expect(writes).toBe(2)
    expect(zips).toBe(1)
    expect(await Bun.file(zipPath).text()).toBe("bar+foo")

    const second = await runOnce()
    expect(second.skipped.length).toBe(3)
    expect(writes).toBe(2)
    expect(zips).toBe(1)

    // No task writes baz.txt. The listing changes, so only zip runs.
    await writeFile(path.join(outDir, "baz.txt"), "baz")
    const third = await runOnce()
    expect(third.executed.map((task) => task.id)).toEqual(["zip"])
    expect(writes).toBe(2)
    expect(zips).toBe(2)
    expect(await Bun.file(zipPath).text()).toBe("bar+baz+foo")
    store.close()
  })

  test("prefix output plus produced child, then a consumer of that file", async () => {
    const root = await tempDir()
    const outDir = path.join(root, "logs")
    await mkdir(outDir, { recursive: true })
    const logPath = path.join(outDir, "1.json")
    const reportPath = path.join(root, "reports", "1.json")

    const build = new Build()
    build.add(
      new Task({
        id: "write-log",
        outputs: [new FilesystemPrefix(outDir)],
        run: async (ctx) => {
          await writeFile(logPath, "{\"ok\":true}")
          ctx.produced(new FileArtifact(logPath))
        },
      }),
    )
    build.add(
      new Task({
        id: "report",
        inputs: [new FileArtifact(logPath)],
        outputs: [new FileArtifact(reportPath)],
        run: async () => {
          await mkdir(path.dirname(reportPath), { recursive: true })
          const raw = await new FileArtifact(logPath).read()
          await writeFile(reportPath, raw)
        },
      }),
    )

    const result = await build.run()
    expect(result.success).toBe(true)
    expect(await Bun.file(reportPath).text()).toBe("{\"ok\":true}")
  })
})

/** A matcher of files that a test sends one at a time, so the test sets the scan order across matchers. */
class SentFiles extends Matcher<FileArtifact> {
  constructor(
    readonly varNames: readonly string[],
    private readonly scanSteps: () => Promise<void> = async () => {},
  ) {
    super()
  }

  async scan(): Promise<void> {
    await this.scanSteps()
  }

  foundFile(vars: Record<string, string>, filePath: string): void {
    this.send({ kind: "found", matched: { vars, data: new FileArtifact(filePath) } })
  }
}

describe("build.each with required, over files", () => {
  // The page of a lang that has no review is the draft of that lang. Page a has a review, page b has none.
  for (const scanOrder of [
    ["review a", "page a", "page b"],
    ["page a", "review a", "page b"],
    ["page a", "page b", "review a"],
  ]) {
    test(`the drafts example skips on build 2 with the scan order ${scanOrder.join(", ")}`, async () => {
      const root = await tempDir()
      const pageAPath = path.join(root, "content", "en", "a.md")
      const pageBPath = path.join(root, "content", "en", "b.md")
      const reviewPath = path.join(root, "reviews", "en", "a", "ann.json")
      await mkdir(path.dirname(pageAPath), { recursive: true })
      await mkdir(path.dirname(reviewPath), { recursive: true })
      await writeFile(pageAPath, "A")
      await writeFile(pageBPath, "B")
      await writeFile(reviewPath, "ok")
      const store = new JsonStore(path.join(root, "state.json"))

      async function buildOnce() {
        const reviews = new SentFiles(["lang", "slug", "reviewer"])
        const sendByStep: Record<string, () => void> = {
          "page a": () => pages.foundFile({ lang: "en", slug: "a" }, pageAPath),
          "page b": () => pages.foundFile({ lang: "en", slug: "b" }, pageBPath),
          "review a": () => reviews.foundFile({ lang: "en", slug: "a", reviewer: "ann" }, reviewPath),
        }
        const pages: SentFiles = new SentFiles(["lang", "slug"], async () => {
          for (const step of scanOrder) {
            sendByStep[step]!()
            await Promise.resolve()
          }
        })
        const build = new Build({ store })
        build.each({
          matchersByName: { page: pages, review: reviews },
          required: ["page"],
          *tasks(vars, matched) {
            const page = matched.page.data
            if (matched.review === undefined) {
              const draft = new FileArtifact(path.join(root, "drafts", `${vars.lang}.html`))
              yield new Task({ id: `draft:${vars.lang}`, inputs: [page], outputs: [draft], run: async () => void (await Bun.write(draft.path, "draft")) })
            } else {
              const html = new FileArtifact(path.join(root, "site", `${vars.lang}`, `${vars.slug}.html`))
              const inputs = [page, matched.review.data]
              yield new Task({ id: `page:${vars.lang}/${vars.slug}`, inputs, outputs: [html], run: async () => void (await Bun.write(html.path, "page")) })
            }
          },
        })
        return build.run()
      }

      const first = await buildOnce()
      expect(first.success).toBe(true)
      expect(first.executed.map((task) => task.id).sort()).toEqual(["draft:en", "page:en/a"])

      const second = await buildOnce()
      expect(second.success).toBe(true)
      expect(second.executed).toEqual([])
      expect(second.skipped.map((task) => task.id).sort()).toEqual(["draft:en", "page:en/a"])
    })
  }
})
