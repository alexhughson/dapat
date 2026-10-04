import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Artifact, Build } from "../../src"
import {
  FieldGen,
  FileOutput,
  MemoryStore,
  RuleBuild,
  capture,
  type FieldRecord,
  type FieldSpec,
} from "../../contrib"

const temps: string[] = []

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dapat-spec-field-"))
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

class RowArtifact extends Artifact<string> {
  readonly id: string

  constructor(
    readonly kind: string,
    readonly key: string,
  ) {
    super()
    this.id = `row:${kind}/${key}`
  }

  async orderStamp(): Promise<bigint | null> {
    return null
  }

  async contentStamp(): Promise<string | null> {
    return this.key
  }

  async read(): Promise<string> {
    return this.key
  }
}

type RowField = "id" | "group" | "tag"

class MemoryRows<S extends FieldSpec<RowField>> extends FieldGen<
  RowField,
  "id",
  RowArtifact,
  S
> {
  constructor(
    private readonly rows: FieldRecord<RowField, RowArtifact>[],
    spec: S,
  ) {
    super(spec, ["id"])
  }

  protected async records(): Promise<FieldRecord<RowField, RowArtifact>[]> {
    const onlyGroup = this.literal("group")
    const out: FieldRecord<RowField, RowArtifact>[] = []
    for (const row of this.rows) {
      if (onlyGroup !== undefined && row.fields.group !== onlyGroup) {
        continue
      }
      out.push(row)
    }
    return out
  }
}

function makeRow(
  id: string,
  group: string,
  tag: string,
): FieldRecord<RowField, RowArtifact> {
  return {
    fields: { id, group, tag },
    artifact: new RowArtifact(group, id),
  }
}

describe("FieldGen over an in-memory list of records", () => {
  const baseRows = [
    makeRow("1", "alpha", "red"),
    makeRow("2", "alpha", "blue"),
    makeRow("3", "beta", "red"),
    makeRow("1", "alpha", "red"),
  ]

  test("literal filter keeps only matching records as single values", async () => {
    const root = await tempDir()
    const gen = new MemoryRows(baseRows, {
      group: "alpha",
      id: capture("id"),
    })
    expect(gen.many).toBe(false)

    const keys: string[] = []
    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)
    rules.rule({
      name: "lit",
      inputs: { row: gen },
      outputs: { out: new FileOutput("out/<id>.txt", { root }) },
      run: async (ctx) => {
        // single artifact, not an array
        keys.push(ctx.inputs.row.key)
        await Bun.write(ctx.outputs.out.path, ctx.inputs.row.key)
      },
    })

    const result = await rules.run()
    expect(result.success).toBe(true)
    expect(sortedIds(result.executed)).toEqual(["lit:id=1", "lit:id=2"])
    expect(keys.sort()).toEqual(["1", "2"])
  })

  test("capture saves the field as the named var", async () => {
    const root = await tempDir()
    const gen = new MemoryRows(baseRows, {
      id: capture("sha"),
      group: capture("branch"),
    })

    const varsSeen: string[] = []
    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)
    rules.rule({
      name: "cap",
      inputs: { row: gen },
      outputs: { out: new FileOutput("out/<branch>-<sha>.txt", { root }) },
      run: async (ctx) => {
        varsSeen.push(`${ctx.vars.branch}/${ctx.vars.sha}`)
        await Bun.write(ctx.outputs.out.path, ctx.inputs.row.key)
      },
    })

    const result = await rules.run()
    expect(result.success).toBe(true)
    expect(varsSeen.sort()).toEqual(["alpha/1", "alpha/2", "beta/3"])
  })

  test("left-out identity field yields a sorted deduped list value", async () => {
    const root = await tempDir()
    const rows = [
      makeRow("c", "g", "t1"),
      makeRow("a", "g", "t2"),
      makeRow("b", "g", "t3"),
      makeRow("a", "g", "t4"), // same identity id=a, same vars {group:g} → dedupe
    ]
    const gen = new MemoryRows(rows, { group: capture("g") })
    expect(gen.many).toBe(true)

    let listIds: string[] = []
    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)
    rules.rule({
      name: "list",
      inputs: { rows: gen },
      outputs: { out: new FileOutput("out/<g>.txt", { root }) },
      run: async (ctx) => {
        listIds = []
        for (const item of ctx.inputs.rows) {
          listIds.push(item.id)
        }
        await Bun.write(ctx.outputs.out.path, listIds.join(","))
      },
    })

    const result = await rules.run()
    expect(result.success).toBe(true)
    expect(sortedIds(result.executed)).toEqual(["list:g=g"])
    // sorted by artifact id, no duplicates
    expect(listIds).toEqual(["row:g/a", "row:g/b", "row:g/c"])
    expect(await Bun.file(path.join(root, "out", "g.txt")).text()).toBe(
      "row:g/a,row:g/b,row:g/c",
    )
  })

  test("left-out non-identity field collapses records that differ only there", async () => {
    const root = await tempDir()
    // leave out `tag`: id=1 appears twice with different tags → one single value
    const gen = new MemoryRows(baseRows, {
      id: capture("id"),
      group: "alpha",
    })

    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)
    rules.rule({
      name: "collapse",
      inputs: { row: gen },
      outputs: { out: new FileOutput("out/<id>.txt", { root }) },
      run: async (ctx) => {
        await Bun.write(ctx.outputs.out.path, ctx.inputs.row.key)
      },
    })

    const result = await rules.run()
    expect(result.success).toBe(true)
    expect(sortedIds(result.executed)).toEqual([
      "collapse:id=1",
      "collapse:id=2",
    ])
  })

  test("same var captured by two fields requires equal values", async () => {
    const root = await tempDir()
    const rows = [
      makeRow("same", "same", "t"),
      makeRow("x", "y", "t"),
    ]
    const gen = new MemoryRows(rows, {
      id: capture("name"),
      group: capture("name"),
    })

    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)
    const names: string[] = []
    rules.rule({
      name: "eq",
      inputs: { row: gen },
      outputs: { out: new FileOutput("out/<name>.txt", { root }) },
      run: async (ctx) => {
        names.push(ctx.vars.name!)
        await Bun.write(ctx.outputs.out.path, "ok")
      },
    })

    const result = await rules.run()
    expect(result.success).toBe(true)
    expect(names).toEqual(["same"])
    expect(sortedIds(result.executed)).toEqual(["eq:name=same"])
  })

  test("start throws when identity fields are wrong for single-value mode", async () => {
    const root = await tempDir()
    // identity is `id`, but two different artifacts share the same captured vars
    const badRows: FieldRecord<RowField, RowArtifact>[] = [
      {
        fields: { id: "1", group: "g", tag: "t" },
        artifact: new RowArtifact("g", "1"),
      },
      {
        fields: { id: "1", group: "g", tag: "t" },
        artifact: new RowArtifact("g", "OTHER"),
      },
    ]
    const gen = new MemoryRows(badRows, {
      id: capture("id"),
      group: capture("group"),
    })

    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)
    rules.rule({
      name: "bad-id",
      inputs: { row: gen },
      outputs: { out: new FileOutput("out/<id>.txt", { root }) },
      run: async (ctx) => {
        await Bun.write(ctx.outputs.out.path, "x")
      },
    })

    let rejected = false
    try {
      await rules.run()
    } catch {
      rejected = true
    }
    expect(rejected).toBe(true)
  })
})
