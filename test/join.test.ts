import { describe, expect, test } from "bun:test"
import { Build, Matcher, MemoryStore, Task } from "../src/index"
import type { AnyMatcher, ArtifactEvent, Ref, TaskMaterializerConfig } from "../src/index"
import { MatchTable, type StoredMatch } from "../src/match-join"
import { TaskGroup } from "../src/task-group"
import { TaskMaterializer } from "../src/task-materializer"
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
    // A matcher with no var has the id `<prefix>` alone.
    const values = withoutVersion === "" ? [] : withoutVersion.split("/")
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
      "build.each 1: the required matchers ['template'] share no var name with required matcher 'page' or its required partners; " +
        "each required matcher must share a var name with another required matcher, and a matcher that is not required does not connect them",
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

  test("after a fatal error, a later match does not call tasks() again", async () => {
    const pages = new PathMatcher("page:", ["lang", "slug"], [new Mem("page:en/a", "A")])
    const templates = new PathMatcher("template:", ["lang"], [new Mem("template:en", "E")])
    const build = new Build()
    let calls = 0
    build.each({
      matchersByName: { page: pages, template: templates },
      *tasks() {
        calls += 1
        throw new Error("bad template")
      },
    })
    await expect(build.run()).rejects.toThrow("bad template")
    expect(calls).toBe(1)

    pages.foundArtifact(new Mem("page:en/b", "B"))
    expect(calls).toBe(1)
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
    ).toThrow("build.each 1: the required matchers ['site'] share no var name with required matcher 'page' or its required partners")
  })
})

/**
 * Pages {lang, section, slug} and templates {lang} are required. A branch `changes-<lang>` {lang}
 * and a review {lang, slug} are not. `made` logs each tasks() call with the ids of the set's matches.
 */
function siteWithOptionalBranchAndReview(made: string[]) {
  const pages = new PathMatcher("page:", ["lang", "section", "slug"], [
    new Mem("page:en/blog/hello", "H"),
    new Mem("page:en/docs/install", "I"),
    new Mem("page:fr/blog/hello", "B"),
  ])
  const templates = new PathMatcher("template:", ["lang"], [new Mem("template:en", "E"), new Mem("template:fr", "F")])
  // main does not match the prefix, so only changes-en is found.
  const branches = new PathMatcher("branch:changes-", ["lang"], [new Mem("branch:main", "m1"), new Mem("branch:changes-en", "c1")])
  const reviews = new PathMatcher("review:", ["lang", "slug"], [new Mem("review:en/hello", "5")])
  const build = new Build()
  build.each({
    matchersByName: { page: pages, template: templates, branch: branches, review: reviews },
    required: ["page", "template"],
    *tasks(vars, matched) {
      const name = `${vars.lang}/${vars.section}/${vars.slug}`
      const inputs: Ref[] = [matched.page.data, matched.template.data]
      if (matched.branch !== undefined) {
        inputs.push(matched.branch.data)
      }
      if (matched.review !== undefined) {
        inputs.push(matched.review.data)
      }
      const inputIds: string[] = []
      for (const input of inputs) {
        inputIds.push(input.id)
      }
      made.push(`${name}: ${inputIds.join(" ")}`)
      yield new Task({ id: `page:${name}`, inputs, outputs: [new Mem(`html:${name}`)], run: async () => {} })
    },
  })
  return { build, pages, templates, branches, reviews }
}

