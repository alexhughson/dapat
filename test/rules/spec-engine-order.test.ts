import { describe, expect, test } from "bun:test"
import { Artifact, Build, IdPrefix, Task } from "../../src"

/**
 * Engine event-ordering for one artifact id.
 *
 * Claim: for one listener, a `retracted` event for artifact X is never
 * delivered before the `produced` event for X that it negates.
 *
 * `Build.listen` unshifts: newest listeners run first (see src/build.ts).
 * RuleBuild registers during load(); a user listener registered later runs
 * first. If that user listener removes the producer on `produced`, it fires
 * `retracted` via `fire()` without awaiting the in-flight `emitAll(produced)`.
 */

class Blob extends Artifact<string> {
  constructor(readonly id: string) {
    super()
  }

  async orderStamp(): Promise<bigint | null> {
    return 1n
  }

  async contentStamp(): Promise<string | null> {
    return this.id
  }

  async read(): Promise<string> {
    return this.id
  }
}

type LogEntry = { seq: number; who: string; type: string }

async function runWithRemover(opts: {
  asyncRemover: boolean
}): Promise<{ log: LogEntry[] }> {
  const build = new Build()
  const prefix = new IdPrefix("map:pages/")
  const page = new Blob("map:pages/1")
  const log: LogEntry[] = []
  let seq = 0

  // Observer first = older listener (RuleBuild-shaped). Remover second = newer
  // user listener that runs first on each event.
  build.listen(prefix, (event) => {
    if (event.id !== page.id) return
    seq += 1
    log.push({ seq, who: "observer", type: event.type })
  })

  build.listen(prefix, async (event) => {
    if (event.id !== page.id) return
    seq += 1
    log.push({ seq, who: "remover", type: event.type })
    if (event.type === "produced") {
      build.remove("writer")
      if (opts.asyncRemover) {
        await Bun.sleep(5)
      }
    }
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

  const result = await build.run()
  expect(result.success).toBe(true)
  return { log }
}

function observerTypes(log: LogEntry[]): string[] {
  const types: string[] = []
  for (const entry of log) {
    if (entry.who !== "observer") continue
    types.push(entry.type)
  }
  return types
}

describe("Build produced/retracted event order", () => {
  test("sync remover: observer order for one artifact", async () => {
    const { log } = await runWithRemover({ asyncRemover: false })
    console.log("engine-order sync log", log)

    const types = observerTypes(log)
    const producedIndex = types.indexOf("produced")
    const retractedIndex = types.indexOf("retracted")

    // Claim: produced before retracted for the observer.
    // If produced is missing, the engine skipped delivery after retract.
    if (producedIndex < 0) {
      expect(types).toEqual(["retracted"])
      // Claim disproved: observer never saw produced, only retracted.
      expect(producedIndex).toBeGreaterThanOrEqual(0)
      return
    }
    expect(retractedIndex).toBeGreaterThanOrEqual(0)
    expect(producedIndex).toBeLessThan(retractedIndex)
  })

  test("async remover (Bun.sleep(5)): observer order for one artifact", async () => {
    const { log } = await runWithRemover({ asyncRemover: true })
    console.log("engine-order async log", log)

    const types = observerTypes(log)
    const producedIndex = types.indexOf("produced")
    const retractedIndex = types.indexOf("retracted")

    if (producedIndex < 0) {
      // Expected failure mode under newest-first + void fire(retracted):
      // observer sees only retracted (produced emitAll aborts after provisions
      // clear). Claim disproved.
      expect(types).toEqual(["retracted"])
      expect(producedIndex).toBeGreaterThanOrEqual(0)
      return
    }
    expect(retractedIndex).toBeGreaterThanOrEqual(0)
    expect(producedIndex).toBeLessThan(retractedIndex)
  })

  test("single listener that removes: its own delivery order", async () => {
    const build = new Build()
    const prefix = new IdPrefix("map:pages/")
    const page = new Blob("map:pages/1")
    const log: LogEntry[] = []
    let seq = 0

    build.listen(prefix, async (event) => {
      if (event.id !== page.id) return
      seq += 1
      log.push({ seq, who: "self", type: event.type })
      if (event.type === "produced") {
        build.remove("writer")
        await Bun.sleep(5)
      }
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

    const result = await build.run()
    expect(result.success).toBe(true)
    console.log("engine-order single-listener log", log)

    const types: string[] = []
    for (const entry of log) {
      types.push(entry.type)
    }
    const producedIndex = types.indexOf("produced")
    const retractedIndex = types.indexOf("retracted")
    expect(producedIndex).toBeGreaterThanOrEqual(0)
    expect(retractedIndex).toBeGreaterThanOrEqual(0)
    expect(producedIndex).toBeLessThan(retractedIndex)
  })
})
