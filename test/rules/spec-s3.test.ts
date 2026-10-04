import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Build } from "../../src"
import {
  FileOutput,
  MemoryS3,
  MemoryStore,
  RuleBuild,
  S3Glob,
  S3ObjectArtifact,
  S3Output,
  S3Pattern,
  S3PrefixOutput,
} from "../../contrib"

const temps: string[] = []

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dapat-spec-s3-"))
  temps.push(dir)
  return dir
}

function sortedIds(tasks: readonly { id: string }[]): string[] {
  const ids: string[] = []
  for (const task of tasks) {
    ids.push(task.id)
  }
  ids.sort()
  return ids
}

describe("S3 rules (DOCS 11.7)", () => {
  test("paginate with S3PrefixOutput then shot to files", async () => {
    const root = await tempDir()
    const s3 = new MemoryS3()
    await s3.put("docs", "inbox/doc.txt", new TextEncoder().encode("a\nb\nc"))

    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)

    rules.rule({
      name: "paginate",
      inputs: { src: new S3Pattern("s3://docs/inbox/<doc>.txt", { client: s3 }) },
      outputs: { pages: new S3PrefixOutput("s3://docs/pages/<doc>/") },
      run: async (ctx) => {
        const text = new TextDecoder().decode(await ctx.inputs.src.read())
        const lines = text.split("\n")
        for (let i = 0; i < lines.length; i++) {
          const key = `${ctx.outputs.pages.keyPrefix}${i + 1}.txt`
          await s3.put("docs", key, new TextEncoder().encode(lines[i]!))
          ctx.produced(new S3ObjectArtifact(s3, "docs", key))
        }
      },
    })

    rules.rule({
      name: "shot",
      inputs: {
        page: new S3Pattern("s3://docs/pages/<doc>/<page>.txt", { client: s3 }),
      },
      outputs: { shot: new FileOutput("shots/<doc>/<page>.png", { root }) },
      run: async (ctx) => {
        await Bun.write(ctx.outputs.shot.path, await ctx.inputs.page.read())
      },
    })

    const result = await rules.run()
    expect(result.success).toBe(true)
    expect(sortedIds(result.executed)).toEqual([
      "paginate:doc=doc",
      "shot:doc=doc,page=1",
      "shot:doc=doc,page=2",
      "shot:doc=doc,page=3",
    ])
    expect(await Bun.file(path.join(root, "shots", "doc", "1.png")).text()).toBe(
      "a",
    )
    expect(await Bun.file(path.join(root, "shots", "doc", "2.png")).text()).toBe(
      "b",
    )
    expect(await Bun.file(path.join(root, "shots", "doc", "3.png")).text()).toBe(
      "c",
    )

    const pageKeys = await s3.list("docs", "pages/doc/")
    expect(pageKeys).toEqual([
      "pages/doc/1.txt",
      "pages/doc/2.txt",
      "pages/doc/3.txt",
    ])
  })

  test("S3Glob groups keys into a sorted list per vars", async () => {
    const root = await tempDir()
    const s3 = new MemoryS3()
    await s3.put("docs", "bag/g/a.txt", new TextEncoder().encode("A"))
    await s3.put("docs", "bag/g/b.txt", new TextEncoder().encode("B"))
    await s3.put("docs", "bag/h/c.txt", new TextEncoder().encode("C"))

    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)
    const lists: Record<string, string[]> = {}

    rules.rule({
      name: "pack",
      inputs: {
        bag: new S3Glob("s3://docs/bag/<group>/*", { client: s3 }),
      },
      outputs: { out: new FileOutput("out/<group>.txt", { root }) },
      run: async (ctx) => {
        const keys: string[] = []
        for (const obj of ctx.inputs.bag) {
          keys.push(obj.id)
        }
        lists[ctx.vars.group!] = keys
        await Bun.write(ctx.outputs.out.path, keys.join(","))
      },
    })

    const result = await rules.run()
    expect(result.success).toBe(true)
    expect(sortedIds(result.executed)).toEqual([
      "pack:group=g",
      "pack:group=h",
    ])
    expect(lists["g"]).toEqual(["s3://docs/bag/g/a.txt", "s3://docs/bag/g/b.txt"])
    expect(lists["h"]).toEqual(["s3://docs/bag/h/c.txt"])
  })

  test("S3Output writes one object and a second rule can read it", async () => {
    const root = await tempDir()
    const s3 = new MemoryS3()
    await s3.put("docs", "in/a.txt", new TextEncoder().encode("hello"))

    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)

    rules.rule({
      name: "upper",
      inputs: { src: new S3Pattern("s3://docs/in/<name>.txt", { client: s3 }) },
      outputs: {
        mid: new S3Output("s3://docs/mid/<name>.txt", { client: s3 }),
      },
      run: async (ctx) => {
        const text = new TextDecoder().decode(await ctx.inputs.src.read())
        await s3.put(
          ctx.outputs.mid.bucket,
          ctx.outputs.mid.key,
          new TextEncoder().encode(text.toUpperCase()),
        )
      },
    })

    rules.rule({
      name: "down",
      inputs: { mid: new S3Pattern("s3://docs/mid/<name>.txt", { client: s3 }) },
      outputs: { out: new FileOutput("out/<name>.txt", { root }) },
      run: async (ctx) => {
        await Bun.write(ctx.outputs.out.path, await ctx.inputs.mid.read())
      },
    })

    const result = await rules.run()
    expect(result.success).toBe(true)
    expect(sortedIds(result.executed)).toEqual([
      "down:name=a",
      "upper:name=a",
    ])
    expect(await Bun.file(path.join(root, "out", "a.txt")).text()).toBe("HELLO")
    const mid = await s3.get("docs", "mid/a.txt")
    expect(new TextDecoder().decode(mid)).toBe("HELLO")
  })
})
