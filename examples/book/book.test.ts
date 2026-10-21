// Runs the real book pipeline on real files in a temp folder, and counts the image calls.
// Each image call is a substitute for a paid model call, so the counts are the cost of each edit.
import { afterAll, describe, expect, test } from "bun:test"
import * as fsPromises from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Build } from "dapat"
import { FilesystemPrefix, JsonStore } from "dapat/contrib"
import * as fakeImage from "./fake-image"
import * as pipeline from "./pipeline"

const temps: string[] = []

// afterAll, not afterEach: the tests can run at the same time, and each one has its own folder.
afterAll(async () => {
  for (const dir of temps.splice(0)) {
    await fsPromises.rm(dir, { recursive: true, force: true })
  }
})

/** A book folder in a new temp folder, with a copy of the sample books. */
class BookFolder {
  constructor(readonly root: string) {}

  static async withSample(): Promise<BookFolder> {
    const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "dapat-book-"))
    temps.push(root)
    await fsPromises.cp(path.join(import.meta.dir, "books"), path.join(root, "books"), { recursive: true })
    return new BookFolder(root)
  }

  file(relativePath: string): string {
    return path.join(this.root, relativePath)
  }

  async read(relativePath: string): Promise<string> {
    return Bun.file(this.file(relativePath)).text()
  }

  async write(relativePath: string, text: string): Promise<void> {
    await Bun.write(this.file(relativePath), text)
  }

  async exists(relativePath: string): Promise<boolean> {
    return Bun.file(this.file(relativePath)).exists()
  }

  async sentencesOf(book: string): Promise<string[]> {
    const text = await this.read(`books/${book}/text.txt`)
    return pipeline.splitIntoPages(text)
  }

  async figureCount(book: string): Promise<number> {
    const html = await this.read(`out/${book}/book.html`)
    return html.split("<figure>").length - 1
  }

  async buildOnce(): Promise<BuildReport> {
    const drawnSentences: string[] = []
    async function recordingDrawImage(request: pipeline.ImageRequest): Promise<Uint8Array> {
      const promptLines = request.prompt.split("\n")
      drawnSentences.push(promptLines[promptLines.length - 1]!)
      return fakeImage.drawImage(request)
    }
    const build = new Build({ store: new JsonStore(this.file(".dapat/state.json")) })
    pipeline.addBookTasks(build, this.root, recordingDrawImage)
    const result = await build.run()
    const failures: string[] = []
    for (const [task, error] of result.failed) {
      failures.push(`${task.id}: ${error.message}`)
    }
    for (const error of result.errors) {
      failures.push(error.message)
    }
    expect(failures).toEqual([])
    expect(result.success).toBe(true)
    const executedIds: string[] = []
    for (const task of result.executed) {
      executedIds.push(task.id)
    }
    executedIds.sort()
    return { executedIds, drawnSentences }
  }
}

interface BuildReport {
  readonly executedIds: string[]
  /** The sentence of each image call, in call order. */
  readonly drawnSentences: string[]
}

