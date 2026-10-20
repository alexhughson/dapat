import { describe, expect, test } from "bun:test"
import { Build, Matcher, Task } from "../src/index"
import type { ArtifactEvent } from "../src/index"
import { MatchTable, type StoredMatch } from "../src/match-join"
import { Mem } from "./mem"

/**
 * A real matcher over in-memory artifacts with ids `<prefix><value>/<value>...#<version>`.
 * The values are its vars, in varNames order. The optional `#<version>` is not a var,
 * so `template:en#2` is a new version of the match `{ lang: "en" }`.
 * Its scan finds the artifacts it was given, and it treats a promised artifact as found.
 */
class PathMatcher extends Matcher<Mem> {
  constructor(
    private readonly prefix: string,
    readonly varNames: readonly string[],
    private readonly scanned: readonly Mem[] = [],
  ) {
    super()
  }

  async scan(_signal: AbortSignal): Promise<void> {
    for (const artifact of this.scanned) {
      this.foundArtifact(artifact)
    }
  }

  override receiveArtifactEvent(event: ArtifactEvent): void {
    if (event.kind !== "promised") return
    if (!(event.output instanceof Mem)) return
    this.foundArtifact(event.output)
  }

  /** Sends found for the artifact, if its id has this prefix. A test calls it to change a match. */
  foundArtifact(artifact: Mem): void {
    const vars = this.varsOf(artifact.id)
    if (vars === null) return
    this.send({ kind: "found", matched: { vars, data: artifact } })
  }

  /** Sends gone for the match of the id. */
  goneArtifact(id: string): void {
    const vars = this.varsOf(id)
    if (vars === null) return
    this.send({ kind: "gone", vars })
  }

  private varsOf(id: string): Record<string, string> | null {
    if (!id.startsWith(this.prefix)) return null
    const withoutVersion = id.slice(this.prefix.length).split("#")[0]!
    const values = withoutVersion.split("/")
    if (values.length !== this.varNames.length) return null
    const vars: Record<string, string> = {}
    for (let i = 0; i < this.varNames.length; i++) {
      vars[this.varNames[i]!] = values[i]!
    }
    return vars
  }
}

function sortedIds(tasks: readonly Task[]): string[] {
  const ids: string[] = []
  for (const task of tasks) {
    ids.push(task.id)
  }
  ids.sort()
  return ids
}

/**
 * The ids of the tasks that the build has now, from its artifact events.
 * Each task in these tests declares one output, so promised adds its task and withdrawn removes it.
 */
function watchTaskIds(build: Build): () => string[] {
  const taskIds = new Set<string>()
  build.subscribe((event) => {
    if (event.kind === "promised") taskIds.add(event.taskId)
    if (event.kind === "withdrawn") taskIds.delete(event.taskId)
  })
  return () => [...taskIds].sort()
}

/** Pages {lang, slug} joined with a template {lang}, each with one render task. `made` logs each tasks() call. */
function pagesWithTemplates(pages: PathMatcher, templates: PathMatcher, made: string[]): Build {
  const build = new Build()
  build.each({
    matchersByName: { page: pages, template: templates },
    *tasks(vars, matched) {
      const page = matched.page.data
      const template = matched.template.data
      made.push(`${vars.lang}/${vars.slug} with ${template.id}`)
      const html = new Mem(`html:${vars.lang}/${vars.slug}`)
      yield new Task({ id: `render:${vars.lang}/${vars.slug}`, inputs: [page, template], outputs: [html], run: async () => {} })
    },
  })
  return build
}

