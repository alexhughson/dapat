import { describe, expect, test } from "bun:test"
import { Build, IdPrefix, Matcher, Task } from "../src/index"
import type { Artifact, ArtifactEvent, RowData, RowEvent } from "../src/index"
import { Mem } from "./mem"

/**
 * A real matcher over in-memory artifacts: it matches the ids `<prefix><name>`,
 * like a FileMatcher for `<prefix><name>`. Its scan finds the artifacts it was given.
 * It treats a promised or produced artifact as found, and a deleted or withdrawn one as gone.
 * Like the Posts matcher in DOCS.md, it puts a row again for each event of one artifact.
 */
class MemMatcher extends Matcher<Mem> {
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
      if (!(event.output instanceof Mem)) return
      if (event.kind === "promised") {
        this.foundArtifact(event.output)
      } else {
        this.gone(event.output)
      }
      return
    }
    this.heard.push(`${event.kind} ${event.artifact.id}`)
    if (!(event.artifact instanceof Mem)) return
    if (event.kind === "produced") {
      this.foundArtifact(event.artifact)
    } else {
      this.gone(event.artifact)
    }
  }

  private foundArtifact(artifact: Mem): void {
    const name = this.nameOf(artifact)
    if (name === null) return
    this.send({ kind: "put", row: { vars: { name }, data: artifact } })
  }

  private gone(artifact: Artifact): void {
    const name = this.nameOf(artifact)
    if (name === null) return
    this.send({ kind: "drop", vars: { name } })
  }

  private nameOf(artifact: Artifact): string | null {
    if (!artifact.id.startsWith(this.prefix)) return null
    return artifact.id.slice(this.prefix.length)
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

/** A MemMatcher whose scan waits until the test calls `finish()`. */
class DeferredMatcher extends MemMatcher {
  private readonly gate = Promise.withResolvers<void>()

  finish(): void {
    this.gate.resolve()
  }

  override async scan(signal: AbortSignal): Promise<void> {
    await this.gate.promise
    await super.scan(signal)
  }
}

/** A matcher whose scan sends a fixed list of row events, in order. */
class EventMatcher<D extends RowData> extends Matcher<D> {
  constructor(
    readonly varNames: readonly string[],
    protected readonly events: readonly RowEvent<D>[],
  ) {
    super()
  }

  async scan(_signal: AbortSignal): Promise<void> {
    for (const event of this.events) {
      this.send(event)
    }
  }
}

/** Like EventMatcher, but it catches the error of each send, as a matcher that skips bad items does. */
class CatchingMatcher extends EventMatcher<Mem> {
  override async scan(_signal: AbortSignal): Promise<void> {
    for (const event of this.events) {
      try {
        this.send(event)
      } catch {
        // skips the item
      }
    }
  }
}

/** A MemMatcher that catches every error of its sends while it hears the build. */
class QuietMemMatcher extends MemMatcher {
  override sendArtifact(event: ArtifactEvent): void {
    try {
      super.sendArtifact(event)
    } catch {
      // ignores the artifact
    }
  }
}

/** A matcher whose scan fails, like a list URL that returns HTTP 500. */
class FailingMatcher extends Matcher<Mem> {
  readonly varNames = ["name"]

  async scan(_signal: AbortSignal): Promise<void> {
    throw new Error("list failed")
  }
}

/** A matcher whose scan sends `first`, if given, and then never returns. It ignores its signal. */
class HangingMatcher extends Matcher<Mem> {
  readonly varNames = ["name"]

  constructor(private readonly first: Mem | null = null) {
    super()
  }

  async scan(_signal: AbortSignal): Promise<void> {
    if (this.first !== null) {
      this.send({ kind: "put", row: { vars: { name: "a" }, data: this.first } })
    }
    await new Promise<void>(() => {})
  }
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

function sortedIds(tasks: readonly Task[]): string[] {
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
        yield copyTask(vars.name!, input.page.data, log)
      },
    })

    const result = await build.run()

    expect(result.success).toBe(true)
    expect(sortedIds(result.executed)).toEqual(["copy:a", "copy:b"])
  })

  test("a row can give several tasks", async () => {
    const page = new Mem("page:a", "A")
    const log: string[] = []
    const build = new Build()
    build.each({
      inputs: { page: new MemMatcher("page:", [page]) },
      *tasks(vars, input) {
        // The data has the type of its matcher, Mem, and not any.
        // @ts-expect-error Mem has no field notAField
        void input.page.data.notAField
        yield copyTask(vars.name!, input.page.data, log)
        yield new Task({ id: `count:${vars.name}`, inputs: [input.page.data], run: async () => {} })
      },
    })

    const result = await build.run()

    expect(sortedIds(result.executed)).toEqual(["copy:a", "count:a"])
  })

  test("a put with known vars and new data replaces the tasks of that row, and a drop removes them", async () => {
    const matcher = new EventMatcher<Mem>(
      ["name"],
      [
        { kind: "put", row: { vars: { name: "a" }, data: new Mem("page:a-1", "1") } },
        { kind: "put", row: { vars: { name: "a" }, data: new Mem("page:a-2", "2") } },
        { kind: "put", row: { vars: { name: "b" }, data: new Mem("page:b-1", "1") } },
        { kind: "drop", vars: { name: "b" } },
      ],
    )
    const log: string[] = []
    const build = new Build()
    build.each({
      inputs: { page: matcher },
      *tasks(vars, input) {
        const page = input.page.data
        // The task id holds the value, so a replaced row gives a new task id.
        yield copyTask(`${vars.name}-${page.value}`, page, log)
      },
    })

    const result = await build.run()

    expect(sortedIds(result.executed)).toEqual(["copy:a-2"])
  })

  test("a put with the same data as the current row does nothing", async () => {
    let made = 0
    const matcher = new EventMatcher<Mem>(
      ["name"],
      [
        { kind: "put", row: { vars: { name: "a" }, data: new Mem("page:a", "1") } },
        // A new object with the same id is the same data.
        { kind: "put", row: { vars: { name: "a" }, data: new Mem("page:a", "1") } },
      ],
    )
    const build = new Build()
    build.each({
      inputs: { page: matcher },
      *tasks(vars) {
        made += 1
        yield new Task({ id: `t:${vars.name}`, run: async () => {} })
      },
    })

    const result = await build.run()

    expect(made).toBe(1)
    expect(result.cancelled).toEqual([])
  })

  test("a list row is equal only with the same ids in the same order", async () => {
    const a = new Mem("html:a", "A")
    const b = new Mem("html:b", "B")
    const made: string[] = []
    const matcher = new EventMatcher<readonly Mem[]>(
      ["lang"],
      [
        { kind: "put", row: { vars: { lang: "en" }, data: [a] } },
        { kind: "put", row: { vars: { lang: "en" }, data: [a, b] } },
        { kind: "put", row: { vars: { lang: "en" }, data: [a, b] } },
        { kind: "put", row: { vars: { lang: "en" }, data: [b, a] } },
      ],
    )
    const build = new Build()
    build.each({
      inputs: { html: matcher },
      *tasks(vars, input) {
        const ids: string[] = []
        for (const page of input.html.data) {
          ids.push(page.id)
        }
        made.push(ids.join(","))
        // The data is typed, so it spreads into the inputs with no cast.
        yield new Task({ id: `sitemap:${vars.lang}`, inputs: [...input.html.data], run: async () => {} })
      },
    })

    const result = await build.run()

    expect(made).toEqual(["html:a", "html:a,html:b", "html:b,html:a"])
    expect(sortedIds(result.executed)).toEqual(["sitemap:en"])
  })

  test("a task that rewrites its own input in place runs one time", async () => {
    const post = new Mem("post:a", "draft")
    let runs = 0
    const build = new Build()
    build.each({
      inputs: { post: new MemMatcher("post:", [post]) },
      *tasks(vars, input) {
        const file = input.post.data
        yield new Task({
          id: `format:${vars.name}`,
          inputs: [file],
          outputs: [file],
          run: async () => {
            runs += 1
            // Before equal puts did nothing, each produced event replaced and reran this task.
            if (runs > 3) throw new Error("the format task runs again and again")
            file.write(`${await file.read()}!`)
          },
        })
      },
    })

    const result = await build.run()

    expect(runs).toBe(1)
    expect(sortedIds(result.executed)).toEqual(["format:a"])
    expect(result.cancelled).toEqual([])
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

  test("a run() that starts during the scans waits for them and runs the rule tasks", async () => {
    const matcher = new DeferredMatcher("page:", [new Mem("page:a", "A")])
    const log: string[] = []
    const build = new Build()
    build.each({
      inputs: { page: matcher },
      *tasks(vars, input) {
        yield copyTask(vars.name!, input.page.data, log)
      },
    })

    const first = build.run()
    const second = build.run()
    matcher.finish()
    const secondResult = await second
    const firstResult = await first

    expect(sortedIds(secondResult.executed)).toEqual(["copy:a"])
    expect(sortedIds(firstResult.executed)).toEqual(["copy:a"])
    expect(log).toEqual(["copy:a"])
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
        yield copyTask(vars.name!, input.page.data, log)
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
          inputs: [input.chapter.data],
          run: async () => void log.push(`summary:${vars.name}`),
        })
      },
    })

    const result = await build.run()

    expect(result.success).toBe(true)
    // The rule made each task inside ctx.produced, before the call returned.
    expect(log.slice(0, 4)).toEqual(["made summary:0", "produced 0", "made summary:1", "produced 1"])
    expect(sortedIds(result.executed)).toEqual(["split", "summary:0", "summary:1"])
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

    expect(sortedIds(result.executed)).toEqual(["one:a", "two:a", "write"])
    expect(matcher.heard).toEqual(["promised page:a", "produced page:a"])
  })
})

