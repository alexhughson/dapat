import { describe, expect, test } from "bun:test"
import { Artifact, Build, IdPrefix, Task } from "../../src"

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

describe("adv2 seq / since listen", () => {
  test("unsubscribe current listener during delivery must not skip the next listener", async () => {
    const build = new Build()
    const item = new Blob("z:1")
    const seen: string[] = []
    let stopSelf: (() => void) | null = null

    stopSelf = build.listen(new IdPrefix("z:"), async (event) => {
      seen.push(`a:${event.type}`)
      stopSelf!()
    })
    build.listen(new IdPrefix("z:"), (event) => {
      seen.push(`b:${event.type}`)
    })

    build.add(
      new Task({
        id: "w",
        outputs: [new IdPrefix("z:")],
        run: async (ctx) => {
          ctx.produced(item)
        },
      }),
    )

    await build.run()
    expect(seen).toContain("a:produced")
    expect(seen).toContain("b:produced")
  })

  test("listener added mid-delivery does not receive the current live event", async () => {
    const build = new Build()
    const item = new Blob("n:1")
    const lateSeen: string[] = []

    build.listen(new IdPrefix("n:"), async (event) => {
      if (event.type !== "produced") return
      await Promise.resolve()
      build.listen(new IdPrefix("n:"), (late) => {
        lateSeen.push(`${late.type}:${late.id}`)
      })
    })

    build.add(
      new Task({
        id: "w",
        outputs: [new IdPrefix("n:")],
        run: async (ctx) => {
          ctx.produced(item)
        },
      }),
    )

    await build.run()
    // Replay may deliver produced once via only=fn; must not also get the
    // in-flight live event (would be duplicate).
    expect(lateSeen.filter((s) => s === "produced:n:1").length).toBe(1)
  })

  test("replay queued then retract: late listener must end on retracted", async () => {
    const build = new Build()
    const prefix = new IdPrefix("p:")
    const page = new Blob("p:1")
    const belief: string[] = []

    build.listen(prefix, async (event) => {
      if (event.type !== "produced" || event.id !== page.id) return
      await Promise.resolve()
      // Register while page is still in provisions so replay is enqueued,
      // then retract so a retract event follows the replay.
      build.listen(prefix, (late) => {
        belief.push(`${late.type}:${late.id}`)
      })
      build.remove("writer")
    })

    build.add(
      new Task({
        id: "writer",
        outputs: [prefix],
        run: async (ctx) => {
          ctx.produced(page)
        },
      }),
    )

    await build.run()

    const forPage = belief.filter((s) => s.endsWith(":p:1"))
    expect(forPage.length).toBeGreaterThan(0)
    expect(forPage[forPage.length - 1]).toBe("retracted:p:1")
  })

  test("listen while live events queued: new listener sees production order via replay", async () => {
    const build = new Build()
    const prefix = new IdPrefix("x:")
    const first = new Blob("x:first")
    const second = new Blob("x:second")
    const lateOrder: string[] = []

    build.listen(prefix, async (event) => {
      if (event.id !== first.id || event.type !== "produced") return
      await Promise.resolve()
      build.listen(prefix, (late) => {
        lateOrder.push(`${late.type}:${late.id}`)
      })
    })

    build.add(
      new Task({
        id: "writer",
        outputs: [prefix],
        run: async (ctx) => {
          ctx.produced(first)
          ctx.produced(second)
        },
      }),
    )

    await build.run()
    expect(lateOrder.indexOf("produced:x:first")).toBeGreaterThanOrEqual(0)
    expect(lateOrder.indexOf("produced:x:second")).toBeGreaterThan(
      lateOrder.indexOf("produced:x:first"),
    )
  })
})
