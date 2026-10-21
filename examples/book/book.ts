// Makes a picture book from each books/<book>/text.txt: one page for each sentence, one image for
// each page, and out/<book>/book.html. Each image also reads the image before it, so the look stays
// the same from page to page. drawImage is a fake for a paid image model, and it counts its calls.
//
// Run it from an empty folder, two times: the second run draws no image. Then add a sentence at the
// end of a text: the next run draws 1 image. Edit a style: it draws every image of that book.
import * as fs from "node:fs"
import * as fsPromises from "node:fs/promises"
import path from "node:path"
import { Build, Task, type Ref } from "dapat"
import { FileArtifact, FileMatcher, FilesystemPrefix, JsonStore } from "dapat/contrib"

if (!fs.existsSync("books")) {
  await fsPromises.cp(path.join(import.meta.dir, "books"), "books", { recursive: true })
}

let imageCalls = 0
async function drawImage(prompt: string, previous: Uint8Array | null): Promise<string> {
  imageCalls += 1
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(prompt)
  if (previous !== null) {
    hasher.update(previous)
  }
  const colour = hasher.digest("hex").slice(0, 6)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#${colour}"/></svg>`
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
    const image = new FileArtifact(`out/${vars.book}/images/${vars.page}.svg`)
    const inputs: Ref[] = [matched.page.data, matched.style.data]
    let previous: FileArtifact | null = null
    if (index > 0) {
      previous = new FileArtifact(`out/${vars.book}/images/${pageName(index - 1)}.svg`)
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
        await Bun.write(image.path, await drawImage(`${style}\n${sentence}`, previousBytes))
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
          figures.push(`<figure><img src="images/${name}.svg"><figcaption>${sentence}</figcaption></figure>`)
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
