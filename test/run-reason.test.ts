import { describe, expect, test } from "bun:test"
import { Build, IdPrefix, MemoryStore, Task } from "../src/index"
import type { Outcome, Ref, Store } from "../src/index"
import { Mem, MemPrefix } from "./mem"

/** Runs one task in a new Build and returns its outcome. The task writes "out" to each Mem output. */
async function runOnce(store: Store | undefined, inputs: Ref[], outputs: Ref[]): Promise<Outcome | undefined> {
  const task = new Task({
    id: "compile",
    inputs,
    outputs,
    run: async () => {
      for (const output of outputs) {
        if (output instanceof Mem) output.write("out")
      }
    },
  })
  const build = new Build({ store })
  build.add(task)
  const result = await build.run()
  expect(result.success).toBe(true)
  return result.outcomes.get(task)
}

describe("the reason a task ran", () => {
  test("no-store: a build with no store runs each task", async () => {
    const outcome = await runOnce(undefined, [new Mem("src", "a")], [new Mem("out")])
    expect(outcome).toEqual({ type: "executed", reason: { kind: "no-store" } })
  })

  test("no-inputs: a task with no input runs on each build", async () => {
    const store = new MemoryStore()
    const out = new Mem("out")
    await runOnce(store, [], [out])
    const outcome = await runOnce(store, [], [out])
    expect(outcome).toEqual({ type: "executed", reason: { kind: "no-inputs" } })
  })

  test("no-record: the first build with a store", async () => {
    const outcome = await runOnce(new MemoryStore(), [new Mem("src", "a")], [new Mem("out")])
    expect(outcome).toEqual({ type: "executed", reason: { kind: "no-record" } })
  })

  test("input-unstamped: an IdPrefix input has a null stamp", async () => {
    const store = new MemoryStore()
    const inputs = [new Mem("src", "a"), new IdPrefix("ids:")]
    const out = new Mem("out")
    await runOnce(store, inputs, [out])
    const outcome = await runOnce(store, inputs, [out])
    expect(outcome).toEqual({ type: "executed", reason: { kind: "input-unstamped", id: "ids:" } })
  })

  test("output-unstamped: an IdPrefix output has a null stamp", async () => {
    const store = new MemoryStore()
    const src = new Mem("src", "a")
    const outputs = [new IdPrefix("ids:")]
    await runOnce(store, [src], outputs)
    const outcome = await runOnce(store, [src], outputs)
    expect(outcome).toEqual({ type: "executed", reason: { kind: "output-unstamped", id: "ids:" } })
  })

  test("input-ids-changed: the task has an input that the record does not", async () => {
    const store = new MemoryStore()
    const src = new Mem("src", "a")
    const out = new Mem("out")
    await runOnce(store, [src], [out])
    const outcome = await runOnce(store, [src, new Mem("header", "h")], [out])
    expect(outcome).toEqual({ type: "executed", reason: { kind: "input-ids-changed" } })
  })

  test("input-changed: an input stamp differs from the record", async () => {
    const store = new MemoryStore()
    const src = new Mem("src", "a")
    const out = new Mem("out")
    await runOnce(store, [src], [out])
    src.write("b")
    const outcome = await runOnce(store, [src], [out])
    expect(outcome).toEqual({ type: "executed", reason: { kind: "input-changed", id: "src" } })
  })

  test("input-changed: a task that writes into a prefix it reads runs again", async () => {
    const store = new MemoryStore()
    const index = new Mem("pages/index")
    const pages = new MemPrefix("pages/", [new Mem("pages/a", "a"), index])
    await runOnce(store, [pages], [index])
    const outcome = await runOnce(store, [pages], [index])
    expect(outcome).toEqual({ type: "executed", reason: { kind: "input-changed", id: "pages/" } })
  })

  test("output-missing: an output artifact is gone", async () => {
    const store = new MemoryStore()
    const src = new Mem("src", "a")
    const out = new Mem("out")
    await runOnce(store, [src], [out])
    out.value = null
    const outcome = await runOnce(store, [src], [out])
    expect(outcome).toEqual({ type: "executed", reason: { kind: "output-missing", id: "out" } })
  })

  test("output-ids-changed: the task has fewer outputs than the record", async () => {
    const store = new MemoryStore()
    const src = new Mem("src", "a")
    const out = new Mem("out")
    await runOnce(store, [src], [out, new Mem("extra")])
    const outcome = await runOnce(store, [src], [out])
    expect(outcome).toEqual({ type: "executed", reason: { kind: "output-ids-changed" } })
  })

  test("output-ids-changed: a new output that does not exist yet", async () => {
    const store = new MemoryStore()
    const src = new Mem("src", "a")
    const out = new Mem("out")
    await runOnce(store, [src], [out])
    const outcome = await runOnce(store, [src], [out, new Mem("extra")])
    expect(outcome).toEqual({ type: "executed", reason: { kind: "output-ids-changed" } })
  })

  test("output-changed: an output was edited by hand", async () => {
    const store = new MemoryStore()
    const src = new Mem("src", "a")
    const out = new Mem("out")
    await runOnce(store, [src], [out])
    out.write("edited")
    const outcome = await runOnce(store, [src], [out])
    expect(outcome).toEqual({ type: "executed", reason: { kind: "output-changed", id: "out" } })
  })

  test("an input and an output that both changed give input-changed", async () => {
    const store = new MemoryStore()
    const src = new Mem("src", "a")
    const out = new Mem("out")
    await runOnce(store, [src], [out])
    src.write("b")
    out.write("edited")
    const outcome = await runOnce(store, [src], [out])
    expect(outcome).toEqual({ type: "executed", reason: { kind: "input-changed", id: "src" } })
  })

  test("a task with the same stamps skips", async () => {
    const store = new MemoryStore()
    const src = new Mem("src", "a")
    const out = new Mem("out")
    await runOnce(store, [src], [out])
    const outcome = await runOnce(store, [src], [out])
    expect(outcome).toEqual({ type: "skipped" })
  })
})
