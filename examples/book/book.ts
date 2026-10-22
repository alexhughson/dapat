// Makes a picture book from <book>/text.txt: a page for each group of lines, one image for each
// page, and <book>/book.html. drawImage calls the OpenRouter image API, and each call costs money.
// Each image also gets the first 5 and the last 5 images before it as references, so the look stays
// the same from page to page. Run it with no arguments to see the usage.
import * as fs from "node:fs"
import * as fsPromises from "node:fs/promises"
import path from "node:path"
import { Build, Task } from "dapat"
import { FileArtifact, FileMatcher, FileTemplate, FilesystemPrefix, JsonStore } from "dapat/contrib"

let scriptPath = path.relative(process.cwd(), import.meta.path)
if (scriptPath.startsWith("..")) {
  scriptPath = import.meta.path
}
const USAGE = `usage: bun ${scriptPath} <book folder> [lines per page]

Makes a picture book from <book folder>/text.txt, with the style in
<book folder>/style.txt. It writes pages/, images/ and book.html into the
book folder. When the book folder is missing, it copies a sample book into it.

  <book folder>     the folder of one book. It can be anywhere.
  [lines per page]  how many lines of text go on each page. The default is 2.

Set OPENROUTER_API_KEY first. Each image is a paid call to the OpenRouter
image API. A second run with no edits draws no image.`

function exitWithUsage(problem: string): never {
  console.error(`${problem}\n\n${USAGE}`)
  process.exit(2)
}

const [bookArgument, linesArgument, ...extraArguments] = process.argv.slice(2)
if (bookArgument === "-h" || bookArgument === "--help") {
  console.log(USAGE)
  process.exit(0)
}
if (bookArgument === undefined) {
  exitWithUsage("give the book folder")
}
if (extraArguments.length > 0) {
  exitWithUsage(`too many arguments: ${extraArguments.join(" ")}`)
}
const linesPerPage = Number(linesArgument ?? "2")
if (!Number.isInteger(linesPerPage) || linesPerPage < 1) {
  exitWithUsage(`lines per page must be a whole number of 1 or more, not '${linesArgument}'`)
}
const IMAGE_MODEL = "google/gemini-nano-banana-2.1"
const apiKey = process.env.OPENROUTER_API_KEY
if (apiKey === undefined || apiKey.length === 0) {
  exitWithUsage("set OPENROUTER_API_KEY to an OpenRouter API key")
}

if (!fs.existsSync(bookArgument)) {
  await fsPromises.cp(path.join(import.meta.dir, "samples/hamlet"), bookArgument, { recursive: true })
  console.log(`copied the sample book into ${bookArgument}`)
}
// Every path below is relative to the book folder.
process.chdir(bookArgument)
for (const file of ["text.txt", "style.txt"]) {
  if (!fs.existsSync(file)) {
    exitWithUsage(`${path.join(bookArgument, file)} is missing`)
  }
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

const text = new FileArtifact("text.txt")
const style = new FileArtifact("style.txt")
const pagesFolder = new FilesystemPrefix("pages/")

// chunk writes one file for each page. It does not know the page count before it runs, so it
// declares the folder and reports each page. Each report makes the image task of that page.
// linesPerPage is in the task id, so a new value makes a new task, and that task runs.
build.add(
  new Task({
    id: `chunk/lines=${linesPerPage}`,
    inputs: [text],
    outputs: [pagesFolder],
    run: async (ctx) => {
      const content = await Bun.file(text.path).text()
      const lines = content.split("\n").filter((line) => line.trim().length > 0)
      const written = new Set<string>()
      for (let index = 0; index * linesPerPage < lines.length; index++) {
        const pageLines = lines.slice(index * linesPerPage, (index + 1) * linesPerPage)
        const page = new FileArtifact(`pages/${pageName(index)}.txt`)
        await Bun.write(page.path, pageLines.join("\n"))
        written.add(page.path)
        ctx.produced(page)
      }
      // A shorter text leaves old pages behind. Delete them, so their image tasks go away.
      for (const file of await pagesFolder.list()) {
        if (!written.has(file)) {
          await fsPromises.unlink(file)
          ctx.deleted(new FileArtifact(file))
        }
      }
    },
  }),
)

// image:<page> reads its page, the style, the first 5 images and the 5 images before it.
// The earlier images come from no matcher, so this build.each uses the tasks form.
build.each({
  matchersByName: { page: new FileMatcher("pages/<page>.txt") },
  outputsByName: { image: new FileTemplate("images/<page>.png") },
  *tasks(vars, matched, outputs) {
    const index = Number(vars.page)
    const earlierImages: FileArtifact[] = []
    for (let earlier = 0; earlier < index; earlier++) {
      const isFirstFive = earlier < 5
      const isLastFive = earlier >= index - 5
      if (isFirstFive || isLastFive) {
        earlierImages.push(new FileArtifact(`images/${pageName(earlier)}.png`))
      }
    }
    yield new Task({
      id: `image:${vars.page}`,
      inputs: [matched.page.data, style, ...earlierImages],
      outputs: [outputs.image],
      run: async () => {
        const styleText = await Bun.file(style.path).text()
        const pageText = await Bun.file(matched.page.data.path).text()
        const earlierBytes: Uint8Array[] = []
        for (const earlier of earlierImages) {
          earlierBytes.push(await earlier.read())
        }
        const prompt = `A picture book illustration. Style: ${styleText.trim()}\nScene: ${pageText}`
        await Bun.write(outputs.image.path, await drawImage(prompt, earlierBytes))
      },
    })
  },
})

// assemble reads both folders, so it waits for chunk and for every image task.
const imagesFolder = new FilesystemPrefix("images/")
const book = new FileArtifact("book.html")
build.add(
  new Task({
    id: "assemble",
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
      const title = path.basename(process.cwd())
      await Bun.write(book.path, `<!doctype html>\n<title>${title}</title>\n${figures.join("\n")}\n`)
    },
  }),
)

const result = await build.run()
for (const [task, error] of result.failed) {
  console.error(`${task.id}: ${error.message}`)
}
console.log(`ran ${result.executed.length} tasks, skipped ${result.skipped.length}, drew ${imageCalls} images`)
if (!result.success) {
  process.exit(1)
}