describe("build.each joins matchers on shared var names", () => {
  test("each page joins with the template of its lang", async () => {
    const pages = new PathMatcher("page:", ["lang", "slug"], [
      new Mem("page:en/a", "A"),
      new Mem("page:en/b", "B"),
      new Mem("page:fr/a", "A"),
      new Mem("page:fr/b", "B"),
    ])
    const templates = new PathMatcher("template:", ["lang"], [new Mem("template:en", "E"), new Mem("template:fr", "F")])
    const made: string[] = []
    const build = pagesWithTemplates(pages, templates, made)

    const result = await build.run()

    expect(result.success).toBe(true)
    expect(sortedIds(result.executed)).toEqual(["render:en/a", "render:en/b", "render:fr/a", "render:fr/b"])
    expect(made.sort()).toEqual([
      "en/a with template:en",
      "en/b with template:en",
      "fr/a with template:fr",
      "fr/b with template:fr",
    ])
  })

  test("a changed template replaces only the tasks of its lang; gone removes them; found brings them back", async () => {
    const pages = new PathMatcher("page:", ["lang", "slug"], [
      new Mem("page:en/a", "A"),
      new Mem("page:en/b", "B"),
      new Mem("page:fr/a", "A"),
      new Mem("page:fr/b", "B"),
    ])
    const templates = new PathMatcher("template:", ["lang"], [new Mem("template:en", "E"), new Mem("template:fr", "F")])
    const made: string[] = []
    const build = pagesWithTemplates(pages, templates, made)
    const currentTaskIds = watchTaskIds(build)
    await build.run()

    made.length = 0
    templates.foundArtifact(new Mem("template:en#2", "E2"))
    expect(made.sort()).toEqual(["en/a with template:en#2", "en/b with template:en#2"])

    made.length = 0
    templates.goneArtifact("template:en")
    expect(made).toEqual([])
    expect(currentTaskIds()).toEqual(["render:fr/a", "render:fr/b"])

    templates.foundArtifact(new Mem("template:en#3", "E3"))
    expect(made.sort()).toEqual(["en/a with template:en#3", "en/b with template:en#3"])
    expect(currentTaskIds()).toEqual(["render:en/a", "render:en/b", "render:fr/a", "render:fr/b"])
    const later = await build.run()
    expect(later.success).toBe(true)
  })

  test("a page with no template of its lang has no task", async () => {
    const pages = new PathMatcher("page:", ["lang", "slug"], [new Mem("page:en/a", "A"), new Mem("page:de/a", "A")])
    const templates = new PathMatcher("template:", ["lang"], [new Mem("template:en", "E")])
    const made: string[] = []
    const build = pagesWithTemplates(pages, templates, made)

    const result = await build.run()

    expect(sortedIds(result.executed)).toEqual(["render:en/a"])
  })

  test("the label of a joined set has the vars of all matchers", async () => {
    const pages = new PathMatcher("page:", ["lang", "slug"], [new Mem("page:en/a", "A"), new Mem("page:en/b", "B")])
    const templates = new PathMatcher("template:", ["lang"], [new Mem("template:en", "E")])
    const build = new Build()
    build.each({
      matchersByName: { template: templates, page: pages },
      *tasks() {
        yield new Task({ id: "same", run: async () => {} })
      },
    })

    // The vars are in name order (template, then page), then in varNames order.
    await expect(build.run()).rejects.toThrow(
      "task 'same' is in two groups: 'build.each 1 lang=en slug=a' and 'build.each 1 lang=en slug=b'",
    )
  })

  test("three matchers: a review joins on lang and slug, a template on lang", async () => {
    const pages = new PathMatcher("page:", ["lang", "slug"], [
      new Mem("page:en/a", "A"),
      new Mem("page:en/b", "B"),
      new Mem("page:fr/a", "A"),
    ])
    const templates = new PathMatcher("template:", ["lang"], [new Mem("template:en", "E"), new Mem("template:fr", "F")])
    const reviews = new PathMatcher("review:", ["lang", "slug"], [new Mem("review:en/a", "5"), new Mem("review:fr/a", "3")])
    const made: string[] = []
    const build = new Build()
    const currentTaskIds = watchTaskIds(build)
    build.each({
      matchersByName: { page: pages, template: templates, review: reviews },
      *tasks(vars, matched) {
        made.push(`${vars.lang}/${vars.slug}: ${matched.page.data.id} ${matched.template.data.id} ${matched.review.data.id}`)
        const html = new Mem(`html:${vars.lang}/${vars.slug}`)
        yield new Task({ id: `render:${vars.lang}/${vars.slug}`, outputs: [html], run: async () => {} })
      },
    })

    const result = await build.run()

    // en/b has no review, so it has no joined set.
    expect(sortedIds(result.executed)).toEqual(["render:en/a", "render:fr/a"])
    expect(made.sort()).toEqual([
      "en/a: page:en/a template:en review:en/a",
      "fr/a: page:fr/a template:fr review:fr/a",
    ])

    // A new review for en/b joins with its page and the en template.
    made.length = 0
    reviews.foundArtifact(new Mem("review:en/b", "4"))
    expect(made).toEqual(["en/b: page:en/b template:en review:en/b"])

    // A changed template changes every set of its lang, and only those.
    made.length = 0
    templates.foundArtifact(new Mem("template:en#2", "E2"))
    expect(made.sort()).toEqual([
      "en/a: page:en/a template:en#2 review:en/a",
      "en/b: page:en/b template:en#2 review:en/b",
    ])

    // A gone page removes only its own set.
    pages.goneArtifact("page:en/a")
    expect(currentTaskIds()).toEqual(["render:en/b", "render:fr/a"])
  })

  test("a found with the same artifact ids does nothing", async () => {
    const pages = new PathMatcher("page:", ["lang", "slug"], [new Mem("page:en/a", "A")])
    const templates = new PathMatcher("template:", ["lang"], [new Mem("template:en", "E")])
    const made: string[] = []
    const build = pagesWithTemplates(pages, templates, made)
    await build.run()

    made.length = 0
    // New objects with the same ids are the same data.
    templates.foundArtifact(new Mem("template:en", "E"))
    pages.foundArtifact(new Mem("page:en/a", "A"))

    expect(made).toEqual([])
    const later = await build.run()
    expect(later.cancelled).toEqual([])
  })

  test("a match that a task promises during the run joins and makes a task in the same run", async () => {
    const pages = new PathMatcher("page:", ["lang", "slug"], [new Mem("page:en/a", "A")])
    const templates = new PathMatcher("template:", ["lang"], [new Mem("template:en", "E")])
    const made: string[] = []
    const build = pagesWithTemplates(pages, templates, made)
    // This task declares a new page. Its promised event reaches the page matcher.
    build.add(new Task({ id: "write", outputs: [new Mem("page:en/new")], run: async () => {} }))

    const result = await build.run()

    expect(sortedIds(result.executed)).toEqual(["render:en/a", "render:en/new", "write"])
    expect(made.sort()).toEqual(["en/a with template:en", "en/new with template:en"])
  })

  test("matchers that do not share a var name make build.each throw", () => {
    const build = new Build()
    expect(() =>
      build.each({
        matchersByName: {
          page: new PathMatcher("page:", ["slug"]),
          template: new PathMatcher("template:", ["lang"]),
        },
        *tasks() {},
      }),
    ).toThrow(
      "build.each 1: the matchers ['template'] share no var name with matcher 'page' or its partners; " +
        "each matcher must share a var name with another matcher",
    )
  })

  test("three matchers are connected when each shares a var with another one, not with all", async () => {
    const pages = new PathMatcher("page:", ["lang", "slug"], [new Mem("page:en/a", "A")])
    const templates = new PathMatcher("template:", ["lang"], [new Mem("template:en", "E")])
    const authors = new PathMatcher("author:", ["slug"], [new Mem("author:a", "Ann")])
    const build = new Build()
    build.each({
      matchersByName: { template: templates, author: authors, page: pages },
      *tasks(vars, matched) {
        yield new Task({ id: `render:${vars.lang}/${vars.slug}:${matched.author.data.value}`, run: async () => {} })
      },
    })

    const result = await build.run()

    expect(sortedIds(result.executed)).toEqual(["render:en/a:Ann"])
  })

  test("a page that is gone stays out when its template changes later", async () => {
    const pages = new PathMatcher("page:", ["lang", "slug"], [new Mem("page:en/a", "A"), new Mem("page:en/b", "B")])
    const templates = new PathMatcher("template:", ["lang"], [new Mem("template:en", "E")])
    const made: string[] = []
    const build = pagesWithTemplates(pages, templates, made)
    const currentTaskIds = watchTaskIds(build)
    await build.run()

    pages.goneArtifact("page:en/a")
    made.length = 0
    templates.foundArtifact(new Mem("template:en#2", "E2"))

    expect(made).toEqual(["en/b with template:en#2"])
    expect(currentTaskIds()).toEqual(["render:en/b"])
  })

  test("a change at the end of a chain A{x} B{x,y} C{y} reaches its sets", async () => {
    const a = new PathMatcher("a:", ["x"], [new Mem("a:1", "A")])
    const b = new PathMatcher("b:", ["x", "y"], [new Mem("b:1/p", "B"), new Mem("b:1/q", "B")])
    const c = new PathMatcher("c:", ["y"], [new Mem("c:p", "C"), new Mem("c:q", "C")])
    const made: string[] = []
    const build = new Build()
    build.each({
      matchersByName: { a, b, c },
      *tasks(vars, matched) {
        made.push(`${vars.x}/${vars.y}: ${matched.a.data.id} ${matched.b.data.id} ${matched.c.data.id}`)
        yield new Task({ id: `t:${vars.x}/${vars.y}`, run: async () => {} })
      },
    })
    await build.run()

    made.length = 0
    c.foundArtifact(new Mem("c:p#2", "C2"))
    expect(made).toEqual(["1/p: a:1 b:1/p c:p#2"])

    made.length = 0
    a.foundArtifact(new Mem("a:1#2", "A2"))
    expect(made.sort()).toEqual(["1/p: a:1#2 b:1/p c:p#2", "1/q: a:1#2 b:1/q c:q"])
  })

  test("an error in tasks() with several matchers rejects run()", async () => {
    const pages = new PathMatcher("page:", ["lang", "slug"], [new Mem("page:en/a", "A")])
    const templates = new PathMatcher("template:", ["lang"], [new Mem("template:en", "E")])
    const build = new Build()
    build.each({
      matchersByName: { page: pages, template: templates },
      *tasks() {
        throw new Error("bad template")
      },
    })

    await expect(build.run()).rejects.toThrow("bad template")
  })

  test("a matcher of another Build among several matchers makes build.each throw, and the error names it", () => {
    const templates = new PathMatcher("template:", ["lang"])
    new Build().each({ matchersByName: { template: templates }, *tasks() {} })
    const build = new Build()

    expect(() =>
      build.each({
        matchersByName: { page: new PathMatcher("page:", ["lang", "slug"]), template: templates },
        *tasks() {},
      }),
    ).toThrow("build.each 1: its matcher 'template' belongs to another Build; make a new matcher for each Build")
  })

  test("one matcher object under two names makes build.each throw", () => {
    const pages = new PathMatcher("page:", ["lang", "slug"])
    const build = new Build()

    expect(() => build.each({ matchersByName: { left: pages, right: pages }, *tasks() {} })).toThrow(
      "build.each 1: 'left' and 'right' are one matcher object; give each name its own matcher",
    )
  })

  test("a matcher with no var shares nothing, so it fails the connectivity check", () => {
    const build = new Build()
    expect(() =>
      build.each({
        matchersByName: { page: new PathMatcher("page:", ["slug"]), site: new PathMatcher("site:", []) },
        *tasks() {},
      }),
    ).toThrow("build.each 1: the matchers ['site'] share no var name with matcher 'page' or its partners")
  })
})

