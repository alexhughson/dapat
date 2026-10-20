import { describe, expect, test } from "bun:test"
import { Build, IdPrefix, Matcher, Task, isArtifact } from "../src/index"
import type { Artifact, ArtifactEvent, MatchRow, RowEvent } from "../src/index"
import { Mem } from "./mem"

/**
 * A real matcher over in-memory artifacts: it matches the ids `<prefix><name>`,
 * like a FileMatcher for `<prefix><name>`. Its scan finds the artifacts it was given.
 * It treats a promised or produced artifact as found, and a deleted or withdrawn one as gone.
 */
class MemMatcher extends Matcher {
  readonly varNames = ["name"]
  // The artifact events that reached this matcher, as "<kind> <id>".
  readonly heard: string[] = []

  constructor(
    private readonly prefix: string,
    private readonly found: readonly Mem[] = [],
  ) {
    super()
  }

  async scan(_signal: AbortSignal): Promise<void> {
    for (const artifact of this.found) {
      this.foundArtifact(artifact)
    }
  }

  override sendArtifact(event: ArtifactEvent): void {
    if (event.kind === "promised" || event.kind === "withdrawn") {
      this.heard.push(`${event.kind} ${event.output.id}`)
      if (!isArtifact(event.output)) return
      if (event.kind === "promised") {
        this.foundArtifact(event.output)
      } else {
        this.gone(event.output.id)
      }
      return
    }
    this.heard.push(`${event.kind} ${event.artifact.id}`)
    if (event.kind === "produced") {
      this.foundArtifact(event.artifact)
    } else {
      this.gone(event.artifact.id)
    }
  }

  private foundArtifact(artifact: Artifact): void {
    const name = this.nameOf(artifact.id)
    if (name === null) return
    this.send({ kind: "put", row: { vars: { name }, data: artifact } })
  }

  private gone(id: string): void {
    const name = this.nameOf(id)
    if (name === null) return
    this.send({ kind: "drop", vars: { name } })
  }

  private nameOf(id: string): string | null {
    if (!id.startsWith(this.prefix)) return null
    return id.slice(this.prefix.length)
  }
}

/** A MemMatcher whose scan takes `delayMs` and then logs that it returned. */
class SlowMatcher extends MemMatcher {
  constructor(
    prefix: string,
    found: readonly Mem[],
    private readonly delayMs: number,
    private readonly log: string[],
  ) {
    super(prefix, found)
  }

  override async scan(signal: AbortSignal): Promise<void> {
    await Bun.sleep(this.delayMs)
    await super.scan(signal)
    this.log.push(`${this.delayMs}ms scan returned`)
  }
}

/** A matcher whose scan sends a fixed list of row events, in order. */
class EventMatcher extends Matcher {
  constructor(
    readonly varNames: readonly string[],
    private readonly events: readonly RowEvent[],
  ) {
    super()
  }

  async scan(_signal: AbortSignal): Promise<void> {
    for (const event of this.events) {
      this.send(event)
    }
  }
}

/** A matcher whose scan fails, like a list URL that returns HTTP 500. */
class FailingMatcher extends Matcher {
  readonly varNames = ["name"]

  async scan(_signal: AbortSignal): Promise<void> {
    throw new Error("list failed")
  }
}

/** The one artifact of a row. These tests send one artifact per row. */
function one(row: MatchRow): Mem {
  return row.data as Mem
}

/** A task that copies one page into `out:<name>`. */
function copyTask(name: string, page: Mem, log: string[]): Task {
  const out = new Mem(`out:${name}`)
  return new Task({
    id: `copy:${name}`,
    inputs: [page],
    outputs: [out],
    run: async () => {
      log.push(`copy:${name}`)
      out.write(await page.read())
    },
  })
}

function executedIds(tasks: readonly Task[]): string[] {
  const ids: string[] = []
  for (const task of tasks) {
    ids.push(task.id)
  }
  ids.sort()
  return ids
}

