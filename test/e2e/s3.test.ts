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
        outputs: [new S3Prefix("bucket", "logs")],
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
})
