import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Build, MemoryStore, Task } from "../../src"
import type { Store } from "../../src/store"
import { FileArtifact, pathPrefix } from "../../contrib"

const temps: string[] = []

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dapat-stamp-"))
  temps.push(dir)
  return dir
}

/**
 * Same file id as FileArtifact, but contentStamp waits until the store has a
 * record for task id T. Used so the replacement's decideSkip runs after the
 * first run's store write (no race with announce).
 */
class WaitForStoreFile extends FileArtifact {
  constructor(
    filePath: string,
    private readonly store: Store,
    private readonly taskId: string,
  ) {
    super(filePath)
  }

  async contentStamp(): Promise<string | null> {
    for (let i = 0; i < 200; i++) {
      if ((await this.store.get(this.taskId)) !== null) break
      await Bun.sleep(1)
    }
    return super.contentStamp()
  }
}

describe("store input stamps from before the run", () => {
  test("replacement after announce uses before-run input stamps, not post-rewrite", async () => {
    // T reads x.txt and writes out.txt. On T's produced, a listener rewrites
    // x.txt to v2 and build.add's a new T (same id, same inputs). The store
    // must keep the v1 input stamp from before the first run. If it stamps
    // after announce, it pairs v2 with an out built from v1; the replacement
    // then content-skips and keeps the stale out.
    const root = await tempDir()
    const xPath = path.join(root, "x.txt")
    const outPath = path.join(root, "out.txt")
    await writeFile(xPath, "v1")

    const store = new MemoryStore()
    const build = new Build({ store })
    const x = new FileArtifact(xPath)
    const out = new FileArtifact(outPath)

    const makeT = (input: FileArtifact): Task =>
      new Task({
        id: "T",
        inputs: [input],
        outputs: [out],
        run: async () => {
          const text = new TextDecoder().decode(await input.read())
          await Bun.write(outPath, `built:${text}`)
        },
      })

    let rewritten = false
    build.listen(pathPrefix(root), async (event) => {
      if (event.type !== "produced") return
      if (event.id !== out.id) return
      if (event.taskId !== "T") return
      if (rewritten) return
      rewritten = true
      await writeFile(xPath, "v2")
      // Replacement sees the same file id; contentStamp waits for the store
      // so decideSkip runs after the first recordSuccess write.
      build.add(makeT(new WaitForStoreFile(xPath, store, "T")))
    })

    build.add(makeT(x))
    const result = await build.run()
    expect(result.success).toBe(true)

    const executed = result.executed.filter((t) => t.id === "T")
    expect(executed.length).toBe(1)
    expect(result.skipped.some((t) => t.id === "T")).toBe(false)
    expect(await Bun.file(outPath).text()).toBe("built:v2")
  })
})
