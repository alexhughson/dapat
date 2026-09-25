import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Artifact, Build, MemoryStore } from "../../src"
import {
  FileOutput,
  FilePattern,
  InputGen,
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
  const dir = await mkdtemp(path.join(tmpdir(), "dapat-adv-"))
  temps.push(dir)
  return dir
}

class Blob extends Artifact<string> {
  constructor(
    readonly id: string,
    private readonly body: string = id,
  ) {
    super()
  }
  async orderStamp(): Promise<bigint | null> {
    return null
  }
  async contentStamp(): Promise<string | null> {
    return this.body
  }
  async read(): Promise<string> {
    return this.body
  }
}

class Values extends InputGen<Blob> {
  readonly varNames: readonly string[]
  constructor(
    private readonly name: string,
    private readonly values: string[],
  ) {
    super()
    this.varNames = [name]
  }
  async start(feed: Feed<Blob>): Promise<void> {
    for (const value of this.values) {
      feed.set({ [this.name]: value }, new Blob(`v:${value}`, value))
    }
  }
}

class ZeroVar extends InputGen<Blob> {
  readonly varNames = [] as const
  constructor(private readonly present: boolean) {
    super()
  }
  async start(feed: Feed<Blob>): Promise<void> {
    if (this.present) {
      feed.set({}, new Blob("zero", "z"))
    }
  }
}

describe("adv RuleBuild sync", () => {
  test("same generator instance in two rules: both rules get tasks", async () => {
    const root = await tempDir()
    const shared = new Values("n", ["a"])
    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)
    const seen: string[] = []

    rules.rule({
      name: "r1",
      inputs: { v: shared },
      outputs: { out: new FileOutput("r1/<n>.txt", { root }) },
      run: async (ctx) => {
        seen.push("r1")
        await Bun.write(ctx.outputs.out.path, "1")
      },
    })
    rules.rule({
      name: "r2",
      inputs: { v: shared },
      outputs: { out: new FileOutput("r2/<n>.txt", { root }) },
      run: async (ctx) => {
        seen.push("r2")
        await Bun.write(ctx.outputs.out.path, "2")
      },
    })

    const result = await rules.run()
    expect(result.success).toBe(true)
    expect(seen.sort()).toEqual(["r1", "r2"])
  })

  test("same generator instance as two inputs of one rule", async () => {
    const root = await tempDir()
    const shared = new Values("n", ["a"])
    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)
    let saw: { a?: string; b?: string } = {}

    rules.rule({
      name: "pair",
      inputs: { a: shared, b: shared },
      outputs: { out: new FileOutput("pair/<n>.txt", { root }) },
      run: async (ctx) => {
        saw = {
          a: await ctx.inputs.a.read(),
          b: await ctx.inputs.b.read(),
        }
        await Bun.write(ctx.outputs.out.path, "ok")
      },
    })

    const result = await rules.run()
    expect(result.success).toBe(true)
    expect(saw).toEqual({ a: "a", b: "a" })
  })

  test("required zero-var generator missing: no tasks", async () => {
    const root = await tempDir()
    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)
    let ran = false
    rules.rule({
      name: "need-zero",
      inputs: {
        z: new ZeroVar(false),
        n: new Values("n", ["a"]),
      },
      outputs: { out: new FileOutput("out/<n>.txt", { root }) },
      run: async () => {
        ran = true
      },
    })
    const result = await rules.run()
    expect(ran).toBe(false)
    expect(result.executed.length).toBe(0)
  })

  test("required zero-var generator present: every task gets it", async () => {
    const root = await tempDir()
    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)
    const got: string[] = []
    rules.rule({
      name: "with-zero",
      inputs: {
        z: new ZeroVar(true),
        n: new Values("n", ["a", "b"]),
      },
      outputs: { out: new FileOutput("out/<n>.txt", { root }) },
      run: async (ctx) => {
        got.push(`${ctx.vars.n}:${await ctx.inputs.z.read()}`)
        await Bun.write(ctx.outputs.out.path, "x")
      },
    })
    await rules.run()
    expect(got.sort()).toEqual(["a:z", "b:z"])
  })

  test("entry deleted: live task is removed", async () => {
    const root = await tempDir()
    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)

    class Dropping extends InputGen<Blob> {
      readonly varNames = ["n"] as const
      async start(feed: Feed<Blob>): Promise<void> {
        feed.set({ n: "a" }, new Blob("src:a"))
        feed.listen(new PathPrefix(path.join(root, "mark")), (event) => {
          if (event.type === "produced") feed.delete({ n: "a" })
        })
      }
    }

    const bodies: string[] = []
    rules.rule({
      name: "pack",
      inputs: { src: new Dropping() },
      outputs: { out: new FileOutput("out/<n>.txt", { root }) },
      run: async (ctx) => {
        bodies.push("pack")
        await Bun.write(ctx.outputs.out.path, "p")
      },
    })
    rules.rule({
      name: "marker",
      inputs: { out: new FilePattern("out/<n>.txt", { root }) },
      outputs: { mark: new FileOutput("mark/<n>.txt", { root }) },
      run: async (ctx) => {
        await Bun.write(ctx.outputs.mark.path, "m")
      },
    })

    // After delete, pack should be removed; a second rematch must not run pack again
    // without the entry. Marker may still run once.
    await rules.run()
    expect(bodies).toEqual(["pack"])
  })

  test("2000 files x 1 rule: one full build time", async () => {
    const root = await tempDir()
    await mkdir(path.join(root, "src"), { recursive: true })
    for (let i = 0; i < 2000; i++) {
      await writeFile(path.join(root, "src", `${i}.txt`), `b${i}`)
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

    const t0 = performance.now()
    const result = await rules.run()
    const ms = performance.now() - t0
    console.log(`adv-perf 2000 files x 1 rule: ${ms.toFixed(1)}ms`)
    expect(result.success).toBe(true)
    expect(result.executed.length + result.skipped.length).toBe(2000)
    // Soft ceiling: join is O(n) here (one required input). Fail if pathological.
    expect(ms).toBeLessThan(60_000)
  })
})
