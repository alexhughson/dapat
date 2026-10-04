import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Artifact, Build, IdPrefix, MemoryStore, Task } from "../../src"
import { FileOutput, InputGen, RuleBuild, type Feed } from "../../contrib"

class Blob extends Artifact<string> {
  constructor(readonly id: string) {
    super()
  }
  async orderStamp(): Promise<bigint | null> {
    return null
  }
  async contentStamp(): Promise<string | null> {
    return this.id
  }
  async read(): Promise<string> {
    return this.id
  }
}

const temps: string[] = []
afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dapat-adv2-idle-"))
  temps.push(dir)
  return dir
}

describe("adv2 idle / double run", () => {
  test("run() does not resolve while a listener delivery is in flight", async () => {
    const build = new Build()
    const out = new Blob("i:1")
    let listenerDone = false
    let runResolvedBeforeListener = false

    build.listen(new IdPrefix("i:"), async () => {
      await Bun.sleep(40)
      listenerDone = true
    })

    build.add(
      new Task({
        id: "w",
        outputs: [out],
        run: async () => {},
      }),
    )

    const finished = build.run().then((r) => {
      if (!listenerDone) runResolvedBeforeListener = true
      return r
    })
    await finished
    expect(listenerDone).toBe(true)
    expect(runResolvedBeforeListener).toBe(false)
  })

  test("second run() on same Build does not re-execute completed tasks", async () => {
    const build = new Build()
    const out = new Blob("s:1")
    let runs = 0
    build.add(
      new Task({
        id: "once",
        outputs: [out],
        run: async () => {
          runs += 1
        },
      }),
    )
    await build.run()
    await build.run()
    expect(runs).toBe(1)
  })
})

describe("adv2 RuleBuild feed guard", () => {
  test("async listen callback may await then feed.set", async () => {
    const root = await tempDir()
    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)
    const names: string[] = []

    class LateSet extends InputGen<Blob> {
      readonly varNames = ["n"] as const
      async start(feed: Feed<Blob>): Promise<void> {
        feed.set({ n: "a" }, new Blob("src:a"))
        feed.listen(new IdPrefix("ping:"), async (event) => {
          if (event.type !== "produced") return
          await Bun.sleep(5)
          feed.set({ n: "b" }, new Blob("src:b"))
        })
      }
    }

    rules.rule({
      name: "pack",
      inputs: { src: new LateSet() },
      outputs: { out: new FileOutput("out/<n>.txt", { root }) },
      run: async (ctx) => {
        names.push(ctx.vars.n!)
        await Bun.write(ctx.outputs.out.path, ctx.vars.n!)
      },
    })

    await rules.load()
    build.add(
      new Task({
        id: "pinger",
        outputs: [new IdPrefix("ping:")],
        run: async (ctx) => {
          ctx.produced(new Blob("ping:1"))
        },
      }),
    )
    await build.run()
    expect(names).toContain("a")
    expect(names).toContain("b")
  })

  test("same generator two inputs: feed.set on other slot during overlap", async () => {
    const root = await tempDir()
    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)
    const errors: string[] = []
    const ok: string[] = []

    class Shared extends InputGen<Blob> {
      readonly varNames = ["n"] as const
      private feeds: Feed<Blob>[] = []

      async start(feed: Feed<Blob>): Promise<void> {
        this.feeds.push(feed)
        const label = String(this.feeds.length)
        feed.set({ n: label }, new Blob(`src:${label}`))
        feed.listen(new IdPrefix("go:"), async (event) => {
          if (event.type !== "produced") return
          await Bun.sleep(10)
          try {
            feed.set({ n: `${label}s` }, new Blob(`src:${label}s`))
            ok.push(`self:${label}`)
          } catch (error) {
            errors.push(`self:${String(error)}`)
          }
          const other = this.feeds.find((f) => f !== feed)
          if (!other) return
          try {
            other.set({ n: `${label}o` }, new Blob(`src:${label}o`))
            ok.push(`cross:${label}`)
          } catch (error) {
            errors.push(
              error instanceof Error ? error.message : String(error),
            )
          }
        })
      }
    }

    const shared = new Shared()
    rules.rule({
      name: "pair",
      inputs: { left: shared, right: shared },
      outputs: { out: new FileOutput("out/<n>.txt", { root }) },
      run: async (ctx) => {
        await Bun.write(ctx.outputs.out.path, "x")
      },
    })

    await rules.load()
    build.add(
      new Task({
        id: "go",
        outputs: [new IdPrefix("go:")],
        run: async (ctx) => {
          ctx.produced(new Blob("go:1"))
        },
      }),
    )
    await build.run()

    expect(ok.some((s) => s.startsWith("self:"))).toBe(true)
    // Per-slot inCallback: setting the other feed while only this slot is
    // marked inCallback must throw (both callbacks overlap on the same event).
    expect(errors.some((e) => e.includes("feed.set"))).toBe(true)
  })
})
