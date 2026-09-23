import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Build, MemoryStore } from "../../src/index"
import { FileArtifact } from "../../contrib/fs/file"
import { FileBuild, FilePattern } from "../../contrib/filebuild"

const temps: string[] = []

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dapat-filebuild-"))
  temps.push(dir)
  return dir
}

async function write(root: string, rel: string, body: string): Promise<void> {
  const full = path.join(root, rel)
  await mkdir(path.dirname(full), { recursive: true })
  await writeFile(full, body)
}

describe("FileBuild", () => {
  test("joins book/section with section/analysis", async () => {
    const root = await tempDir()
    await write(root, "input/moby/ch1.txt", "moby-1")
    await write(root, "input/moby/ch2.txt", "moby-2")
    await write(root, "input/ch1/sentiment.txt", "sent")
    await write(root, "input/ch1/tone.txt", "tone")
    await write(root, "input/ch2/sentiment.txt", "sent2")

    const build = new Build({ store: new MemoryStore() })
    const files = new FileBuild(build, { root })
    files.rule({
      name: "pair",
      inputs: {
        text: new FilePattern("input/<book>/<section>.txt"),
        analysis: new FilePattern("input/<section>/<analysis>.txt"),
      },
      outputs: {
        out: new FilePattern("output/<book>/<section>/<analysis>.txt"),
      },
      run: async (ctx) => {
        const text = new TextDecoder().decode(await ctx.file("text").read())
        const analysis = new TextDecoder().decode(await ctx.file("analysis").read())
        await writeFile(
          ctx.outputFile("out").path,
          `${text}|${analysis}|${ctx.vars.book}|${ctx.vars.section}|${ctx.vars.analysis}`,
        )
      },
    })

    await files.run()

    expect(await Bun.file(path.join(root, "output/moby/ch1/sentiment.txt")).text()).toBe(
      "moby-1|sent|moby|ch1|sentiment",
    )
    expect(await Bun.file(path.join(root, "output/moby/ch1/tone.txt")).text()).toBe(
      "moby-1|tone|moby|ch1|tone",
    )
    expect(await Bun.file(path.join(root, "output/moby/ch2/sentiment.txt")).text()).toBe(
      "moby-2|sent2|moby|ch2|sentiment",
    )
    expect(
      await Bun.file(path.join(root, "output/moby/ch2/tone.txt")).exists(),
    ).toBe(false)
  })

  test("optional input still schedules when the file is missing", async () => {
    const root = await tempDir()
    await write(root, "input/moby.txt", "book")

    const build = new Build()
    const files = new FileBuild(build, { root })
    let sawMeta: boolean | undefined
    files.rule({
      name: "meta",
      inputs: {
        book: new FilePattern("input/<name>.txt"),
        meta: new FilePattern("input/<name>.meta", { optional: true }),
      },
      outputs: {
        out: new FilePattern("output/<name>.txt"),
      },
      run: async (ctx) => {
        sawMeta = ctx.inputs.meta !== undefined
        const body = new TextDecoder().decode(await ctx.file("book").read())
        await writeFile(ctx.outputFile("out").path, body)
      },
    })

    await files.run()
    expect(sawMeta).toBe(false)
    expect(await Bun.file(path.join(root, "output/moby.txt")).text()).toBe("book")
  })

  test("a glob input is a list and does not permute extra tasks", async () => {
    const root = await tempDir()
    await write(root, "input/moby/notes.txt", "notes")
    await write(root, "input/moby/pages/1.txt", "p1")
    await write(root, "input/moby/pages/2.txt", "p2")
    await write(root, "input/dune/notes.txt", "dune-notes")
    await write(root, "input/dune/pages/a.txt", "pa")

    const build = new Build()
    const files = new FileBuild(build, { root })
    const pageCounts: Record<string, number> = {}
    files.rule({
      name: "bundle",
      inputs: {
        notes: new FilePattern("input/<book>/notes.txt"),
        pages: new FilePattern("input/<book>/pages/*.txt"),
      },
      outputs: {
        out: new FilePattern("output/<book>.txt"),
      },
      run: async (ctx) => {
        const pages = ctx.files("pages")
        pageCounts[ctx.vars.book!] = pages.length
        await writeFile(ctx.outputFile("out").path, String(pages.length))
      },
    })

    await files.run()
    expect(pageCounts).toEqual({ moby: 2, dune: 1 })
    expect(await Bun.file(path.join(root, "output/moby.txt")).text()).toBe("2")
    expect(await Bun.file(path.join(root, "output/dune.txt")).text()).toBe("1")
  })

  test("an output file becomes an input for another rule", async () => {
    const root = await tempDir()
    await write(root, "src/a.txt", "hello")

    const build = new Build()
    const files = new FileBuild(build, { root })
    files.rule({
      name: "upper",
      inputs: { src: new FilePattern("src/<name>.txt") },
      outputs: { mid: new FilePattern("mid/<name>.txt") },
      run: async (ctx) => {
        const text = new TextDecoder().decode(await ctx.file("src").read())
        await writeFile(ctx.outputFile("mid").path, text.toUpperCase())
      },
    })
    files.rule({
      name: "wrap",
      inputs: { mid: new FilePattern("mid/<name>.txt") },
      outputs: { out: new FilePattern("out/<name>.txt") },
      run: async (ctx) => {
        const text = new TextDecoder().decode(await ctx.file("mid").read())
        await writeFile(ctx.outputFile("out").path, `[${text}]`)
      },
    })

    const result = await files.run()
    expect(result.success).toBe(true)
    expect(await Bun.file(path.join(root, "mid/a.txt")).text()).toBe("HELLO")
    expect(await Bun.file(path.join(root, "out/a.txt")).text()).toBe("[HELLO]")
  })

  test("a write-back loop rematches and then skips", async () => {
    const root = await tempDir()
    await write(root, "a/1.txt", "same")

    const build = new Build({ store: new MemoryStore() })
    const files = new FileBuild(build, { root })
    const ran: string[] = []
    files.rule({
      name: "to-b",
      inputs: { src: new FilePattern("a/<n>.txt") },
      outputs: { out: new FilePattern("b/<n>.txt") },
      run: async (ctx) => {
        ran.push(`to-b:${ctx.vars.n}`)
        const bytes = await ctx.file("src").read()
        await writeFile(ctx.outputFile("out").path, bytes)
      },
    })
    files.rule({
      name: "to-a",
      inputs: { src: new FilePattern("b/<n>.txt") },
      outputs: { out: new FilePattern("a/<n>.txt") },
      run: async (ctx) => {
        ran.push(`to-a:${ctx.vars.n}`)
        const bytes = await ctx.file("src").read()
        await writeFile(ctx.outputFile("out").path, bytes)
      },
    })

    const result = await files.run()
    expect(result.success).toBe(true)
    expect(ran).toContain("to-b:1")
    expect(ran).toContain("to-a:1")
    expect(ran.filter((id) => id === "to-b:1").length).toBe(1)
    expect(ran.filter((id) => id === "to-a:1").length).toBe(1)
    expect(await Bun.file(path.join(root, "a/1.txt")).text()).toBe("same")
    expect(await Bun.file(path.join(root, "b/1.txt")).text()).toBe("same")
  })

  test("a glob output announces children; a second rule matches each one", async () => {
    const root = await tempDir()
    await write(root, "inbox/report.txt", "p1\np2\np3")
    await write(root, "inbox/notes.txt", "only")

    const build = new Build({ store: new MemoryStore() })
    const files = new FileBuild(build, { root })
    files.rule({
      name: "paginate",
      inputs: { src: new FilePattern("inbox/<doc>.txt") },
      outputs: { pages: new FilePattern("pages/<doc>/*.txt") },
      run: async (ctx) => {
        const text = new TextDecoder().decode(await ctx.file("src").read())
        const lines = text.split("\n")
        for (let i = 0; i < lines.length; i++) {
          const pagePath = path.join(root, "pages", ctx.vars.doc!, `${i + 1}.txt`)
          await writeFile(pagePath, lines[i]!)
          ctx.produced(new FileArtifact(pagePath))
        }
      },
    })
    files.rule({
      name: "shot",
      inputs: { page: new FilePattern("pages/<doc>/<page>.txt") },
      outputs: { shot: new FilePattern("shots/<doc>/<page>.png") },
      run: async (ctx) => {
        const body = new TextDecoder().decode(await ctx.file("page").read())
        await writeFile(ctx.outputFile("shot").path, `shot:${body}`)
      },
    })

    const result = await files.run()
    expect(result.success).toBe(true)
    expect(await Bun.file(path.join(root, "shots/report/1.png")).text()).toBe(
      "shot:p1",
    )
    expect(await Bun.file(path.join(root, "shots/report/2.png")).text()).toBe(
      "shot:p2",
    )
    expect(await Bun.file(path.join(root, "shots/report/3.png")).text()).toBe(
      "shot:p3",
    )
    expect(await Bun.file(path.join(root, "shots/notes/1.png")).text()).toBe(
      "shot:only",
    )
  })
})
