import { afterEach, describe, expect, test } from "bun:test"
import * as fsPromises from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Build, Task, type Result, type TaskState } from "../../src/index"
import { FileArtifact, FileMatcher, FilesystemPrefix } from "../../contrib/fs"
import { JsonStore } from "../../contrib/store"

const temps: string[] = []

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await fsPromises.rm(dir, { recursive: true, force: true })
  }
})

async function tempDir(): Promise<string> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "dapat-orphans-"))
  temps.push(dir)
  return dir
}

async function writeText(filePath: string, text: string): Promise<void> {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true })
  await fsPromises.writeFile(filePath, text)
}

function taskIds(tasks: readonly Task[]): string[] {
  const ids: string[] = []
  for (const task of tasks) {
    ids.push(task.id)
  }
  ids.sort()
  return ids
}

describe("orphans across runs", () => {
  test("a deleted template makes an orphan, dapat deletes nothing, and store.delete forgets it", async () => {
    const root = await tempDir()
    await writeText(path.join(root, "content", "en", "hello.md"), "Hello")
    await writeText(path.join(root, "content", "fr", "hello.md"), "Bonjour")
    await writeText(path.join(root, "templates", "en.html"), "<main>{{body}}</main>")
    await writeText(path.join(root, "templates", "fr.html"), "<main lang=fr>{{body}}</main>")
    const statePath = path.join(root, "state.json")
    const frenchOutputPath = path.join(root, "site", "fr", "hello.html")
    const frenchOutputId = new FileArtifact(frenchOutputPath).id

    // Each run uses a new Build and a new JsonStore object on the same file, as a new process does.
    async function buildOnce(): Promise<Result> {
      const build = new Build({ store: new JsonStore(statePath) })
      build.each({
        matchersByName: {
          page: new FileMatcher(path.join(root, "content/<lang>/<slug>.md")),
          template: new FileMatcher(path.join(root, "templates/<lang>.html")),
        },
        *tasks(vars, matched) {
          const page = matched.page.data
          const template = matched.template.data
          const html = new FileArtifact(path.join(root, "site", vars.lang!, `${vars.slug}.html`))
          yield new Task({
            id: `page:${vars.lang}/${vars.slug}`,
            inputs: [page, template],
            outputs: [html],
            run: async () => {
              const text = await Bun.file(page.path).text()
              const layout = await Bun.file(template.path).text()
              await Bun.write(html.path, layout.replace("{{body}}", text))
            },
          })
        },
      })
      return build.run()
    }

    const first = await buildOnce()
    expect(first.success).toBe(true)
    expect(taskIds(first.executed)).toEqual(["page:en/hello", "page:fr/hello"])
    expect(first.orphans).toEqual([])

    await fsPromises.rm(path.join(root, "templates", "fr.html"))
    const second = await buildOnce()
    expect(second.success).toBe(true)
    expect(taskIds(second.skipped)).toEqual(["page:en/hello"])
    expect(second.executed).toEqual([])
    expect(second.orphans).toEqual([{ taskId: "page:fr/hello", outputIds: [frenchOutputId], prefixIds: [] }])
    // dapat deletes nothing: the output and the record stay.
    expect(await Bun.file(frenchOutputPath).text()).toBe("<main lang=fr>Bonjour</main>")
    expect(await new JsonStore(statePath).get("page:fr/hello")).not.toBeNull()

    // A run with no change reports the same orphan again.
    const third = await buildOnce()
    expect(third.orphans).toEqual([{ taskId: "page:fr/hello", outputIds: [frenchOutputId], prefixIds: [] }])

    // The program deletes the output and then the record. The next run has no orphan.
    const cleanupStore = new JsonStore(statePath)
    for (const orphan of third.orphans) {
      for (const outputId of orphan.outputIds) {
        const filePath = outputId.slice("file:".length)
        await fsPromises.rm(filePath, { force: true })
      }
      await cleanupStore.delete(orphan.taskId)
    }
    const fourth = await buildOnce()
    expect(fourth.orphans).toEqual([])
    expect(taskIds(fourth.skipped)).toEqual(["page:en/hello"])
    expect(await Bun.file(frenchOutputPath).exists()).toBe(false)

    // The template comes back. Its task runs again, because its record is gone.
    await writeText(path.join(root, "templates", "fr.html"), "<main lang=fr>{{body}}</main>")
    const fifth = await buildOnce()
    expect(taskIds(fifth.executed)).toEqual(["page:fr/hello"])
    expect(fifth.orphans).toEqual([])
    expect(await Bun.file(frenchOutputPath).text()).toBe("<main lang=fr>Bonjour</main>")
  })

  test("a task with a folder output gives an orphan with the prefix id, and the program deletes the folder", async () => {
    const root = await tempDir()
    await writeText(path.join(root, "books", "a.txt"), "one\ntwo")
    await writeText(path.join(root, "books", "b.txt"), "three")
    const statePath = path.join(root, "state.json")

    async function buildOnce(): Promise<Result> {
      const build = new Build({ store: new JsonStore(statePath) })
      build.each({
        matchersByName: { book: new FileMatcher(path.join(root, "books/<book>.txt")) },
        *tasks(vars, matched) {
          const book = matched.book.data
          const chapters = new FilesystemPrefix(path.join(root, "chapters", vars.book!))
          const index = new FileArtifact(path.join(root, "index", `${vars.book}.txt`))
          yield new Task({
            id: `split:${vars.book}`,
            inputs: [book],
            outputs: [chapters, index],
            run: async () => {
              const lines = (await Bun.file(book.path).text()).split("\n")
              for (let number = 0; number < lines.length; number++) {
                await Bun.write(path.join(chapters.path, `${number}.txt`), lines[number]!)
              }
              await Bun.write(index.path, String(lines.length))
            },
          })
        },
      })
      return build.run()
    }

    const first = await buildOnce()
    expect(first.success).toBe(true)
    expect(first.orphans).toEqual([])

    await fsPromises.rm(path.join(root, "books", "b.txt"))
    const bookChapters = new FilesystemPrefix(path.join(root, "chapters", "b"))
    const bookIndex = new FileArtifact(path.join(root, "index", "b.txt"))
    const second = await buildOnce()
    expect(second.orphans).toEqual([{ taskId: "split:b", outputIds: [bookIndex.id], prefixIds: [bookChapters.id] }])
    // dapat deletes nothing.
    expect(await fsPromises.readdir(bookChapters.path)).toEqual(["0.txt"])

    const cleanupStore = new JsonStore(statePath)
    for (const orphan of second.orphans) {
      for (const prefixId of orphan.prefixIds) {
        await fsPromises.rm(prefixId.slice("file:".length), { recursive: true, force: true })
      }
      for (const outputId of orphan.outputIds) {
        await fsPromises.rm(outputId.slice("file:".length), { force: true })
      }
      await cleanupStore.delete(orphan.taskId)
    }
    const third = await buildOnce()
    expect(third.orphans).toEqual([])
    expect(await fsPromises.readdir(path.join(root, "chapters"))).toEqual(["a"])
  })

  test("a JsonStore with a few thousand orphans gives the result in well under a second", async () => {
    const root = await tempDir()
    const statePath = path.join(root, "state.json")
    const orphanCount = 3000
    // The file has the shape of a JsonStore file. One write is faster than 3000 calls of set.
    const tasks: Record<string, TaskState> = {}
    for (let number = 0; number < orphanCount; number++) {
      tasks[`page:${number}`] = {
        inputStamps: { [`artifact file:/src/${number}.md`]: "1:2" },
        outputStamps: { [`artifact file:/site/${number}.html`]: "3:4" },
      }
    }
    await writeText(statePath, JSON.stringify({ tasks }))

    const build = new Build({ store: new JsonStore(statePath) })
    const startTime = performance.now()
    const result = await build.run()
    const elapsed = performance.now() - startTime
    expect(result.orphans.length).toBe(orphanCount)
    expect(result.orphans[0]).toEqual({ taskId: "page:0", outputIds: ["file:/site/0.html"], prefixIds: [] })
    expect(elapsed).toBeLessThan(1000)
  })
})