describe("build.each with required", () => {
  test("a set needs only the required matchers; the others join when they have a match", async () => {
    const made: string[] = []
    const { build } = siteWithOptionalBranchAndReview(made)

    const result = await build.run()

    expect(result.success).toBe(true)
    expect(sortedIds(result.executed)).toEqual(["page:en/blog/hello", "page:en/docs/install", "page:fr/blog/hello"])
    // The scans send one match at a time, so a set gets new tasks each time a branch or review joins it.
    // The last tasks of each set are the ones that ran.
    const lastMadeByName = new Map<string, string>()
    for (const line of made) {
      lastMadeByName.set(line.split(":")[0]!, line)
    }
    expect([...lastMadeByName.values()].sort()).toEqual([
      "en/blog/hello: page:en/blog/hello template:en branch:changes-en review:en/hello",
      "en/docs/install: page:en/docs/install template:en branch:changes-en",
      "fr/blog/hello: page:fr/blog/hello template:fr",
    ])
  })

  test("a match that is not required replaces the tasks of only its sets when it is found, changes, or is gone", async () => {
    const made: string[] = []
    const { build, branches, reviews } = siteWithOptionalBranchAndReview(made)
    const currentTaskIds = watchTaskIds(build)
    await build.run()
    const allTaskIds = ["page:en/blog/hello", "page:en/docs/install", "page:fr/blog/hello"]

    made.length = 0
    reviews.foundArtifact(new Mem("review:en/install", "4"))
    expect(made).toEqual(["en/docs/install: page:en/docs/install template:en branch:changes-en review:en/install"])

    made.length = 0
    reviews.foundArtifact(new Mem("review:en/install#2", "3"))
    expect(made).toEqual(["en/docs/install: page:en/docs/install template:en branch:changes-en review:en/install#2"])

    made.length = 0
    reviews.goneArtifact("review:en/install")
    expect(made).toEqual(["en/docs/install: page:en/docs/install template:en branch:changes-en"])
    expect(currentTaskIds()).toEqual(allTaskIds)

    // A branch with vars {lang} joins every set of its lang, and only those.
    made.length = 0
    branches.foundArtifact(new Mem("branch:changes-fr", "c2"))
    expect(made).toEqual(["fr/blog/hello: page:fr/blog/hello template:fr branch:changes-fr"])

    made.length = 0
    branches.goneArtifact("branch:changes-en")
    expect(made.sort()).toEqual([
      "en/blog/hello: page:en/blog/hello template:en review:en/hello",
      "en/docs/install: page:en/docs/install template:en",
    ])
    expect(currentTaskIds()).toEqual(allTaskIds)

    // A gone review with no match does nothing.
    made.length = 0
    reviews.goneArtifact("review:fr/nothing")
    expect(made).toEqual([])
    const later = await build.run()
    expect(later.success).toBe(true)
  })

  test("a match that is not required and has no set now joins the sets that come later", async () => {
    const made: string[] = []
    const { build, pages, templates, reviews } = siteWithOptionalBranchAndReview(made)
    const currentTaskIds = watchTaskIds(build)
    await build.run()

    // A gone template removes the fr set. A review of that set then makes no task.
    templates.goneArtifact("template:fr")
    expect(currentTaskIds()).toEqual(["page:en/blog/hello", "page:en/docs/install"])
    made.length = 0
    reviews.foundArtifact(new Mem("review:fr/hello", "2"))
    expect(made).toEqual([])

    // The template comes back, and its set gets the review that waited.
    templates.foundArtifact(new Mem("template:fr#2", "F2"))
    expect(made).toEqual(["fr/blog/hello: page:fr/blog/hello template:fr#2 review:fr/hello"])

    // A new page joins the reviews of its lang and slug, also in another section.
    made.length = 0
    pages.foundArtifact(new Mem("page:fr/news/hello", "N"))
    expect(made).toEqual(["fr/news/hello: page:fr/news/hello template:fr#2 review:fr/hello"])

    // A changed review replaces the tasks of both sets that hold it.
    made.length = 0
    reviews.foundArtifact(new Mem("review:fr/hello#2", "1"))
    expect(made.sort()).toEqual([
      "fr/blog/hello: page:fr/blog/hello template:fr#2 review:fr/hello#2",
      "fr/news/hello: page:fr/news/hello template:fr#2 review:fr/hello#2",
    ])
  })

  test("a matcher that is not required and has no var joins every set with its one match", async () => {
    const pages = new PathMatcher("page:", ["slug"], [new Mem("page:a", "A"), new Mem("page:b", "B")])
    const sites = new PathMatcher("site", [])
    const made: string[] = []
    const build = new Build()
    build.each({
      matchersByName: { page: pages, site: sites },
      required: ["page"],
      *tasks(vars, matched) {
        made.push(`${vars.slug}: ${matched.site?.data.id ?? "no site"}`)
        yield new Task({ id: `page:${vars.slug}`, run: async () => {} })
      },
    })
    await build.run()
    expect(made.sort()).toEqual(["a: no site", "b: no site"])

    made.length = 0
    sites.foundArtifact(new Mem("site", "S"))
    expect(made.sort()).toEqual(["a: site", "b: site"])
  })

  test("required left out makes every matcher required", async () => {
    const pages = new PathMatcher("page:", ["lang", "slug"], [new Mem("page:en/a", "A"), new Mem("page:en/b", "B")])
    const reviews = new PathMatcher("review:", ["lang", "slug"], [new Mem("review:en/a", "5")])
    const build = new Build()
    build.each({
      matchersByName: { page: pages, review: reviews },
      *tasks(vars, matched) {
        // Every matcher is required, so the types have no undefined: not in matched, and not in vars.
        const slug: string = vars.slug
        yield new Task({ id: `page:${slug}`, inputs: [matched.page.data, matched.review.data], run: async () => {} })
      },
    })

    const result = await build.run()

    expect(sortedIds(result.executed)).toEqual(["page:a"])
  })

  test("tsc requires a check before the data of a matcher that is not required", () => {
    const build = new Build()
    build.each({
      matchersByName: { page: new PathMatcher("page:", ["lang", "slug"]), review: new PathMatcher("review:", ["lang", "slug"]) },
      required: ["page"],
      *tasks(vars, matched) {
        // @ts-expect-error with a matcher that is not required, any var can be undefined
        const lang: string = vars.lang
        void lang
        void matched.page.data.id
        // @ts-expect-error matched.review is possibly undefined
        void matched.review.data.id
        if (matched.review !== undefined) {
          void matched.review.data.id
        }
      },
    })
    expect(() =>
      build.each({
        matchersByName: { page: new PathMatcher("page:", ["slug"]) },
        // @ts-expect-error 'pages' is not a name in matchersByName
        required: ["pages"],
        *tasks() {},
      }),
    ).toThrow("build.each 2: required names 'pages', which is not a name in matchersByName")
  })

  test("an empty required makes build.each throw", () => {
    const build = new Build()
    expect(() =>
      build.each({ matchersByName: { page: new PathMatcher("page:", ["slug"]) }, required: [], *tasks() {} }),
    ).toThrow("build.each 1: required is empty; name at least one matcher, or leave required out to require every matcher")
  })

  test("the required matchers must connect among themselves; a matcher that is not required does not connect them", () => {
    const build = new Build()
    expect(() =>
      build.each({
        matchersByName: {
          page: new PathMatcher("page:", ["slug"]),
          template: new PathMatcher("template:", ["lang"]),
          review: new PathMatcher("review:", ["lang", "slug"]),
        },
        required: ["page", "template"],
        *tasks() {},
      }),
    ).toThrow(
      "build.each 1: the required matchers ['template'] share no var name with required matcher 'page' or its required partners; " +
        "each required matcher must share a var name with another required matcher, and a matcher that is not required does not connect them",
    )
  })
})

