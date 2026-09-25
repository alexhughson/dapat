import { describe, expect, test } from "bun:test"
import { Artifact, Build, IdPrefix, Task } from "../../src"

/** No stamps → never order-skips; content-skip needs a store match. */
class Blob extends Artifact<string> {
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

describe("adv drain / listen / idle", () => {
  test("listen during queued live events: new listener sees replay then later live in order", async () => {
    const build = new Build()
    const prefix = new IdPrefix("x:")
    const first = new Blob("x:first")
    const second = new Blob("x:second")
    const lateOrder: string[] = []

    build.listen(prefix, async (event) => {
      if (event.id !== first.id || event.type !== "produced") return
      // Yield so the writer can finish enqueueing `second` before we listen.
      // Drain started inside the first fire(); without a yield, `second` is not
      // provisioned yet and the race under test cannot happen.
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

    // Replay covers provisions in order; live events queued before registration
    // are skipped (seq < since).
    expect(lateOrder[0]).toBe("produced:x:first")
    expect(lateOrder).toContain("produced:x:second")
    expect(lateOrder.indexOf("produced:x:second")).toBeGreaterThan(
      lateOrder.indexOf("produced:x:first"),
    )
  })

  test("listener throw: run rejects once, other tasks still finish, second run is sane", async () => {
    const build = new Build()
    const a = new Blob("t:a")
    const b = new Blob("t:b")
    let bRan = false

    build.listen(new IdPrefix("t:"), () => {
      throw new Error("listener boom")
    })

    build.add(
      new Task({
        id: "A",
        outputs: [a],
        run: async () => {},
      }),
    )
    build.add(
      new Task({
        id: "B",
        outputs: [b],
        run: async () => {
          bRan = true
        },
      }),
    )

    let firstError: Error | null = null
    try {
      await build.run()
    } catch (error) {
      firstError = error instanceof Error ? error : new Error(String(error))
    }
    expect(firstError?.message).toBe("listener boom")
    expect(bRan).toBe(true)

    // Second run must not throw from a stale listenerError.
    // Result still reflects first-run outcomes (run is not a clean re-entry).
    let secondThrow: Error | null = null
    let second: Awaited<ReturnType<Build["run"]>> | null = null
    try {
      second = await build.run()
    } catch (error) {
      secondThrow = error instanceof Error ? error : new Error(String(error))
    }
    expect(secondThrow).toBe(null)
    expect(second).not.toBe(null)
  })

  test("listener added during delivery does not get the current event twice", async () => {
    const build = new Build()
    const item = new Blob("z:1")
    const seen: string[] = []
    let added = false

    build.listen(new IdPrefix("z:"), async (event) => {
      seen.push(`first:${event.id}`)
      if (added) return
      added = true
      await Promise.resolve()
      build.listen(new IdPrefix("z:"), (late) => {
        seen.push(`late:${late.id}`)
      })
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
    expect(seen.filter((s) => s === "late:z:1").length).toBe(1)
  })
})
