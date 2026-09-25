import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Artifact, Build } from "../../src"
import {
  DirOutput,
  FileGlob,
  FileOutput,
  FilePattern,
  InputGen,
  MemoryStore,
  RuleBuild,
  S3Glob,
  S3Output,
  S3Pattern,
  S3PrefixOutput,
  type Feed,
} from "../../contrib"

const temps: string[] = []

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dapat-spec-shape-"))
  temps.push(dir)
  return dir
}

class BoomGen extends InputGen<Artifact> {
  readonly varNames: readonly string[] = ["n"]

  async start(_feed: Feed<Artifact>): Promise<void> {
    throw new Error("start exploded")
  }
}

class WrongVarsGen extends InputGen<Artifact> {
  readonly varNames: readonly string[] = ["a", "b"]

  constructor(private readonly vars: Record<string, string>) {
    super()
  }

  async start(feed: Feed<Artifact>): Promise<void> {
    feed.set(this.vars, new (class extends Artifact {
      readonly id = "dummy:1"
      async orderStamp() {
        return null
      }
      async contentStamp() {
        return "x"
      }
      async read() {
        return null
      }
    })())
  }
}

describe("rule() and constructor throw conditions", () => {
  test("rule throws when optional name is not an input", () => {
    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)
    let threw = false
    try {
      rules.rule({
        name: "bad-opt",
        inputs: { src: new FilePattern("src/<n>.txt") },
        optional: ["missing"],
        outputs: { out: new FileOutput("out/<n>.txt") },
        run: async () => {},
      } as never)
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  test("rule throws when there is no required input", () => {
    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)
    let threw = false
    try {
      rules.rule({
        name: "all-optional",
        inputs: {
          a: new FilePattern("a/<n>.txt"),
          b: new FilePattern("b/<n>.txt"),
        },
        optional: ["a", "b"],
        outputs: { out: new FileOutput("out/<n>.txt") },
        run: async () => {},
      })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  test("rule throws when optional input uses a var no required input captures", () => {
    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)
    let threw = false
    try {
      rules.rule({
        name: "opt-extra-var",
        inputs: {
          src: new FilePattern("src/<n>.txt"),
          extra: new FilePattern("extra/<n>/<m>.txt"),
        },
        optional: ["extra"],
        outputs: { out: new FileOutput("out/<n>.txt") },
        run: async () => {},
      })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  test("rule throws when output uses a var no required input captures", () => {
    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)
    let threw = false
    try {
      rules.rule({
        name: "out-extra-var",
        inputs: { src: new FilePattern("src/<n>.txt") },
        outputs: { out: new FileOutput("out/<n>/<m>.txt") },
        run: async () => {},
      })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  test("FilePattern throws when the template contains a glob", () => {
    let threw = false
    let message = ""
    try {
      new FilePattern("posts/*.md")
    } catch (err) {
      threw = true
      if (err instanceof Error) {
        message = err.message
      }
    }
    expect(threw).toBe(true)
    expect(message.toLowerCase().includes("fileglob") || message.includes("FileGlob")).toBe(
      true,
    )
  })

  test("FilePattern throws when the template contains **", () => {
    let threw = false
    try {
      new FilePattern("posts/<dir>/**")
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  test("FileGlob throws when the template has no glob", () => {
    let threw = false
    try {
      new FileGlob("posts/<name>.md")
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  test("FileOutput throws when the template contains a glob", () => {
    let threw = false
    try {
      new FileOutput("out/*.txt")
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  test("FileOutput throws when the template ends with /", () => {
    let threw = false
    try {
      new FileOutput("out/<name>/")
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  test("DirOutput throws when the template does not end with /", () => {
    let threw = false
    try {
      new DirOutput("pages/<doc>")
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  test("DirOutput throws when the template contains a glob", () => {
    let threw = false
    try {
      new DirOutput("pages/<doc>/*/")
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  test("S3Pattern throws without s3://<bucket>/", () => {
    const fakeClient = {
      head: async () => null,
      get: async () => new Uint8Array(),
      put: async () => ({ lastModified: new Date(), etag: "e" }),
      list: async () => [] as string[],
    }
    let threw = false
    try {
      new S3Pattern("docs/inbox/<doc>.txt", { client: fakeClient })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  test("S3Pattern throws when the template contains a glob", () => {
    const fakeClient = {
      head: async () => null,
      get: async () => new Uint8Array(),
      put: async () => ({ lastModified: new Date(), etag: "e" }),
      list: async () => [] as string[],
    }
    let threw = false
    try {
      new S3Pattern("s3://docs/inbox/*.txt", { client: fakeClient })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  test("S3Output throws without s3://<bucket>/, with glob, or ending with /", () => {
    const fakeClient = {
      head: async () => null,
      get: async () => new Uint8Array(),
      put: async () => ({ lastModified: new Date(), etag: "e" }),
      list: async () => [] as string[],
    }
    const cases = [
      "docs/out/<n>.txt",
      "s3://docs/out/*.txt",
      "s3://docs/out/<n>/",
    ]
    for (const template of cases) {
      let threw = false
      try {
        new S3Output(template, { client: fakeClient })
      } catch {
        threw = true
      }
      expect(threw).toBe(true)
    }
  })

  test("S3Glob throws without glob or without s3:// prefix", () => {
    const fakeClient = {
      head: async () => null,
      get: async () => new Uint8Array(),
      put: async () => ({ lastModified: new Date(), etag: "e" }),
      list: async () => [] as string[],
    }
    let noGlob = false
    try {
      new S3Glob("s3://docs/out/<n>.txt", { client: fakeClient })
    } catch {
      noGlob = true
    }
    expect(noGlob).toBe(true)

    let noScheme = false
    try {
      new S3Glob("docs/out/*.txt", { client: fakeClient })
    } catch {
      noScheme = true
    }
    expect(noScheme).toBe(true)
  })

  test("S3PrefixOutput throws without trailing / or with a glob", () => {
    let noSlash = false
    try {
      new S3PrefixOutput("s3://docs/pages/<doc>")
    } catch {
      noSlash = true
    }
    expect(noSlash).toBe(true)

    let withGlob = false
    try {
      new S3PrefixOutput("s3://docs/pages/<doc>/*/")
    } catch {
      withGlob = true
    }
    expect(withGlob).toBe(true)
  })

  test("Feed.set with wrong var names throws", async () => {
    const root = await tempDir()
    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)

    rules.rule({
      name: "bad-feed",
      inputs: { bad: new WrongVarsGen({ a: "1" }) },
      outputs: { out: new FileOutput("out/<a>.txt", { root }) },
      run: async (ctx) => {
        await Bun.write(ctx.outputs.out.path, "x")
      },
    })

    let threw = false
    try {
      await rules.run()
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  test("generator start that throws makes rules.run() reject", async () => {
    const root = await tempDir()
    await mkdir(path.join(root, "src"), { recursive: true })
    await writeFile(path.join(root, "src", "a.txt"), "a")

    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)
    rules.rule({
      name: "boom",
      inputs: { bad: new BoomGen() },
      outputs: { out: new FileOutput("out/<n>.txt", { root }) },
      run: async (ctx) => {
        await Bun.write(ctx.outputs.out.path, "x")
      },
    })

    let message = ""
    let rejected = false
    try {
      await rules.run()
    } catch (err) {
      rejected = true
      if (err instanceof Error) {
        message = err.message
      }
    }
    expect(rejected).toBe(true)
    expect(message).toBe("start exploded")
  })
})
