import { describe, expect, test } from "bun:test"
import { Artifact, Build, Task } from "../../src"

/** Null stamps so tasks actually run instead of order-skipping. */
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

describe("adv finish / remove during pending wait", () => {
  test("remove of pending waiter: task body must not run; outcome stays removed", async () => {
    const build = new Build()
    const depOut = new Blob("dep:out")
    const victimOut = new Blob("victim:out")
    let victimRan = false
    let depGate!: () => void
    const depRelease = new Promise<void>((resolve) => {
      depGate = resolve
    })

    build.add(
      new Task({
        id: "dep",
        outputs: [depOut],
        run: async () => {
          await depRelease
        },
      }),
    )
    build.add(
      new Task({
        id: "victim",
        inputs: [depOut],
        outputs: [victimOut],
        run: async () => {
          victimRan = true
        },
      }),
    )

    const runPromise = build.run()
    // Victim is in waitForInputs while dep holds the gate.
    await Bun.sleep(20)
    build.remove("victim")
    depGate()
    const result = await runPromise

    expect(victimRan).toBe(false)
    expect(result.executed.some((t) => t.id === "victim")).toBe(false)
    expect(result.cancelled.some((t) => t.id === "victim")).toBe(true)
  })

  test("finish early-return: removed pending task must not run after wait unblocks", async () => {
    const build = new Build()
    const depOut = new Blob("d:1")
    const out = new Blob("v:1")
    let ranAfterRemove = false
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
      outputs: [out],
      run: async () => {
        ranAfterRemove = true
      },
    })
    build.add(victim)

    const running = build.run()
    await Bun.sleep(20)
    build.remove("victim")
    release()
    const result = await running

    expect(ranAfterRemove).toBe(false)
    expect(result.cancelled).toContain(victim)
  })
})
