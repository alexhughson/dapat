import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Build, MemoryStore } from "../../src/index"
import {
  DirOutput,
  FileArtifact,
  FileGlob,
  FileOutput,
  FilePattern,
  InputGen,
  RuleBuild,
  type Feed,
} from "../../contrib"

const temps: string[] = []

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dapat-rules-"))
  temps.push(dir)
  return dir
}

async function write(root: string, rel: string, body: string): Promise<void> {
  const full = path.join(root, rel)
  await mkdir(path.dirname(full), { recursive: true })
  await writeFile(full, body)
}

function sortedIds(tasks: readonly { id: string }[]): string[] {
  const ids: string[] = []
  for (const task of tasks) {
    ids.push(task.id)
  }
  ids.sort()
  return ids
}

describe("RuleBuild file rules", () => {
  test("joins book/section with section/analysis", async () => {
    const root = await tempDir()
    await write(root, "input/moby/ch1.txt", "moby-1")
    await write(root, "input/moby/ch2.txt", "moby-2")
    await write(root, "input/ch1/sentiment.txt", "sent")
    await write(root, "input/ch1/tone.txt", "tone")
    await write(root, "input/ch2/sentiment.txt", "sent2")

    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)
    rules.rule({
      name: "pair",
      inputs: {
        text: new FilePattern("input/<book>/<section>.txt", { root }),
        analysis: new FilePattern("input/<section>/<analysis>.txt", { root }),
      },
      outputs: {
        out: new FileOutput("output/<book>/<section>/<analysis>.txt", { root }),
      },
      run: async (ctx) => {
        const text = new TextDecoder().decode(await ctx.inputs.text.read())
        const analysis = new TextDecoder().decode(await ctx.inputs.analysis.read())
        await Bun.write(
          ctx.outputs.out.path,
          `${text}|${analysis}|${ctx.vars.book}|${ctx.vars.section}|${ctx.vars.analysis}`,
        )
      },
    })

    await rules.run()

    expect(await Bun.file(path.join(root, "output/moby/ch1/sentiment.txt")).text()).toBe(
      "moby-1|sent|moby|ch1|sentiment",
    )
    expect(await Bun.file(path.join(root, "output/moby/ch1/tone.txt")).text()).toBe(
      "moby-1|tone|moby|ch1|tone",
    )
    expect(await Bun.file(path.join(root, "output/moby/ch2/sentiment.txt")).text()).toBe(
      "moby-2|sent2|moby|ch2|sentiment",
    )
    expect(await Bun.file(path.join(root, "output/moby/ch2/tone.txt")).exists()).toBe(
      false,
    )
  })

  test("optional input still schedules when the file is missing", async () => {
    const root = await tempDir()
    await write(root, "input/moby.txt", "book")

    const build = new Build()
    const rules = new RuleBuild(build)
    let sawMeta: boolean | undefined
    rules.rule({
      name: "meta",
      inputs: {
        book: new FilePattern("input/<name>.txt", { root }),
        meta: new FilePattern("input/<name>.meta", { root }),
      },
      optional: ["meta"],
      outputs: { out: new FileOutput("output/<name>.txt", { root }) },
      run: async (ctx) => {
        sawMeta = ctx.inputs.meta !== undefined
        const body = new TextDecoder().decode(await ctx.inputs.book.read())
        await Bun.write(ctx.outputs.out.path, body)
      },
    })

    await rules.run()
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
    const rules = new RuleBuild(build)
    const pageCounts: Record<string, number> = {}
    rules.rule({
      name: "bundle",
      inputs: {
        notes: new FilePattern("input/<book>/notes.txt", { root }),
        pages: new FileGlob("input/<book>/pages/*.txt", { root }),
      },
      outputs: { out: new FileOutput("output/<book>.txt", { root }) },
      run: async (ctx) => {
        pageCounts[ctx.vars.book!] = ctx.inputs.pages.length
        await Bun.write(ctx.outputs.out.path, String(ctx.inputs.pages.length))
      },
    })

    await rules.run()
    expect(pageCounts).toEqual({ moby: 2, dune: 1 })
    expect(await Bun.file(path.join(root, "output/moby.txt")).text()).toBe("2")
    expect(await Bun.file(path.join(root, "output/dune.txt")).text()).toBe("1")
  })

  test("an output file becomes an input for another rule", async () => {
    const root = await tempDir()
    await write(root, "src/a.txt", "hello")

    const build = new Build()
    const rules = new RuleBuild(build)
    rules.rule({
      name: "upper",
      inputs: { src: new FilePattern("src/<name>.txt", { root }) },
      outputs: { mid: new FileOutput("mid/<name>.txt", { root }) },
      run: async (ctx) => {
        const text = new TextDecoder().decode(await ctx.inputs.src.read())
        await Bun.write(ctx.outputs.mid.path, text.toUpperCase())
      },
    })
    rules.rule({
      name: "wrap",
      inputs: { mid: new FilePattern("mid/<name>.txt", { root }) },
      outputs: { out: new FileOutput("out/<name>.txt", { root }) },
      run: async (ctx) => {
        const text = new TextDecoder().decode(await ctx.inputs.mid.read())
        await Bun.write(ctx.outputs.out.path, `[${text}]`)
      },
    })

    const result = await rules.run()
    expect(result.success).toBe(true)
    expect(await Bun.file(path.join(root, "mid/a.txt")).text()).toBe("HELLO")
    expect(await Bun.file(path.join(root, "out/a.txt")).text()).toBe("[HELLO]")
  })

  test("a write-back loop rematches and then skips", async () => {
    const root = await tempDir()
    await write(root, "a/1.txt", "same")

    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)
    const ran: string[] = []
    rules.rule({
      name: "to-b",
      inputs: { src: new FilePattern("a/<n>.txt", { root }) },
      outputs: { out: new FileOutput("b/<n>.txt", { root }) },
      run: async (ctx) => {
        ran.push(`to-b:${ctx.vars.n}`)
        const bytes = await ctx.inputs.src.read()
        await Bun.write(ctx.outputs.out.path, bytes)
      },
    })
    rules.rule({
      name: "to-a",
      inputs: { src: new FilePattern("b/<n>.txt", { root }) },
      outputs: { out: new FileOutput("a/<n>.txt", { root }) },
      run: async (ctx) => {
        ran.push(`to-a:${ctx.vars.n}`)
        const bytes = await ctx.inputs.src.read()
        await Bun.write(ctx.outputs.out.path, bytes)
      },
    })

    const result = await rules.run()
    expect(result.success).toBe(true)
    expect(ran).toContain("to-b:1")
    expect(ran).toContain("to-a:1")
    expect(ran.filter((id) => id === "to-b:1").length).toBe(1)
    expect(ran.filter((id) => id === "to-a:1").length).toBe(1)
    expect(await Bun.file(path.join(root, "a/1.txt")).text()).toBe("same")
    expect(await Bun.file(path.join(root, "b/1.txt")).text()).toBe("same")
  })

  test("DirOutput announces children; a second rule matches each one", async () => {
    const root = await tempDir()
    await write(root, "inbox/report.txt", "p1\np2\np3")
    await write(root, "inbox/notes.txt", "only")

    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)
    rules.rule({
      name: "paginate",
      inputs: { src: new FilePattern("inbox/<doc>.txt", { root }) },
      outputs: { pages: new DirOutput("pages/<doc>/", { root }) },
      run: async (ctx) => {
        const text = new TextDecoder().decode(await ctx.inputs.src.read())
        const lines = text.split("\n")
        for (let i = 0; i < lines.length; i++) {
          const page = new FileArtifact(
            path.join(ctx.outputs.pages.path, `${i + 1}.txt`),
          )
          await Bun.write(page.path, lines[i]!)
          ctx.produced(page)
        }
      },
    })
    rules.rule({
      name: "shot",
      inputs: { page: new FilePattern("pages/<doc>/<page>.txt", { root }) },
      outputs: { shot: new FileOutput("shots/<doc>/<page>.png", { root }) },
      run: async (ctx) => {
        const body = new TextDecoder().decode(await ctx.inputs.page.read())
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

  test("rule shape checks throw clear errors", () => {
    const build = new Build()
    const rules = new RuleBuild(build)

    expect(() => {
      rules.rule({
        name: "bad-opt",
        inputs: { src: new FilePattern("src/<n>.txt") },
        optional: ["missing" as "src"],
        outputs: { out: new FileOutput("out/<n>.txt") },
        run: async () => {},
      })
    }).toThrow(/optional name 'missing' is not an input/)

    expect(() => {
      rules.rule({
        name: "no-req",
        inputs: { src: new FilePattern("src/<n>.txt") },
        optional: ["src"],
        outputs: { out: new FileOutput("out/<n>.txt") },
        run: async () => {},
      })
    }).toThrow(/needs at least one required input/)

    expect(() => {
      rules.rule({
        name: "opt-var",
        inputs: {
          src: new FilePattern("src/<n>.txt"),
          extra: new FilePattern("extra/<n>/<m>.txt"),
        },
        optional: ["extra"],
        outputs: { out: new FileOutput("out/<n>.txt") },
        run: async () => {},
      })
    }).toThrow(/optional input 'extra' uses var 'm'/)

    expect(() => {
      rules.rule({
        name: "out-var",
        inputs: { src: new FilePattern("src/<n>.txt") },
        outputs: { out: new FileOutput("out/<n>/<m>.txt") },
        run: async () => {},
      })
    }).toThrow(/output 'out' uses var 'm'/)
  })

  test("constructors reject mismatched templates", () => {
    expect(() => new FilePattern("posts/*.md")).toThrow(/use FileGlob/)
    expect(() => new FileGlob("posts/<name>.md")).toThrow(/use FilePattern/)
    expect(() => new FileOutput("posts/*.md")).toThrow(/must not contain a glob/)
    expect(() => new DirOutput("posts/<name>")).toThrow(/must end with/)
  })

  test("custom id overrides the default task id", async () => {
    const root = await tempDir()
    await write(root, "src/a.txt", "x")
    const build = new Build()
    const rules = new RuleBuild(build)
    rules.rule({
      name: "one",
      inputs: { src: new FilePattern("src/<name>.txt", { root }) },
      outputs: { out: new FileOutput("out/<name>.txt", { root }) },
      id: (vars) => `custom-${vars.name}`,
      run: async (ctx) => {
        await Bun.write(ctx.outputs.out.path, "ok")
      },
    })
    const result = await rules.run()
    expect(sortedIds(result.executed)).toEqual(["custom-a"])
  })

  test("start error rejects load and run", async () => {
    class Boom extends InputGen<FileArtifact> {
      readonly varNames = ["n"] as const
      async start(_feed: Feed<FileArtifact>): Promise<void> {
        throw new Error("start failed")
      }
    }
    const build = new Build()
    const rules = new RuleBuild(build)
    rules.rule({
      name: "boom",
      inputs: { src: new Boom() },
      outputs: { out: new FileOutput("out/<n>.txt") },
      run: async () => {},
    })
    await expect(rules.load()).rejects.toThrow("start failed")
  })
})
