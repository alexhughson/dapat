// The children's book pipeline. For each book folder books/<book>/ under `root`:
//
//   chunk:<book>         text.txt                                   -> out/<book>/pages/<nnn>.txt (one sentence each)
//   image:<book>/<nnn>   pages/<nnn>.txt, style.txt, images/<nnn-1>.svg -> out/<book>/images/<nnn>.svg
//   assemble:<book>      pages/, images/ (only when style.txt exists)  -> out/<book>/book.html
//
// The image step is a substitute for a paid model call. Each image also reads the image before it,
// as a reference for the look of the characters, so the images form a chain.
import * as fsPromises from "node:fs/promises"
import path from "node:path"
import { Build, Task, type Ref } from "dapat"
import { FileArtifact, FileMatcher, FilesystemPrefix } from "dapat/contrib"

export interface ImageRequest {
  readonly prompt: string
  /** The bytes of the image of the page before, or `null` for the first page. */
  readonly previous: Uint8Array | null
}

export type DrawImage = (request: ImageRequest) => Promise<Uint8Array>

/** Page names have three digits, so a string sort is the page order. */
export const MAX_PAGES = 1000
const PAGE_NAME = /^[0-9]{3}$/

export function pageName(index: number): string {
  return String(index).padStart(3, "0")
}

export function isPageName(name: string): boolean {
  return PAGE_NAME.test(name)
}

/**
 * One sentence for each page. A sentence ends with `.`, `!` or `?` and white space.
 * Line breaks inside a sentence become spaces, so a new line wrap does not change a page.
 */
export function splitIntoPages(text: string): string[] {
  const pages: string[] = []
  for (const part of text.split(/(?<=[.!?])\s+/)) {
    const sentence = part.replace(/\s+/g, " ").trim()
    if (sentence.length > 0) {
      pages.push(sentence)
    }
  }
  return pages
}

export function addBookTasks(build: Build, root: string, drawImage: DrawImage): void {
  build.each({
    matchersByName: { text: new FileMatcher(path.join(root, "books/<book>/text.txt")) },
    *tasks(vars, matched) {
      const text = matched.text.data
      const pagesFolder = new FilesystemPrefix(path.join(root, `out/${vars.book}/pages/`))
      yield new Task({
        id: `chunk:${vars.book}`,
        inputs: [text],
        outputs: [pagesFolder],
        run: async (ctx) => {
          const textContent = await Bun.file(text.path).text()
          const sentences = splitIntoPages(textContent)
          if (sentences.length > MAX_PAGES) {
            throw new Error(`${text.path} has ${sentences.length} sentences; the limit is ${MAX_PAGES}`)
          }
          const keptFiles = new Set<string>()
          for (let index = 0; index < sentences.length; index++) {
            const page = new FileArtifact(path.join(pagesFolder.path, `${pageName(index)}.txt`))
            await Bun.write(page.path, sentences[index]!)
            keptFiles.add(page.path)
            ctx.produced(page)
          }
          // A shorter text leaves pages of the last run in the folder. This task deletes them,
          // so their image tasks leave the build. Other files in the folder are not pages, so it keeps them.
          for (const file of await pagesFolder.list()) {
            if (keptFiles.has(file)) {
              continue
            }
            if (!isPageFile(pagesFolder, file)) {
              continue
            }
            await fsPromises.unlink(file)
            ctx.deleted(new FileArtifact(file))
          }
        },
      })
    },
  })

  build.each({
    matchersByName: {
      page: new FileMatcher(path.join(root, "out/<book>/pages/<page>.txt")),
      style: new FileMatcher(path.join(root, "books/<book>/style.txt")),
    },
    *tasks(vars, matched) {
      if (!isPageName(vars.page)) {
        return
      }
      const index = Number(vars.page)
      const page = matched.page.data
      const style = matched.style.data
      const imagesFolder = path.join(root, `out/${vars.book}/images`)
      const image = new FileArtifact(path.join(imagesFolder, `${vars.page}.svg`))
      const inputs: Ref[] = [page, style]
      let previous: FileArtifact | null = null
      if (index > 0) {
        previous = new FileArtifact(path.join(imagesFolder, `${pageName(index - 1)}.svg`))
        inputs.push(previous)
      }
      yield new Task({
        id: `image:${vars.book}/${vars.page}`,
        inputs,
        outputs: [image],
        run: async () => {
          const styleContent = await Bun.file(style.path).text()
          const styleText = styleContent.trim()
          const pageText = await Bun.file(page.path).text()
          let previousBytes: Uint8Array | null = null
          if (previous !== null) {
            previousBytes = await previous.read()
          }
          const prompt = `${styleText}\n\n${pageText}`
          const bytes = await drawImage({ prompt, previous: previousBytes })
          await Bun.write(image.path, bytes)
        },
      })
    },
  })

  build.each({
    // The style is not read here. Without it there are no image tasks, so no book is made.
    matchersByName: {
      text: new FileMatcher(path.join(root, "books/<book>/text.txt")),
      style: new FileMatcher(path.join(root, "books/<book>/style.txt")),
    },
    *tasks(vars) {
      const pagesFolder = new FilesystemPrefix(path.join(root, `out/${vars.book}/pages/`))
      const imagesFolder = new FilesystemPrefix(path.join(root, `out/${vars.book}/images/`))
      const book = new FileArtifact(path.join(root, `out/${vars.book}/book.html`))
      yield new Task({
        id: `assemble:${vars.book}`,
        inputs: [pagesFolder, imagesFolder],
        outputs: [book],
        run: async () => {
          const pageFiles: string[] = []
          for (const file of await pagesFolder.list()) {
            if (isPageFile(pagesFolder, file)) {
              pageFiles.push(file)
            }
          }
          pageFiles.sort()
          const figures: string[] = []
          for (const file of pageFiles) {
            const name = path.basename(file, ".txt")
            const sentence = await Bun.file(file).text()
            figures.push(`<figure><img src="images/${name}.svg"><figcaption>${escapeHtml(sentence)}</figcaption></figure>`)
          }
          const html = `<!doctype html>\n<title>${escapeHtml(vars.book)}</title>\n${figures.join("\n")}\n`
          await Bun.write(book.path, html)
        },
      })
    },
  })
}

/** A file directly in the pages folder with a page name, such as `003.txt`. */
function isPageFile(pagesFolder: FilesystemPrefix, file: string): boolean {
  if (path.dirname(file) + path.sep !== pagesFolder.path) {
    return false
  }
  if (path.extname(file) !== ".txt") {
    return false
  }
  return isPageName(path.basename(file, ".txt"))
}

const HTML_ESCAPES: readonly [string, string][] = [
  ["&", "&amp;"],
  ["<", "&lt;"],
  [">", "&gt;"],
  ['"', "&quot;"],
]

export function escapeHtml(text: string): string {
  let escaped = text
  for (const [character, entity] of HTML_ESCAPES) {
    escaped = escaped.replaceAll(character, entity)
  }
  return escaped
}
