// Makes a picture book from each books/<book>/text.txt: one page for each sentence, one image for
// each page, and out/<book>/book.html. drawImage calls the OpenRouter image API, and each call costs
// money. Each image also gets the image before it as a reference, so the look stays the same from
// page to page.
//
// Set OPENROUTER_API_KEY, and run it from an empty folder two times: the second run draws no image.
// Then add a sentence at the end of a text: the next run draws 1 image.
import * as fs from "node:fs"
import * as fsPromises from "node:fs/promises"
import path from "node:path"
import { Build, Task, type Ref } from "dapat"
import { FileArtifact, FileMatcher, FilesystemPrefix, JsonStore } from "dapat/contrib"

const IMAGE_MODEL = "google/gemini-2.5-flash-image"
const apiKey = process.env.OPENROUTER_API_KEY
if (apiKey === undefined || apiKey.length === 0) {
  throw new Error("set OPENROUTER_API_KEY to an OpenRouter API key")
}

if (!fs.existsSync("books")) {
  await fsPromises.cp(path.join(import.meta.dir, "books"), "books", { recursive: true })
}

let imageCalls = 0
async function drawImage(prompt: string, previous: Uint8Array | null): Promise<Uint8Array> {
  imageCalls += 1
  const inputReferences = []
  if (previous !== null) {
    const url = `data:image/png;base64,${Buffer.from(previous).toString("base64")}`
    inputReferences.push({ type: "image_url", image_url: { url } })
  }
  const response = await fetch("https://openrouter.ai/api/v1/images", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: IMAGE_MODEL, prompt, input_references: inputReferences }),
  })
  if (!response.ok) {
    throw new Error(`image API: ${response.status} ${await response.text()}`)
  }
  const body = (await response.json()) as { data: { b64_json: string; media_type?: string }[] }
  const image = body.data[0]!
  if (image.media_type !== "image/png") {
    throw new Error(`image API: expected image/png, got ${image.media_type}`)
  }
  return Buffer.from(image.b64_json, "base64")
}

const pageName = (index: number) => String(index).padStart(3, "0")
const build = new Build({ store: new JsonStore(".dapat/state.json") })

// chunk:<book> writes one file for each sentence. It does not know the page count before it runs,
// so it declares the folder and reports each page. Each report makes the image task of that page.
build.each({
  matchersByName: { text: new FileMatcher("books/<book>/text.txt") },
  *tasks(vars, matched) {
    const pagesFolder = new FilesystemPrefix(`out/${vars.book}/pages/`)
    yield new Task({
      id: `chunk:${vars.book}`,
      inputs: [matched.text.data],
      outputs: [pagesFolder],
      run: async (ctx) => {
        const text = await Bun.file(matched.text.data.path).text()
        const sentences = text.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.length > 0)
        const pages = new Set<string>()
        for (let index = 0; index < sentences.length; index++) {
          const page = new FileArtifact(`out/${vars.book}/pages/${pageName(index)}.txt`)
          await Bun.write(page.path, sentences[index]!.trim())
          pages.add(page.path)
          ctx.produced(page)
        }
        // A shorter text leaves old pages behind. Delete them, so their image tasks go away.
        for (const file of await pagesFolder.list()) {
          if (!pages.has(file)) {
            await fsPromises.unlink(file)
            ctx.deleted(new FileArtifact(file))
          }
        }
      },
    })
  },
})

// image:<book>/<page> joins each page to the style of its book, and reads the image before it.
build.each({
  matchersByName: {
    page: new FileMatcher("out/<book>/pages/<page>.txt"),
    style: new FileMatcher("books/<book>/style.txt"),
  },
  *tasks(vars, matched) {
    const index = Number(vars.page)
    const image = new FileArtifact(`out/${vars.book}/images/${vars.page}.png`)
    const inputs: Ref[] = [matched.page.data, matched.style.data]
    let previous: FileArtifact | null = null
    if (index > 0) {
      previous = new FileArtifact(`out/${vars.book}/images/${pageName(index - 1)}.png`)
      inputs.push(previous)
    }
    yield new Task({
      id: `image:${vars.book}/${vars.page}`,
      inputs,
      outputs: [image],
      run: async () => {
        const style = await Bun.file(matched.style.data.path).text()
        const sentence = await Bun.file(matched.page.data.path).text()
        let previousBytes: Uint8Array | null = null
        if (previous !== null) {
          previousBytes = await previous.read()
        }
        const prompt = `A picture book illustration. Style: ${style.trim()}\nScene: ${sentence}`
        await Bun.write(image.path, await drawImage(prompt, previousBytes))
      },
    })
  },
})

// assemble:<book> reads both folders, so it waits for chunk and for every image task.
build.each({
  matchersByName: { text: new FileMatcher("books/<book>/text.txt") },
  *tasks(vars) {
    const pagesFolder = new FilesystemPrefix(`out/${vars.book}/pages/`)
    const imagesFolder = new FilesystemPrefix(`out/${vars.book}/images/`)
    const book = new FileArtifact(`out/${vars.book}/book.html`)
    yield new Task({
      id: `assemble:${vars.book}`,
      inputs: [pagesFolder, imagesFolder],
      outputs: [book],
      run: async () => {
        const pageFiles = await pagesFolder.list()
        pageFiles.sort()
        const figures: string[] = []
        for (const file of pageFiles) {
          const name = path.basename(file, ".txt")
          const sentence = await Bun.file(file).text()
          figures.push(`<figure><img src="images/${name}.png"><figcaption>${sentence}</figcaption></figure>`)
        }
        await Bun.write(book.path, `<!doctype html>\n<title>${vars.book}</title>\n${figures.join("\n")}\n`)
      },
    })
  },
})

const result = await build.run()
for (const [task, error] of result.failed) {
  console.error(`${task.id}: ${error.message}`)
}
console.log(`ran ${result.executed.length} tasks, skipped ${result.skipped.length}, drew ${imageCalls} images`)
if (!result.success) {
  process.exit(1)
}