describe("build.each with required: indexes, shared matchers, re-entrant events", () => {
  test("after a found and gone cycle, the tables and the set indexes are empty", () => {
    const taskIdsByGroup = new Map<TaskGroup, string[]>()
    const pages = new PathMatcher("page:", ["lang", "slug"])
    const templates = new PathMatcher("template:", ["lang"])
    const reviews = new PathMatcher("review:", ["lang", "slug"])
    const branches = new PathMatcher("branch:", ["lang"])
    const taskMaterializer = new TaskMaterializer(
      1,
      {
        matchersByName: { page: pages, template: templates, review: reviews, branch: branches },
        required: ["page", "template"],
        *tasks(vars, matched) {
          yield new Task({ id: `page:${vars.lang}/${vars.slug}:${matched.review?.data.id}:${matched.branch?.data.id}`, run: async () => {} })
        },
      },
      (changes) => {
        for (const { group, tasks } of changes) {
          const ids: string[] = []
          for (const task of tasks) {
            ids.push(task.id)
          }
          taskIdsByGroup.set(group, ids)
        }
      },
    )
    function found(name: string, vars: Record<string, string>, id: string): void {
      taskMaterializer.hear(name, { kind: "found", matched: { vars, data: new Mem(id) } })
    }
    function gone(name: string, vars: Record<string, string>): void {
      taskMaterializer.hear(name, { kind: "gone", vars })
    }
    function currentTaskIds(): string[] {
      const ids: string[] = []
      for (const groupIds of taskIdsByGroup.values()) {
        ids.push(...groupIds)
      }
      return ids.sort()
    }

    // Optional matches before, between and after the required ones; one review has no set.
    found("review", { lang: "en", slug: "a" }, "review:en/a")
    found("template", { lang: "en" }, "template:en")
    found("page", { lang: "en", slug: "a" }, "page:en/a")
    found("branch", { lang: "en" }, "branch:en")
    found("page", { lang: "en", slug: "b" }, "page:en/b")
    found("review", { lang: "en", slug: "c" }, "review:en/c")
    found("review", { lang: "en", slug: "a" }, "review:en/a#2")
    expect(currentTaskIds()).toEqual(["page:en/a:review:en/a#2:branch:en", "page:en/b:undefined:branch:en"])

    // A required match goes first, while the optional matches stay.
    gone("template", { lang: "en" })
    expect(currentTaskIds()).toEqual([])
    found("template", { lang: "en" }, "template:en#2")
    expect(currentTaskIds()).toEqual(["page:en/a:review:en/a#2:branch:en", "page:en/b:undefined:branch:en"])

    gone("review", { lang: "en", slug: "a" })
    gone("branch", { lang: "en" })
    expect(currentTaskIds()).toEqual(["page:en/a:undefined:undefined", "page:en/b:undefined:undefined"])
    gone("page", { lang: "en", slug: "a" })
    gone("page", { lang: "en", slug: "b" })
    gone("review", { lang: "en", slug: "c" })
    gone("template", { lang: "en" })

    expect(currentTaskIds()).toEqual([])
    expect(taskMaterializer.joinKeyCount).toBe(0)
  })

  test("one matcher can be required in one build.each and not required in another", async () => {
    const pages = new PathMatcher("page:", ["lang", "slug"], [new Mem("page:en/a", "A"), new Mem("page:en/b", "B")])
    const reviews = new PathMatcher("review:", ["lang", "slug"], [new Mem("review:en/a", "5")])
    const build = new Build()
    const currentTaskIds = watchTaskIds(build)
    build.each({
      matchersByName: { page: pages, review: reviews },
      *tasks(vars, matched) {
        yield new Task({ id: `reviewed:${vars.slug}:${matched.review.data.id}`, outputs: [new Mem(`reviewed:${vars.slug}`)], run: async () => {} })
      },
    })
    build.each({
      matchersByName: { page: pages, review: reviews },
      required: ["page"],
      *tasks(vars, matched) {
        yield new Task({ id: `page:${vars.slug}:${matched.review?.data.id}`, outputs: [new Mem(`html:${vars.slug}`)], run: async () => {} })
      },
    })

    const result = await build.run()

    expect(result.success).toBe(true)
    expect(currentTaskIds()).toEqual(["page:a:review:en/a", "page:b:undefined", "reviewed:a:review:en/a"])

    reviews.foundArtifact(new Mem("review:en/b", "4"))
    expect(currentTaskIds()).toEqual(["page:a:review:en/a", "page:b:review:en/b", "reviewed:a:review:en/a", "reviewed:b:review:en/b"])

    reviews.goneArtifact("review:en/a")
    expect(currentTaskIds()).toEqual(["page:a:undefined", "page:b:review:en/b", "reviewed:b:review:en/b"])
  })

  test("a found of a matcher that is not required, sent from a subscriber of promised, ends in the tasks of the set", async () => {
    const pages = new PathMatcher("page:", ["lang", "slug"], [new Mem("page:en/a", "A")])
    const templates = new PathMatcher("template:", ["lang"], [new Mem("template:en", "E")])
    const reviews = new PathMatcher("review:", ["lang", "slug"])
    const build = new Build()
    const currentTaskIds = watchTaskIds(build)
    const ran: string[] = []
    // The first promised html makes a review for its page, while build.each still hears the page.
    build.subscribe((event) => {
      if (event.kind !== "promised") return
      if (event.output.id !== "html:en/a") return
      reviews.foundArtifact(new Mem("review:en/a", "5"))
    })
    build.each({
      matchersByName: { page: pages, template: templates, review: reviews },
      required: ["page", "template"],
      *tasks(vars, matched) {
        const reviewId = matched.review?.data.id ?? "no review"
        const html = new Mem(`html:${vars.lang}/${vars.slug}`)
        yield new Task({ id: `page:${vars.slug}`, outputs: [html], run: async () => void ran.push(reviewId) })
      },
    })

    const result = await build.run()

    expect(result.success).toBe(true)
    expect(currentTaskIds()).toEqual(["page:a"])
    expect(ran).toEqual(["review:en/a"])
  })
})