describe("build.each with one input", () => {
  test("each scanned row becomes a task", async () => {
    const pageA = new Mem("page:a", "A")
    const pageB = new Mem("page:b", "B")
    const log: string[] = []
    const build = new Build()
    build.each({
      inputs: { page: new MemMatcher("page:", [pageA, pageB]) },
      *tasks(vars, input) {
        yield copyTask(vars.name!, one(input.page), log)
      },
    })

    const result = await build.run()

    expect(result.success).toBe(true)
    expect(executedIds(result.executed)).toEqual(["copy:a", "copy:b"])
  })

  test("a row can give several tasks", async () => {
    const page = new Mem("page:a", "A")
    const log: string[] = []
    const build = new Build()
    build.each({
      inputs: { page: new MemMatcher("page:", [page]) },
      *tasks(vars, input) {
        yield copyTask(vars.name!, one(input.page), log)
        yield new Task({ id: `count:${vars.name}`, inputs: [one(input.page)], run: async () => {} })
      },
    })

    const result = await build.run()

    expect(executedIds(result.executed)).toEqual(["copy:a", "count:a"])
  })

  test("a put with known vars replaces the tasks of that row, and a drop removes them", async () => {
    const matcher = new EventMatcher(
      ["name"],
      [
        { kind: "put", row: { vars: { name: "a" }, data: new Mem("page:a", "1") } },
        { kind: "put", row: { vars: { name: "a" }, data: new Mem("page:a", "2") } },
        { kind: "put", row: { vars: { name: "b" }, data: new Mem("page:b", "1") } },
        { kind: "drop", vars: { name: "b" } },
      ],
    )
    const log: string[] = []
    const build = new Build()
    build.each({
      inputs: { page: matcher },
      *tasks(vars, input) {
        const page = one(input.page)
        // The task id holds the value, so a replaced row gives a new task id.
        yield copyTask(`${vars.name}-${page.value}`, page, log)
      },
    })

    const result = await build.run()

    expect(executedIds(result.executed)).toEqual(["copy:a-2"])
  })

  test("every scan returns before any task starts", async () => {
    const log: string[] = []
    const fast = new SlowMatcher("fast:", [new Mem("fast:a", "x")], 0, log)
    const slow = new SlowMatcher("slow:", [new Mem("slow:a", "x")], 20, log)
    const build = new Build()
    build.each({
      inputs: { page: fast },
      *tasks(vars) {
        yield new Task({ id: `fast:${vars.name}`, run: async () => void log.push(`fast:${vars.name}`) })
      },
    })
    build.each({
      inputs: { page: slow },
      *tasks(vars) {
        yield new Task({ id: `slow:${vars.name}`, run: async () => void log.push(`slow:${vars.name}`) })
      },
    })

    await build.run()

    expect(log.slice(0, 2)).toEqual(["0ms scan returned", "20ms scan returned"])
    expect([...log.slice(2)].sort()).toEqual(["fast:a", "slow:a"])
  })

  test("a promised output makes a rule task, and that task waits for the writer", async () => {
    const page = new Mem("page:a")
    const log: string[] = []
    const build = new Build()
    build.add(
      new Task({
        id: "write",
        outputs: [page],
        run: async () => {
          log.push("write")
          page.write("A")
        },
      }),
    )
    build.each({
      inputs: { page: new MemMatcher("page:") },
      *tasks(vars, input) {
        yield copyTask(vars.name!, one(input.page), log)
      },
    })

    const result = await build.run()

    expect(result.success).toBe(true)
    expect(log).toEqual(["write", "copy:a"])
  })

  test("a row sent during the run makes a task in that run", async () => {
    const log: string[] = []
    const build = new Build()
    build.add(
      new Task({
        id: "split",
        outputs: [new IdPrefix("chapter:")],
        run: async (ctx) => {
          for (const n of ["0", "1"]) {
            const chapter = new Mem(`chapter:${n}`, `text ${n}`)
            ctx.produced(chapter)
            log.push(`produced ${n}`)
          }
        },
      }),
    )
    build.each({
      inputs: { chapter: new MemMatcher("chapter:") },
      *tasks(vars, input) {
        log.push(`made summary:${vars.name}`)
        yield new Task({
          id: `summary:${vars.name}`,
          inputs: [one(input.chapter)],
          run: async () => void log.push(`summary:${vars.name}`),
        })
      },
    })

    const result = await build.run()

    expect(result.success).toBe(true)
    // The rule made each task inside ctx.produced, before the call returned.
    expect(log.slice(0, 4)).toEqual(["made summary:0", "produced 0", "made summary:1", "produced 1"])
    expect(executedIds(result.executed)).toEqual(["split", "summary:0", "summary:1"])
  })

  test("a matcher that two rules use hears each artifact event one time", async () => {
    const matcher = new MemMatcher("page:")
    const build = new Build()
    build.add(new Task({ id: "write", outputs: [new Mem("page:a", "A")], run: async () => {} }))
    for (const kind of ["one", "two"]) {
      build.each({
        inputs: { page: matcher },
        *tasks(vars) {
          yield new Task({ id: `${kind}:${vars.name}`, run: async () => {} })
        },
      })
    }

    const result = await build.run()

    expect(executedIds(result.executed)).toEqual(["one:a", "two:a", "write"])
    expect(matcher.heard).toEqual(["promised page:a", "produced page:a"])
  })
})

describe("build.each errors", () => {
  test("a scan error rejects run(), and no task runs", async () => {
    const matcher = new FailingMatcher()
    const log: string[] = []
    const build = new Build()
    build.add(new Task({ id: "plain", run: async () => void log.push("plain") }))
    build.each({
      inputs: { page: matcher },
      *tasks() {},
    })

    await expect(build.run()).rejects.toThrow("list failed")
    expect(log).toEqual([])
  })

  test("two rows that give one task id reject run()", async () => {
    const matcher = new MemMatcher("page:", [new Mem("page:a", "A"), new Mem("page:b", "B")])
    const build = new Build()
    build.each({
      inputs: { page: matcher },
      *tasks() {
        yield new Task({ id: "same", run: async () => {} })
      },
    })

    await expect(build.run()).rejects.toThrow("task 'same' has two owners: '1:a' and '1:b'")
  })

  test("a row whose vars are not the matcher's varNames rejects run()", async () => {
    const wrongVars: RowEvent = { kind: "put", row: { vars: { slug: "a" }, data: new Mem("page:a", "A") } }
    const matcher = new EventMatcher(["name"], [wrongVars])
    const build = new Build()
    build.each({
      inputs: { page: matcher },
      *tasks() {},
    })

    await expect(build.run()).rejects.toThrow(
      "input 'page' of rule 1 sent a row with vars [slug]; its matcher's varNames are [name]",
    )
  })

  test("a rule needs exactly one input", () => {
    const build = new Build()
    expect(() => build.each({ inputs: {}, *tasks() {} })).toThrow(
      "rule 1 has 0 inputs; a rule needs exactly one input",
    )
    expect(() =>
      build.each({
        inputs: { a: new MemMatcher("a:"), b: new MemMatcher("b:") },
        *tasks() {},
      }),
    ).toThrow("rule 1 has 2 inputs; a rule needs exactly one input")
  })

  test("build.each after run() throws", async () => {
    const build = new Build()
    await build.run()
    expect(() => build.each({ inputs: { page: new MemMatcher("page:") }, *tasks() {} })).toThrow(
      "build.each must come before the first build.run()",
    )
  })
})
