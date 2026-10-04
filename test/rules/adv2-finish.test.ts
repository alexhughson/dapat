import { describe, expect, test } from "bun:test"
import { Artifact, Build, IdPrefix, MemoryStore, Task } from "../../src"

class Blob extends Artifact<string> {
  constructor(
    readonly id: string,
    private content: string = id,
  ) {
    super()
  }
  async orderStamp(): Promise<bigint | null> {
    return null
  }
  async contentStamp(): Promise<string | null> {
    return this.content
  }
  async read(): Promise<string> {
    return this.content
  }
}

describe("adv2 finish / runningCount", () => {
  test("remove during announce: cancelled once; later tasks still run", async () => {
    const build = new Build()
    const out = new Blob("w:out")
    const laterOut = new Blob("later:out")

    build.listen(new IdPrefix("w:"), (event) => {
      if (event.type === "produced") build.remove("writer")
    })

    const writer = new Task({
      id: "writer",
      outputs: [out],
      run: async () => {},
    })
    build.add(writer)
    build.add(
      new Task({
        id: "later",
        outputs: [laterOut],
        run: async () => {},
      }),
    )

    const result = await Promise.race([
      build.run(),
      Bun.sleep(2000).then(() => {
        throw new Error("hang: remove during announce")
      }),
    ])
    expect(result.cancelled).toContain(writer)
    expect(result.executed.some((t) => t.id === "writer")).toBe(false)
    expect(result.executed.some((t) => t.id === "later")).toBe(true)
  })

  test("replace during announce: old cancelled once, replacement runs once", async () => {
    const build = new Build()
    const out = new Blob("r:out")
    const oldTask = new Task({
      id: "job",
      outputs: [out],
      run: async () => {},
    })
    let replacements = 0
    let replaced = false

    build.listen(new IdPrefix("r:"), (event) => {
      if (event.type !== "produced") return
      if (replaced) return
      replaced = true
      build.add(
        new Task({
          id: "job",
          outputs: [new Blob("r:out2")],
          run: async () => {
            replacements += 1
          },
        }),
      )
    })

    build.add(oldTask)
    const result = await Promise.race([
      build.run(),
      Bun.sleep(2000).then(() => {
        throw new Error("hang: replace during announce")
      }),
    ])

    expect(result.cancelled).toContain(oldTask)
    expect(result.executed).not.toContain(oldTask)
    expect(replacements).toBe(1)
  })

  test("remove while waiting for inputs: body does not run; cancelled", async () => {
    const build = new Build()
    const depOut = new Blob("dep:out")
    const victimOut = new Blob("victim:out")
    let victimRan = false
    let release!: () => void
    const hold = new Promise<void>((r) => {
      release = r
    })

    build.add(
      new Task({
        id: "dep",
        outputs: [depOut],
        run: async () => {
          await hold
        },
      }),
    )
    const victim = new Task({
      id: "victim",
      inputs: [depOut],
      outputs: [victimOut],
      run: async () => {
        victimRan = true
      },
    })
    build.add(victim)

    const running = build.run()
    await Bun.sleep(15)
    build.remove("victim")
    release()
    const result = await running

    expect(victimRan).toBe(false)
    expect(result.cancelled).toContain(victim)
    expect(result.executed).not.toContain(victim)
  })

  test("remove during decideSkip (slow output stamp): body does not run", async () => {
    const store = new MemoryStore()
    const in1 = new Blob("in:skip", "v1")
    const out1 = new Blob("out:skip", "o1")
    const seed = new Build({ store })
    seed.add(
      new Task({
        id: "job",
        inputs: [in1],
        outputs: [out1],
        run: async () => {},
      }),
    )
    await seed.run()

    let release!: () => void
    const hold = new Promise<void>((r) => {
      release = r
    })
    let ran = false

    class SlowOut extends Artifact<string> {
      readonly id = "out:skip"
      async orderStamp() {
        return null
      }
      async contentStamp() {
        await hold
        return "o1"
      }
      async read() {
        return "o1"
      }
    }

    const build = new Build({ store })
    const job = new Task({
      id: "job",
      inputs: [new Blob("in:skip", "v1")],
      outputs: [new SlowOut()],
      run: async () => {
        ran = true
      },
    })
    build.add(job)

    const running = build.run()
    await Bun.sleep(15)
    build.remove("job")
    release()
    const result = await running

    expect(ran).toBe(false)
    expect(result.cancelled).toContain(job)
  })

  test("abort then throw in body: cancelled, not failed", async () => {
    const build = new Build()
    const out = new Blob("x:1")
    let armed!: () => void
    const ready = new Promise<void>((r) => {
      armed = r
    })

    const task = new Task({
      id: "body",
      outputs: [out],
      run: async (ctx) => {
        armed()
        await new Promise<void>((resolve) => {
          ctx.signal.addEventListener("abort", () => resolve(), { once: true })
        })
        throw new Error("body threw after abort")
      },
    })
    build.add(task)

    const running = build.run()
    await ready
    build.remove("body")
    const result = await running

    expect(result.cancelled).toContain(task)
    expect(result.failed.has(task)).toBe(false)
  })

  test("listener error during announce: run rejects; second run does not hang", async () => {
    const build = new Build()
    const out = new Blob("e:1")
    build.listen(new IdPrefix("e:"), () => {
      throw new Error("announce boom")
    })
    build.add(
      new Task({
        id: "w",
        outputs: [out],
        run: async () => {},
      }),
    )

    let err: Error | null = null
    try {
      await build.run()
    } catch (error) {
      err = error instanceof Error ? error : new Error(String(error))
    }
    expect(err?.message).toBe("announce boom")

    const second = await Promise.race([
      build.run(),
      Bun.sleep(1000).then(() => {
        throw new Error("hang on second run")
      }),
    ])
    expect(second).toBeDefined()
  })
})
