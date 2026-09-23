import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Build, MemoryStore, Task } from "../../src/index"
import { DirectoryArtifact, FileArtifact, PathPrefix } from "../../contrib/fs"

const temps: string[] = []

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dapat-stress-"))
  temps.push(dir)
  return dir
}

const COPIES = 4000
const PREFIX_FILES = 1000

describe("filesystem stress", () => {
  test(
    `copies ${COPIES} files, skips them, then rebuilds one`,
    async () => {
      const root = await tempDir()
      const srcDir = path.join(root, "src")
      const outDir = path.join(root, "out")
      await mkdir(srcDir, { recursive: true })
      await mkdir(outDir, { recursive: true })

      for (let i = 0; i < COPIES; i++) {
        await writeFile(path.join(srcDir, `${i}.txt`), `src-${i}`)
      }

      const store = new MemoryStore()
      let runs = 0

      const runOnce = async () => {
        const build = new Build({ store })
        for (let i = 0; i < COPIES; i++) {
          const src = new FileArtifact(path.join(srcDir, `${i}.txt`))
          const out = new FileArtifact(path.join(outDir, `${i}.txt`))
          const index = i
          build.add(
            new Task({
              id: `copy:${index}`,
              inputs: [src],
              outputs: [out],
              run: async () => {
                runs += 1
                const bytes = await src.read()
                await writeFile(out.path, bytes)
              },
            }),
          )
        }
        return build.run()
      }

      const first = await runOnce()
      expect(first.success).toBe(true)
      expect(first.executed.length).toBe(COPIES)
      expect(runs).toBe(COPIES)
      expect(await Bun.file(path.join(outDir, "7.txt")).text()).toBe("src-7")

      const second = await runOnce()
      expect(second.success).toBe(true)
      expect(second.skipped.length).toBe(COPIES)
      expect(second.executed.length).toBe(0)
      expect(runs).toBe(COPIES)

      await writeFile(path.join(srcDir, "7.txt"), "changed")
      const third = await runOnce()
      expect(third.success).toBe(true)
      expect(third.executed.length).toBe(1)
      expect(third.skipped.length).toBe(COPIES - 1)
      expect(runs).toBe(COPIES + 1)
      expect(await Bun.file(path.join(outDir, "7.txt")).text()).toBe("changed")
    },
    { timeout: 120_000 },
  )

  test(
    `one prefix writer emits ${PREFIX_FILES} files; a directory consumer waits`,
    async () => {
      const root = await tempDir()
      const outDir = path.join(root, "out")
      const manifestPath = path.join(root, "manifest.txt")

      const store = new MemoryStore()
      let writes = 0
      let manifests = 0

      const runOnce = async () => {
        const listing = new DirectoryArtifact(outDir)
        const manifest = new FileArtifact(manifestPath)
        const build = new Build({ store })
        build.add(
          new Task({
            id: "write-all",
            outputs: [new PathPrefix(outDir), listing],
            run: async (ctx) => {
              writes += 1
              await mkdir(outDir, { recursive: true })
              for (let i = 0; i < PREFIX_FILES; i++) {
                const filePath = path.join(outDir, `${i}.txt`)
                await writeFile(filePath, `n=${i}`)
                ctx.produced(new FileArtifact(filePath))
              }
            },
          }),
        )
        build.add(
          new Task({
            id: "manifest",
            inputs: [listing],
            outputs: [manifest],
            run: async () => {
              manifests += 1
              const files = await listing.read()
              await writeFile(manifestPath, String(files.length))
            },
          }),
        )
        return build.run()
      }

      const first = await runOnce()
      expect(first.success).toBe(true)
      expect(writes).toBe(1)
      expect(manifests).toBe(1)
      expect(await Bun.file(manifestPath).text()).toBe(String(PREFIX_FILES))

      const second = await runOnce()
      expect(second.skipped.length).toBe(2)
      expect(writes).toBe(1)
      expect(manifests).toBe(1)
    },
    { timeout: 120_000 },
  )
})
