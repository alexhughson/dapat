/**
 * Times the join of build.each. Run it with `bun bench/join.ts`.
 *
 * 1. `n` pages {lang, slug} joined to 2 templates {lang} with build.each, against the same
 *    `n` tasks added with build.add. Both include build.run().
 * 2. One changed template among `n` pages: the time of its found event, which replaces n/2 tasks.
 *
 * The join itself costs one index lookup for each partner matcher. The build finds the producers of
 * each task in an index of the outputs, so its scheduling cost does not grow with all the tasks.
 */
import { Build, Matcher, Task } from "../src/index"
import { Mem } from "../test/mem"

/** Finds a fixed list of artifacts, each with fixed vars. A bench calls `foundArtifact` to change a match. */
class ListMatcher extends Matcher<Mem> {
  constructor(
    readonly varNames: readonly string[],
    private readonly matches: readonly { vars: Record<string, string>; data: Mem }[],
  ) {
    super()
  }

  async scan(_signal: AbortSignal): Promise<void> {
    for (const match of this.matches) {
      this.foundArtifact(match.vars, match.data)
    }
  }

  foundArtifact(vars: Record<string, string>, data: Mem): void {
    this.send({ kind: "found", matched: { vars, data } })
  }
}

const LANGS = ["en", "fr"]

function langOf(i: number): string {
  return LANGS[i % LANGS.length]!
}

function renderTask(lang: string, slug: string, page: Mem, template: Mem): Task {
  const html = new Mem(`html:${lang}/${slug}`)
  return new Task({ id: `render:${lang}/${slug}`, inputs: [page, template], outputs: [html], run: async () => {} })
}

async function timeAdd(n: number): Promise<number> {
  const templates = new Map<string, Mem>()
  for (const lang of LANGS) {
    templates.set(lang, new Mem(`template:${lang}`, "T"))
  }
  const start = performance.now()
  const build = new Build()
  for (let i = 0; i < n; i++) {
    const lang = langOf(i)
    const slug = `p${i}`
    build.add(renderTask(lang, slug, new Mem(`page:${lang}/${slug}`, "P"), templates.get(lang)!))
  }
  const result = await build.run()
  const elapsed = performance.now() - start
  if (result.executed.length !== n) throw new Error(`build.add ran ${result.executed.length} tasks, not ${n}`)
  return elapsed
}

async function timeJoin(n: number): Promise<{ runMs: number; changeMs: number; replaced: number }> {
  const pageMatches: { vars: Record<string, string>; data: Mem }[] = []
  for (let i = 0; i < n; i++) {
    const lang = langOf(i)
    const slug = `p${i}`
    pageMatches.push({ vars: { lang, slug }, data: new Mem(`page:${lang}/${slug}`, "P") })
  }
  const templateMatches: { vars: Record<string, string>; data: Mem }[] = []
  for (const lang of LANGS) {
    templateMatches.push({ vars: { lang }, data: new Mem(`template:${lang}`, "T") })
  }
  const templates = new ListMatcher(["lang"], templateMatches)
  let made = 0

  const start = performance.now()
  const build = new Build()
  build.each({
    matchersByName: { page: new ListMatcher(["lang", "slug"], pageMatches), template: templates },
    *tasks(vars, matched) {
      made += 1
      yield renderTask(vars.lang!, vars.slug!, matched.page.data, matched.template.data)
    },
  })
  const result = await build.run()
  const runMs = performance.now() - start
  if (result.executed.length !== n) throw new Error(`build.each ran ${result.executed.length} tasks, not ${n}`)

  made = 0
  const changeStart = performance.now()
  templates.foundArtifact({ lang: "en" }, new Mem("template:en#2", "T2"))
  const changeMs = performance.now() - changeStart
  return { runMs, changeMs, replaced: made }
}

function format(ms: number): string {
  return `${ms.toFixed(1)} ms`.padStart(10)
}

// One warm-up run of each, so the JIT does not count.
await timeAdd(200)
await timeJoin(200)

console.log("pages   build.add + run   build.each join + run   one changed template (tasks replaced)")
for (const n of [1000, 2000, 4000, 8000]) {
  const addMs = await timeAdd(n)
  const join = await timeJoin(n)
  console.log(
    `${String(n).padStart(5)}   ${format(addMs)}        ${format(join.runMs)}              ${format(join.changeMs)} (${join.replaced})`,
  )
}
