import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Artifact, Build, IdPrefix, MemoryStore, Task } from "../../src"
import {
  FileOutput,
  FilePattern,
  JsonStore,
  RuleBuild,
} from "../../contrib"

const temps: string[] = []

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dapat-adv-err-"))
  temps.push(dir)
  return dir
}

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

describe("adv error surfacing", () => {
  test("output var not captured by required inputs: runtime throw at rule()", () => {
    const build = new Build()
    const rules = new RuleBuild(build)
    expect(() =>
      rules.rule({
        name: "bad-out-var",
        inputs: { src: new FilePattern("src/<a>.txt") },
        outputs: { out: new FileOutput("out/<b>.txt") },
        run: async () => {},
      }),
    ).toThrow(/output 'out' uses var 'b'/)
  })

  test("optional name not an input: runtime throw at rule()", () => {
    const build = new Build()
    const rules = new RuleBuild(build)
    expect(() =>
      rules.rule({
        name: "bad-opt",
        inputs: { src: new FilePattern("src/<a>.txt") },
        optional: ["missing" as "src"],
        outputs: { out: new FileOutput("out/<a>.txt") },
        run: async () => {},
      }),
    ).toThrow(/optional name 'missing' is not an input/)
  })

  test("JsonStore corrupt JSON rejects get (does not hide)", async () => {
    const root = await tempDir()
    const storePath = path.join(root, "state.json")
    await writeFile(storePath, "{not-json")
    const store = new JsonStore(storePath)
    let threw = false
    try {
      await store.get("x")
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  test("JsonStore object without tasks key must not load as empty", async () => {
    const root = await tempDir()
    const storePath = path.join(root, "state.json")
    await writeFile(storePath, JSON.stringify({ nope: true }))
    const store = new JsonStore(storePath)
    let threw = false
    try {
      await store.get("x")
    } catch {
      threw = true
    }
    // Today load() returns { tasks: {} } and hides corruption.
    expect(threw).toBe(true)
  })

  test("listener error during declared-output announce: run rejects", async () => {
    const build = new Build({ store: new MemoryStore() })
    const out = new Blob("out:1")
    build.listen(new IdPrefix("out:"), () => {
      throw new Error("announce boom")
    })
    build.add(
      new Task({
        id: "w",
        outputs: [out],
        run: async () => {},
      }),
    )
    let runError: Error | null = null
    try {
      await build.run()
    } catch (error) {
      runError = error instanceof Error ? error : new Error(String(error))
    }
    expect(runError?.message).toBe("announce boom")
  })
})
