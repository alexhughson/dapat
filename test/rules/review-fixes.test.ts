import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Artifact, Build, IdPrefix, MemoryStore, Task } from "../../src"
import {
  FileOutput,
  FilePattern,
  InputGen,
  JsonStore,
  PathPrefix,
  RuleBuild,
  capture,
  FieldGen,
  type Feed,
  type FieldRecord,
  type FieldSpec,
} from "../../contrib"
import type { Stamp, TaskState } from "../../src/store"
import type { Outcome } from "../../src/result"

const temps: string[] = []

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dapat-review-"))
  temps.push(dir)
  return dir
}

class Blob extends Artifact<string> {
  constructor(
    readonly id: string,
    private readonly stamp: string = id,
  ) {
    super()
  }
  async orderStamp(): Promise<bigint | null> {
    return 1n
  }
  async contentStamp(): Promise<string | null> {
    return this.stamp
  }
  async read(): Promise<string> {
    return this.stamp
  }
}

describe("replacement never order-skips when optional disappears", () => {
  async function runCase(useStore: boolean): Promise<void> {
    const root = await tempDir()
    const store = useStore ? new MemoryStore() : undefined
    const build = new Build(store ? { store } : undefined)
    const rules = new RuleBuild(build)
    const bodies: string[] = []

    class Src extends InputGen<Blob> {
      readonly varNames = ["name"] as const
      async start(feed: Feed<Blob>): Promise<void> {
        feed.set({ name: "a" }, new Blob("src:a", "src-v1"))
      }
    }

    class Opt extends InputGen<Blob> {
      readonly varNames = ["name"] as const
      async start(feed: Feed<Blob>): Promise<void> {
        feed.set({ name: "a" }, new Blob("opt:a", "opt-v1"))
        // Dropper's FileOutput announce covers this prefix; delete then rematch.
        feed.listen(new PathPrefix(path.join(root, "markers")), (event) => {
          if (event.type !== "produced") return
          feed.delete({ name: "a" })
        })
      }
    }

    rules.rule({
      name: "pack",
      inputs: { src: new Src(), opt: new Opt() },
      optional: ["opt"],
      outputs: { out: new FileOutput("out/<name>.txt", { root }) },
      run: async (ctx) => {
        let text = "src"
        if (ctx.inputs.opt !== undefined) {
          text += "+opt"
        }
        bodies.push(text)
        await Bun.write(ctx.outputs.out.path, text)
      },
    })

    // After pack writes out/, write a marker so Opt deletes and pack rematches.
    rules.rule({
      name: "dropper",
      inputs: { out: new FilePattern("out/<name>.txt", { root }) },
      outputs: { marker: new FileOutput("markers/<name>.txt", { root }) },
      run: async (ctx) => {
        await Bun.write(ctx.outputs.marker.path, "dropped")
      },
    })

    const result = await rules.run()
    expect(result.success).toBe(true)
    expect(bodies[0]).toBe("src+opt")
    // Rematch after optional disappeared must run (not order-skip on out/).
    expect(bodies).toContain("src")
    expect(await Bun.file(path.join(root, "out", "a.txt")).text()).toBe("src")
  }

  test("with no store", async () => {
    await runCase(false)
  })

  test("with MemoryStore", async () => {
    await runCase(true)
  })
})

describe("remove during announce", () => {
  test("ends as cancelled with reason removed, not replaced", async () => {
    const build = new Build()
    // Soft stamps so decideSkip does not order-skip before announce.
    class Soft extends Artifact<string> {
      constructor(readonly id: string) {
        super()
      }
      async orderStamp(): Promise<bigint | null> {
        return null
      }
      async contentStamp(): Promise<string | null> {
        return null
      }
      async read(): Promise<string> {
        return this.id
      }
    }
    const page = new Soft("map:pages/1")
    const prefix = new IdPrefix("map:pages/")

    build.listen(prefix, (event) => {
      if (event.type === "produced" && event.id === page.id) {
        build.remove("writer")
      }
    })

    const writer = new Task({
      id: "writer",
      outputs: [page],
      run: async () => {},
    })
    build.add(writer)

    const result = await build.run()
    expect(result.cancelled.some((t) => t.id === "writer")).toBe(true)
    expect(result.executed.some((t) => t.id === "writer")).toBe(false)
    expect(result.skipped.some((t) => t.id === "writer")).toBe(false)

    const outcomes = (
      build as unknown as { outcomes: Map<Task, Outcome> }
    ).outcomes
    expect(outcomes.get(writer)).toEqual({
      type: "cancelled",
      reason: "removed",
    })
  })
})

