// Makes a picture book from one book folder: text.txt is cut into pages, an LLM writes a scene for
// each page from plan.txt and page<nnn>_notes.txt, and an image model draws each scene in the style
// of style.txt. Image models follow plain descriptions well and conditions badly, so the LLM does
// all the reasoning and the image prompt is only the style and the scene. The last step puts every
// page image into book.pdf. Each call costs money. Run it with no arguments to see the usage.
import * as fs from "node:fs"
import * as fsPromises from "node:fs/promises"
import path from "node:path"
import { PDFDocument } from "pdf-lib"
import { Artifact, Build, Task } from "dapat"
import { FileArtifact, FileMatcher, FileTemplate, FilesystemPrefix, JsonStore } from "dapat/contrib"
import { assert } from "node:console"

const IMAGE_MODEL = "openai/gpt-image-2.5-flare"
const TEXT_MODEL = "anthropic/claude-opus-5.5"
const DEFAULT_LINES_PER_PAGE = 2
const FIRST_REFERENCES = 5
const RECENT_REFERENCES = 5

const USAGE = `usage: bun ${scriptPath()} <book folder> [lines per page]

Makes a picture book from the files in <book folder>:

  text.txt              the story. It is cut into pages of [lines per page] lines.
  plan.txt              the goals of the plot. An LLM uses it to write a scene for each page.
  style.txt             the look of the images.
  page<nnn>_notes.txt   optional. Strict notes for the picture of one page, for example
                        page003_notes.txt for pages/003.txt. The LLM puts them into the scene.
  scene_prompt.txt      optional. Replaces the default prompt of the scene step. It can use
                        {{plan}}, {{page}}, {{notes}} and {{previous_scene}}.
  image_prompt.txt      optional. Replaces the default prompt of the image step. It can use
                        {{style}} and {{scene}}.
  Run with --prompts to print the default prompts.

It writes pages/, scenes/, images/, book.html and book.pdf into the book folder.
When the book folder is missing, it copies a sample book into it.

  <book folder>     the folder of one book. It can be anywhere.
  [lines per page]  how many lines of text go on each page. The default is ${DEFAULT_LINES_PER_PAGE}.

Set OPENROUTER_API_KEY first. Each scene and each image is a paid call to
OpenRouter. A second run with no edits makes no call.`

const { bookFolder, linesPerPage, apiKey } = await validateArgs()

/**
 * The prompt of one step. The text is <name>_prompt.txt in the book folder when that file exists,
 * and the default text in this script when it does not. The stamp is a hash of the text, so an edit
 * to either one makes the tasks that read the prompt run again.
 */
class PromptArtifact extends Artifact<string> {
  readonly id: string
  readonly overrideFile: FileArtifact

  constructor(
    readonly name: string,
    readonly defaultText: string,
  ) {
    super()
    this.id = `prompt:${name}`
    this.overrideFile = new FileArtifact(`${name}_prompt.txt`)
  }

  async stamp(): Promise<string> {
    const hasher = new Bun.CryptoHasher("sha256")
    hasher.update(await this.read())
    return hasher.digest("hex")
  }

  async read(): Promise<string> {
    let text = this.defaultText
    if (await Bun.file(this.overrideFile.path).exists()) {
      text = await Bun.file(this.overrideFile.path).text()
    }
    return text.trim()
  }

  /** The text with each {{name}} replaced. Throws on a {{name}} that has no value. */
  async fill(values: Record<string, string>): Promise<string> {
    let filled = await this.read()
    for (const [key, value] of Object.entries(values)) {
      filled = filled.replaceAll(`{{${key}}}`, () => value)
    }
    const unknown = filled.match(/\{\{\w+\}\}/)
    if (unknown !== null) {
      throw new Error(`${this.name} prompt: ${unknown[0]} has no value; the names are ${Object.keys(values).join(", ")}`)
    }
    return filled
  }
}

let sceneCalls = 0
let imageCalls = 0
const build = new Build({ store: new JsonStore(".dapat/state.json") })
// chunk and image name these files here. The scene step gets the same files from its matchers.
const text = new FileArtifact("text.txt")
const style = new FileArtifact("style.txt")
const pagesFolder = new FilesystemPrefix("pages/")
const scenePrompt = new PromptArtifact("scene", defaultScenePrompt())
const imagePrompt = new PromptArtifact("image", defaultImagePrompt())

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

