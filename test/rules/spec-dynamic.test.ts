import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Artifact, Build } from "../../src"
import {
  DirOutput,
  FileArtifact,
  FileGlob,
  FileOutput,
  FilePattern,
  InputGen,
  JsonStore,
  MemoryStore,
  PathPrefix,
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
  const dir = await mkdtemp(path.join(tmpdir(), "dapat-spec-dyn-"))
  temps.push(dir)
  return dir
}

function sortedIds(tasks: readonly { id: string }[]): string[] {
  const ids: string[] = []
  for (const task of tasks) {
    ids.push(task.id)
  }
  ids.sort()
  return ids
}

class ValueArtifact extends Artifact<string> {
  readonly id: string

  constructor(
    readonly name: string,
    readonly value: string,
  ) {
    super()
    this.id = `value:${name}=${value}`
  }

  async orderStamp(): Promise<bigint | null> {
    return null
  }

  async contentStamp(): Promise<string | null> {
    return this.value
  }

  async read(): Promise<string> {
    return this.value
  }
}

class Values extends InputGen<ValueArtifact> {
  readonly varNames: readonly string[]

  constructor(
    private readonly name: string,
    private readonly values: string[],
  ) {
    super()
    this.varNames = [name]
  }

  async start(feed: Feed<ValueArtifact>): Promise<void> {
    for (const value of this.values) {
      feed.set({ [this.name]: value }, new ValueArtifact(this.name, value))
    }
  }
}

