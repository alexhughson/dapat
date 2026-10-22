// Makes a picture book from each <folder>/books/<book>/text.txt: a page for each group of lines,
// one image for each page, and <folder>/out/<book>/book.html. drawImage calls the OpenRouter image
// API, and each call costs money. Each image also gets every image before it as a reference, so the
// look stays the same from page to page. Run it with no arguments to see the usage.
import * as fs from "node:fs"
import * as fsPromises from "node:fs/promises"
import path from "node:path"
import { Build, Task, type Ref } from "dapat"
import { FileArtifact, FileMatcher, FilesystemPrefix, JsonStore } from "dapat/contrib"

let scriptPath = path.relative(process.cwd(), import.meta.path)
if (scriptPath.startsWith("..")) {
  scriptPath = import.meta.path
}
const USAGE = `usage: bun ${scriptPath} <folder> [lines per page]

Makes a picture book for each <folder>/books/<book>/text.txt, with the style
in <folder>/books/<book>/style.txt. It writes <folder>/out/<book>/book.html.
When <folder>/books/ is missing, it copies two sample books into it.

  <folder>          the work folder. It can be anywhere. It is made if missing.
  [lines per page]  how many lines of text go on each page. The default is 2.

Set OPENROUTER_API_KEY first. Each image is a paid call to the OpenRouter
image API. A second run with no edits draws no image.`

function exitWithUsage(problem: string): never {
  console.error(`${problem}\n\n${USAGE}`)
  process.exit(2)
}

const [folderArgument, linesArgument, ...extraArguments] = process.argv.slice(2)
if (folderArgument === "-h" || folderArgument === "--help") {
  console.log(USAGE)
  process.exit(0)
}
if (folderArgument === undefined) {
  exitWithUsage("give the work folder")
}
if (extraArguments.length > 0) {
  exitWithUsage(`too many arguments: ${extraArguments.join(" ")}`)
}
const linesPerPage = Number(linesArgument ?? "2")
if (!Number.isInteger(linesPerPage) || linesPerPage < 1) {
  exitWithUsage(`lines per page must be a whole number of 1 or more, not '${linesArgument}'`)
}
const IMAGE_MODEL = "google/gemini-2.5-flash-image"
const apiKey = process.env.OPENROUTER_API_KEY
if (apiKey === undefined || apiKey.length === 0) {
  exitWithUsage("set OPENROUTER_API_KEY to an OpenRouter API key")
}

// Every path below is relative to the work folder.
await fsPromises.mkdir(folderArgument, { recursive: true })
process.chdir(folderArgument)
if (!fs.existsSync("books")) {
  await fsPromises.cp(path.join(import.meta.dir, "books"), "books", { recursive: true })
}

let imageCalls = 0
async function drawImage(prompt: string, earlierImages: Uint8Array[]): Promise<Uint8Array> {
  imageCalls += 1
  const inputReferences = []
  for (const earlier of earlierImages) {
    const url = `data:image/png;base64,${Buffer.from(earlier).toString("base64")}`
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

// chunk:<book> writes one file for each page. It does not know the page count before it runs,
// so it declares the folder and reports each page. Each report makes the image task of that page.
// linesPerPage is in the task id, so a new value makes a new task, and that task runs.
build.each({
  matchersByName: { text: new FileMatcher("books/<book>/text.txt") },
  *tasks(vars, matched) {
    const pagesFolder = new FilesystemPrefix(`out/${vars.book}/pages/`)
    yield new Task({
      id: `chunk:${vars.book}/lines=${linesPerPage}`,
      inputs: [matched.text.data],
      outputs: [pagesFolder],
      run: async (ctx) => {
        const text = await Bun.file(matched.text.data.path).text()
        const lines = text.split("\n").filter((line) => line.trim().length > 0)
        const pages = new Set<string>()
        for (let index = 0; index * linesPerPage < lines.length; index++) {
          const pageLines = lines.slice(index * linesPerPage, (index + 1) * linesPerPage)
          const page = new FileArtifact(`out/${vars.book}/pages/${pageName(index)}.txt`)
          await Bun.write(page.path, pageLines.join("\n"))
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

// image:<book>/<page> joins each page to the style of its book, and reads every image before it.
build.each({
  matchersByName: {
    page: new FileMatcher("out/<book>/pages/<page>.txt"),
    style: new FileMatcher("books/<book>/style.txt"),
  },
  *tasks(vars, matched) {
    const index = Number(vars.page)
    const image = new FileArtifact(`out/${vars.book}/images/${vars.page}.png`)
    const earlierImages: FileArtifact[] = []
    for (let earlier = 0; earlier < index; earlier++) {
      earlierImages.push(new FileArtifact(`out/${vars.book}/images/${pageName(earlier)}.png`))
    }
    const inputs: Ref[] = [matched.page.data, matched.style.data, ...earlierImages]
    yield new Task({
      id: `image:${vars.book}/${vars.page}`,
      inputs,
      outputs: [image],
      run: async () => {
        const style = await Bun.file(matched.style.data.path).text()
        const pageText = await Bun.file(matched.page.data.path).text()
        const earlierBytes: Uint8Array[] = []
        for (const earlier of earlierImages) {
          earlierBytes.push(await earlier.read())
        }
        const prompt = `A picture book illustration. Style: ${style.trim()}\nScene: ${pageText}`
        await Bun.write(image.path, await drawImage(prompt, earlierBytes))
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
          const pageText = await Bun.file(file).text()
          figures.push(`<figure><img src="images/${name}.png"><figcaption>${pageText}</figcaption></figure>`)
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
