import { describe, expect, test } from "bun:test"
import { Build, IdPrefix, Matcher, Task } from "../src/index"
import type { Artifact, ArtifactEvent, MatchedData, MatchedArtifactEvent } from "../src/index"
import { Mem } from "./mem"

/**
 * A real matcher over in-memory artifacts: it matches the ids `<prefix><name>`,
 * like a FileMatcher for `<prefix><name>`. Its scan finds the artifacts it was given.
 * It treats a promised or produced artifact as found, and a deleted or withdrawn one as gone.
 * Like the Posts matcher in DOCS.md, it sends `found` again for each event of one artifact.
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

  override receiveArtifactEvent(event: ArtifactEvent): void {
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
    this.send({ kind: "found", matched: { vars: { name }, data: artifact } })
  }

  private gone(artifact: Artifact): void {
    const name = this.nameOf(artifact)
    if (name === null) return
    this.send({ kind: "gone", vars: { name } })
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

/** A matcher whose scan sends a fixed list of matched artifact events, in order. */
class EventMatcher<D extends MatchedData> extends Matcher<D> {
  constructor(
    readonly varNames: readonly string[],
    protected readonly events: readonly MatchedArtifactEvent<D>[],
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
  override receiveArtifactEvent(event: ArtifactEvent): void {
    try {
      super.receiveArtifactEvent(event)
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
      this.send({ kind: "found", matched: { vars: { name: "a" }, data: this.first } })
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

describe("build.each with one matcher", () => {
  test("each artifact that a scan finds becomes a task", async () => {
    const pageA = new Mem("page:a", "A")
    const pageB = new Mem("page:b", "B")
    const log: string[] = []
    const build = new Build()
    build.each({
      matchersByName: { page: new MemMatcher("page:", [pageA, pageB]) },
      *tasks(vars, matched) {
        yield copyTask(vars.name!, matched.page.data, log)
      },
    })

    const result = await build.run()

    expect(result.success).toBe(true)
    expect(sortedIds(result.executed)).toEqual(["copy:a", "copy:b"])
  })

  test("one matched artifact can give several tasks", async () => {
    const page = new Mem("page:a", "A")
    const log: string[] = []
    const build = new Build()
    build.each({
      matchersByName: { page: new MemMatcher("page:", [page]) },
      *tasks(vars, matched) {
        // The data has the type of its matcher, Mem, and not any.
        // @ts-expect-error Mem has no field notAField
        void matched.page.data.notAField
        yield copyTask(vars.name!, matched.page.data, log)
        yield new Task({ id: `count:${vars.name}`, inputs: [matched.page.data], run: async () => {} })
      },
    })

    const result = await build.run()

    expect(sortedIds(result.executed)).toEqual(["copy:a", "count:a"])
  })

  test("found with known vars and new data replaces the tasks of that match, and gone removes them", async () => {
    const matcher = new EventMatcher<Mem>(
      ["name"],
      [
        { kind: "found", matched: { vars: { name: "a" }, data: new Mem("page:a-1", "1") } },
        { kind: "found", matched: { vars: { name: "a" }, data: new Mem("page:a-2", "2") } },
        { kind: "found", matched: { vars: { name: "b" }, data: new Mem("page:b-1", "1") } },
        { kind: "gone", vars: { name: "b" } },
      ],
    )
    const log: string[] = []
    const build = new Build()
    build.each({
      matchersByName: { page: matcher },
      *tasks(vars, matched) {
        const page = matched.page.data
        // The task id holds the value, so a replaced match gives a new task id.
        yield copyTask(`${vars.name}-${page.value}`, page, log)
      },
    })

    const result = await build.run()

    expect(sortedIds(result.executed)).toEqual(["copy:a-2"])
  })

  test("found with the same artifact ids as the current match does nothing", async () => {
    let made = 0
    const matcher = new EventMatcher<Mem>(
      ["name"],
      [
        { kind: "found", matched: { vars: { name: "a" }, data: new Mem("page:a", "1") } },
        // A new object with the same id is the same data.
        { kind: "found", matched: { vars: { name: "a" }, data: new Mem("page:a", "1") } },
      ],
    )
    const build = new Build()
    build.each({
      matchersByName: { page: matcher },
      *tasks(vars) {
        made += 1
        yield new Task({ id: `t:${vars.name}`, run: async () => {} })
      },
    })

    const result = await build.run()

    expect(made).toBe(1)
    expect(result.cancelled).toEqual([])
  })

  test("a list match is equal only with the same ids in the same order", async () => {
    const a = new Mem("html:a", "A")
    const b = new Mem("html:b", "B")
    const made: string[] = []
    const matcher = new EventMatcher<readonly Mem[]>(
      ["lang"],
      [
        { kind: "found", matched: { vars: { lang: "en" }, data: [a] } },
        { kind: "found", matched: { vars: { lang: "en" }, data: [a, b] } },
        { kind: "found", matched: { vars: { lang: "en" }, data: [a, b] } },
        { kind: "found", matched: { vars: { lang: "en" }, data: [b, a] } },
      ],
    )
    const build = new Build()
    build.each({
      matchersByName: { html: matcher },
      *tasks(vars, matched) {
        const ids: string[] = []
        for (const page of matched.html.data) {
          ids.push(page.id)
        }
        made.push(ids.join(","))
        // The data is typed, so it spreads into the inputs with no cast.
        yield new Task({ id: `sitemap:${vars.lang}`, inputs: [...matched.html.data], run: async () => {} })
      },
    })

    const result = await build.run()

    expect(made).toEqual(["html:a", "html:a,html:b", "html:b,html:a"])
    expect(sortedIds(result.executed)).toEqual(["sitemap:en"])
  })

  test("one artifact and a list of that one artifact are different data", async () => {
    const a = new Mem("html:a", "A")
    const shapes: string[] = []
    const matcher = new EventMatcher<Mem | readonly Mem[]>(
      ["lang"],
      [
        { kind: "found", matched: { vars: { lang: "en" }, data: a } },
        { kind: "found", matched: { vars: { lang: "en" }, data: [a] } },
      ],
    )
    const build = new Build()
    build.each({
      matchersByName: { html: matcher },
      *tasks(vars, matched) {
        const data = matched.html.data
        if (Array.isArray(data)) {
          shapes.push("list")
        } else {
          shapes.push("one")
        }
        yield new Task({ id: `sitemap:${vars.lang}`, run: async () => {} })
      },
    })

    await build.run()

    expect(shapes).toEqual(["one", "list"])
  })

  test("a var named __proto__ and a matcher named __proto__ reach tasks() as own properties", async () => {
    const events: MatchedArtifactEvent<Mem>[] = []
    for (const owner of ["ann", "bob"]) {
      // A computed key makes an own property named __proto__.
      events.push({ kind: "found", matched: { vars: { ["__proto__"]: owner, slug: "x" }, data: new Mem(`mem:${owner}`, "1") } })
    }
    const matcher = new EventMatcher<Mem>(["__proto__", "slug"], events)
    const got: string[] = []
    const build = new Build()
    build.each({
      matchersByName: { ["__proto__"]: matcher },
      *tasks(vars, matched) {
        const owner = Object.hasOwn(vars, "__proto__") ? vars["__proto__"] : "?"
        const data = Object.hasOwn(matched, "__proto__") ? matched["__proto__"].data.id : "?"
        got.push(`${owner} ${data}`)
        yield new Task({ id: `t:${owner}/${vars.slug}`, run: async () => {} })
      },
    })

    const result = await build.run()

    expect(got).toEqual(["ann mem:ann", "bob mem:bob"])
    expect(sortedIds(result.executed)).toEqual(["t:ann/x", "t:bob/x"])
  })

  test("a var value with a lone surrogate makes a task", async () => {
    // The two halves of one emoji, each one alone.
    const highHalf = "\ud83d"
    const lowHalf = "\ude00"
    const matcher = new EventMatcher<Mem>(
      ["name"],
      [
        { kind: "found", matched: { vars: { name: highHalf }, data: new Mem("page:high", "1") } },
        { kind: "found", matched: { vars: { name: lowHalf }, data: new Mem("page:low", "1") } },
      ],
    )
    const build = new Build()
    build.each({
      matchersByName: { page: matcher },
      *tasks(_vars, matched) {
        yield new Task({ id: `t:${matched.page.data.id}`, run: async () => {} })
      },
    })

    const result = await build.run()

    expect(sortedIds(result.executed)).toEqual(["t:page:high", "t:page:low"])
  })

  test("a task that rewrites its own input in place runs one time", async () => {
    const post = new Mem("post:a", "draft")
    let runs = 0
    const build = new Build()
    build.each({
      matchersByName: { post: new MemMatcher("post:", [post]) },
      *tasks(vars, matched) {
        const file = matched.post.data
        yield new Task({
          id: `format:${vars.name}`,
          inputs: [file],
          outputs: [file],
          run: async () => {
            runs += 1
            // Before an equal found did nothing, each produced event replaced and reran this task.
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
      matchersByName: { page: fast },
      *tasks(vars) {
        yield new Task({ id: `fast:${vars.name}`, run: async () => void log.push(`fast:${vars.name}`) })
      },
    })
    build.each({
      matchersByName: { page: slow },
      *tasks(vars) {
        yield new Task({ id: `slow:${vars.name}`, run: async () => void log.push(`slow:${vars.name}`) })
      },
    })

    await build.run()

    expect(log.slice(0, 2)).toEqual(["0ms scan returned", "20ms scan returned"])
    expect([...log.slice(2)].sort()).toEqual(["fast:a", "slow:a"])
  })

  test("a run() that starts during the scans waits for them and runs their tasks", async () => {
    const matcher = new DeferredMatcher("page:", [new Mem("page:a", "A")])
    const log: string[] = []
    const build = new Build()
    build.each({
      matchersByName: { page: matcher },
      *tasks(vars, matched) {
        yield copyTask(vars.name!, matched.page.data, log)
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

  test("a promised output makes a task, and that task waits for the writer", async () => {
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
      matchersByName: { page: new MemMatcher("page:") },
      *tasks(vars, matched) {
        yield copyTask(vars.name!, matched.page.data, log)
      },
    })

    const result = await build.run()

    expect(result.success).toBe(true)
    expect(log).toEqual(["write", "copy:a"])
  })

  test("an artifact found during the run makes a task in that run", async () => {
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
      matchersByName: { chapter: new MemMatcher("chapter:") },
      *tasks(vars, matched) {
        log.push(`made summary:${vars.name}`)
        yield new Task({
          id: `summary:${vars.name}`,
          inputs: [matched.chapter.data],
          run: async () => void log.push(`summary:${vars.name}`),
        })
      },
    })

    const result = await build.run()

    expect(result.success).toBe(true)
    // build.each made each task inside ctx.produced, before the call returned.
    expect(log.slice(0, 4)).toEqual(["made summary:0", "produced 0", "made summary:1", "produced 1"])
    expect(sortedIds(result.executed)).toEqual(["split", "summary:0", "summary:1"])
  })

  test("a matcher that two build.each calls use gets each artifact event one time", async () => {
    const matcher = new MemMatcher("page:")
    const build = new Build()
    build.add(new Task({ id: "write", outputs: [new Mem("page:a", "A")], run: async () => {} }))
    for (const kind of ["one", "two"]) {
      build.each({
        matchersByName: { page: matcher },
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
      matchersByName: { page: new FailingMatcher() },
      *tasks() {},
    })

    await expect(build.run()).rejects.toThrow("list failed")
    expect(log).toEqual([])
  })

  test("a scan error rejects run() even when another scan never returns", async () => {
    const build = new Build()
    build.each({ matchersByName: { page: new HangingMatcher() }, *tasks() {} })
    build.each({ matchersByName: { page: new FailingMatcher() }, *tasks() {} })

    await expect(build.run()).rejects.toThrow("list failed")
  })

  test("a subscriber error during the scans rejects run() even when a scan never returns", async () => {
    const build = new Build()
    build.subscribe((event) => {
      if (event.kind === "promised") throw new Error("index is full")
    })
    build.each({
      matchersByName: { page: new HangingMatcher(new Mem("page:a", "A")) },
      *tasks(vars) {
        yield new Task({ id: `t:${vars.name}`, outputs: [new Mem(`out:${vars.name}`)], run: async () => {} })
      },
    })

    await expect(build.run()).rejects.toThrow("index is full")
  })

  test("two matches that give one task id reject run()", async () => {
    const matcher = new MemMatcher("page:", [new Mem("page:a", "A"), new Mem("page:b", "B")])
    const build = new Build()
    build.each({
      matchersByName: { page: matcher },
      *tasks() {
        yield new Task({ id: "same", run: async () => {} })
      },
    })

    await expect(build.run()).rejects.toThrow("task 'same' is in two groups: 'build.each 1 name=a' and 'build.each 1 name=b'")
  })

  test("a matcher that catches the error of its send cannot hide a build.each error", async () => {
    const build = new Build()
    build.each({
      matchersByName: {
        page: new CatchingMatcher(
          ["name"],
          [
            { kind: "found", matched: { vars: { name: "a" }, data: new Mem("page:a", "A") } },
            { kind: "found", matched: { vars: { name: "b" }, data: new Mem("page:b", "B") } },
          ],
        ),
      },
      *tasks() {
        yield new Task({ id: "same", run: async () => {} })
      },
    })

    await expect(build.run()).rejects.toThrow("task 'same' is in two groups: 'build.each 1 name=a' and 'build.each 1 name=b'")
  })

  test("a build.each error outside run() makes the next run() reject, even if the matcher catches it", async () => {
    const build = new Build()
    build.each({
      matchersByName: { page: new QuietMemMatcher("page:") },
      *tasks(vars) {
        if (vars.name === "bad") throw new Error("bad match")
        yield new Task({ id: `t:${vars.name}`, run: async () => {} })
      },
    })
    const first = await build.run()
    expect(first.success).toBe(true)

    // Its promised event reaches the matcher, and tasks() throws.
    build.add(new Task({ id: "write", outputs: [new Mem("page:bad")], run: async () => {} }))

    await expect(build.run()).rejects.toThrow("bad match")
  })

  test("a match whose vars are not the matcher's varNames rejects run()", async () => {
    const wrongVars: MatchedArtifactEvent<Mem> = { kind: "found", matched: { vars: { slug: "a" }, data: new Mem("page:a", "A") } }
    const build = new Build()
    build.each({
      matchersByName: { page: new EventMatcher(["name"], [wrongVars]) },
      *tasks() {},
    })

    await expect(build.run()).rejects.toThrow(
      "matcher 'page' of build.each 1 sent vars [slug]; its varNames are [name]",
    )
  })

  test("a gone with wrong var names rejects run(); a gone with the right var names and no match does nothing", async () => {
    const unknownGone = new EventMatcher<Mem>(["name"], [{ kind: "gone", vars: { name: "nobody" } }])
    const quiet = new Build()
    quiet.each({ matchersByName: { page: unknownGone }, *tasks() {} })
    const result = await quiet.run()
    expect(result.success).toBe(true)

    const wrongGone = new EventMatcher<Mem>(["name"], [{ kind: "gone", vars: { slug: "a" } }])
    const failing = new Build()
    failing.each({ matchersByName: { page: wrongGone }, *tasks() {} })
    await expect(failing.run()).rejects.toThrow(
      "matcher 'page' of build.each 1 sent vars [slug]; its varNames are [name]",
    )
  })

  test("build.each needs a matcher, and its matchers must share var names", () => {
    const build = new Build()
    expect(() => build.each({ matchersByName: {}, *tasks() {} })).toThrow(
      "build.each 1 has no matcher; build.each needs at least one matcher",
    )
    expect(() =>
      build.each({
        matchersByName: { a: new MemMatcher("a:"), b: new EventMatcher<Mem>(["slug"], []) },
        *tasks() {},
      }),
    ).toThrow("build.each 1: the matchers ['b'] share no var name with matcher 'a' or its partners")
  })

  test("build.each after run() throws", async () => {
    const build = new Build()
    await build.run()
    expect(() => build.each({ matchersByName: { page: new MemMatcher("page:") }, *tasks() {} })).toThrow(
      "build.each must come before the first build.run()",
    )
  })

  test("a matcher belongs to one Build", () => {
    const matcher = new MemMatcher("page:")
    const first = new Build()
    first.each({ matchersByName: { page: matcher }, *tasks() {} })
    const second = new Build()

    expect(() => second.each({ matchersByName: { page: matcher }, *tasks() {} })).toThrow(
      "build.each 1: its matcher 'page' belongs to another Build; make a new matcher for each Build",
    )
  })
})
