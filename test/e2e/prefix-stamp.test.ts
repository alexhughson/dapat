import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Build, IdPrefix, Task } from "../../src/index"
import type { Result } from "../../src/index"
import { FileArtifact, PathPrefix, file, pathPrefix } from "../../contrib/fs"
import type { FileStampMode } from "../../contrib/fs"
import { JsonStore } from "../../contrib/store"

const temps: string[] = []

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dapat-prefix-"))
  temps.push(dir)
  return dir
}

function ids(tasks: readonly Task[]): string[] {
  const result: string[] = []
  for (const task of tasks) {
    result.push(task.id)
  }
  return result
}

/** Runs one build with a task that writes index.html from every page under pages/. */
async function buildIndex(root: string, store: JsonStore): Promise<Result> {
  const pagesDir = path.join(root, "pages")
  const index = new FileArtifact(path.join(root, "index.html"))
  const build = new Build({ store })
  build.add(
    new Task({
      id: "index",
      inputs: [new PathPrefix(pagesDir)],
      outputs: [index],
      run: async () => {
        const names = await readdir(pagesDir)
        names.sort()
        const items: string[] = []
        for (const name of names) {
          const text = await readFile(path.join(pagesDir, name), "utf8")
          items.push(`<li>${name}: ${text}</li>`)
        }
        await writeFile(index.path, `<ul>${items.join("")}</ul>`)
      },
    }),
  )
  return build.run()
}

describe("prefix stamps", () => {
  test("a PathPrefix input sees pages that are added, edited, and deleted", async () => {
    const root = await tempDir()
    const pagesDir = path.join(root, "pages")
    await mkdir(pagesDir)
    await writeFile(path.join(pagesDir, "a.md"), "A")
    await writeFile(path.join(pagesDir, "b.md"), "B")
    await writeFile(path.join(pagesDir, "c.md"), "C")
    const store = new JsonStore(path.join(root, "state.json"))

    const first = await buildIndex(root, store)
    expect(ids(first.executed)).toEqual(["index"])
    const second = await buildIndex(root, store)
    expect(ids(second.skipped)).toEqual(["index"])

    await writeFile(path.join(pagesDir, "d.md"), "D")
    const added = await buildIndex(root, store)
    expect(ids(added.executed)).toEqual(["index"])
    const indexText = await readFile(path.join(root, "index.html"), "utf8")
    expect(indexText).toContain("d.md: D")

    // A new size, so the time stamp changes even inside one clock tick.
    await writeFile(path.join(pagesDir, "b.md"), "B edited")
    const edited = await buildIndex(root, store)
    expect(ids(edited.executed)).toEqual(["index"])

    await rm(path.join(pagesDir, "c.md"))
    const deleted = await buildIndex(root, store)
    expect(ids(deleted.executed)).toEqual(["index"])
    const afterDelete = await readFile(path.join(root, "index.html"), "utf8")
    expect(afterDelete).not.toContain("c.md")

    const last = await buildIndex(root, store)
    expect(ids(last.skipped)).toEqual(["index"])
  })

  test("a PathPrefix output runs again when files under it are deleted by hand", async () => {
    const root = await tempDir()
    const docPath = path.join(root, "doc.txt")
    const outDir = path.join(root, "out")
    await writeFile(docPath, "p1\np2")
    const store = new JsonStore(path.join(root, "state.json"))
    let runs = 0

    const runOnce = async () => {
      const doc = file(docPath)
      const build = new Build({ store })
      build.add(
        new Task({
          id: "split",
          inputs: [doc],
          outputs: [pathPrefix(outDir)],
          run: async (ctx) => {
            runs += 1
            const text = new TextDecoder().decode(await doc.read())
            const lines = text.split("\n")
            await mkdir(outDir, { recursive: true })
            for (let i = 0; i < lines.length; i++) {
              const page = file(path.join(outDir, `${i + 1}.txt`))
              await writeFile(page.path, lines[i]!)
              ctx.produced(page)
            }
          },
        }),
      )
      return build.run()
    }

    const first = await runOnce()
    expect(first.executed.length).toBe(1)
    const second = await runOnce()
    expect(second.skipped.length).toBe(1)

    await rm(path.join(outDir, "1.txt"))
    const third = await runOnce()
    expect(third.executed.length).toBe(1)
    expect(await readFile(path.join(outDir, "1.txt"), "utf8")).toBe("p1")
    expect(runs).toBe(2)
  })

  test("an IdPrefix input makes the task run on every build", async () => {
    const root = await tempDir()
    const srcPath = path.join(root, "src.txt")
    const outPath = path.join(root, "out.txt")
    await writeFile(srcPath, "x")
    const store = new JsonStore(path.join(root, "state.json"))
    let runs = 0

    const runOnce = async () => {
      const build = new Build({ store })
      build.add(
        new Task({
          id: "copy",
          inputs: [file(srcPath), new IdPrefix("mem:pages/")],
          outputs: [file(outPath)],
          run: async () => {
            runs += 1
            await writeFile(outPath, "x")
          },
        }),
      )
      return build.run()
    }

    await runOnce()
    const second = await runOnce()
    const third = await runOnce()
    expect(second.executed.length).toBe(1)
    expect(third.executed.length).toBe(1)
    expect(runs).toBe(3)
  })

  test("an old record with no prefix stamps makes the task run one time", async () => {
    const root = await tempDir()
    const pagesDir = path.join(root, "pages")
    await mkdir(pagesDir)
    await writeFile(path.join(pagesDir, "a.md"), "A")
    const statePath = path.join(root, "state.json")
    const store = new JsonStore(statePath)

    await buildIndex(root, store)
    // Make the record look like one from before prefix stamps.
    const record = await store.get("index")
    const oldRecord = {
      inputStamps: record!.inputStamps,
      outputStamps: record!.outputStamps,
    }
    await writeFile(statePath, JSON.stringify({ tasks: { index: oldRecord } }))

    const upgraded = await buildIndex(root, store)
    expect(ids(upgraded.executed)).toEqual(["index"])
    const next = await buildIndex(root, store)
    expect(ids(next.skipped)).toEqual(["index"])
  })

  test("a prefix and an artifact with the same id do not share a recorded stamp", async () => {
    const root = await tempDir()
    const dir = path.join(root, "pages")
    await mkdir(dir)
    await writeFile(path.join(dir, "a.md"), "A")
    const store = new JsonStore(path.join(root, "state.json"))
    const prefix = new PathPrefix(dir)

    const build = new Build({ store })
    build.add(
      new Task({
        id: "read",
        inputs: [prefix],
        run: async () => {},
      }),
    )
    await build.run()
    const record = await store.get("read")
    expect(Object.keys(record!.inputStamps)).toEqual([])
    expect(Object.keys(record!.inputPrefixStamps)).toEqual([prefix.id])
  })
})

