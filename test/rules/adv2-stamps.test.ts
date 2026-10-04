import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Artifact, Build, MemoryStore, Task } from "../../src"
import { DirectoryArtifact, FileArtifact, PathPrefix } from "../../contrib"

const temps: string[] = []

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dapat-adv2-"))
  temps.push(dir)
  return dir
}

class Blob extends Artifact<string> {
  constructor(
    readonly id: string,
    private content: string,
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

describe("adv2 before-run input stamps", () => {
  test("stamping is after inputs are ready, not while waiting", async () => {
    const stampLog: string[] = []
    let releaseDep!: () => void
    const holdDep = new Promise<void>((r) => {
      releaseDep = r
    })

    class LoggedIn extends Artifact<string> {
      readonly id = "in:logged"
      async orderStamp() {
        return null
      }
      async contentStamp() {
        stampLog.push("stamp")
        return "c1"
      }
      async read() {
        return "c1"
      }
    }

    const build = new Build()
    const depOut = new Blob("dep:out", "d")
    build.add(
      new Task({
        id: "dep",
        outputs: [depOut],
        run: async () => {
          stampLog.push("dep-run")
          await holdDep
          stampLog.push("dep-done")
        },
      }),
    )
    build.add(
      new Task({
        id: "consumer",
        inputs: [depOut, new LoggedIn()],
        outputs: [new Blob("out:1", "o")],
        run: async () => {
          stampLog.push("consumer-run")
        },
      }),
    )

    const running = build.run()
    await Bun.sleep(15)
    expect(stampLog.includes("stamp")).toBe(false)
    releaseDep()
    await running
    expect(stampLog.indexOf("stamp")).toBeGreaterThan(stampLog.indexOf("dep-done"))
    expect(stampLog.indexOf("consumer-run")).toBeGreaterThan(
      stampLog.indexOf("stamp"),
    )
  })

  test("prefix-artifact input: DirectoryArtifact is stamped; PathPrefix is not an artifact stamp", async () => {
    const root = await tempDir()
    await mkdir(path.join(root, "dir"), { recursive: true })
    await writeFile(path.join(root, "dir", "a.txt"), "a")

    const store = new MemoryStore()
    const dir = new DirectoryArtifact(path.join(root, "dir"))
    const out = new FileArtifact(path.join(root, "out.txt"))

    const build = new Build({ store })
    let ran = 0
    build.add(
      new Task({
        id: "list",
        inputs: [dir],
        outputs: [out],
        run: async () => {
          ran += 1
          await Bun.write(out.path, "x")
        },
      }),
    )
    const first = await build.run()
    expect(first.executed.some((t) => t.id === "list") || first.skipped.some((t) => t.id === "list")).toBe(true)

    // Second build with unchanged dir should content-skip (dir has content stamp).
    const build2 = new Build({ store })
    build2.add(
      new Task({
        id: "list",
        inputs: [new DirectoryArtifact(path.join(root, "dir"))],
        outputs: [new FileArtifact(path.join(root, "out.txt"))],
        run: async () => {
          ran += 1
        },
      }),
    )
    const second = await build2.run()
    expect(second.skipped.some((t) => t.id === "list")).toBe(true)
    expect(ran).toBe(1)

    // PathPrefix as input does not go through stampMap (not an Artifact).
    const build3 = new Build()
    let prefixTaskRan = false
    build3.add(
      new Task({
        id: "prefix-in",
        inputs: [new PathPrefix(path.join(root, "dir"))],
        outputs: [new Blob("out:prefix", "p")],
        run: async () => {
          prefixTaskRan = true
        },
      }),
    )
    await build3.run()
    expect(prefixTaskRan).toBe(true)
  })
})