describe("matcher events never run inside another hear", () => {
  test("a subscriber that finds the template again while its gone removes the pages", async () => {
    const pages = new PathMatcher("page:", ["lang", "slug"], [
      new Mem("page:en/p0", "A"),
      new Mem("page:en/p1", "B"),
      new Mem("page:en/p2", "C"),
    ])
    const templates = new PathMatcher("template:", ["lang"], [new Mem("template:en", "E")])
    const made: string[] = []
    const build = pagesWithTemplates(pages, templates, made)
    const currentTaskIds = watchTaskIds(build)
    await build.run()
    let foundAgain = false
    build.subscribe((event) => {
      if (foundAgain) return
      if (event.kind !== "withdrawn") return
      foundAgain = true
      templates.foundArtifact(new Mem("template:en#2", "E2"))
    })

    made.length = 0
    templates.goneArtifact("template:en")

    expect(currentTaskIds()).toEqual(["render:en/p0", "render:en/p1", "render:en/p2"])
    expect(made.sort()).toEqual(["en/p0 with template:en#2", "en/p1 with template:en#2", "en/p2 with template:en#2"])
    const later = await build.run()
    expect(later.success).toBe(true)
  })

  test("tasks() that sends gone for its own template leaves no task", async () => {
    const pages = new PathMatcher("page:", ["lang", "slug"], [new Mem("page:en/a", "A")])
    const templates = new PathMatcher("template:", ["lang"], [new Mem("template:en", "E")])
    const build = new Build()
    const currentTaskIds = watchTaskIds(build)
    let sentGone = false
    const templateIdsThatRan: string[] = []
    build.each({
      matchersByName: { page: pages, template: templates },
      *tasks(vars, matched) {
        if (!sentGone) {
          sentGone = true
          templates.goneArtifact("template:en")
        }
        const templateId = matched.template.data.id
        const html = new Mem(`html:${vars.lang}/${vars.slug}`)
        yield new Task({ id: `render:${vars.slug}`, outputs: [html], run: async () => void templateIdsThatRan.push(templateId) })
      },
    })

    const first = await build.run()
    expect(first.executed).toEqual([])
    expect(currentTaskIds()).toEqual([])

    templates.foundArtifact(new Mem("template:en#2", "E2"))
    expect(currentTaskIds()).toEqual(["render:a"])
    const second = await build.run()
    expect(second.success).toBe(true)
    expect(templateIdsThatRan).toEqual(["template:en#2"])

    templates.goneArtifact("template:en")
    expect(currentTaskIds()).toEqual([])
  })

  test("tasks() that sends a newer found ends with the tasks of the newer data", async () => {
    const pages = new PathMatcher("page:", ["lang", "slug"], [new Mem("page:en/a", "A")])
    const templates = new PathMatcher("template:", ["lang"], [new Mem("template:en", "E")])
    const build = new Build()
    let sentNewer = false
    const templateIdsThatRan: string[] = []
    build.each({
      matchersByName: { page: pages, template: templates },
      *tasks(vars, matched) {
        const templateId = matched.template.data.id
        if (!sentNewer) {
          sentNewer = true
          templates.foundArtifact(new Mem("template:en#2", "E2"))
        }
        yield new Task({ id: `render:${vars.slug}`, run: async () => void templateIdsThatRan.push(templateId) })
      },
    })

    const result = await build.run()

    expect(result.success).toBe(true)
    expect(templateIdsThatRan).toEqual(["template:en#2"])
  })
})

describe("MatchTable", () => {
  test("deletes a join key when its last match is gone", () => {
    const table = new MatchTable("page", ["lang", "slug"], 1)
    table.addIndex(["lang"])
    table.addIndex(["lang", "slug"])
    const a: StoredMatch = { matched: { vars: { lang: "en", slug: "a" }, data: new Mem("page:en/a") }, artifactIds: "", sets: new Set() }
    const b: StoredMatch = { matched: { vars: { lang: "en", slug: "b" }, data: new Mem("page:en/b") }, artifactIds: "", sets: new Set() }
    table.put(a)
    table.put(b)
    // lang: en; lang+slug: en/a and en/b.
    expect(table.joinKeyCount).toBe(3)

    table.delete(a)
    expect(table.joinKeyCount).toBe(2)
    expect([...table.lookup(["lang"], { lang: "en" })]).toEqual([b])

    table.delete(b)
    expect(table.joinKeyCount).toBe(0)
    expect(table.get({ lang: "en", slug: "b" })).toBeUndefined()
  })
})
