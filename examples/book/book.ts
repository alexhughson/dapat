// Makes a picture book from one book folder: text.txt is cut into pages, an LLM writes a scene for
// each page from plan.txt, and an image model draws each scene in the style of style.txt.
// page<nnn>_notes.txt steers the image of one page. Each LLM call and each image call costs money.
// Run it with no arguments to see the usage.
import * as fs from "node:fs"
import * as fsPromises from "node:fs/promises"
import path from "node:path"
import { Build, Task } from "dapat"
import { FileArtifact, FileMatcher, FileTemplate, FilesystemPrefix, JsonStore } from "dapat/contrib"

const IMAGE_MODEL = "google/gemini-nano-banana-2.1"
const TEXT_MODEL = "anthropic/claude-sonnet-5.5"
const DEFAULT_LINES_PER_PAGE = 2
const FIRST_REFERENCES = 5
const RECENT_REFERENCES = 5

const USAGE = `usage: bun ${scriptPath()} <book folder> [lines per page]

Makes a picture book from the files in <book folder>:

  text.txt              the story. It is cut into pages of [lines per page] lines.
  plan.txt              the goals of the plot. An LLM uses it to write a scene for each page.
  style.txt             the look of the images.
  page<nnn>_notes.txt   optional. Strict notes for the image of one page, for example
                        page003_notes.txt for pages/003.txt.

It writes pages/, scenes/, images/ and book.html into the book folder. When the
book folder is missing, it copies a sample book into it.

  <book folder>     the folder of one book. It can be anywhere.
  [lines per page]  how many lines of text go on each page. The default is ${DEFAULT_LINES_PER_PAGE}.

Set OPENROUTER_API_KEY first. Each scene and each image is a paid call to
OpenRouter. A second run with no edits makes no call.`

const { bookFolder, linesPerPage, apiKey } = await validateArgs()

let sceneCalls = 0
let imageCalls = 0
const build = new Build({ store: new JsonStore(".dapat/state.json") })
const text = new FileArtifact("text.txt")
const plan = new FileArtifact("plan.txt")
const style = new FileArtifact("style.txt")
const pagesFolder = new FilesystemPrefix("pages/")

// chunk writes one file for each page. It does not know the page count before it runs, so it
// declares the folder and reports each page. Each report makes the scene and image tasks of that page.
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
      // A shorter text leaves old pages behind. Delete them, so their tasks go away.
      for (const file of await pagesFolder.list()) {
        if (!written.has(file)) {
          await fsPromises.unlink(file)
          ctx.deleted(new FileArtifact(file))
        }
      }
    },
  }),
)

// scene:<page> asks the LLM for the scene of one page. It reads the plan, its page, and the scene
// before it, so the scenes follow on from each other. One call for each page means that a new page
// at the end makes one call, and an edit to page n makes calls for page n and the pages after it.
build.each({
  matchersByName: { page: new FileMatcher("pages/<page>.txt") },
  outputsByName: { scene: new FileTemplate("scenes/<page>.txt") },
  *tasks(vars, matched, outputs) {
    const index = Number(vars.page)
    let previousScene: FileArtifact | null = null
    const inputs = [plan, matched.page.data]
    if (index > 0) {
      previousScene = new FileArtifact(`scenes/${pageName(index - 1)}.txt`)
      inputs.push(previousScene)
    }
    yield new Task({
      id: `scene:${vars.page}`,
      inputs,
      outputs: [outputs.scene],
      run: async () => {
        const planText = await Bun.file(plan.path).text()
        const pageText = await Bun.file(matched.page.data.path).text()
        let previousSceneText: string | null = null
        if (previousScene !== null) {
          previousSceneText = await Bun.file(previousScene.path).text()
        }
        const prompt = scenePrompt(planText, pageText, previousSceneText)
        await Bun.write(outputs.scene.path, await promptLlm(prompt))
      },
    })
  },
})

