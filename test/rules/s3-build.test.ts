import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Build, MemoryStore } from "../../src/index"
import {
  FileOutput,
  MemoryS3,
  RuleBuild,
  S3ObjectArtifact,
  S3Pattern,
  S3PrefixOutput,
} from "../../contrib"

const temps: string[] = []

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dapat-s3rules-"))
  temps.push(dir)
  return dir
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

describe("RuleBuild with S3", () => {
  test("joins book/section with section/analysis on MemoryS3", async () => {
    const root = await tempDir()
    const s3 = new MemoryS3()
    await s3.put("books", "input/moby/ch1.txt", encode("moby-1"))
    await s3.put("books", "input/moby/ch2.txt", encode("moby-2"))
    await s3.put("books", "input/ch1/sentiment.txt", encode("sent"))
    await s3.put("books", "input/ch1/tone.txt", encode("tone"))
    await s3.put("books", "input/ch2/sentiment.txt", encode("sent2"))

    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)
    rules.rule({
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
        out: new FileOutput(
          "output/<book>/<section>/<analysis>.txt",
          { root },
        ),
      },
      run: async (ctx) => {
        const text = decode(await ctx.inputs.text.read())
        const analysis = decode(await ctx.inputs.analysis.read())
        await Bun.write(
          ctx.outputs.out.path,
          `${text}|${analysis}|${ctx.vars.book}|${ctx.vars.section}|${ctx.vars.analysis}`,
        )
      },
    })

    await rules.run()

    expect(
      await Bun.file(path.join(root, "output/moby/ch1/sentiment.txt")).text(),
    ).toBe("moby-1|sent|moby|ch1|sentiment")
    expect(
      await Bun.file(path.join(root, "output/moby/ch1/tone.txt")).text(),
    ).toBe("moby-1|tone|moby|ch1|tone")
    expect(
      await Bun.file(path.join(root, "output/moby/ch2/sentiment.txt")).text(),
    ).toBe("moby-2|sent2|moby|ch2|sentiment")
  })

  test("S3 prefix output feeds file shots", async () => {
    const root = await tempDir()
    const s3 = new MemoryS3()
    await s3.put("docs", "inbox/report.txt", encode("p1\np2\np3"))
    await s3.put("docs", "inbox/notes.txt", encode("only"))

    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)

    rules.rule({
      name: "paginate",
      inputs: {
        src: new S3Pattern("s3://docs/inbox/<doc>.txt", { client: s3 }),
      },
      outputs: {
        pages: new S3PrefixOutput("s3://docs/pages/<doc>/"),
      },
      run: async (ctx) => {
        const text = decode(await ctx.inputs.src.read())
        const lines = text.split("\n")
        for (let i = 0; i < lines.length; i++) {
          const key = `${ctx.outputs.pages.keyPrefix}${i + 1}.txt`
          await s3.put("docs", key, encode(lines[i]!))
          ctx.produced(new S3ObjectArtifact(s3, "docs", key))
        }
      },
    })

    rules.rule({
      name: "shot",
      inputs: {
        page: new S3Pattern("s3://docs/pages/<doc>/<page>.txt", { client: s3 }),
      },
      outputs: { shot: new FileOutput("shots/<doc>/<page>.png", { root }) },
      run: async (ctx) => {
        const body = decode(await ctx.inputs.page.read())
        await Bun.write(ctx.outputs.shot.path, `shot:${body}`)
      },
    })

    const result = await rules.run()
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