describe("dynamic behaviour in one build", () => {
  test("a rule feeds another rule in the same run", async () => {
    const root = await tempDir()
    await mkdir(path.join(root, "src"), { recursive: true })
    await writeFile(path.join(root, "src", "a.txt"), "hi")

    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)

    rules.rule({
      name: "step1",
      inputs: { src: new FilePattern("src/<name>.txt", { root }) },
      outputs: { mid: new FileOutput("mid/<name>.txt", { root }) },
      run: async (ctx) => {
        await Bun.write(ctx.outputs.mid.path, "MID")
      },
    })

    rules.rule({
      name: "step2",
      inputs: { mid: new FilePattern("mid/<name>.txt", { root }) },
      outputs: { out: new FileOutput("out/<name>.txt", { root }) },
      run: async (ctx) => {
        await Bun.write(ctx.outputs.out.path, "OUT")
      },
    })

    const result = await rules.run()
    expect(result.success).toBe(true)
    expect(sortedIds(result.executed)).toEqual(["step1:name=a", "step2:name=a"])
    expect(await Bun.file(path.join(root, "out", "a.txt")).text()).toBe("OUT")
  })

  test("a rule feeds itself for N turns then stops", async () => {
    const root = await tempDir()
    const sid = "s1"
    const maxN = 3
    await mkdir(path.join(root, "turns", sid, "0"), { recursive: true })
    await writeFile(path.join(root, "turns", sid, "0", "prompt.txt"), "start")

    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)
    const turns: number[] = []

    rules.rule({
      name: "turn",
      inputs: { prompt: new FilePattern("turns/<sid>/<n>/prompt.txt", { root }) },
      outputs: { tree: new DirOutput("turns/<sid>/", { root }) },
      run: async (ctx) => {
        const n = Number(ctx.vars.n)
        turns.push(n)
        if (n >= maxN) {
          return
        }
        const nextN = n + 1
        const next = new FileArtifact(
          path.join(ctx.outputs.tree.path, String(nextN), "prompt.txt"),
        )
        await mkdir(path.dirname(next.path), { recursive: true })
        await Bun.write(next.path, `turn-${nextN}`)
        ctx.produced(next)
      },
    })

    const result = await rules.run()
    expect(result.success).toBe(true)
    expect(sortedIds(result.executed)).toEqual([
      "turn:n=0,sid=s1",
      "turn:n=1,sid=s1",
      "turn:n=2,sid=s1",
      "turn:n=3,sid=s1",
    ])
    expect(turns.sort((a, b) => a - b)).toEqual([0, 1, 2, 3])
    expect(
      await Bun.file(path.join(root, "turns", sid, "3", "prompt.txt")).text(),
    ).toBe("turn-3")
  })

  test("optional input produced mid-build reaches the consuming task", async () => {
    const root = await tempDir()
    await mkdir(path.join(root, "src"), { recursive: true })
    await writeFile(path.join(root, "src", "a.txt"), "body")

    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)
    let sawFeedback: boolean | undefined

    // writer creates the optional feedback file during the build
    rules.rule({
      name: "write-feedback",
      inputs: { src: new FilePattern("src/<name>.txt", { root }) },
      outputs: {
        feedback: new FileOutput("feedback/<name>.txt", { root }),
      },
      run: async (ctx) => {
        await Bun.write(ctx.outputs.feedback.path, "fb")
      },
    })

    rules.rule({
      name: "consume",
      inputs: {
        src: new FilePattern("src/<name>.txt", { root }),
        feedback: new FilePattern("feedback/<name>.txt", { root }),
      },
      optional: ["feedback"],
      outputs: { out: new FileOutput("out/<name>.txt", { root }) },
      run: async (ctx) => {
        sawFeedback = ctx.inputs.feedback !== undefined
        let text = new TextDecoder().decode(await ctx.inputs.src.read())
        if (ctx.inputs.feedback !== undefined) {
          const fb = new TextDecoder().decode(await ctx.inputs.feedback.read())
          text = `${text}+${fb}`
        }
        await Bun.write(ctx.outputs.out.path, text)
      },
    })

    const result = await rules.run()
    expect(result.success).toBe(true)
    // Contract: writing the optional feedback mid-build must re-add consume
    // with the new entry (11.2 step 5 / 11.5). The durable output must include it.
    expect(await Bun.file(path.join(root, "out", "a.txt")).text()).toBe("body+fb")
    const consumeTouched = result.executed
      .concat(result.cancelled)
      .some((t) => t.id === "consume:name=a")
    expect(consumeTouched).toBe(true)
    expect(sawFeedback).toBe(true)
  })

  test("FileGlob list grows mid-build and the consumer re-runs with the new list", async () => {
    const root = await tempDir()
    await mkdir(path.join(root, "src"), { recursive: true })
    await mkdir(path.join(root, "bag", "g"), { recursive: true })
    await writeFile(path.join(root, "src", "g.txt"), "seed")
    await writeFile(path.join(root, "bag", "g", "a.txt"), "A")

    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)
    const listSizes: number[] = []

    rules.rule({
      name: "grow",
      inputs: { src: new FilePattern("src/<bucket>.txt", { root }) },
      outputs: { more: new FileOutput("bag/<bucket>/b.txt", { root }) },
      run: async (ctx) => {
        await Bun.write(ctx.outputs.more.path, "B")
      },
    })

    rules.rule({
      name: "pack",
      inputs: {
        src: new FilePattern("src/<bucket>.txt", { root }),
        bag: new FileGlob("bag/<bucket>/*", { root }),
      },
      outputs: { out: new FileOutput("out/<bucket>.txt", { root }) },
      run: async (ctx) => {
        listSizes.push(ctx.inputs.bag.length)
        const names: string[] = []
        for (const file of ctx.inputs.bag) {
          names.push(path.basename(file.path))
        }
        await Bun.write(ctx.outputs.out.path, names.join(","))
      },
    })

    const result = await rules.run()
    expect(result.success).toBe(true)
    expect(await Bun.file(path.join(root, "out", "g.txt")).text()).toBe("a.txt,b.txt")
    expect(listSizes.includes(2)).toBe(true)
  })

  test("paginate replacement retracts dropped pages and removes their shots", async () => {
    // rewrite depends only on seed/, not on paginate outputs. rewrite and the
    // first paginate may interleave either way; assert only the final net
    // artifact events (Result cannot express "executed then removed after
    // complete"). Run 20 times to shake out interleavings.
    for (let trial = 0; trial < 20; trial++) {
      const root = await tempDir()
      await mkdir(path.join(root, "inbox"), { recursive: true })
      await mkdir(path.join(root, "seed"), { recursive: true })
      // Start with a 3-line inbox so a first paginate can produce page 3.
      // seed is 2 lines; rewrite overwrites inbox without reading pages/.
      await writeFile(path.join(root, "inbox", "doc.txt"), "a\nb\nc")
      await writeFile(path.join(root, "seed", "doc.txt"), "a\nb")

      const build = new Build({ store: new MemoryStore() })
      const rules = new RuleBuild(build)

      const lastEvent = new Map<string, "produced" | "retracted">()
      const shotsPrefix = new PathPrefix(path.join(root, "shots"))
      const pagesPrefix = new PathPrefix(path.join(root, "pages"))
      const stopShots = build.listen(shotsPrefix, (event) => {
        lastEvent.set(event.id, event.type)
      })
      const stopPages = build.listen(pagesPrefix, (event) => {
        lastEvent.set(event.id, event.type)
      })

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
        outputs: { out: new FileOutput("shots/<doc>/<page>.txt", { root }) },
        run: async (ctx) => {
          await Bun.write(ctx.outputs.out.path, await ctx.inputs.page.read())
        },
      })

      rules.rule({
        name: "rewrite",
        inputs: { seed: new FilePattern("seed/<doc>.txt", { root }) },
        outputs: { inbox: new FileOutput("inbox/<doc>.txt", { root }) },
        run: async (ctx) => {
          await Bun.write(ctx.outputs.inbox.path, await ctx.inputs.seed.read())
        },
      })

      const result = await rules.run()
      stopShots()
      stopPages()

      expect(result.success).toBe(true)

      expect(
        await Bun.file(path.join(root, "shots", "doc", "1.txt")).text(),
      ).toBe("a")
      expect(
        await Bun.file(path.join(root, "shots", "doc", "2.txt")).text(),
      ).toBe("b")

      const shot1 = new FileArtifact(path.join(root, "shots", "doc", "1.txt")).id
      const shot2 = new FileArtifact(path.join(root, "shots", "doc", "2.txt")).id
      const shot3 = new FileArtifact(path.join(root, "shots", "doc", "3.txt")).id
      const page3 = new FileArtifact(path.join(root, "pages", "doc", "3.txt")).id

      // Standing shots: last event produced, or produced and never retracted.
      expect(lastEvent.get(shot1)).toBe("produced")
      expect(lastEvent.get(shot2)).toBe("produced")

      // Page 3 / shot 3: never produced, or last event retracted.
      const shot3Last = lastEvent.get(shot3)
      expect(shot3Last === undefined || shot3Last === "retracted").toBe(true)

      const page3Last = lastEvent.get(page3)
      expect(page3Last === undefined || page3Last === "retracted").toBe(true)
    }
  })

  test("rewriting an output mid-build re-runs downstream", async () => {
    const root = await tempDir()
    await mkdir(path.join(root, "src"), { recursive: true })
    await writeFile(path.join(root, "src", "a.txt"), "v1")

    const store = new JsonStore(path.join(root, "state.json"))
    const build = new Build({ store })
    const rules = new RuleBuild(build)
    let makeRuns = 0
    let useBodies: string[] = []

    rules.rule({
      name: "make",
      inputs: { src: new FilePattern("src/<name>.txt", { root }) },
      outputs: { mid: new FileOutput("mid/<name>.txt", { root }) },
      run: async (ctx) => {
        makeRuns += 1
        const body = new TextDecoder().decode(await ctx.inputs.src.read())
        await Bun.write(ctx.outputs.mid.path, `mid:${body}`)
      },
    })

    rules.rule({
      name: "use",
      inputs: { mid: new FilePattern("mid/<name>.txt", { root }) },
      outputs: { out: new FileOutput("out/<name>.txt", { root }) },
      run: async (ctx) => {
        const text = new TextDecoder().decode(await ctx.inputs.mid.read())
        useBodies.push(text)
        await Bun.write(ctx.outputs.out.path, text)
      },
    })

    // First complete run
    const first = await rules.run()
    expect(first.success).toBe(true)
    expect(makeRuns).toBe(1)
    expect(useBodies).toEqual(["mid:v1"])

    // Second build: change src so make rewrites mid; use must execute again
    await writeFile(path.join(root, "src", "a.txt"), "v2")
    const build2 = new Build({ store })
    const rules2 = new RuleBuild(build2)
    useBodies = []
    rules2.rule({
      name: "make",
      inputs: { src: new FilePattern("src/<name>.txt", { root }) },
      outputs: { mid: new FileOutput("mid/<name>.txt", { root }) },
      run: async (ctx) => {
        makeRuns += 1
        const body = new TextDecoder().decode(await ctx.inputs.src.read())
        await Bun.write(ctx.outputs.mid.path, `mid:${body}`)
      },
    })
    rules2.rule({
      name: "use",
      inputs: { mid: new FilePattern("mid/<name>.txt", { root }) },
      outputs: { out: new FileOutput("out/<name>.txt", { root }) },
      run: async (ctx) => {
        const text = new TextDecoder().decode(await ctx.inputs.mid.read())
        useBodies.push(text)
        await Bun.write(ctx.outputs.out.path, text)
      },
    })

    const second = await rules2.run()
    expect(second.success).toBe(true)
    expect(sortedIds(second.executed)).toEqual(["make:name=a", "use:name=a"])
    expect(useBodies).toEqual(["mid:v2"])
    expect(await Bun.file(path.join(root, "out", "a.txt")).text()).toBe("mid:v2")
  })

  test("same generator instance in two inputs and in two rules", async () => {
    const root = await tempDir()
    await mkdir(path.join(root, "src"), { recursive: true })
    await writeFile(path.join(root, "src", "a.txt"), "A")
    await writeFile(path.join(root, "src", "b.txt"), "B")

    const shared = new FilePattern("src/<name>.txt", { root })
    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)

    rules.rule({
      name: "copy-a",
      inputs: { src: shared },
      outputs: { out: new FileOutput("out-a/<name>.txt", { root }) },
      run: async (ctx) => {
        await Bun.write(ctx.outputs.out.path, await ctx.inputs.src.read())
      },
    })

    rules.rule({
      name: "copy-b",
      inputs: { src: shared },
      outputs: { out: new FileOutput("out-b/<name>.txt", { root }) },
      run: async (ctx) => {
        await Bun.write(ctx.outputs.out.path, await ctx.inputs.src.read())
      },
    })

    // two inputs of one rule share one instance (cross product on same table
    // would be wrong; same var name joins with itself — one task per name)
    rules.rule({
      name: "echo-twice",
      inputs: { left: shared, right: shared },
      outputs: { out: new FileOutput("out-both/<name>.txt", { root }) },
      run: async (ctx) => {
        const left = new TextDecoder().decode(await ctx.inputs.left.read())
        const right = new TextDecoder().decode(await ctx.inputs.right.read())
        await Bun.write(ctx.outputs.out.path, `${left}|${right}`)
      },
    })

    const result = await rules.run()
    expect(result.success).toBe(true)
    expect(sortedIds(result.executed)).toEqual([
      "copy-a:name=a",
      "copy-a:name=b",
      "copy-b:name=a",
      "copy-b:name=b",
      "echo-twice:name=a",
      "echo-twice:name=b",
    ])
    expect(await Bun.file(path.join(root, "out-both", "a.txt")).text()).toBe("A|A")
  })

  test("diamond: one producer fans out then joins", async () => {
    const root = await tempDir()
    await mkdir(path.join(root, "src"), { recursive: true })
    await writeFile(path.join(root, "src", "x.txt"), "X")

    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)

    rules.rule({
      name: "root",
      inputs: { src: new FilePattern("src/<name>.txt", { root }) },
      outputs: { mid: new FileOutput("mid/<name>.txt", { root }) },
      run: async (ctx) => {
        await Bun.write(ctx.outputs.mid.path, "M")
      },
    })

    rules.rule({
      name: "left",
      inputs: { mid: new FilePattern("mid/<name>.txt", { root }) },
      outputs: { out: new FileOutput("left/<name>.txt", { root }) },
      run: async (ctx) => {
        await Bun.write(ctx.outputs.out.path, "L")
      },
    })

    rules.rule({
      name: "right",
      inputs: { mid: new FilePattern("mid/<name>.txt", { root }) },
      outputs: { out: new FileOutput("right/<name>.txt", { root }) },
      run: async (ctx) => {
        await Bun.write(ctx.outputs.out.path, "R")
      },
    })

    rules.rule({
      name: "join",
      inputs: {
        left: new FilePattern("left/<name>.txt", { root }),
        right: new FilePattern("right/<name>.txt", { root }),
      },
      outputs: { out: new FileOutput("out/<name>.txt", { root }) },
      run: async (ctx) => {
        const l = new TextDecoder().decode(await ctx.inputs.left.read())
        const r = new TextDecoder().decode(await ctx.inputs.right.read())
        await Bun.write(ctx.outputs.out.path, `${l}${r}`)
      },
    })

    const result = await rules.run()
    expect(result.success).toBe(true)
    expect(sortedIds(result.executed)).toEqual([
      "join:name=x",
      "left:name=x",
      "right:name=x",
      "root:name=x",
    ])
    expect(await Bun.file(path.join(root, "out", "x.txt")).text()).toBe("LR")
  })

  test("two rules that declare the same output make Build.add throw", async () => {
    const root = await tempDir()
    await mkdir(path.join(root, "src"), { recursive: true })
    await writeFile(path.join(root, "src", "a.txt"), "A")

    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)

    rules.rule({
      name: "one",
      inputs: { src: new FilePattern("src/<name>.txt", { root }) },
      outputs: { out: new FileOutput("clash/<name>.txt", { root }) },
      run: async (ctx) => {
        await Bun.write(ctx.outputs.out.path, "one")
      },
    })

    rules.rule({
      name: "two",
      inputs: { src: new FilePattern("src/<name>.txt", { root }) },
      outputs: { out: new FileOutput("clash/<name>.txt", { root }) },
      run: async (ctx) => {
        await Bun.write(ctx.outputs.out.path, "two")
      },
    })

    let threw = false
    let message = ""
    try {
      await rules.run()
    } catch (err) {
      threw = true
      if (err instanceof Error) {
        message = err.message
      }
    }
    expect(threw).toBe(true)
    expect(message.length).toBeGreaterThan(0)
  })

  test("optional input that matches the rule's own output still finishes", async () => {
    // Contract: optional input path == output path. Each successful write
    // produces the file, the optional generator sets the entry, RuleBuild
    // re-adds the task (11.2 step 5). The loop stops only when the content
    // check skips (same input/output stamps in the store sense / skip rules).
    //
    // Bound: runs <= 3.
    //   1) first run: self is undefined, writes "no-self"
    //   2) re-add: self is set, writes "with-self"
    //   3) at most one more re-add before content-skip can stop the loop
    // A fourth run means the content check is not stopping the replace loop.
    const root = await tempDir()
    await mkdir(path.join(root, "src"), { recursive: true })
    await writeFile(path.join(root, "src", "a.txt"), "A")

    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)
    let runs = 0
    let lastHadSelf: boolean | undefined

    rules.rule({
      name: "selfish",
      inputs: {
        src: new FilePattern("src/<name>.txt", { root }),
        self: new FilePattern("out/<name>.txt", { root }),
      },
      optional: ["self"],
      outputs: { out: new FileOutput("out/<name>.txt", { root }) },
      run: async (ctx) => {
        runs += 1
        lastHadSelf = ctx.inputs.self !== undefined
        const body = lastHadSelf ? "with-self" : "no-self"
        await Bun.write(ctx.outputs.out.path, body)
      },
    })

    const result = await rules.run()
    expect(result.success).toBe(true)
    expect(runs).toBeGreaterThanOrEqual(1)
    expect(runs).toBeLessThanOrEqual(3)
    expect(lastHadSelf).toBe(true)
    expect(await Bun.file(path.join(root, "out", "a.txt")).text()).toBe("with-self")
  })

  test("var values with dash, dot, space, and unicode become distinct tasks", async () => {
    const root = await tempDir()
    const names = ["a-b", "a.b", "a b", "café"]
    await mkdir(path.join(root, "src"), { recursive: true })
    for (const name of names) {
      await writeFile(path.join(root, "src", `${name}.txt`), name)
    }

    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)
    rules.rule({
      name: "copy",
      inputs: { src: new FilePattern("src/<name>.txt", { root }) },
      outputs: { out: new FileOutput("out/<name>.txt", { root }) },
      run: async (ctx) => {
        await Bun.write(ctx.outputs.out.path, await ctx.inputs.src.read())
      },
    })

    const result = await rules.run()
    expect(result.success).toBe(true)
    expect(sortedIds(result.executed)).toEqual([
      "copy:name=a b",
      "copy:name=a-b",
      "copy:name=a.b",
      "copy:name=café",
    ])
    for (const name of names) {
      expect(await Bun.file(path.join(root, "out", `${name}.txt`)).text()).toBe(name)
    }
  })

  test("deep literal template start only walks under that prefix", async () => {
    const root = await tempDir()
    await mkdir(path.join(root, "a", "b", "c", "d"), { recursive: true })
    await mkdir(path.join(root, "noise"), { recursive: true })
    await writeFile(path.join(root, "a", "b", "c", "d", "x.txt"), "deep")
    await writeFile(path.join(root, "noise", "x.txt"), "no")

    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)
    rules.rule({
      name: "deep",
      inputs: { src: new FilePattern("a/b/c/d/<name>.txt", { root }) },
      outputs: { out: new FileOutput("out/<name>.txt", { root }) },
      run: async (ctx) => {
        await Bun.write(ctx.outputs.out.path, await ctx.inputs.src.read())
      },
    })

    const result = await rules.run()
    expect(result.success).toBe(true)
    expect(sortedIds(result.executed)).toEqual(["deep:name=x"])
    expect(await Bun.file(path.join(root, "out", "x.txt")).text()).toBe("deep")
  })

  test("200 x 5 cross product finishes quickly with exact task count", async () => {
    const root = await tempDir()
    const xs: string[] = []
    const ys: string[] = []
    for (let i = 0; i < 200; i++) {
      xs.push(`x${i}`)
    }
    for (let j = 0; j < 5; j++) {
      ys.push(`y${j}`)
    }

    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)
    rules.rule({
      name: "fan",
      inputs: {
        left: new Values("x", xs),
        right: new Values("y", ys),
      },
      outputs: { out: new FileOutput("out/<x>-<y>.txt", { root }) },
      run: async (ctx) => {
        await Bun.write(ctx.outputs.out.path, "1")
      },
    })

    const started = Date.now()
    const result = await rules.run()
    const elapsed = Date.now() - started

    expect(result.success).toBe(true)
    expect(result.executed.length).toBe(1000)
    expect(elapsed).toBeLessThan(10_000)
  })

  test("entry deleted then set again in one listen callback uses the new value", async () => {
    const root = await tempDir()
    await mkdir(path.join(root, "kick"), { recursive: true })
    await writeFile(path.join(root, "kick", "go.txt"), "go")

    class FlipFlop extends InputGen<ValueArtifact> {
      readonly varNames: readonly string[] = ["k"]

      async start(feed: Feed<ValueArtifact>): Promise<void> {
        feed.set({ k: "1" }, new ValueArtifact("k", "first"))
        feed.listen(new PathPrefix(path.join(root, "mark")), (event) => {
          if (event.type !== "produced") return
          feed.delete({ k: "1" })
          feed.set({ k: "1" }, new ValueArtifact("k", "second"))
        })
      }
    }

    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)
    const bodies: string[] = []

    rules.rule({
      name: "kick",
      inputs: { go: new FilePattern("kick/<name>.txt", { root }) },
      outputs: { mark: new FileOutput("mark/<name>.txt", { root }) },
      run: async (ctx) => {
        await Bun.write(ctx.outputs.mark.path, "kicked")
      },
    })

    rules.rule({
      name: "use",
      inputs: { item: new FlipFlop() },
      outputs: { out: new FileOutput("out/<k>.txt", { root }) },
      run: async (ctx) => {
        bodies.push(ctx.inputs.item.value)
        await Bun.write(ctx.outputs.out.path, ctx.inputs.item.value)
      },
    })

    const result = await rules.run()
    expect(result.success).toBe(true)
    expect(bodies.includes("second")).toBe(true)
    expect(await Bun.file(path.join(root, "out", "1.txt")).text()).toBe("second")
  })

  test("task re-added while running is cancelled with replaced and the new run wins", async () => {
    const root = await tempDir()
    await mkdir(path.join(root, "src"), { recursive: true })
    await writeFile(path.join(root, "src", "a.txt"), "v1")

    class SlowGate extends InputGen<ValueArtifact> {
      readonly varNames: readonly string[] = ["name"]

      async start(feed: Feed<ValueArtifact>): Promise<void> {
        feed.set({ name: "a" }, new ValueArtifact("name", "v1"))
        feed.listen(new PathPrefix(path.join(root, "bump")), (event) => {
          if (event.type !== "produced") return
          feed.set({ name: "a" }, new ValueArtifact("name", "v2"))
        })
      }
    }

    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)
    const gate = new SlowGate()
    const seen: string[] = []

    rules.rule({
      name: "bump",
      inputs: { src: new FilePattern("src/<name>.txt", { root }) },
      outputs: { mark: new FileOutput("bump/<name>.txt", { root }) },
      run: async (ctx) => {
        // small delay so the slow task can be running when we change the feed
        await Bun.sleep(20)
        await Bun.write(ctx.outputs.mark.path, "bump")
      },
    })

    rules.rule({
      name: "slow",
      inputs: { gate },
      outputs: { out: new FileOutput("out/<name>.txt", { root }) },
      run: async (ctx) => {
        const value = ctx.inputs.gate.value
        seen.push(`start:${value}`)
        await Bun.sleep(80)
        if (ctx.signal.aborted) {
          seen.push(`aborted:${value}`)
          return
        }
        seen.push(`write:${value}`)
        await Bun.write(ctx.outputs.out.path, value)
      },
    })

    const result = await rules.run()
    expect(result.success).toBe(true)
    expect(result.cancelled.some((t) => t.id === "slow:name=a")).toBe(true)
    expect(await Bun.file(path.join(root, "out", "a.txt")).text()).toBe("v2")
    expect(seen.includes("write:v2")).toBe(true)
  })
})
