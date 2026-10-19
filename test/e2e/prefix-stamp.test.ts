import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Build, IdPrefix, Task } from "../../src/index"
import type { Result } from "../../src/index"
import { DirectoryArtifact, FileArtifact, PathPrefix, directory, file, pathPrefix } from "../../contrib/fs"
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

  test("a prefix and an artifact with the same id keep separate stamps in the record", async () => {
    const root = await tempDir()
    const dir = path.join(root, "pages")
    await mkdir(dir)
    await writeFile(path.join(dir, "a.md"), "A")
    const store = new JsonStore(path.join(root, "state.json"))
    const prefix = new PathPrefix(dir)
    const listing = new DirectoryArtifact(dir)
    expect(prefix.id).toBe(listing.id)

    const runOnce = async () => {
      const build = new Build({ store })
      build.add(
        new Task({
          id: "read",
          inputs: [prefix, listing],
          outputs: [file(path.join(root, "out.txt"))],
          run: async () => {
            await writeFile(path.join(root, "out.txt"), "x")
          },
        }),
      )
      return build.run()
    }

    await runOnce()
    const record = await store.get("read")
    const keys = Object.keys(record!.inputStamps)
    keys.sort()
    expect(keys).toEqual([`artifact ${listing.id}`, `prefix ${prefix.id}`])
    const second = await runOnce()
    expect(second.skipped.length).toBe(1)
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
          outputs: [pathPrefix(rawDir)],
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

describe("prefix layouts that never settle are rejected", () => {
  test("a prefix input must not cover an output of the same task", () => {
    const root = "/tmp/dapat-layout"
    const build = new Build()
    const task = new Task({
      id: "index",
      inputs: [pathPrefix(path.join(root, "pages"))],
      outputs: [file(path.join(root, "pages", "index.html"))],
      run: async () => {},
    })
    expect(() => build.add(task)).toThrow(
      `task 'index': input 'file:${root}/pages/' overlaps its output ` +
        `'file:${root}/pages/index.html'; put the output outside the input`,
    )
  })

  test("a directory() input must not cover an output of the same task", () => {
    const root = "/tmp/dapat-layout"
    const build = new Build()
    const task = new Task({
      id: "index",
      inputs: [directory(path.join(root, "pages"))],
      outputs: [file(path.join(root, "pages", "index.html"))],
      run: async () => {},
    })
    expect(() => build.add(task)).toThrow(`input 'file:${root}/pages/' overlaps its output`)
  })

  test("an input inside a prefix output of the same task is rejected too", () => {
    const build = new Build()
    const task = new Task({
      id: "grow",
      inputs: [pathPrefix("/tmp/dapat-layout/pages/sub")],
      outputs: [pathPrefix("/tmp/dapat-layout/pages")],
      run: async () => {},
    })
    expect(() => build.add(task)).toThrow(
      "input 'file:/tmp/dapat-layout/pages/sub/' overlaps its output 'file:/tmp/dapat-layout/pages/'",
    )
  })

  test("a prefix input must not overlap a prefix output of the same task", () => {
    const build = new Build()
    const task = new Task({
      id: "grow",
      inputs: [new IdPrefix("mem:pages/")],
      outputs: [new IdPrefix("mem:pages/new/")],
      run: async () => {},
    })
    expect(() => build.add(task)).toThrow("overlaps its output 'mem:pages/new/'")
  })

  test("a prefix output must not cover an exact output of another task, in either order", () => {
    const split = new Task({
      id: "split",
      outputs: [pathPrefix("/tmp/dapat-layout/out")],
      run: async () => {},
    })
    const index = new Task({
      id: "index",
      outputs: [file("/tmp/dapat-layout/out/index.html")],
      run: async () => {},
    })
    const message =
      "two tasks write into one region: outputs 'file:/tmp/dapat-layout/out/index.html' of task " +
      "'index' and 'file:/tmp/dapat-layout/out/' of task 'split' overlap"

    const first = new Build()
    first.add(split)
    expect(() => first.add(index)).toThrow(message)

    const second = new Build()
    second.add(index)
    expect(() => second.add(split)).toThrow("give each writer its own folder")
  })

  test("two prefix outputs of different tasks must not overlap", () => {
    const build = new Build()
    build.add(new Task({ id: "a", outputs: [new IdPrefix("mem:out/")], run: async () => {} }))
    const same = new Task({ id: "b", outputs: [new IdPrefix("mem:out/")], run: async () => {} })
    const nested = new Task({ id: "c", outputs: [new IdPrefix("mem:out/sub/")], run: async () => {} })
    const outer = new Task({ id: "d", outputs: [new IdPrefix("mem:")], run: async () => {} })
    expect(() => build.add(same)).toThrow("of task 'b' and 'mem:out/' of task 'a' overlap")
    expect(() => build.add(nested)).toThrow("of task 'c' and 'mem:out/' of task 'a' overlap")
    expect(() => build.add(outer)).toThrow("of task 'd' and 'mem:out/' of task 'a' overlap")
  })

  test("a directory() output must not cover an output of another task, in either order", () => {
    const all = new Task({
      id: "all",
      outputs: [directory("/tmp/dapat-layout/out")],
      run: async () => {},
    })
    const one = new Task({
      id: "one",
      outputs: [file("/tmp/dapat-layout/out/z.html")],
      run: async () => {},
    })
    const first = new Build()
    first.add(all)
    expect(() => first.add(one)).toThrow("of task 'one' and 'file:/tmp/dapat-layout/out/' of task 'all'")
    const second = new Build()
    second.add(one)
    expect(() => second.add(all)).toThrow("two tasks write into one region")
    // A directory() output next to a prefix output inside it.
    const third = new Build()
    third.add(all)
    const sub = new Task({ id: "sub", outputs: [pathPrefix("/tmp/dapat-layout/out/sub")], run: async () => {} })
    expect(() => third.add(sub)).toThrow("two tasks write into one region")
  })

  test("ctx.add rejects a clashing task, and the task that called it fails", async () => {
    const build = new Build()
    build.add(
      new Task({
        id: "parent",
        outputs: [new IdPrefix("mem:out/")],
        run: async (ctx) => {
          ctx.add(new Task({ id: "child", outputs: [new IdPrefix("mem:out/child/")], run: async () => {} }))
        },
      }),
    )
    const result = await build.run()
    const error = result.failed.get([...result.failed.keys()][0]!)!
    expect(ids([...result.failed.keys()])).toEqual(["parent"])
    expect(error.message).toContain("two tasks write into one region")
  })

  test("a rejected add changes nothing, and a replacement can move its own prefix", async () => {
    const build = new Build()
    const events: string[] = []
    build.subscribe((event) => {
      events.push(event.kind)
    })
    build.add(new Task({ id: "a", outputs: [new IdPrefix("mem:out/")], run: async () => {} }))
    const clash = new Task({ id: "b", outputs: [new IdPrefix("mem:out/x/")], run: async () => {} })
    expect(() => build.add(clash)).toThrow("two tasks write into one region")
    // The same task id may change its own prefix output. Only other tasks count.
    build.add(new Task({ id: "a", outputs: [new IdPrefix("mem:out/x/")], run: async () => {} }))
    const result = await build.run()
    expect(ids(result.executed)).toEqual(["a"])
    expect(events).toEqual(["promised"])
  })

  test("the split and index example settles when each writer has its own folder", async () => {
    const root = await tempDir()
    const bookPath = path.join(root, "book.txt")
    const pagesDir = path.join(root, "out", "pages")
    const indexPath = path.join(root, "out", "index.html")
    await writeFile(bookPath, "one\n---\ntwo")
    const store = new JsonStore(path.join(root, ".dapat", "state.json"))

    const runOnce = async () => {
      const book = file(bookPath)
      const build = new Build({ store })
      build.add(
        new Task({
          id: "split",
          inputs: [book],
          outputs: [pathPrefix(pagesDir)],
          run: async (ctx) => {
            const text = new TextDecoder().decode(await book.read())
            const parts = text.split("\n---\n")
            await mkdir(pagesDir, { recursive: true })
            for (let i = 0; i < parts.length; i++) {
              const page = file(path.join(pagesDir, `${i + 1}.md`))
              await writeFile(page.path, parts[i]!)
              ctx.produced(page)
            }
          },
        }),
      )
      build.add(
        new Task({
          id: "index",
          inputs: [pathPrefix(pagesDir)],
          outputs: [file(indexPath)],
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
  test("a missing folder has a stamp; a file where a folder must be fails the task", async () => {
    const root = await tempDir()
    const pagesPath = path.join(root, "pages")
    const missing = await pathPrefix(pagesPath).stamp()
    expect(missing).not.toBeNull()
    await mkdir(pagesPath)
    expect(await pathPrefix(pagesPath).stamp()).toBe(missing)
    await rm(pagesPath, { recursive: true })

    await writeFile(pagesPath, "a file, not a folder")
    const store = new JsonStore(path.join(root, "state.json"))
    const build = new Build({ store })
    build.add(
      new Task({
        id: "index",
        inputs: [pathPrefix(pagesPath)],
        outputs: [file(path.join(root, "index.html"))],
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
    expect(file(root).stamp()).rejects.toThrow(`not a file: ${root}`)
    expect(file(root, { stamp: "hash" }).stamp()).rejects.toThrow(`not a file: ${root}`)
    expect(await file(path.join(root, "none.txt")).stamp()).toBeNull()
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

    const listing = await directory(pagesDir).read()
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
          inputs: [pathPrefix(pagesDir)],
          outputs: [file(path.join(root, "count.txt"))],
          run: async () => {
            const files = await directory(pagesDir).read()
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

    const listing = await directory(pagesDir).read()
    expect(listing).toEqual([path.join(pagesDir, "a.md")])
    expect(await pathPrefix(pagesDir).stamp()).not.toBeNull()

    // The prefix root itself is a link loop. That is an error, not a missing folder.
    const loopRoot = path.join(root, "loop-root")
    await symlink(loopRoot, loopRoot)
    expect(pathPrefix(loopRoot).stamp()).rejects.toThrow("ELOOP")
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
    expect(await file(bigPath, { stamp: "hash" }).stamp()).toBe(hasher.digest("hex"))
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