describe("children's book pipeline", () => {
  test("the first build draws one image for each sentence, and the second build draws none", async () => {
    const folder = await BookFolder.withSample()
    const hamlet = await folder.sentencesOf("hamlet")
    const owl = await folder.sentencesOf("owl")
    expect(hamlet.length).toBe(9)
    expect(owl.length).toBe(4)

    const first = await folder.buildOnce()
    expect(first.drawnSentences.length).toBe(13)
    expect(new Set(first.drawnSentences)).toEqual(new Set([...hamlet, ...owl]))
    expect(await folder.figureCount("hamlet")).toBe(9)
    expect(await folder.figureCount("owl")).toBe(4)
    const firstImage = await folder.read("out/hamlet/images/000.svg")
    expect(firstImage).toContain(hamlet[0]!)

    const second = await folder.buildOnce()
    expect(second.executedIds).toEqual([])
    expect(second.drawnSentences).toEqual([])
  })

  test("a sentence added at the end draws one image", async () => {
    const folder = await BookFolder.withSample()
    await folder.buildOnce()
    const imageBefore = await folder.read("out/hamlet/images/008.svg")

    await fsPromises.appendFile(folder.file("books/hamlet/text.txt"), "Then the sun came up.\n")
    const report = await folder.buildOnce()

    // chunk writes all 10 pages again, but 9 of them have the same bytes, so their hash stamps match.
    expect(report.drawnSentences).toEqual(["Then the sun came up."])
    expect(report.executedIds).toEqual(["assemble:hamlet", "chunk:hamlet", "image:hamlet/009"])
    expect(await folder.read("out/hamlet/images/008.svg")).toBe(imageBefore)
    expect(await folder.figureCount("hamlet")).toBe(10)
  })

  test("a touch of every file draws no image", async () => {
    const folder = await BookFolder.withSample()
    await folder.buildOnce()

    const later = new Date(Date.now() + 60_000)
    const files = await new FilesystemPrefix(folder.file("books/")).list()
    const outputFiles = await new FilesystemPrefix(folder.file("out/")).list()
    for (const file of outputFiles) {
      files.push(file)
    }
    for (const file of files) {
      await fsPromises.utimes(file, later, later)
    }
    const report = await folder.buildOnce()

    expect(report.executedIds).toEqual([])
    expect(report.drawnSentences).toEqual([])
  })

  test("new line wraps in the text draw no image", async () => {
    const folder = await BookFolder.withSample()
    await folder.buildOnce()

    const text = await folder.read("books/hamlet/text.txt")
    await folder.write("books/hamlet/text.txt", text.replaceAll(" in ", "\n  in "))
    const report = await folder.buildOnce()

    expect(report.executedIds).toEqual(["chunk:hamlet"])
    expect(report.drawnSentences).toEqual([])
  })

  test("a new style draws every image of that book and no image of the other book", async () => {
    const folder = await BookFolder.withSample()
    await folder.buildOnce()

    await folder.write("books/hamlet/style.txt", "thick oil paint, red and black\n")
    const report = await folder.buildOnce()

    expect(report.drawnSentences).toEqual(await folder.sentencesOf("hamlet"))
    expect(report.executedIds).not.toContain("chunk:hamlet")
    const owlIds: string[] = []
    for (const id of report.executedIds) {
      if (id.includes("owl")) {
        owlIds.push(id)
      }
    }
    expect(owlIds).toEqual([])
  })

  test("an edit in the middle draws that image and each image after it", async () => {
    const folder = await BookFolder.withSample()
    await folder.buildOnce()
    const hamlet = await folder.sentencesOf("hamlet")

    const text = await folder.read("books/hamlet/text.txt")
    await folder.write("books/hamlet/text.txt", text.replace(hamlet[3]!, "The prince did not believe it."))
    const report = await folder.buildOnce()

    // Each image reads the image before it, so a new image 003 makes 004 to 008 stale too.
    const expected = ["The prince did not believe it.", ...hamlet.slice(4)]
    expect(report.drawnSentences).toEqual(expected)
  })

  test("a removed last sentence draws no image and drops its page; putting it back draws it again", async () => {
    const folder = await BookFolder.withSample()
    await folder.buildOnce()
    const hamlet = await folder.sentencesOf("hamlet")
    const fullText = await folder.read("books/hamlet/text.txt")

    await folder.write("books/hamlet/text.txt", fullText.replace(` ${hamlet[8]!}`, ""))
    const removed = await folder.buildOnce()

    expect(removed.drawnSentences).toEqual([])
    expect(removed.executedIds).toEqual(["assemble:hamlet", "chunk:hamlet"])
    expect(await folder.exists("out/hamlet/pages/008.txt")).toBe(false)
    expect(await folder.figureCount("hamlet")).toBe(8)
    const next = await folder.buildOnce()
    expect(next.executedIds).toEqual([])

    // The image task of page 008 left the build, and its store record went with it.
    await folder.write("books/hamlet/text.txt", fullText)
    const restored = await folder.buildOnce()
    expect(restored.drawnSentences).toEqual([hamlet[8]!])
  })

  test("files in the pages folder that are not pages stay there and do not get into the book", async () => {
    const folder = await BookFolder.withSample()
    await folder.buildOnce()

    await folder.write("out/hamlet/pages/.DS_Store", "finder data")
    await folder.write("out/hamlet/pages/notes.txt", "my notes")
    await folder.write("out/hamlet/pages/backup/003.txt", "an old page")
    const report = await folder.buildOnce()

    expect(report.drawnSentences).toEqual([])
    expect(await folder.exists("out/hamlet/pages/.DS_Store")).toBe(true)
    expect(await folder.exists("out/hamlet/pages/notes.txt")).toBe(true)
    expect(await folder.exists("out/hamlet/pages/backup/003.txt")).toBe(true)
    expect(await folder.figureCount("hamlet")).toBe(9)
  })

  test("a book with no style gets no images and no book file", async () => {
    const folder = await BookFolder.withSample()
    await fsPromises.rm(folder.file("books/owl/style.txt"))

    const report = await folder.buildOnce()

    expect(report.executedIds).toContain("chunk:owl")
    expect(report.executedIds).not.toContain("assemble:owl")
    expect(await folder.exists("out/owl/book.html")).toBe(false)
    expect(await folder.figureCount("hamlet")).toBe(9)
  })

  test("a text with more than 1000 sentences fails its chunk task and its book", async () => {
    const folder = await BookFolder.withSample()
    const sentences: string[] = []
    for (let n = 0; n <= pipeline.MAX_PAGES; n++) {
      sentences.push(`Line ${n}.`)
    }
    await folder.write("books/long/text.txt", sentences.join(" "))
    await folder.write("books/long/style.txt", "pencil")

    const build = new Build({ store: new JsonStore(folder.file(".dapat/state.json")) })
    pipeline.addBookTasks(build, folder.root, fakeImage.drawImage)
    const result = await build.run()

    const messagesById = new Map<string, string>()
    for (const [task, error] of result.failed) {
      messagesById.set(task.id, error.message)
    }
    expect(messagesById.get("chunk:long")).toContain("has 1001 sentences; the limit is 1000")
    expect(messagesById.get("assemble:long")).toBe("dependency of 'assemble:long' failed")
    expect(messagesById.size).toBe(2)
  })
})
