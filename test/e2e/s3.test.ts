import { describe, expect, test } from "bun:test"
import { MemoryS3, S3ObjectArtifact, S3Prefix } from "../../contrib/s3"
import { MemoryStore } from "../../contrib/store"
import { Build, Task } from "../../src/index"

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

describe("S3 artifacts", () => {
  test("copies an object and skips on the next run", async () => {
    const s3 = new MemoryS3()
    await s3.put("bucket", "src.txt", encode("hello"))
    const store = new MemoryStore()
    let runs = 0

    const runOnce = async () => {
      const src = new S3ObjectArtifact(s3, "bucket", "src.txt")
      const out = new S3ObjectArtifact(s3, "bucket", "out.txt")
      const build = new Build({ store })
      build.add(
        new Task({
          id: "copy",
          inputs: [src],
          outputs: [out],
          run: async () => {
            runs += 1
            await s3.put("bucket", "out.txt", await src.read())
          },
        }),
      )
      return build.run()
    }

    const first = await runOnce()
    expect(first.executed.length).toBe(1)
    expect(decode(await s3.get("bucket", "out.txt"))).toBe("hello")
    expect(runs).toBe(1)

    const second = await runOnce()
    expect(second.skipped.length).toBe(1)
    expect(runs).toBe(1)

    await s3.put("bucket", "src.txt", encode("hello world"))
    const third = await runOnce()
    expect(third.executed.length).toBe(1)
    expect(decode(await s3.get("bucket", "out.txt"))).toBe("hello world")
    expect(runs).toBe(2)
  })

  test("prefix output plus produced child, then a consumer of that object", async () => {
    const s3 = new MemoryS3()
    const log = new S3ObjectArtifact(s3, "bucket", "logs/1.json")
    const report = new S3ObjectArtifact(s3, "bucket", "reports/1.json")

    const build = new Build()
    build.add(
      new Task({
        id: "write-log",
        outputs: [new S3Prefix(s3, "bucket", "logs")],
        run: async (ctx) => {
          await s3.put("bucket", "logs/1.json", encode('{"ok":true}'))
          ctx.produced(log)
        },
      }),
    )
    build.add(
      new Task({
        id: "report",
        inputs: [log],
        outputs: [report],
        run: async () => {
          await s3.put("bucket", "reports/1.json", await log.read())
        },
      }),
    )

    const result = await build.run()
    expect(result.success).toBe(true)
    expect(decode(await s3.get("bucket", "reports/1.json"))).toBe('{"ok":true}')
  })

  test("an S3Prefix input stamps the listed keys and their etags", async () => {
    const s3 = new MemoryS3()
    await s3.put("bucket", "pages/a.md", encode("A"))
    await s3.put("bucket", "pages/b.md", encode("B"))
    // Under "pagesx/", not under "pages/". It must not change the stamp.
    await s3.put("bucket", "pagesx/z.md", encode("Z"))
    const store = new MemoryStore()
    let runs = 0

    const runOnce = async () => {
      const index = new S3ObjectArtifact(s3, "bucket", "index.html")
      const build = new Build({ store })
      build.add(
        new Task({
          id: "index",
          inputs: [new S3Prefix(s3, "bucket", "pages")],
          outputs: [index],
          run: async () => {
            runs += 1
            const keys = await s3.list("bucket", "pages/")
            await s3.put("bucket", "index.html", encode(keys.join(",")))
          },
        }),
      )
      return build.run()
    }

    const first = await runOnce()
    expect(first.executed.length).toBe(1)
    const second = await runOnce()
    expect(second.skipped.length).toBe(1)

    await s3.put("bucket", "pagesx/y.md", encode("Y"))
    const outside = await runOnce()
    expect(outside.skipped.length).toBe(1)

    await s3.put("bucket", "pages/c.md", encode("C"))
    const added = await runOnce()
    expect(added.executed.length).toBe(1)
    expect(decode(await s3.get("bucket", "index.html"))).toBe("pages/a.md,pages/b.md,pages/c.md")

    await s3.put("bucket", "pages/a.md", encode("A edited"))
    const edited = await runOnce()
    expect(edited.executed.length).toBe(1)

    // MemoryS3 sets the etag to the hash of the body, so the same body keeps the stamp.
    await s3.put("bucket", "pages/a.md", encode("A edited"))
    const same = await runOnce()
    expect(same.skipped.length).toBe(1)
    expect(runs).toBe(3)
  })

  test("an empty S3Prefix has a stamp, so the task can skip", async () => {
    const s3 = new MemoryS3()
    const prefix = new S3Prefix(s3, "bucket", "none/")
    const stamp = await prefix.stamp()
    expect(stamp).not.toBeNull()
    expect(await new S3Prefix(s3, "other", "none").stamp()).toBe(stamp)
  })
})
