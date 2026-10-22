import { afterEach, expect, test } from "bun:test"
import * as fsPromises from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Build, Task } from "../../src/index"
import { FileArtifact, FileMatcher, FileTemplate, FilesystemPrefix } from "../../contrib/fs"

const temps: string[] = []
const startFolder = process.cwd()

afterEach(async () => {
  process.chdir(startFolder)
  for (const dir of temps.splice(0)) {
    await fsPromises.rm(dir, { recursive: true, force: true })
  }
})

async function enterTempDir(): Promise<void> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "dapat-gate-"))
  temps.push(dir)
  process.chdir(dir)
}

async function writeText(filePath: string, text: string): Promise<void> {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true })
  await fsPromises.writeFile(filePath, text)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test("a task that reads a template folder waits for the tasks that do not exist yet", async () => {
  await enterTempDir()
  await writeText("text.txt", "text")
  const build = new Build()
  const text = new FileArtifact("text.txt")
  const imagesFolder = new FilesystemPrefix("images/")
  // Two roots: each image needs a scene from chunk and a sketch from sketch. No image task exists before both report.
  for (const [id, folder, extension] of [["chunk", "scenes", "txt"], ["sketch", "sketches", "png"]] as const) {
    build.add(
      new Task({
        id,
        inputs: [text],
        outputs: [new FilesystemPrefix(`${folder}/`)],
        run: async (ctx) => {
          await sleep(20)
          for (const page of ["1", "2"]) {
            const file = new FileArtifact(`${folder}/${page}.${extension}`)
            await writeText(file.path, page)
            ctx.produced(file)
          }
        },
      }),
    )
  }
  build.each({
    matchersByName: { scene: new FileMatcher("scenes/<page>.txt"), sketch: new FileMatcher("sketches/<page>.png") },
    outputsByName: { image: new FileTemplate("images/<page>.png") },
    name: "image",
    run: async ({ outputs }) => {
      await writeText(outputs.image.path, "png")
    },
  })
  let imagesSeen = -1
  build.add(
    new Task({
      id: "pdf",
      inputs: [imagesFolder],
      outputs: [new FileArtifact("book.pdf")],
      run: async () => {
        imagesSeen = (await imagesFolder.list()).length
      },
    }),
  )

  const result = await build.run()

  expect(result.success).toBe(true)
  expect(imagesSeen).toBe(2)
  // The gate is not a task of the user, so the result does not show it.
  const ids = result.executed.map((task) => task.id).sort()
  expect(ids).toEqual(["chunk", "image:1", "image:2", "pdf", "sketch"])
})

test("two build.each that feed each other do not deadlock on their gates", async () => {
  await enterTempDir()
  await writeText("a/0.txt", "start")
  const build = new Build()
  const bFolder = new FilesystemPrefix("b/")
  build.each({
    matchersByName: { a: new FileMatcher("a/<n>.txt") },
    outputsByName: { b: new FileTemplate("b/<n>.txt") },
    name: "ping",
    run: async ({ outputs }) => {
      await writeText(outputs.b.path, "b")
    },
  })
  build.each({
    matchersByName: { b: new FileMatcher("b/<n>.txt") },
    outputsByName: { a: new FileTemplate("a/<n>.txt") },
    *tasks(vars, matched) {
      const next = Number(vars.n) + 1
      if (next > 2) return
      const nextFile = new FileArtifact(`a/${next}.txt`)
      yield new Task({
        id: `pong:${vars.n}`,
        inputs: [matched.b.data],
        outputs: [nextFile],
        run: async () => {
          await writeText(nextFile.path, "a")
        },
      })
    },
  })
  let bSeen = -1
  build.add(
    new Task({
      id: "summary",
      inputs: [bFolder],
      outputs: [new FileArtifact("summary.txt")],
      run: async () => {
        bSeen = (await bFolder.list()).length
      },
    }),
  )

  const result = await build.run()

  expect(result.success).toBe(true)
  expect(bSeen).toBe(3)
})
