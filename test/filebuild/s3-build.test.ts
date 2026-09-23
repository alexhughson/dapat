import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { FileBuild, FilePattern, S3Pattern } from "../../contrib/filebuild"
import { MemoryS3, S3ObjectArtifact } from "../../contrib/s3"
import { Build, MemoryStore } from "../../src/index"

const temps: string[] = []

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dapat-s3build-"))
  temps.push(dir)
  return dir
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

describe("FileBuild with S3Pattern", () => {
  test("joins book/section with section/analysis on MemoryS3", async () => {
    const s3 = new MemoryS3()
    await s3.put("books", "input/moby/ch1.txt", encode("moby-1"))
    await s3.put("books", "input/moby/ch2.txt", encode("moby-2"))
    await s3.put("books", "input/ch1/sentiment.txt", encode("sent"))
    await s3.put("books", "input/ch1/tone.txt", encode("tone"))
    await s3.put("books", "input/ch2/sentiment.txt", encode("sent2"))

    const build = new Build({ store: new MemoryStore() })
    const files = new FileBuild(build)
    files.rule({
      name: "pair",
      inputs: {
        text: new S3Pattern("s3://books/input/<book>/<section>.txt", {
          client: s3,
        }),
        analysis: new S3Pattern("s3://books/input/<section>/<analysis>.txt", {
          client: s3,
        }),
      },
      outputs: {
        out: new S3Pattern("s3://books/output/<book>/<section>/<analysis>.txt", {
          client: s3,
        }),
      },
      run: async (ctx) => {
        const text = decode(await ctx.item("text").read())
        const analysis = decode(await ctx.item("analysis").read())
        const out = ctx.outputObject("out")
        await s3.put(
          out.bucket,
          out.key,
          encode(
            `${text}|${analysis}|${ctx.vars.book}|${ctx.vars.section}|${ctx.vars.analysis}`,
          ),
        )
      },
    })

    await files.run()

    expect(decode(await s3.get("books", "output/moby/ch1/sentiment.txt"))).toBe(
      "moby-1|sent|moby|ch1|sentiment",
    )
    expect(decode(await s3.get("books", "output/moby/ch1/tone.txt"))).toBe(
      "moby-1|tone|moby|ch1|tone",
    )
    expect(decode(await s3.get("books", "output/moby/ch2/sentiment.txt"))).toBe(
      "moby-2|sent2|moby|ch2|sentiment",
    )
    expect(await s3.head("books", "output/moby/ch2/tone.txt")).toBeNull()
  })

  test("a glob input is a list and does not permute extra tasks", async () => {
    const s3 = new MemoryS3()
    await s3.put("books", "input/moby/notes.txt", encode("notes"))
    await s3.put("books", "input/moby/pages/1.txt", encode("p1"))
    await s3.put("books", "input/moby/pages/2.txt", encode("p2"))
    await s3.put("books", "input/dune/notes.txt", encode("dune-notes"))
    await s3.put("books", "input/dune/pages/a.txt", encode("pa"))

    const build = new Build()
    const files = new FileBuild(build)
    const pageCounts: Record<string, number> = {}
    files.rule({
      name: "bundle",
      inputs: {
        notes: new S3Pattern("s3://books/input/<book>/notes.txt", { client: s3 }),
        pages: new S3Pattern("s3://books/input/<book>/pages/*.txt", { client: s3 }),
      },
      outputs: {
        out: new S3Pattern("s3://books/output/<book>.txt", { client: s3 }),
      },
      run: async (ctx) => {
        const pages = ctx.items("pages")
        pageCounts[ctx.vars.book!] = pages.length
        const out = ctx.outputObject("out")
        await s3.put(out.bucket, out.key, encode(String(pages.length)))
      },
    })

    await files.run()
    expect(pageCounts).toEqual({ moby: 2, dune: 1 })
    expect(decode(await s3.get("books", "output/moby.txt"))).toBe("2")
    expect(decode(await s3.get("books", "output/dune.txt"))).toBe("1")
  })

  test("a file input writes an S3 output, then an S3 input writes a file", async () => {
    const root = await tempDir()
    await mkdir(path.join(root, "src"), { recursive: true })
    await writeFile(path.join(root, "src", "a.txt"), "hello")

    const s3 = new MemoryS3()
    const build = new Build()
    const files = new FileBuild(build, { root })
    files.rule({
      name: "upload",
      inputs: { src: new FilePattern("src/<name>.txt") },
      outputs: {
        mid: new S3Pattern("s3://books/mid/<name>.txt", { client: s3 }),
      },
      run: async (ctx) => {
        const bytes = await ctx.file("src").read()
        const out = ctx.outputObject("mid")
        await s3.put(out.bucket, out.key, bytes)
      },
    })
    files.rule({
      name: "download",
      inputs: {
        mid: new S3Pattern("s3://books/mid/<name>.txt", { client: s3 }),
      },
      outputs: { out: new FilePattern("out/<name>.txt") },
      run: async (ctx) => {
        const bytes = await ctx.item("mid").read()
        await writeFile(ctx.outputFile("out").path, bytes)
      },
    })

    const result = await files.run()
    expect(result.success).toBe(true)
    expect(decode(await s3.get("books", "mid/a.txt"))).toBe("hello")
    expect(await Bun.file(path.join(root, "out/a.txt")).text()).toBe("hello")
  })

  test("a write-back loop rematches and then skips", async () => {
    const s3 = new MemoryS3()
    await s3.put("books", "a/1.txt", encode("same"))

    const build = new Build({ store: new MemoryStore() })
    const files = new FileBuild(build)
    const ran: string[] = []
    files.rule({
      name: "to-b",
      inputs: {
        src: new S3Pattern("s3://books/a/<n>.txt", { client: s3 }),
      },
      outputs: {
        out: new S3Pattern("s3://books/b/<n>.txt", { client: s3 }),
      },
      run: async (ctx) => {
        ran.push(`to-b:${ctx.vars.n}`)
        const bytes = await ctx.item("src").read()
        const out = ctx.outputObject("out")
        await s3.put(out.bucket, out.key, bytes)
      },
    })
    files.rule({
      name: "to-a",
      inputs: {
        src: new S3Pattern("s3://books/b/<n>.txt", { client: s3 }),
      },
      outputs: {
        out: new S3Pattern("s3://books/a/<n>.txt", { client: s3 }),
      },
      run: async (ctx) => {
        ran.push(`to-a:${ctx.vars.n}`)
        const bytes = await ctx.item("src").read()
        const out = ctx.outputObject("out")
        await s3.put(out.bucket, out.key, bytes)
      },
    })

    const result = await files.run()
    expect(result.success).toBe(true)
    expect(ran).toContain("to-b:1")
    expect(ran).toContain("to-a:1")
    expect(ran.filter((id) => id === "to-b:1").length).toBe(1)
    expect(ran.filter((id) => id === "to-a:1").length).toBe(1)
    expect(decode(await s3.get("books", "a/1.txt"))).toBe("same")
    expect(decode(await s3.get("books", "b/1.txt"))).toBe("same")
  })

  test("a glob output announces children; a second rule matches each one", async () => {
    const s3 = new MemoryS3()
    await s3.put("docs", "inbox/report.txt", encode("p1\np2\np3"))
    await s3.put("docs", "inbox/notes.txt", encode("only"))

    const build = new Build({ store: new MemoryStore() })
    const files = new FileBuild(build)
    files.rule({
      name: "paginate",
      inputs: {
        src: new S3Pattern("s3://docs/inbox/<doc>.txt", { client: s3 }),
      },
      outputs: {
        pages: new S3Pattern("s3://docs/pages/<doc>/*.txt", { client: s3 }),
      },
      run: async (ctx) => {
        const text = decode(await ctx.item("src").read())
        const lines = text.split("\n")
        for (let i = 0; i < lines.length; i++) {
          const key = `pages/${ctx.vars.doc}/${i + 1}.txt`
          await s3.put("docs", key, encode(lines[i]!))
          ctx.produced(new S3ObjectArtifact(s3, "docs", key))
        }
      },
    })
    files.rule({
      name: "shot",
      inputs: {
        page: new S3Pattern("s3://docs/pages/<doc>/<page>.txt", { client: s3 }),
      },
      outputs: {
        shot: new S3Pattern("s3://docs/shots/<doc>/<page>.png", { client: s3 }),
      },
      run: async (ctx) => {
        const body = decode(await ctx.item("page").read())
        const out = ctx.outputObject("shot")
        await s3.put(out.bucket, out.key, encode(`shot:${body}`))
      },
    })

    const result = await files.run()
    expect(result.success).toBe(true)
    expect(decode(await s3.get("docs", "shots/report/1.png"))).toBe("shot:p1")
    expect(decode(await s3.get("docs", "shots/report/2.png"))).toBe("shot:p2")
    expect(decode(await s3.get("docs", "shots/report/3.png"))).toBe("shot:p3")
    expect(decode(await s3.get("docs", "shots/notes/1.png"))).toBe("shot:only")
  })
})