describe("file stamp modes", () => {
  /** Writes the same bytes again and moves the modified time one minute ahead. */
  async function rewriteSameBytes(filePath: string): Promise<void> {
    const bytes = await readFile(filePath)
    await writeFile(filePath, bytes)
    const later = new Date(Date.now() + 60_000)
    await utimes(filePath, later, later)
  }

  async function runCopy(
    root: string,
    store: JsonStore,
    mode: FileStampMode,
  ): Promise<Result> {
    const src = file(path.join(root, "src.txt"), { stamp: mode })
    const out = file(path.join(root, "out.txt"), { stamp: mode })
    const build = new Build({ store })
    build.add(
      new Task({
        id: "copy",
        inputs: [src],
        outputs: [out],
        run: async () => {
          await writeFile(out.path, await src.read())
        },
      }),
    )
    return build.run()
  }

  test('stamp "time": the same bytes with a new modified time make the task run', async () => {
    const root = await tempDir()
    await writeFile(path.join(root, "src.txt"), "hello")
    const store = new JsonStore(path.join(root, "state.json"))

    await runCopy(root, store, "time")
    const second = await runCopy(root, store, "time")
    expect(second.skipped.length).toBe(1)
    await rewriteSameBytes(path.join(root, "src.txt"))
    const third = await runCopy(root, store, "time")
    expect(third.executed.length).toBe(1)
  })

  test('stamp "hash": the same bytes with a new modified time let the task skip', async () => {
    const root = await tempDir()
    await writeFile(path.join(root, "src.txt"), "hello")
    const store = new JsonStore(path.join(root, "state.json"))

    await runCopy(root, store, "hash")
    await rewriteSameBytes(path.join(root, "src.txt"))
    const second = await runCopy(root, store, "hash")
    expect(second.skipped.length).toBe(1)
  })

  test('stamp "hash" on a PathPrefix: the same bytes let the task skip', async () => {
    const root = await tempDir()
    const pagesDir = path.join(root, "pages")
    await mkdir(pagesDir)
    await writeFile(path.join(pagesDir, "a.md"), "A")
    const store = new JsonStore(path.join(root, "state.json"))

    const runOnce = async (mode: FileStampMode) => {
      const build = new Build({ store })
      build.add(
        new Task({
          id: "count",
          inputs: [pathPrefix(pagesDir, { stamp: mode })],
          outputs: [file(path.join(root, "count.txt"), { stamp: mode })],
          run: async () => {
            const names = await readdir(pagesDir)
            await writeFile(path.join(root, "count.txt"), String(names.length))
          },
        }),
      )
      return build.run()
    }

    await runOnce("hash")
    await rewriteSameBytes(path.join(pagesDir, "a.md"))
    const hashed = await runOnce("hash")
    expect(hashed.skipped.length).toBe(1)

    await runOnce("time")
    await rewriteSameBytes(path.join(pagesDir, "a.md"))
    const timed = await runOnce("time")
    expect(timed.executed.length).toBe(1)
  })

  test("an unknown stamp mode throws", () => {
    const bad = { stamp: "md5" } as unknown as { stamp: FileStampMode }
    expect(() => file("x.txt", bad)).toThrow('stamp must be "time" or "hash", not "md5"')
  })
})