describe("build.each errors", () => {
  test("a scan error rejects run(), and no task runs", async () => {
    const log: string[] = []
    const build = new Build()
    build.add(new Task({ id: "plain", run: async () => void log.push("plain") }))
    build.each({
      inputs: { page: new FailingMatcher() },
      *tasks() {},
    })

    await expect(build.run()).rejects.toThrow("list failed")
    expect(log).toEqual([])
  })

  test("a scan error rejects run() even when another scan never returns", async () => {
    const build = new Build()
    build.each({ inputs: { page: new HangingMatcher() }, *tasks() {} })
    build.each({ inputs: { page: new FailingMatcher() }, *tasks() {} })

    await expect(build.run()).rejects.toThrow("list failed")
  })

  test("a subscriber error during the scans rejects run() even when a scan never returns", async () => {
    const build = new Build()
    build.subscribe((event) => {
      if (event.kind === "promised") throw new Error("index is full")
    })
    build.each({
      inputs: { page: new HangingMatcher(new Mem("page:a", "A")) },
      *tasks(vars) {
        yield new Task({ id: `t:${vars.name}`, outputs: [new Mem(`out:${vars.name}`)], run: async () => {} })
      },
    })

    await expect(build.run()).rejects.toThrow("index is full")
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

  test("a matcher that catches the error of its send cannot hide a rule error", async () => {
    const build = new Build()
    build.each({
      inputs: {
        page: new CatchingMatcher(
          ["name"],
          [
            { kind: "put", row: { vars: { name: "a" }, data: new Mem("page:a", "A") } },
            { kind: "put", row: { vars: { name: "b" }, data: new Mem("page:b", "B") } },
          ],
        ),
      },
      *tasks() {
        yield new Task({ id: "same", run: async () => {} })
      },
    })

    await expect(build.run()).rejects.toThrow("task 'same' has two owners: '1:a' and '1:b'")
  })

  test("a rule error outside run() makes the next run() reject, even if the matcher catches it", async () => {
    const build = new Build()
    build.each({
      inputs: { page: new QuietMemMatcher("page:") },
      *tasks(vars) {
        if (vars.name === "bad") throw new Error("bad row")
        yield new Task({ id: `t:${vars.name}`, run: async () => {} })
      },
    })
    const first = await build.run()
    expect(first.success).toBe(true)

    // Its promised event reaches the matcher, and the rule throws.
    build.add(new Task({ id: "write", outputs: [new Mem("page:bad")], run: async () => {} }))

    await expect(build.run()).rejects.toThrow("bad row")
  })

  test("a row whose vars are not the matcher's varNames rejects run()", async () => {
    const wrongVars: RowEvent<Mem> = { kind: "put", row: { vars: { slug: "a" }, data: new Mem("page:a", "A") } }
    const build = new Build()
    build.each({
      inputs: { page: new EventMatcher(["name"], [wrongVars]) },
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

  test("a matcher belongs to one Build", () => {
    const matcher = new MemMatcher("page:")
    const first = new Build()
    first.each({ inputs: { page: matcher }, *tasks() {} })
    const second = new Build()

    expect(() => second.each({ inputs: { page: matcher }, *tasks() {} })).toThrow(
      "rule 1: its matcher belongs to another Build; make a new matcher for each Build",
    )
  })
})