describe("listener errors", () => {
  test("build.run rejects when a listener throws", async () => {
    const build = new Build()
    const prefix = new IdPrefix("map:x/")
    build.listen(prefix, () => {
      throw new Error("listener boom")
    })
    build.add(
      new Task({
        id: "w",
        outputs: [prefix],
        run: async (ctx) => {
          ctx.produced(new Blob("map:x/1"))
        },
      }),
    )
    await expect(build.run()).rejects.toThrow("listener boom")
  })
})

describe("JsonStore write lock", () => {
  test("parallel set calls on one path all persist", async () => {
    const root = await tempDir()
    const filePath = path.join(root, "state.json")
    const store = new JsonStore(filePath)

    const writes: Promise<void>[] = []
    for (let i = 0; i < 40; i++) {
      const id = `task-${i}`
      const state: TaskState = {
        inputStamps: {},
        outputStamps: {
          [`out:${i}`]: { content: `c${i}`, order: BigInt(i) } as Stamp,
        },
      }
      writes.push(store.set(id, state))
    }
    await Promise.all(writes)

    for (let i = 0; i < 40; i++) {
      const got = await store.get(`task-${i}`)
      expect(got).not.toBeNull()
      expect(got!.outputStamps[`out:${i}`]?.content).toBe(`c${i}`)
    }
  })
})

describe("RuleBuild feed after start", () => {
  test("setTimeout feed.set throws; generator catches it", async () => {
    let lateError: Error | null = null

    class Late extends InputGen<Blob> {
      readonly varNames = ["n"] as const

      async start(feed: Feed<Blob>): Promise<void> {
        feed.set({ n: "1" }, new Blob("late:1"))
        setTimeout(() => {
          try {
            feed.set({ n: "2" }, new Blob("late:2"))
          } catch (error) {
            lateError =
              error instanceof Error ? error : new Error(String(error))
          }
        }, 20)
      }
    }

    const root = await tempDir()
    const build = new Build()
    const rules = new RuleBuild(build)
    rules.rule({
      name: "one",
      inputs: { v: new Late() },
      outputs: { out: new FileOutput("out/<n>.txt", { root }) },
      run: async (ctx) => {
        await Bun.write(ctx.outputs.out.path, "ok")
      },
    })

    const result = await rules.run()
    expect(result.success).toBe(true)
    await Bun.sleep(50)
    expect(lateError).not.toBeNull()
    expect(lateError!.message).toMatch(/inside a listen callback/)
  })
})

describe("FieldGen rejects undefined spec values", () => {
  test("constructor throws for explicit undefined", () => {
    type F = "branch" | "commit"
    class Rows extends FieldGen<F, "commit", Blob, FieldSpec<F>> {
      constructor(spec: FieldSpec<F>) {
        super(spec, ["commit"])
      }
      protected async records(): Promise<FieldRecord<F, Blob>[]> {
        return []
      }
    }
    expect(() => {
      new Rows({ branch: undefined, commit: capture("sha") })
    }).toThrow(/must not be undefined/)
  })
})

describe("walkFiles errors", () => {
  test("ENOENT on missing root returns empty; other errors rethrow", async () => {
    const { walkFiles } = await import("../../contrib/fs/walk")
    const { chmod, mkdir } = await import("node:fs/promises")

    const missing = path.join(await tempDir(), "no-such-dir")
    expect(await walkFiles(missing)).toEqual([])

    const blocked = await tempDir()
    const locked = path.join(blocked, "locked")
    await mkdir(locked)
    await chmod(locked, 0o000)
    try {
      await expect(walkFiles(locked)).rejects.toThrow()
    } finally {
      await chmod(locked, 0o755)
    }
  })
})
