/**
 * Times the first and the second build of the children's book pipeline of PR #28
 * (examples/book/book.ts on its branch), for one book of n pages, with a MemoryStore.
 * The tasks are the same as in book.ts. drawImage is its fake image model.
 *
 *   bun bench/book.ts                    100, 200, 400 and 1000 pages, each in its own process
 *   bun bench/book.ts 400                one size, prints one JSON line
 *   BENCH_TIMEOUT=60 bun bench/book.ts   per-size limit in seconds (default 300)
 */
import * as fsPromises from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Build, MemoryStore, Task, type Ref } from "../src/index"
import { FileArtifact, FileMatcher, FilesystemPrefix } from "../contrib/index"

const pageName = (index: number) => String(index).padStart(3, "0")

async function drawImage(prompt: string, previous: Uint8Array | null): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(prompt)
  if (previous !== null) hasher.update(previous)
  const colour = hasher.digest("hex").slice(0, 6)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#${colour}"/></svg>`
}

/** The three build.each calls of book.ts. The patterns resolve against the working directory. */
function bookBuild(store: MemoryStore): Build {
  const build = new Build({ store })
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
          if (previous !== null) previousBytes = await previous.read()
          await Bun.write(image.path, await drawImage(`${style}\n${sentence}`, previousBytes))
        },
      })
    },
  })
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
  return build
}

async function timeBook(pages: number): Promise<{ firstMs: number; secondMs: number; executed: number }> {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "dapat-book-bench-"))
  const startFolder = process.cwd()
  try {
    process.chdir(root)
    const sentences: string[] = []
    for (let i = 0; i < pages; i++) sentences.push(`Sentence number ${i} of the big book.`)
    await Bun.write("books/big/text.txt", sentences.join(" "))
    await Bun.write("books/big/style.txt", "Soft watercolour.")
    const store = new MemoryStore()
    let start = performance.now()
    const first = await bookBuild(store).run()
    const firstMs = performance.now() - start
    // chunk + one image for each page + assemble.
    if (!first.success || first.executed.length !== pages + 2) {
      throw new Error(`first build: ${first.executed.length} executed, ${first.failed.size} failed`)
    }
    start = performance.now()
    const second = await bookBuild(store).run()
    const secondMs = performance.now() - start
    if (!second.success) throw new Error("second build failed")
    return { firstMs, secondMs, executed: first.executed.length }
  } finally {
    process.chdir(startFolder)
    await fsPromises.rm(root, { recursive: true, force: true })
  }
}

const [sizeText] = process.argv.slice(2)
if (sizeText !== undefined) {
  const pages = Number(sizeText)
  const { firstMs, secondMs } = await timeBook(pages)
  console.log(JSON.stringify({ scenario: "book", n: pages, firstMs: Math.round(firstMs), secondMs: Math.round(secondMs) }))
} else {
  const limit = Number(process.env.BENCH_TIMEOUT ?? 300)
  for (const pages of [100, 200, 400, 1000]) {
    const proc = Bun.spawn(["bun", import.meta.path, String(pages)], { stdout: "pipe", stderr: "inherit" })
    const timer = setTimeout(() => proc.kill(), limit * 1000)
    const text = await new Response(proc.stdout).text()
    clearTimeout(timer)
    await proc.exited
    if (proc.signalCode !== null) {
      console.log(JSON.stringify({ scenario: "book", n: pages, firstMs: `>${limit * 1000}` }))
      break
    }
    process.stdout.write(text)
  }
}
