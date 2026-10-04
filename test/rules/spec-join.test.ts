import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Artifact, Build } from "../../src"
import {
  FileGlob,
  FileOutput,
  FilePattern,
  InputGen,
  MemoryStore,
  RuleBuild,
  type Feed,
} from "../../contrib"

const temps: string[] = []

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dapat-spec-join-"))
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

class ValueArtifact extends Artifact<string> {
  readonly id: string

  constructor(
    readonly name: string,
    readonly value: string,
  ) {
    super()
    this.id = `value:${name}=${value}`
  }

  async orderStamp(): Promise<bigint | null> {
    return null
  }

  async contentStamp(): Promise<string | null> {
    return this.value
  }

  async read(): Promise<string> {
    return this.value
  }
}

class Values extends InputGen<ValueArtifact> {
  readonly varNames: readonly string[]

  constructor(
    private readonly name: string,
    private readonly values: string[],
  ) {
    super()
    this.varNames = [name]
  }

  async start(feed: Feed<ValueArtifact>): Promise<void> {
    for (const value of this.values) {
      feed.set({ [this.name]: value }, new ValueArtifact(this.name, value))
    }
  }
}

class ListGen extends InputGen<ValueArtifact[]> {
  readonly varNames: readonly string[] = []

  constructor(private readonly items: string[]) {
    super()
  }

  async start(feed: Feed<ValueArtifact[]>): Promise<void> {
    const artifacts: ValueArtifact[] = []
    for (const item of this.items) {
      artifacts.push(new ValueArtifact("item", item))
    }
    feed.set({}, artifacts)
  }
}

class EmptyListGen extends InputGen<ValueArtifact[]> {
  readonly varNames: readonly string[] = ["group"]

  async start(feed: Feed<ValueArtifact[]>): Promise<void> {
    feed.set({ group: "g1" }, [])
  }
}