describe("build.each with required: a matcher that is not required can have var names of its own", () => {
  /** The ids of the current tasks, each with the label of its task group, from a TaskMaterializer. */
  function materialize<M extends Record<string, AnyMatcher>, R extends keyof M & string>(config: TaskMaterializerConfig<M, R>) {
    const taskIdsByGroup = new Map<TaskGroup, string[]>()
    const taskMaterializer = new TaskMaterializer(1, config, (changes) => {
      for (const { group, tasks } of changes) {
        if (tasks.length === 0) {
          taskIdsByGroup.delete(group)
          continue
        }
        const ids: string[] = []
        for (const task of tasks) {
          ids.push(task.id)
        }
        taskIdsByGroup.set(group, ids)
      }
    })
    function found(name: string, vars: Record<string, string>, id: string): void {
      taskMaterializer.hear(name, { kind: "found", matched: { vars, data: new Mem(id) } })
    }
    function gone(name: string, vars: Record<string, string>): void {
      taskMaterializer.hear(name, { kind: "gone", vars })
    }
    function currentTasks(): string[] {
      const lines: string[] = []
      for (const [group, ids] of taskIdsByGroup) {
        lines.push(`${group.label}: ${ids.join(" ")}`)
      }
      return lines.sort()
    }
    return { taskMaterializer, found, gone, currentTasks }
  }

  test("each review of a page is one joined set; with no review, the page has one set with no review", () => {
    const { taskMaterializer, found, gone, currentTasks } = materialize({
      matchersByName: { page: new PathMatcher("page:", ["lang", "slug"]), review: new PathMatcher("review:", ["lang", "slug", "reviewer"]) },
      required: ["page"],
      *tasks(vars, matched) {
        // vars has the reviewer of the matched review, or no reviewer.
        expect(vars.reviewer).toBe(matched.review?.vars.reviewer)
        const reviewer = vars.reviewer ?? "nobody"
        yield new Task({ id: `page:${vars.lang}/${vars.slug}:${reviewer}`, run: async () => {} })
      },
    })

    found("page", { lang: "en", slug: "about" }, "page:en/about")
    expect(currentTasks()).toEqual(["build.each 1 lang=en slug=about: page:en/about:nobody"])

    // The first review replaces the set with no review.
    found("review", { lang: "en", slug: "about", reviewer: "ann" }, "review:en/about/ann")
    expect(currentTasks()).toEqual(["build.each 1 lang=en slug=about reviewer=ann: page:en/about:ann"])

    // A second review adds a set.
    found("review", { lang: "en", slug: "about", reviewer: "bob" }, "review:en/about/bob")
    expect(currentTasks()).toEqual([
      "build.each 1 lang=en slug=about reviewer=ann: page:en/about:ann",
      "build.each 1 lang=en slug=about reviewer=bob: page:en/about:bob",
    ])

    // A review of another page joins no set.
    found("review", { lang: "en", slug: "contact", reviewer: "ann" }, "review:en/contact/ann")
    expect(currentTasks()).toHaveLength(2)

    gone("review", { lang: "en", slug: "about", reviewer: "bob" })
    expect(currentTasks()).toEqual(["build.each 1 lang=en slug=about reviewer=ann: page:en/about:ann"])

    // When the last review is gone, the set with no review comes back.
    gone("review", { lang: "en", slug: "about", reviewer: "ann" })
    expect(currentTasks()).toEqual(["build.each 1 lang=en slug=about: page:en/about:nobody"])

    // The page that comes later gets the review that waited.
    found("page", { lang: "en", slug: "contact" }, "page:en/contact")
    expect(currentTasks()).toEqual([
      "build.each 1 lang=en slug=about: page:en/about:nobody",
      "build.each 1 lang=en slug=contact reviewer=ann: page:en/contact:ann",
    ])

    gone("page", { lang: "en", slug: "about" })
    gone("page", { lang: "en", slug: "contact" })
    gone("review", { lang: "en", slug: "contact", reviewer: "ann" })
    expect(currentTasks()).toEqual([])
    expect(taskMaterializer.joinKeyCount).toBe(0)
  })

  test("the first review replaces the set with no review before it adds its own, so both can give one task id", async () => {
    const pages = new PathMatcher("page:", ["slug"], [new Mem("page:a", "A")])
    const reviews = new PathMatcher("review:", ["slug", "reviewer"])
    const build = new Build()
    const currentTaskIds = watchTaskIds(build)
    const ran: string[] = []
    build.each({
      matchersByName: { page: pages, review: reviews },
      required: ["page"],
      *tasks(vars, matched) {
        const reviewer = matched.review?.vars.reviewer ?? "nobody"
        yield new Task({ id: `page:${vars.slug}`, outputs: [new Mem(`html:${vars.slug}`)], run: async () => void ran.push(reviewer) })
      },
    })
    await build.run()

    reviews.foundArtifact(new Mem("review:a/ann", "5"))
    expect(currentTaskIds()).toEqual(["page:a"])
    const later = await build.run()

    expect(later.success).toBe(true)
    expect(ran).toEqual(["nobody", "ann"])
  })

  test("two matchers with var names of their own make the product of their matches", () => {
    const { taskMaterializer, found, gone, currentTasks } = materialize({
      matchersByName: {
        page: new PathMatcher("page:", ["slug"]),
        review: new PathMatcher("review:", ["slug", "reviewer"]),
        comment: new PathMatcher("comment:", ["slug", "commenter"]),
      },
      required: ["page"],
      *tasks(vars, matched) {
        const reviewer = matched.review?.vars.reviewer ?? "-"
        const commenter = matched.comment?.vars.commenter ?? "-"
        yield new Task({ id: `page:${vars.slug}:${reviewer}:${commenter}`, run: async () => {} })
      },
    })

    found("page", { slug: "a" }, "page:a")
    found("review", { slug: "a", reviewer: "ann" }, "review:a/ann")
    found("review", { slug: "a", reviewer: "bob" }, "review:a/bob")
    // No comment yet: comment is undefined in each set.
    expect(currentTasks()).toEqual([
      "build.each 1 slug=a reviewer=ann: page:a:ann:-",
      "build.each 1 slug=a reviewer=bob: page:a:bob:-",
    ])

    found("comment", { slug: "a", commenter: "cy" }, "comment:a/cy")
    found("comment", { slug: "a", commenter: "di" }, "comment:a/di")
    expect(currentTasks()).toEqual([
      "build.each 1 slug=a reviewer=ann commenter=cy: page:a:ann:cy",
      "build.each 1 slug=a reviewer=ann commenter=di: page:a:ann:di",
      "build.each 1 slug=a reviewer=bob commenter=cy: page:a:bob:cy",
      "build.each 1 slug=a reviewer=bob commenter=di: page:a:bob:di",
    ])

    gone("review", { slug: "a", reviewer: "ann" })
    gone("review", { slug: "a", reviewer: "bob" })
    expect(currentTasks()).toEqual([
      "build.each 1 slug=a commenter=cy: page:a:-:cy",
      "build.each 1 slug=a commenter=di: page:a:-:di",
    ])

    gone("comment", { slug: "a", commenter: "cy" })
    gone("comment", { slug: "a", commenter: "di" })
    gone("page", { slug: "a" })
    expect(currentTasks()).toEqual([])
    expect(taskMaterializer.joinKeyCount).toBe(0)
  })

  test("a new match of a matcher with no var of its own changes the tasks of each set, and keeps their groups", () => {
    const groups: TaskGroup[] = []
    const taskMaterializer = new TaskMaterializer(
      1,
      {
        matchersByName: {
          page: new PathMatcher("page:", ["slug"]),
          review: new PathMatcher("review:", ["slug", "reviewer"]),
          template: new PathMatcher("template:", []),
        },
        required: ["page"],
        *tasks() {},
      },
      (changes) => {
        for (const { group } of changes) {
          groups.push(group)
        }
      },
    )
    taskMaterializer.hear("page", { kind: "found", matched: { vars: { slug: "a" }, data: new Mem("page:a") } })
    taskMaterializer.hear("review", { kind: "found", matched: { vars: { slug: "a", reviewer: "ann" }, data: new Mem("review:a/ann") } })
    groups.length = 0
    taskMaterializer.hear("template", { kind: "found", matched: { vars: {}, data: new Mem("template") } })

    // One call for the set reviewer=ann, in the same group as before.
    expect(groups.map((group) => group.label)).toEqual(["build.each 1 slug=a reviewer=ann"])
  })

  test("the left joins chain in name order, so the order of the names can change the sets", () => {
    const review = { lang: "en", slug: "about", reviewer: "ann" }
    const rating = { lang: "en", slug: "about", reviewer: "bob" }
    function setsInOrder(names: readonly ["review", "rating"] | readonly ["rating", "review"]): string[] {
      const matchersByName: Record<string, PathMatcher> = { page: new PathMatcher("page:", ["lang", "slug"]) }
      for (const name of names) {
        matchersByName[name] = new PathMatcher(`${name}:`, ["lang", "slug", "reviewer"])
      }
      const { found, currentTasks } = materialize({
        matchersByName,
        required: ["page"],
        *tasks(vars, matched) {
          const review = matched.review?.data.id ?? "no review"
          const rating = matched.rating?.data.id ?? "no rating"
          yield new Task({ id: `page:${vars.slug}:${vars.reviewer}:${review}:${rating}`, run: async () => {} })
        },
      })
      found("page", { lang: "en", slug: "about" }, "page:en/about")
      found("review", review, "review:en/about/ann")
      found("rating", rating, "rating:en/about/bob")
      return currentTasks()
    }

    // review binds reviewer=ann first. The rating of bob does not agree, so rating is undefined.
    expect(setsInOrder(["review", "rating"])).toEqual([
      "build.each 1 lang=en slug=about reviewer=ann: page:about:ann:review:en/about/ann:no rating",
    ])
    // rating binds reviewer=bob first. The review of ann does not agree, so review is undefined.
    expect(setsInOrder(["rating", "review"])).toEqual([
      "build.each 1 lang=en slug=about reviewer=bob: page:about:bob:no review:rating:en/about/bob",
    ])
  })

  test("a matcher whose ON var comes from an earlier matcher that is undefined is undefined too, as NULL in SQL", () => {
    const { taskMaterializer, found, gone, currentTasks } = materialize({
      matchersByName: {
        page: new PathMatcher("page:", ["slug"]),
        comment: new PathMatcher("comment:", ["slug", "author"]),
        info: new PathMatcher("info:", ["author"]),
      },
      required: ["page"],
      *tasks(vars, matched) {
        yield new Task({ id: `page:${vars.slug}:${vars.author}:${matched.info?.data.id ?? "-"}`, run: async () => {} })
      },
    })
    found("info", { author: "ann" }, "info:ann")
    found("info", { author: "bob" }, "info:bob")
    found("page", { slug: "a" }, "page:a")
    found("page", { slug: "b" }, "page:b")
    found("comment", { slug: "a", author: "ann" }, "comment:a/ann")

    // Page b has no comment, so it has no author, and no info agrees with it.
    expect(currentTasks()).toEqual([
      "build.each 1 slug=a author=ann: page:a:ann:info:ann",
      "build.each 1 slug=b: page:b:undefined:-",
    ])

    // A comment by an author with no info: info is undefined, and author stays.
    found("comment", { slug: "b", author: "cy" }, "comment:b/cy")
    expect(currentTasks()).toEqual([
      "build.each 1 slug=a author=ann: page:a:ann:info:ann",
      "build.each 1 slug=b author=cy: page:b:cy:-",
    ])

    // An info found later joins the sets of its author.
    found("info", { author: "cy" }, "info:cy")
    expect(currentTasks()).toEqual([
      "build.each 1 slug=a author=ann: page:a:ann:info:ann",
      "build.each 1 slug=b author=cy: page:b:cy:info:cy",
    ])

    gone("comment", { slug: "a", author: "ann" })
    gone("comment", { slug: "b", author: "cy" })
    expect(currentTasks()).toEqual(["build.each 1 slug=a: page:a:undefined:-", "build.each 1 slug=b: page:b:undefined:-"])
    for (const author of ["ann", "bob", "cy"]) {
      gone("info", { author })
    }
    gone("page", { slug: "a" })
    gone("page", { slug: "b" })
    expect(currentTasks()).toEqual([])
    expect(taskMaterializer.joinKeyCount).toBe(0)
  })

  test("a matcher with no ON var joins each set with each of its matches, as LEFT JOIN ON TRUE", () => {
    const { taskMaterializer, found, gone, currentTasks } = materialize({
      matchersByName: { page: new PathMatcher("page:", ["slug"]), tag: new PathMatcher("tag:", ["tag"]) },
      required: ["page"],
      *tasks(vars) {
        yield new Task({ id: `page:${vars.slug}:${vars.tag}`, run: async () => {} })
      },
    })
    found("page", { slug: "a" }, "page:a")
    found("page", { slug: "b" }, "page:b")
    expect(currentTasks()).toEqual(["build.each 1 slug=a: page:a:undefined", "build.each 1 slug=b: page:b:undefined"])

    found("tag", { tag: "x" }, "tag:x")
    found("tag", { tag: "y" }, "tag:y")
    expect(currentTasks()).toEqual([
      "build.each 1 slug=a tag=x: page:a:x",
      "build.each 1 slug=a tag=y: page:a:y",
      "build.each 1 slug=b tag=x: page:b:x",
      "build.each 1 slug=b tag=y: page:b:y",
    ])

    gone("tag", { tag: "x" })
    gone("tag", { tag: "y" })
    gone("page", { slug: "a" })
    gone("page", { slug: "b" })
    expect(currentTasks()).toEqual([])
    expect(taskMaterializer.joinKeyCount).toBe(0)
  })

  test("new data of a match in one of two branches calls tasks one time, for its set only", () => {
    const made: string[] = []
    const { found } = materialize({
      matchersByName: { page: new PathMatcher("page:", ["slug"]), review: new PathMatcher("review:", ["slug", "reviewer"]) },
      required: ["page"],
      *tasks(vars, matched) {
        made.push(`${vars.reviewer}: ${matched.review?.data.id}`)
        yield new Task({ id: `page:${vars.slug}:${vars.reviewer}`, run: async () => {} })
      },
    })
    found("page", { slug: "a" }, "page:a")
    found("review", { slug: "a", reviewer: "ann" }, "review:a/ann")
    found("review", { slug: "a", reviewer: "bob" }, "review:a/bob")

    made.length = 0
    found("review", { slug: "a", reviewer: "bob" }, "review:a/bob#2")

    expect(made).toEqual(["bob: review:a/bob#2"])
  })

  test("a later matcher that agrees with the var of an earlier one joins the same set", () => {
    const { taskMaterializer, found, gone, currentTasks } = materialize({
      matchersByName: {
        page: new PathMatcher("page:", ["slug"]),
        review: new PathMatcher("review:", ["slug", "reviewer"]),
        rating: new PathMatcher("rating:", ["slug", "reviewer"]),
      },
      required: ["page"],
      *tasks(vars, matched) {
        yield new Task({ id: `page:${vars.slug}:${vars.reviewer}:${matched.rating?.data.id ?? "-"}`, run: async () => {} })
      },
    })
    found("page", { slug: "a" }, "page:a")
    found("review", { slug: "a", reviewer: "ann" }, "review:a/ann")
    found("review", { slug: "a", reviewer: "bob" }, "review:a/bob")
    found("rating", { slug: "a", reviewer: "bob" }, "rating:a/bob")
    expect(currentTasks()).toEqual([
      "build.each 1 slug=a reviewer=ann: page:a:ann:-",
      "build.each 1 slug=a reviewer=bob: page:a:bob:rating:a/bob",
    ])

    // With no review, reviewer has no value, so no rating agrees: rating is undefined.
    gone("review", { slug: "a", reviewer: "ann" })
    gone("review", { slug: "a", reviewer: "bob" })
    expect(currentTasks()).toEqual(["build.each 1 slug=a: page:a:undefined:-"])

    gone("rating", { slug: "a", reviewer: "bob" })
    gone("page", { slug: "a" })
    expect(currentTasks()).toEqual([])
    expect(taskMaterializer.joinKeyCount).toBe(0)
  })
})

