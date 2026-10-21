import { afterEach, describe, expect, test } from "bun:test"
import * as fsPromises from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Build, Task, type Result } from "../../src/index"
import { FileArtifact, FileMatcher } from "../../contrib/fs"
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
    expect(second.orphans).toEqual([{ taskId: "page:fr/hello", outputIds: [frenchOutputId] }])
    // dapat deletes nothing: the output and the record stay.
    expect(await Bun.file(frenchOutputPath).text()).toBe("<main lang=fr>Bonjour</main>")
    expect(await new JsonStore(statePath).get("page:fr/hello")).not.toBeNull()

    // A run with no change reports the same orphan again.
    const third = await buildOnce()
    expect(third.orphans).toEqual([{ taskId: "page:fr/hello", outputIds: [frenchOutputId] }])

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
})