// image:<page> draws the scene of one page in the style, with the notes of that page when they
// exist. It also reads the first 5 images and the 5 images before it, as references for the look.
// So a change to one image draws that image and the images after it again.
build.each({
  matchersByName: {
    page: new FileMatcher("pages/<page>.txt"),
    notes: new FileMatcher("page<page>_notes.txt"),
  },
  required: ["page"],
  outputsByName: { image: new FileTemplate("images/<page>.png") },
  *tasks(vars, matched, outputs) {
    const index = Number(vars.page)
    const scene = new FileArtifact(`scenes/${vars.page}.txt`)
    let notes: FileArtifact | null = null
    if (matched.notes !== undefined) {
      notes = matched.notes.data
    }
    const earlierImages: FileArtifact[] = []
    for (let earlier = 0; earlier < index; earlier++) {
      const isFirst = earlier < FIRST_REFERENCES
      const isRecent = earlier >= index - RECENT_REFERENCES
      if (isFirst || isRecent) {
        earlierImages.push(new FileArtifact(`images/${pageName(earlier)}.png`))
      }
    }
    const inputs = [scene, style, ...earlierImages]
    if (notes !== null) {
      inputs.push(notes)
    }
    yield new Task({
      id: `image:${vars.page}`,
      inputs,
      outputs: [outputs.image],
      run: async () => {
        const styleText = await Bun.file(style.path).text()
        const sceneText = await Bun.file(scene.path).text()
        let notesText: string | null = null
        if (notes !== null) {
          notesText = await Bun.file(notes.path).text()
        }
        const earlierBytes: Uint8Array[] = []
        for (const earlier of earlierImages) {
          earlierBytes.push(await earlier.read())
        }
        const prompt = imagePrompt(styleText, sceneText, notesText)
        await Bun.write(outputs.image.path, await generateImage(prompt, earlierBytes))
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
      const title = path.basename(bookFolder)
      await Bun.write(book.path, `<!doctype html>\n<title>${title}</title>\n${figures.join("\n")}\n`)
    },
  }),
)

const result = await build.run()
for (const [task, error] of result.failed) {
  console.error(`${task.id}: ${error.message}`)
}
console.log(`ran ${result.executed.length} tasks, skipped ${result.skipped.length}`)
console.log(`made ${sceneCalls} scene calls and ${imageCalls} image calls`)
if (!result.success) {
  process.exit(1)
}

/** Checks the arguments, the API key and the book folder, and changes into the book folder. */
async function validateArgs(): Promise<{ bookFolder: string; linesPerPage: number; apiKey: string }> {
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
  const linesPerPage = Number(linesArgument ?? DEFAULT_LINES_PER_PAGE)
  if (!Number.isInteger(linesPerPage) || linesPerPage < 1) {
    exitWithUsage(`lines per page must be a whole number of 1 or more, not '${linesArgument}'`)
  }
  const apiKey = process.env.OPENROUTER_API_KEY
  if (apiKey === undefined || apiKey.length === 0) {
    exitWithUsage("set OPENROUTER_API_KEY to an OpenRouter API key")
  }
  if (!fs.existsSync(bookArgument)) {
    await fsPromises.cp(path.join(import.meta.dir, "samples/hamlet"), bookArgument, { recursive: true })
    console.log(`copied the sample book into ${bookArgument}`)
  }
  for (const file of ["text.txt", "plan.txt", "style.txt"]) {
    if (!fs.existsSync(path.join(bookArgument, file))) {
      exitWithUsage(`${path.join(bookArgument, file)} is missing`)
    }
  }
  // Every path in the build is relative to the book folder.
  process.chdir(bookArgument)
  return { bookFolder: bookArgument, linesPerPage, apiKey }
}

function exitWithUsage(problem: string): never {
  console.error(`${problem}\n\n${USAGE}`)
  process.exit(2)
}

function scriptPath(): string {
  const relativePath = path.relative(process.cwd(), import.meta.path)
  if (relativePath.startsWith("..")) {
    return import.meta.path
  }
  return relativePath
}

function pageName(index: number): string {
  return String(index).padStart(3, "0")
}

async function promptLlm(prompt: string): Promise<string> {
  sceneCalls += 1
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: TEXT_MODEL, messages: [{ role: "user", content: prompt }] }),
  })
  if (!response.ok) {
    throw new Error(`chat API: ${response.status} ${await response.text()}`)
  }
  const body = (await response.json()) as { choices: { message: { content: string } }[] }
  return body.choices[0]!.message.content
}

async function generateImage(prompt: string, earlierImages: Uint8Array[]): Promise<Uint8Array> {
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

function scenePrompt(plan: string, page: string, previousScene: string | null): string {
  let previous = "This is the first page."
  if (previousScene !== null) {
    previous = `The scene of the page before:\n${previousScene}`
  }
  return `You plan the illustrations of a children's picture book.

The goals of the plot:
${plan}

${previous}

The text of this page:
${page}

Describe the one picture for this page in 3 to 5 sentences: who is in it, what they do, where they
are, and the mood. Keep the characters and places the same as in the scene before. Reply with only
the description.`
}

function imagePrompt(style: string, scene: string, notes: string | null): string {
  let prompt = `An illustration for a children's picture book. Use the reference images to keep the
characters and places the same.

Style: ${style.trim()}

Scene: ${scene.trim()}`
  if (notes !== null) {
    prompt += `\n\nFollow these notes exactly: ${notes.trim()}`
  }
  return prompt
}