describe("build.each gives the changes of one matcher event to the build in one step", () => {
  test("a page found before its review keeps its store record when the review replaces its set, so the next build skips", async () => {
    const store = new MemoryStore()
    const page = new Mem("page:a", "A")
    const review = new Mem("review:a/ann", "5")
    async function buildOnce() {
      const build = new Build({ store })
      // page comes first, so its scan sends the page before the review: the set with no review comes first.
      build.each({
        matchersByName: { page: new PathMatcher("page:", ["slug"], [page]), review: new PathMatcher("review:", ["slug", "reviewer"], [review]) },
        required: ["page"],
        *tasks(vars, matched) {
          const inputs: Ref[] = [matched.page.data]
          if (matched.review !== undefined) {
            inputs.push(matched.review.data)
          }
          yield new Task({ id: `page:${vars.slug}`, inputs, run: async () => {} })
        },
      })
      return build.run()
    }

    const first = await buildOnce()
    expect(sortedIds(first.executed)).toEqual(["page:a"])

    const second = await buildOnce()
    expect(second.executed).toEqual([])
    expect(sortedIds(second.skipped)).toEqual(["page:a"])
  })

  test("two sets that swap their task ids in one event do not clash", async () => {
    const pages = new PathMatcher("page:", ["slug"], [new Mem("page:a", "A"), new Mem("page:b", "B")])
    // order has no ON var, so its one match joins the set of each page.
    const orders = new PathMatcher("order:", ["flip"])
    const build = new Build()
    const ran: string[] = []
    build.each({
      matchersByName: { page: pages, order: orders },
      required: ["page"],
      *tasks(vars) {
        // With no order: a gives "first" and b gives "second". With flip=yes, they swap.
        const slugOfFirst = vars.flip === "yes" ? "b" : "a"
        const id = vars.slug === slugOfFirst ? "first" : "second"
        yield new Task({ id, run: async () => void ran.push(`${id}:${vars.slug}`) })
      },
    })
    await build.run()
    expect(ran.sort()).toEqual(["first:a", "second:b"])

    ran.length = 0
    orders.foundArtifact(new Mem("order:yes", "Y"))
    const later = await build.run()

    expect(later.success).toBe(true)
    expect(ran.sort()).toEqual(["first:b", "second:a"])
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
  test("two build.each calls on one matcher both end with the newer found that tasks() of the first sends", async () => {
    const posts = new PathMatcher("post:", ["slug"], [new Mem("post:a#1", "1")])
    const build = new Build()
    let sentNewer = false
    const ran: string[] = []
    build.each({
      matchersByName: { post: posts },
      *tasks(vars, matched) {
        const postId = matched.post.data.id
        if (!sentNewer) {
          sentNewer = true
          posts.foundArtifact(new Mem("post:a#2", "2"))
        }
        yield new Task({ id: `one:${vars.slug}`, inputs: [matched.post.data], run: async () => void ran.push(`one ${postId}`) })
      },
    })
    build.each({
      matchersByName: { post: posts },
      *tasks(vars, matched) {
        const postId = matched.post.data.id
        yield new Task({ id: `two:${vars.slug}`, inputs: [matched.post.data], run: async () => void ran.push(`two ${postId}`) })
      },
    })

    const result = await build.run()

    expect(result.success).toBe(true)
    expect(ran.sort()).toEqual(["one post:a#2", "two post:a#2"])
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