describe("join semantics", () => {
  test("required inputs keep only the inner join of shared vars", async () => {
    const root = await tempDir()
    await mkdir(path.join(root, "pages", "fr"), { recursive: true })
    await mkdir(path.join(root, "pages", "es"), { recursive: true })
    await writeFile(path.join(root, "pages", "fr", "home.md"), "bonjour")
    await writeFile(path.join(root, "pages", "es", "home.md"), "hola")

    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)

    rules.rule({
      name: "translate",
      inputs: {
        locale: new Values("locale", ["fr", "de"]),
        page: new FilePattern("pages/<locale>/<page>.md", { root }),
      },
      outputs: { out: new FileOutput("site/<locale>/<page>.html", { root }) },
      run: async (ctx) => {
        const body = new TextDecoder().decode(await ctx.inputs.page.read())
        await Bun.write(ctx.outputs.out.path, `${ctx.inputs.locale.value}:${body}`)
      },
    })

    const result = await rules.run()
    expect(result.success).toBe(true)
    // pages/es/home.md has no locale in Values; de has no page file
    expect(sortedIds(result.executed)).toEqual([
      "translate:locale=fr,page=home",
    ])
    expect(await Bun.file(path.join(root, "site", "fr", "home.html")).text()).toBe(
      "fr:bonjour",
    )
  })

  test("optional inputs left-join: missing optional keeps the task", async () => {
    const root = await tempDir()
    await mkdir(path.join(root, "src"), { recursive: true })
    await mkdir(path.join(root, "notes"), { recursive: true })
    await writeFile(path.join(root, "src", "a.txt"), "A")
    await writeFile(path.join(root, "src", "b.txt"), "B")
    await writeFile(path.join(root, "notes", "a.txt"), "note-a")

    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)
    const seen: Record<string, boolean> = {}

    rules.rule({
      name: "pack",
      inputs: {
        src: new FilePattern("src/<name>.txt", { root }),
        notes: new FilePattern("notes/<name>.txt", { root }),
      },
      optional: ["notes"],
      outputs: { out: new FileOutput("out/<name>.txt", { root }) },
      run: async (ctx) => {
        seen[ctx.vars.name!] = ctx.inputs.notes !== undefined
        const body = new TextDecoder().decode(await ctx.inputs.src.read())
        let note = ""
        if (ctx.inputs.notes !== undefined) {
          note = new TextDecoder().decode(await ctx.inputs.notes.read())
        }
        await Bun.write(ctx.outputs.out.path, `${body}|${note}`)
      },
    })

    const result = await rules.run()
    expect(result.success).toBe(true)
    expect(sortedIds(result.executed)).toEqual(["pack:name=a", "pack:name=b"])
    expect(seen["a"]).toBe(true)
    expect(seen["b"]).toBe(false)
    expect(await Bun.file(path.join(root, "out", "a.txt")).text()).toBe("A|note-a")
    expect(await Bun.file(path.join(root, "out", "b.txt")).text()).toBe("B|")
  })

  test("no shared vars gives the cross product of required inputs", async () => {
    const root = await tempDir()
    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)

    rules.rule({
      name: "pair",
      inputs: {
        left: new Values("x", ["a", "b"]),
        right: new Values("y", ["1", "2"]),
      },
      outputs: { out: new FileOutput("out/<x>-<y>.txt", { root }) },
      run: async (ctx) => {
        await Bun.write(
          ctx.outputs.out.path,
          `${ctx.inputs.left.value},${ctx.inputs.right.value}`,
        )
      },
    })

    const result = await rules.run()
    expect(result.success).toBe(true)
    expect(sortedIds(result.executed)).toEqual([
      "pair:x=a,y=1",
      "pair:x=a,y=2",
      "pair:x=b,y=1",
      "pair:x=b,y=2",
    ])
  })

  test("three inputs join when each pair shares a different var", async () => {
    const root = await tempDir()
    await mkdir(path.join(root, "ab"), { recursive: true })
    await mkdir(path.join(root, "bc"), { recursive: true })
    await mkdir(path.join(root, "ca"), { recursive: true })
    await writeFile(path.join(root, "ab", "i1-j1.txt"), "ab")
    await writeFile(path.join(root, "bc", "j1-k1.txt"), "bc")
    await writeFile(path.join(root, "ca", "k1-i1.txt"), "ca")
    // dangling edges that must not form a full triangle
    await writeFile(path.join(root, "ab", "i2-j9.txt"), "ab-orphan")
    await writeFile(path.join(root, "bc", "j9-k9.txt"), "bc-orphan")

    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)

    rules.rule({
      name: "tri",
      inputs: {
        ab: new FilePattern("ab/<i>-<j>.txt", { root }),
        bc: new FilePattern("bc/<j>-<k>.txt", { root }),
        ca: new FilePattern("ca/<k>-<i>.txt", { root }),
      },
      outputs: { out: new FileOutput("out/<i>-<j>-<k>.txt", { root }) },
      run: async (ctx) => {
        await Bun.write(
          ctx.outputs.out.path,
          `${ctx.vars.i},${ctx.vars.j},${ctx.vars.k}`,
        )
      },
    })

    const result = await rules.run()
    expect(result.success).toBe(true)
    expect(sortedIds(result.executed)).toEqual(["tri:i=i1,j=j1,k=k1"])
    expect(await Bun.file(path.join(root, "out", "i1-j1-k1.txt")).text()).toBe(
      "i1,j1,k1",
    )
  })

  test("inputs object key order does not change task ids", async () => {
    const runWithOrder = async (order: "ab" | "ba"): Promise<string[]> => {
      const root = await tempDir()
      await mkdir(path.join(root, "a"), { recursive: true })
      await mkdir(path.join(root, "b"), { recursive: true })
      await writeFile(path.join(root, "a", "x.txt"), "A")
      await writeFile(path.join(root, "b", "x.txt"), "B")

      const build = new Build({ store: new MemoryStore() })
      const rules = new RuleBuild(build)
      if (order === "ab") {
        rules.rule({
          name: "merge",
          inputs: {
            a: new FilePattern("a/<name>.txt", { root }),
            b: new FilePattern("b/<name>.txt", { root }),
          },
          outputs: { out: new FileOutput("out/<name>.txt", { root }) },
          run: async (ctx) => {
            await Bun.write(ctx.outputs.out.path, "ok")
          },
        })
      } else {
        rules.rule({
          name: "merge",
          inputs: {
            b: new FilePattern("b/<name>.txt", { root }),
            a: new FilePattern("a/<name>.txt", { root }),
          },
          outputs: { out: new FileOutput("out/<name>.txt", { root }) },
          run: async (ctx) => {
            await Bun.write(ctx.outputs.out.path, "ok")
          },
        })
      }
      const result = await rules.run()
      expect(result.success).toBe(true)
      return sortedIds(result.executed)
    }

    const first = await runWithOrder("ab")
    const second = await runWithOrder("ba")
    expect(first).toEqual(["merge:name=x"])
    expect(second).toEqual(first)
  })

  test("zero-var required input broadcasts; missing entry makes no tasks", async () => {
    const root = await tempDir()
    await mkdir(path.join(root, "src"), { recursive: true })
    await mkdir(path.join(root, "config"), { recursive: true })
    await writeFile(path.join(root, "src", "a.txt"), "A")
    await writeFile(path.join(root, "src", "b.txt"), "B")
    await writeFile(path.join(root, "config", "one.json"), "{}")
    await writeFile(path.join(root, "config", "two.json"), "{}")

    const withConfig = new Build({ store: new MemoryStore() })
    const withConfigRules = new RuleBuild(withConfig)
    withConfigRules.rule({
      name: "use-config",
      inputs: {
        src: new FilePattern("src/<name>.txt", { root }),
        config: new FileGlob("config/*.json", { root }),
      },
      outputs: { out: new FileOutput("out/<name>.txt", { root }) },
      run: async (ctx) => {
        const names: string[] = []
        for (const file of ctx.inputs.config) {
          names.push(path.basename(file.path))
        }
        await Bun.write(ctx.outputs.out.path, names.join(","))
      },
    })
    const hit = await withConfigRules.run()
    expect(hit.success).toBe(true)
    expect(sortedIds(hit.executed)).toEqual([
      "use-config:name=a",
      "use-config:name=b",
    ])
    expect(await Bun.file(path.join(root, "out", "a.txt")).text()).toBe(
      "one.json,two.json",
    )

    const emptyRoot = await tempDir()
    await mkdir(path.join(emptyRoot, "src"), { recursive: true })
    await writeFile(path.join(emptyRoot, "src", "a.txt"), "A")

    const noConfig = new Build({ store: new MemoryStore() })
    const noConfigRules = new RuleBuild(noConfig)
    noConfigRules.rule({
      name: "use-config",
      inputs: {
        src: new FilePattern("src/<name>.txt", { root: emptyRoot }),
        config: new FileGlob("config/*.json", { root: emptyRoot }),
      },
      outputs: { out: new FileOutput("out/<name>.txt", { root: emptyRoot }) },
      run: async (ctx) => {
        await Bun.write(ctx.outputs.out.path, "should-not-run")
      },
    })
    const miss = await noConfigRules.run()
    expect(miss.success).toBe(true)
    expect(sortedIds(miss.executed)).toEqual([])
    expect(sortedIds(miss.skipped)).toEqual([])
  })

  test("zero-var optional input lets tasks run when the entry is missing", async () => {
    const root = await tempDir()
    await mkdir(path.join(root, "src"), { recursive: true })
    await writeFile(path.join(root, "src", "a.txt"), "A")

    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)
    let sawConfig: unknown = "unset"

    rules.rule({
      name: "pack",
      inputs: {
        src: new FilePattern("src/<name>.txt", { root }),
        config: new FileGlob("config/*.json", { root }),
      },
      optional: ["config"],
      outputs: { out: new FileOutput("out/<name>.txt", { root }) },
      run: async (ctx) => {
        sawConfig = ctx.inputs.config
        await Bun.write(ctx.outputs.out.path, "ok")
      },
    })

    const result = await rules.run()
    expect(result.success).toBe(true)
    expect(sortedIds(result.executed)).toEqual(["pack:name=a"])
    expect(sawConfig).toBeUndefined()
  })

  test("a var repeated in one template requires equal captures", async () => {
    const root = await tempDir()
    await mkdir(path.join(root, "pair", "same"), { recursive: true })
    await mkdir(path.join(root, "pair", "other"), { recursive: true })
    await writeFile(path.join(root, "pair", "same", "same.txt"), "ok")
    await writeFile(path.join(root, "pair", "other", "diff.txt"), "no")

    const pattern = new FilePattern("pair/<name>/<name>.txt", { root })
    expect(pattern.match(path.join(root, "pair", "same", "same.txt"))).toEqual({
      name: "same",
    })
    expect(pattern.match(path.join(root, "pair", "other", "diff.txt"))).toBeNull()

    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)
    rules.rule({
      name: "dup",
      inputs: { src: pattern },
      outputs: { out: new FileOutput("out/<name>.txt", { root }) },
      run: async (ctx) => {
        await Bun.write(ctx.outputs.out.path, await ctx.inputs.src.read())
      },
    })

    const result = await rules.run()
    expect(result.success).toBe(true)
    expect(sortedIds(result.executed)).toEqual(["dup:name=same"])
  })

  test("var match is greedy within one segment", async () => {
    const root = await tempDir()
    const pattern = new FilePattern("seg/<a>-<b>.txt", { root })
    const vars = pattern.match(path.join(root, "seg", "x-y-z.txt"))
    expect(vars).toEqual({ a: "x-y", b: "z" })
  })

  test("required empty-list value still makes a task", async () => {
    const root = await tempDir()
    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)
    let gotList: ValueArtifact[] | undefined

    rules.rule({
      name: "empty",
      inputs: { items: new EmptyListGen() },
      outputs: { out: new FileOutput("out/<group>.txt", { root }) },
      run: async (ctx) => {
        gotList = [...ctx.inputs.items]
        await Bun.write(ctx.outputs.out.path, String(ctx.inputs.items.length))
      },
    })

    const result = await rules.run()
    expect(result.success).toBe(true)
    expect(sortedIds(result.executed)).toEqual(["empty:group=g1"])
    expect(gotList).toEqual([])
    expect(await Bun.file(path.join(root, "out", "g1.txt")).text()).toBe("0")
  })

  test("zero-var list generator gives every artifact to each task", async () => {
    const root = await tempDir()
    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)

    rules.rule({
      name: "broadcast",
      inputs: {
        name: new Values("n", ["one", "two"]),
        items: new ListGen(["x", "y"]),
      },
      outputs: { out: new FileOutput("out/<n>.txt", { root }) },
      run: async (ctx) => {
        const parts: string[] = []
        for (const item of ctx.inputs.items) {
          parts.push(item.value)
        }
        await Bun.write(ctx.outputs.out.path, parts.join(","))
      },
    })

    const result = await rules.run()
    expect(result.success).toBe(true)
    expect(sortedIds(result.executed)).toEqual([
      "broadcast:n=one",
      "broadcast:n=two",
    ])
    expect(await Bun.file(path.join(root, "out", "one.txt")).text()).toBe("x,y")
  })
})