// scene:<page> asks the LLM for the scene of one page. It reads the plan, its page, the notes of
// the page when they exist, and the scene before it, so the scenes follow on from each other.
// One call for each page means that a new page at the end makes one call, and an edit to page n
// makes calls for page n and the pages after it.
build.each({
  matchersByName: {
    page: new FileMatcher("pages/<page>.txt"),
    notes: new FileMatcher("page<page>_notes.txt"),
    plan: new FileMatcher("plan.txt"),
    text: new FileMatcher("text.txt"),
    style: new FileMatcher("style.txt"),
  },
  required: ["page", "plan", "text", "style"],
  outputsByName: { scene: new FileTemplate("scenes/<page>.txt") },
  *tasks(vars, matched, outputs) {

    const index = Number(vars.page)
    let notes: FileArtifact | null = null
    if (matched.notes !== undefined) {
      notes = matched.notes.data
    }
    let previousScene: FileArtifact | null = null
    const inputs: Artifact[] = [scenePrompt, matched.plan.data, matched.text.data, matched.style.data, matched.page.data]
    if (notes !== null) {
      inputs.push(notes)
    }
    if (index > 0) {
      previousScene = new FileArtifact(`scenes/${pageName(index - 1)}.txt`)
      inputs.push(previousScene)
    }
    yield new Task({
      id: `scene:${vars.page}`,
      inputs,
      outputs: [outputs.scene],
      run: async () => {
        const planText = await Bun.file(matched.plan.data.path).text()
        const textText = await Bun.file(matched.text.data.path).text()
        const styleText = await Bun.file(matched.style.data.path).text()
        const pageText = await Bun.file(matched.page.data.path).text()
        let notesText = "None."
        if (notes !== null) {
          notesText = await Bun.file(notes.path).text()
        }
        let previousSceneText = "None. This is the first page."
        if (previousScene !== null) {
          previousSceneText = await Bun.file(previousScene.path).text()
        }
        const prompt = await scenePrompt.fill({
          plan: planText,
          text: textText,
          style: styleText,
          page: pageText,
          notes: notesText,
          previous_scene: previousSceneText,
        })
        await Bun.write(outputs.scene.path, await promptLlm(prompt))
      },
    })
  },
})

// image:<page> draws the scene of one page in the style. It also reads the first 5 images and the
// 5 images before it, as references for the look. So a change to one image draws that image and
// the images after it again.
build.each({
  matchersByName: {
    pageText: new FileMatcher("pages/<page>.txt"),
    pageScene: new FileMatcher("scenes/<page>.txt"),
  },
  outputsByName: { image: new FileTemplate("images/<page>.png") },
  *tasks(vars, matched, outputs) {
    const index = Number(vars.page)
    const scene = matched.pageScene.data
    const pageText = matched.pageText.data
    const earlierImages: FileArtifact[] = []
    for (let earlier = 0; earlier < index; earlier++) {
      const isFirst = earlier < FIRST_REFERENCES
      const isRecent = earlier >= index - RECENT_REFERENCES
      if (isFirst || isRecent) {
        earlierImages.push(new FileArtifact(`images/${pageName(earlier)}.png`))
      }
    }
    yield new Task({
      id: `image:${vars.page}`,
      inputs: [imagePrompt, scene, pageText, style, ...earlierImages],
      outputs: [outputs.image],
      run: async () => {
        const styleText = await Bun.file(style.path).text()
        const sceneText = await Bun.file(scene.path).text()
        const pageTextContent = await Bun.file(pageText.path).text()
        const earlierBytes: Uint8Array[] = []
        for (const earlier of earlierImages) {
          earlierBytes.push(await earlier.read())
        }
        const prompt = await imagePrompt.fill({ style: styleText.trim(), scene: sceneText.trim(), page: pageTextContent.trim() })
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

// pdf puts every page image into one PDF, in name order. One image fills one page.
// It also reads pages/, so it waits for chunk. On the first run, the image tasks exist only after
// chunk reports the pages, so images/ alone has no producer to wait for, and pdf would run at once.
const bookPdf = new FileArtifact("book.pdf")
build.add(
  new Task({
    id: "pdf",
    inputs: [pagesFolder, imagesFolder],
    outputs: [bookPdf],
    run: async () => {
      const imageFiles = (await imagesFolder.list()).filter((file) => file.endsWith(".png"))
      imageFiles.sort()
      const pdf = await PDFDocument.create()
      for (const file of imageFiles) {
        const bytes = await Bun.file(file).bytes()
        const image = await pdf.embedPng(bytes)
        const page = pdf.addPage([image.width, image.height])
        page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height })
      }
      await Bun.write(bookPdf.path, await pdf.save())
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
  if (bookArgument === "--prompts") {
    console.log(`== scene_prompt.txt\n${defaultScenePrompt()}\n\n== image_prompt.txt\n${defaultImagePrompt()}`)
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

function defaultScenePrompt(): string {
  return `You write the picture descriptions for a children's picture book. An image model draws each
description. Image models follow plain descriptions well and conditions badly, so do the thinking
here and give the image model only what it must draw.

The goals of the plot:
{{plan}}

The style of the book:
{{style}}

The description of the picture on the page before:
{{previous_scene}}

Notes from the author for this picture. They win over the plan and the page before:
{{notes}}

The text of the entire story:
{{text}}

The text of this page:
{{page}}

Write the description of the one picture for this page. Rules:
- Describe only what is visible: each character with their looks and clothes, what they do, where
  they stand, the place, the light, and the colours.
- Use plain statements. Do not use "if", "unless", "or", "should", "maybe", or "not".
- Use 4 to 6 sentences. Reply with only the description.`
}

function defaultImagePrompt(): string {
  return `A children's picture book illustration. 

  We are converting a text story into a picture book.
  Draw the same characters as in the reference images.

  Draw the text at the bottom of the page, drawing above, unless the style says otherwise.

Style: {{style}}

{{scene}}

Text of this page is: {{page}}`
}
