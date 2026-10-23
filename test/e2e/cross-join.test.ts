import { afterEach, describe, expect, test } from "bun:test"
import * as fsPromises from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Build, Task } from "../../src/index"
import { FileArtifact, FileMatcher, FileTemplate } from "../../contrib/fs"
import { JsonStore } from "../../contrib/store"

const temps: string[] = []

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await fsPromises.rm(dir, { recursive: true, force: true })
  }
})

async function tempDir(): Promise<string> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "dapat-cross-join-"))
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

/** The scene step of the book example: each page joins the one plan.txt, which has no vars. */
async function buildScenes(root: string, store: JsonStore) {
  const build = new Build({ store })
  build.each({
    matchersByName: {
      page: new FileMatcher(path.join(root, "pages/<page>.txt")),
      plan: new FileMatcher(path.join(root, "plan.txt")),
    },
    outputsByName: { scene: new FileTemplate(path.join(root, "scenes/<page>.txt")) },
    *tasks(vars, matched, outputs) {
      yield new Task({
        id: `scene:${vars.page}`,
        inputs: [matched.plan.data, matched.page.data],
        outputs: [outputs.scene],
        run: async () => {
          const plan = await Bun.file(matched.plan.data.path).text()
          const page = await Bun.file(matched.page.data.path).text()
          await Bun.write(outputs.scene.path, `${plan}: ${page}`)
        },
      })
    },
  })
  return build.run()
}

describe("required matchers that share no var join as a cross product", () => {
  test("a matcher with no vars: no file gives no tasks, the file makes every task, an edit to it runs every task again", async () => {
    const root = await tempDir()
    await writeText(path.join(root, "pages", "001.txt"), "one")
    await writeText(path.join(root, "pages", "002.txt"), "two")
    const store = new JsonStore(path.join(root, "state.json"))

    const first = await buildScenes(root, store)
    expect(first.success).toBe(true)
    expect(first.outcomes.size).toBe(0)

    await writeText(path.join(root, "plan.txt"), "quest")
    const second = await buildScenes(root, store)
    expect(taskIds(second.executed)).toEqual(["scene:001", "scene:002"])
    expect(await Bun.file(path.join(root, "scenes", "002.txt")).text()).toBe("quest: two")

    const third = await buildScenes(root, store)
    expect(taskIds(third.skipped)).toEqual(["scene:001", "scene:002"])

    await writeText(path.join(root, "plan.txt"), "journey")
    const fourth = await buildScenes(root, store)
    expect(taskIds(fourth.executed)).toEqual(["scene:001", "scene:002"])
    expect(await Bun.file(path.join(root, "scenes", "001.txt")).text()).toBe("journey: one")

    await writeText(path.join(root, "pages", "001.txt"), "uno")
    const fifth = await buildScenes(root, store)
    expect(taskIds(fifth.executed)).toEqual(["scene:001"])
    expect(taskIds(fifth.skipped)).toEqual(["scene:002"])
  })

  test("a no-var file that a task writes during the run makes every set, and the sets wait for it", async () => {
    const root = await tempDir()
    await writeText(path.join(root, "pages", "001.txt"), "one")
    await writeText(path.join(root, "pages", "002.txt"), "two")
    const plan = new FileArtifact(path.join(root, "plan.txt"))
    const build = new Build()
    build.add(
      new Task({
        id: "plan",
        outputs: [plan],
        run: async () => {
          await Bun.write(plan.path, "made")
        },
      }),
    )
    build.each({
      matchersByName: {
        plan: new FileMatcher(path.join(root, "plan.txt")),
        page: new FileMatcher(path.join(root, "pages/<page>.txt")),
      },
      outputsByName: { scene: new FileTemplate(path.join(root, "scenes/<page>.txt")) },
      *tasks(vars, matched, outputs) {
        yield new Task({
          id: `scene:${vars.page}`,
          inputs: [matched.plan.data, matched.page.data],
          outputs: [outputs.scene],
          run: async () => {
            await Bun.write(outputs.scene.path, await Bun.file(matched.plan.data.path).text())
          },
        })
      },
    })
    const result = await build.run()
    expect(result.success).toBe(true)
    expect(taskIds(result.executed)).toEqual(["plan", "scene:001", "scene:002"])
    expect(await Bun.file(path.join(root, "scenes", "001.txt")).text()).toBe("made")
  })

  test("matchers with disjoint vars give each pair", async () => {
    const root = await tempDir()
    await writeText(path.join(root, "pages", "a.txt"), "")
    await writeText(path.join(root, "pages", "b.txt"), "")
    await writeText(path.join(root, "styles", "dark.css"), "")
    await writeText(path.join(root, "styles", "light.css"), "")
    const build = new Build()
    build.each({
      matchersByName: {
        page: new FileMatcher(path.join(root, "pages/<page>.txt")),
        style: new FileMatcher(path.join(root, "styles/<style>.css")),
      },
      *tasks(vars, matched) {
        yield new Task({ id: `render:${vars.page}/${vars.style}`, inputs: [matched.page.data, matched.style.data], run: async () => {} })
      },
    })
    const result = await build.run()
    expect(taskIds(result.executed)).toEqual(["render:a/dark", "render:a/light", "render:b/dark", "render:b/light"])
  })
})
