import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Build, IdPrefix, Task } from "../../src/index"
import type { Result } from "../../src/index"
import { FileArtifact, FilesystemPrefix } from "../../contrib/fs"
import type { FileStampMode, FileStampOptions } from "../../contrib/fs"
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
      inputs: [new FilesystemPrefix(pagesDir)],
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
  test("a FilesystemPrefix input sees pages that are added, edited, and deleted", async () => {
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

  test("a FilesystemPrefix output runs again when files under it are deleted by hand", async () => {
    const root = await tempDir()
    const docPath = path.join(root, "doc.txt")
    const outDir = path.join(root, "out")
    await writeFile(docPath, "p1\np2")
    const store = new JsonStore(path.join(root, "state.json"))
    let runs = 0

    const runOnce = async () => {
      const doc = new FileArtifact(docPath)
      const build = new Build({ store })
      build.add(
        new Task({
          id: "split",
          inputs: [doc],
          outputs: [new FilesystemPrefix(outDir)],
          run: async (ctx) => {
            runs += 1
            const text = new TextDecoder().decode(await doc.read())
            const lines = text.split("\n")
            await mkdir(outDir, { recursive: true })
            for (let i = 0; i < lines.length; i++) {
              const page = new FileArtifact(path.join(outDir, `${i + 1}.txt`))
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
          inputs: [new FileArtifact(srcPath), new IdPrefix("mem:pages/")],
          outputs: [new FileArtifact(outPath)],
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
    // The record shape of the version before prefix stamps: bare artifact ids, no prefixes.
    const index = new FileArtifact(path.join(root, "index.html"))
    const oldRecord = {
      inputStamps: {},
      outputStamps: { [index.id]: await index.stamp() },
    }
    await writeFile(statePath, JSON.stringify({ tasks: { index: oldRecord } }))

    const upgraded = await buildIndex(root, store)
    expect(ids(upgraded.executed)).toEqual(["index"])
    const next = await buildIndex(root, store)
    expect(ids(next.skipped)).toEqual(["index"])
  })

  test("a task with no inputs runs on every build, also with a prefix output", async () => {
    const root = await tempDir()
    const rawDir = path.join(root, "raw")
    const store = new JsonStore(path.join(root, "state.json"))
    let runs = 0

    const runOnce = async () => {
      const build = new Build({ store })
      build.add(
        new Task({
          id: "fetch",
          outputs: [new FilesystemPrefix(rawDir)],
          run: async () => {
            runs += 1
            await mkdir(rawDir, { recursive: true })
            await writeFile(path.join(rawDir, "data.json"), "{}")
          },
        }),
      )
      return build.run()
    }

    await runOnce()
    const second = await runOnce()
    expect(second.executed.length).toBe(1)
    expect(runs).toBe(2)
  })
})

describe("prefix layouts that overlap", () => {
  test('stamp "time": a task that reads pages/ and writes pages/index.html runs on every build', async () => {
    const root = await tempDir()
    const pagesDir = path.join(root, "pages")
    const indexPath = path.join(pagesDir, "index.html")
    await mkdir(pagesDir)
    await writeFile(path.join(pagesDir, "a.md"), "A")
    const store = new JsonStore(path.join(root, "state.json"))
    let runs = 0

    const runOnce = async () => {
      const build = new Build({ store })
      build.add(
        new Task({
          id: "index",
          inputs: [new FilesystemPrefix(pagesDir, { stamp: "time" })],
          outputs: [new FileArtifact(indexPath, { stamp: "time" })],
          run: async () => {
            runs += 1
            const names = await readdir(pagesDir)
            names.sort()
            // One more "#" on each run, so the size changes even inside one clock tick.
            const marks = "#".repeat(runs)
            await writeFile(indexPath, `${names.join(",")} ${marks}`)
          },
        }),
      )
      return build.run()
    }

    const first = await runOnce()
    expect(first.success).toBe(true)
    expect(ids(first.executed)).toEqual(["index"])
    expect(runs).toBe(1)
    expect(await readFile(indexPath, "utf8")).toBe("a.md #")

    // No edits. The last run wrote index.html into pages/, so the input stamp changed.
    const second = await runOnce()
    expect(ids(second.executed)).toEqual(["index"])
    expect(runs).toBe(2)
    expect(await readFile(indexPath, "utf8")).toBe("a.md,index.html ##")
    const third = await runOnce()
    expect(ids(third.executed)).toEqual(["index"])
    expect(runs).toBe(3)
  })

  test('stamp "time": a new FilesystemPrefix() input whose list() includes the output of its own task also runs on every build', async () => {
    const root = await tempDir()
    const pagesDir = path.join(root, "pages")
    const indexPath = path.join(pagesDir, "index.html")
    await mkdir(pagesDir)
    await writeFile(path.join(pagesDir, "a.md"), "A")
    const store = new JsonStore(path.join(root, "state.json"))
    let runs = 0

    const runOnce = async () => {
      const pages = new FilesystemPrefix(pagesDir, { stamp: "time" })
      const build = new Build({ store })
      build.add(
        new Task({
          id: "index",
          inputs: [pages],
          outputs: [new FileArtifact(indexPath, { stamp: "time" })],
          run: async () => {
            runs += 1
            const files = await pages.list()
            // One more "#" on each run, so the size changes even inside one clock tick.
            const marks = "#".repeat(runs)
            await writeFile(indexPath, `${files.length} ${marks}`)
          },
        }),
      )
      return build.run()
    }

    await runOnce()
    const second = await runOnce()
    expect(ids(second.executed)).toEqual(["index"])
    const third = await runOnce()
    expect(ids(third.executed)).toEqual(["index"])
  })

  test('stamp "time": two tasks that write into out/ and a reader of out/ run on every build', async () => {
    const root = await tempDir()
    const outDir = path.join(root, "out")
    const pagePath = path.join(outDir, "page.html")
    const indexPath = path.join(outDir, "index.html")
    const listPath = path.join(root, "list.txt")
    await writeFile(path.join(root, "book.txt"), "one")
    const store = new JsonStore(path.join(root, ".dapat", "state.json"))
    let runs: string[] = []
    let buildCount = 0

    const runOnce = async () => {
      runs = []
      buildCount += 1
      // One more "#" in each build, so each write changes the size even inside one clock tick.
      const marks = "#".repeat(buildCount)
      const build = new Build({ store })
      // split owns the whole folder. index writes one file in it, and reads the page that split wrote.
      build.add(
        new Task({
          id: "split",
          inputs: [new FileArtifact(path.join(root, "book.txt"), { stamp: "time" })],
          outputs: [new FilesystemPrefix(outDir, { stamp: "time" })],
          run: async () => {
            runs.push("split")
            await mkdir(outDir, { recursive: true })
            await writeFile(pagePath, `one ${marks}`)
          },
        }),
      )
      build.add(
        new Task({
          id: "index",
          inputs: [new FileArtifact(pagePath, { stamp: "time" })],
          outputs: [new FileArtifact(indexPath, { stamp: "time" })],
          run: async () => {
            runs.push("index")
            await writeFile(indexPath, `page.html ${marks}`)
          },
        }),
      )
      build.add(
        new Task({
          id: "list",
          inputs: [new FilesystemPrefix(outDir, { stamp: "time" })],
          outputs: [new FileArtifact(listPath, { stamp: "time" })],
          run: async () => {
            runs.push("list")
            const names = await readdir(outDir)
            names.sort()
            await writeFile(listPath, names.join(","))
          },
        }),
      )
      return build.run()
    }

    const first = await runOnce()
    expect(first.success).toBe(true)
    // index waits for split, and list waits for both.
    expect(runs).toEqual(["split", "index", "list"])
    expect(await readFile(listPath, "utf8")).toBe("index.html,page.html")

    // No edits. The record of split holds a stamp of out/ from before index wrote index.html.
    // So split runs, which rewrites page.html, so index runs, and so list runs.
    const second = await runOnce()
    expect(ids(second.executed).toSorted()).toEqual(["index", "list", "split"])
    expect(runs).toEqual(["split", "index", "list"])
    const third = await runOnce()
    expect(ids(third.executed).toSorted()).toEqual(["index", "list", "split"])
  })

  test("a folder input waits for a folder output in a subfolder", async () => {
    const root = await tempDir()
    const outDir = path.join(root, "out")
    const subDir = path.join(outDir, "sub")
    const listPath = path.join(root, "list.txt")
    const runs: string[] = []

    const build = new Build()
    build.add(
      new Task({
        id: "top",
        outputs: [new FilesystemPrefix(outDir)],
        run: async () => {
          runs.push("top")
          await mkdir(outDir, { recursive: true })
          await writeFile(path.join(outDir, "top.txt"), "top")
        },
      }),
    )
    build.add(
      new Task({
        id: "sub",
        outputs: [new FilesystemPrefix(subDir)],
        run: async () => {
          // sub ends after top, so a reader that waits only for top misses sub/a.txt.
          await Bun.sleep(20)
          runs.push("sub")
          await mkdir(subDir, { recursive: true })
          await writeFile(path.join(subDir, "a.txt"), "a")
        },
      }),
    )
    const out = new FilesystemPrefix(outDir)
    build.add(
      new Task({
        id: "list",
        inputs: [out],
        outputs: [new FileArtifact(listPath)],
        run: async () => {
          runs.push("list")
          const names: string[] = []
          for (const filePath of await out.list()) {
            names.push(path.relative(outDir, filePath))
          }
          names.sort()
          await writeFile(listPath, names.join(","))
        },
      }),
    )

    const result = await build.run()
    expect(result.success).toBe(true)
    expect(runs).toEqual(["top", "sub", "list"])
    expect(await readFile(listPath, "utf8")).toBe(`sub${path.sep}a.txt,top.txt`)
  })

  test("the split and index example settles when each writer has its own folder", async () => {
    const root = await tempDir()
    const bookPath = path.join(root, "book.txt")
    const pagesDir = path.join(root, "out", "pages")
    const indexPath = path.join(root, "out", "index.html")
    await writeFile(bookPath, "one\n---\ntwo")
    const store = new JsonStore(path.join(root, ".dapat", "state.json"))

    const runOnce = async () => {
      const book = new FileArtifact(bookPath)
      const build = new Build({ store })
      build.add(
        new Task({
          id: "split",
          inputs: [book],
          outputs: [new FilesystemPrefix(pagesDir)],
          run: async (ctx) => {
            const text = new TextDecoder().decode(await book.read())
            const parts = text.split("\n---\n")
            await mkdir(pagesDir, { recursive: true })
            for (let i = 0; i < parts.length; i++) {
              const page = new FileArtifact(path.join(pagesDir, `${i + 1}.md`))
              await writeFile(page.path, parts[i]!)
              ctx.produced(page)
            }
          },
        }),
      )
      build.add(
        new Task({
          id: "index",
          inputs: [new FilesystemPrefix(pagesDir)],
          outputs: [new FileArtifact(indexPath)],
          run: async () => {
            const names = await readdir(pagesDir)
            names.sort()
            await writeFile(indexPath, names.join(","))
          },
        }),
      )
      return build.run()
    }

    const first = await runOnce()
    expect(ids(first.executed).toSorted()).toEqual(["index", "split"])
    expect(await readFile(indexPath, "utf8")).toBe("1.md,2.md")
    const second = await runOnce()
    expect(ids(second.skipped).toSorted()).toEqual(["index", "split"])
    const third = await runOnce()
    expect(ids(third.skipped).toSorted()).toEqual(["index", "split"])

    await writeFile(bookPath, "one\n---\ntwo\n---\nthree")
    const changed = await runOnce()
    expect(ids(changed.executed).toSorted()).toEqual(["index", "split"])
    expect(await readFile(indexPath, "utf8")).toBe("1.md,2.md,3.md")
  })
})

describe("folder walks", () => {
  test("a missing folder has a stamp and lists no files; a file where a folder must be fails the task", async () => {
    const root = await tempDir()
    const pagesPath = path.join(root, "pages")
    const missing = await new FilesystemPrefix(pagesPath).stamp()
    expect(missing).not.toBeNull()
    expect(await new FilesystemPrefix(pagesPath).list()).toEqual([])
    await mkdir(pagesPath)
    expect(await new FilesystemPrefix(pagesPath).stamp()).toBe(missing)
    await rm(pagesPath, { recursive: true })

    await writeFile(pagesPath, "a file, not a folder")
    const store = new JsonStore(path.join(root, "state.json"))
    const build = new Build({ store })
    build.add(
      new Task({
        id: "index",
        inputs: [new FilesystemPrefix(pagesPath)],
        outputs: [new FileArtifact(path.join(root, "index.html"))],
        run: async () => {},
      }),
    )
    const result = await build.run()
    expect(result.success).toBe(false)
    const error = [...result.failed.values()][0]!
    expect(error.message).toContain("ENOTDIR")
  })

  test("a FileArtifact whose path is a folder throws from stamp", async () => {
    const root = await tempDir()
    expect(new FileArtifact(root).stamp()).rejects.toThrow(`not a file: ${root}`)
    expect(new FileArtifact(root, { stamp: "hash" }).stamp()).rejects.toThrow(`not a file: ${root}`)
    expect(await new FileArtifact(path.join(root, "none.txt")).stamp()).toBeNull()
  })

  test("symlinks under a prefix: a file link counts as its target, a folder link is walked, a loop stops", async () => {
    const root = await tempDir()
    const pagesDir = path.join(root, "pages")
    const outside = path.join(root, "outside")
    await mkdir(pagesDir)
    await mkdir(outside)
    await writeFile(path.join(root, "external.md"), "v1")
    await writeFile(path.join(outside, "x.md"), "x")
    await symlink(path.join(root, "external.md"), path.join(pagesDir, "link.md"))
    await symlink(outside, path.join(pagesDir, "linked"))
    await symlink(pagesDir, path.join(pagesDir, "loop"))
    await symlink(path.join(root, "nothing"), path.join(pagesDir, "broken.md"))

    const listing = await new FilesystemPrefix(pagesDir).list()
    const names: string[] = []
    for (const filePath of listing) {
      names.push(path.relative(pagesDir, filePath))
    }
    names.sort()
    expect(names).toEqual(["link.md", "linked/x.md"])

    const store = new JsonStore(path.join(root, "state.json"))
    const runOnce = async () => {
      const build = new Build({ store })
      build.add(
        new Task({
          id: "count",
          inputs: [new FilesystemPrefix(pagesDir)],
          outputs: [new FileArtifact(path.join(root, "count.txt"))],
          run: async () => {
            const files = await new FilesystemPrefix(pagesDir).list()
            await writeFile(path.join(root, "count.txt"), String(files.length))
          },
        }),
      )
      return build.run()
    }
    await runOnce()
    const same = await runOnce()
    expect(ids(same.skipped)).toEqual(["count"])

    await writeFile(path.join(root, "external.md"), "v2, longer")
    const editedTarget = await runOnce()
    expect(ids(editedTarget.executed)).toEqual(["count"])

    await writeFile(path.join(outside, "y.md"), "y")
    const addedInLinkedFolder = await runOnce()
    expect(ids(addedInLinkedFolder.executed)).toEqual(["count"])
    expect(await readFile(path.join(root, "count.txt"), "utf8")).toBe("3")
  })

  test("links that cannot resolve are skipped like broken links; the root still throws", async () => {
    const root = await tempDir()
    const pagesDir = path.join(root, "pages")
    await mkdir(pagesDir)
    await writeFile(path.join(pagesDir, "a.md"), "A")
    await writeFile(path.join(root, "plain.txt"), "p")
    await symlink(path.join(pagesDir, "self"), path.join(pagesDir, "self"))
    await symlink(path.join(pagesDir, "pong"), path.join(pagesDir, "ping"))
    await symlink(path.join(pagesDir, "ping"), path.join(pagesDir, "pong"))
    await symlink(path.join(root, "plain.txt", "inside"), path.join(pagesDir, "through-file"))

    const listing = await new FilesystemPrefix(pagesDir).list()
    expect(listing).toEqual([path.join(pagesDir, "a.md")])
    expect(await new FilesystemPrefix(pagesDir).stamp()).not.toBeNull()

    // The prefix root itself is a link loop. That is an error, not a missing folder.
    const loopRoot = path.join(root, "loop-root")
    await symlink(loopRoot, loopRoot)
    expect(new FilesystemPrefix(loopRoot).stamp()).rejects.toThrow("ELOOP")
  })

  test('stamp "hash" streams a large file and gets the same hash as the bytes', async () => {
    const root = await tempDir()
    const bigPath = path.join(root, "big.bin")
    const bytes = new Uint8Array(3 * 1024 * 1024 + 17)
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = i % 251
    }
    await writeFile(bigPath, bytes)
    const hasher = new Bun.CryptoHasher("sha256")
    hasher.update(bytes)
    expect(await new FileArtifact(bigPath, { stamp: "hash" }).stamp()).toBe(hasher.digest("hex"))
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
    const src = new FileArtifact(path.join(root, "src.txt"), { stamp: mode })
    const out = new FileArtifact(path.join(root, "out.txt"), { stamp: mode })
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

  test('stamp "hash" on a FilesystemPrefix: the same bytes let the task skip', async () => {
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
          inputs: [new FilesystemPrefix(pagesDir, { stamp: mode })],
          outputs: [new FileArtifact(path.join(root, "count.txt"), { stamp: mode })],
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

  /**
   * Runs one build of two tasks. "chunk" writes the first line of book.txt to page.txt.
   * "draw" reads page.txt and counts its runs, as a paid image task does.
   * With no mode, each file uses the default stamp.
   */
  async function runChunkAndDraw(
    root: string,
    store: JsonStore,
    mode: FileStampMode | undefined,
    drawRuns: string[],
  ): Promise<Result> {
    let opts: FileStampOptions | undefined = undefined
    if (mode !== undefined) {
      opts = { stamp: mode }
    }
    const book = new FileArtifact(path.join(root, "book.txt"), opts)
    const page = new FileArtifact(path.join(root, "page.txt"), opts)
    const image = new FileArtifact(path.join(root, "image.txt"), opts)
    const build = new Build({ store })
    build.add(
      new Task({
        id: "chunk",
        inputs: [book],
        outputs: [page],
        run: async () => {
          const text = new TextDecoder().decode(await book.read())
          const firstLine = text.split("\n")[0]!
          await writeFile(page.path, firstLine)
        },
      }),
    )
    build.add(
      new Task({
        id: "draw",
        inputs: [page],
        outputs: [image],
        run: async () => {
          const pageText = new TextDecoder().decode(await page.read())
          drawRuns.push(pageText)
          await writeFile(image.path, `image of ${pageText}`)
        },
      }),
    )
    return build.run()
  }

  /** Edits book.txt so that chunk runs again and writes the same page.txt. */
  async function editBookButNotPage(root: string): Promise<void> {
    await writeFile(path.join(root, "book.txt"), "page one\nnotes v2")
    // An old modified time on page.txt makes sure that the rewrite gives it a new one.
    const earlier = new Date(Date.now() - 60_000)
    await utimes(path.join(root, "page.txt"), earlier, earlier)
  }

  test("default stamp: a task rewrites its output with the same bytes, and the task that reads it skips", async () => {
    const root = await tempDir()
    await writeFile(path.join(root, "book.txt"), "page one\nnotes v1")
    const store = new JsonStore(path.join(root, "state.json"))
    const drawRuns: string[] = []

    const first = await runChunkAndDraw(root, store, undefined, drawRuns)
    expect(ids(first.executed).toSorted()).toEqual(["chunk", "draw"])
    expect(drawRuns).toEqual(["page one"])

    await editBookButNotPage(root)
    const second = await runChunkAndDraw(root, store, undefined, drawRuns)
    expect(second.success).toBe(true)
    expect(ids(second.executed)).toEqual(["chunk"])
    expect(ids(second.skipped)).toEqual(["draw"])
    expect(drawRuns).toEqual(["page one"])
  })

  test('stamp "time": a task rewrites its output with the same bytes, and the task that reads it runs', async () => {
    const root = await tempDir()
    await writeFile(path.join(root, "book.txt"), "page one\nnotes v1")
    const store = new JsonStore(path.join(root, "state.json"))
    const drawRuns: string[] = []

    await runChunkAndDraw(root, store, "time", drawRuns)
    expect(drawRuns).toEqual(["page one"])

    await editBookButNotPage(root)
    const second = await runChunkAndDraw(root, store, "time", drawRuns)
    expect(second.success).toBe(true)
    expect(ids(second.executed).toSorted()).toEqual(["chunk", "draw"])
    expect(drawRuns).toEqual(["page one", "page one"])
  })

  test("default stamp: a task that reads pages/ and writes the same pages/index.html skips from build 3", async () => {
    const root = await tempDir()
    const pagesDir = path.join(root, "pages")
    const indexPath = path.join(pagesDir, "index.html")
    await mkdir(pagesDir)
    await writeFile(path.join(pagesDir, "a.md"), "A")
    const store = new JsonStore(path.join(root, "state.json"))

    const runOnce = async () => {
      const build = new Build({ store })
      build.add(
        new Task({
          id: "index",
          inputs: [new FilesystemPrefix(pagesDir)],
          outputs: [new FileArtifact(indexPath)],
          run: async () => {
            await writeFile(indexPath, "index of pages")
          },
        }),
      )
      return build.run()
    }

    const first = await runOnce()
    expect(ids(first.executed)).toEqual(["index"])
    // Build 1 recorded pages/ before index.html was in it.
    const second = await runOnce()
    expect(ids(second.executed)).toEqual(["index"])
    const third = await runOnce()
    expect(ids(third.skipped)).toEqual(["index"])
  })

  test("an unknown stamp mode throws", () => {
    const bad = { stamp: "md5" } as unknown as { stamp: FileStampMode }
    expect(() => new FileArtifact("x.txt", bad)).toThrow('stamp must be "time" or "hash", not "md5"')
  })
})
