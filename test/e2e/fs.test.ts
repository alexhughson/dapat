import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Build, Task } from "../../src/index"
import { DirectoryArtifact, FileArtifact, PathPrefix } from "../../contrib/fs"
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

  test("directory listing waits for writers and reruns when a child changes", async () => {
    const root = await tempDir()
    const outDir = path.join(root, "out")
    const zipPath = path.join(root, "bundle.txt")
    await mkdir(outDir, { recursive: true })

    const store = new SqliteStore(path.join(root, "state.sqlite"))
    let writes = 0
    let zips = 0

    const runOnce = async () => {
      const foo = new FileArtifact(path.join(outDir, "foo.txt"))
      const bar = new FileArtifact(path.join(outDir, "bar.txt"))
      const listing = new DirectoryArtifact(outDir)
      const zip = new FileArtifact(zipPath)
      const build = new Build({ store })
      build.add(
        new Task({
          id: "write-foo",
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
            const names = await listing.read()
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

    await writeFile(path.join(outDir, "foo.txt"), "FOO")
    const third = await runOnce()
    expect(zips).toBe(2)
    expect(await Bun.file(zipPath).text()).toBe("bar+FOO")
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
        outputs: [new PathPrefix(outDir)],
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
