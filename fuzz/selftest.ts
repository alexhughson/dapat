/**
 * Checks the harness itself:
 *  1. The docs example of section 10 (pages joined to templates), on real files, gives exactly the
 *     three joined sets that DOCS.md lists, through the same FileMatcher the fs scenario uses.
 *  2. Without a plant, a batch of cases has no finding outside the known bug codes.
 *  3. With each planted oracle mistake, the same batch has findings: the harness can see a mismatch.
 * Run: bun fuzz/selftest.ts
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Build, Task } from "../src/index"
import { Rng } from "./rng"
import { CaseLog } from "./types"
import { runPatternCase } from "./scenario-pattern"
import { runJoinMemCase } from "./scenario-join-mem"
import { runFsCase, FUZZ_TMP, FileMatcherForSelftest } from "./scenario-fs"

const KNOWN = new Set([
  "pattern.repeatedVarNoBacktrack",
  "pattern.lineBreakNotMatched",
  "pattern.objectPrototypeVarName",
  "pattern.lineBreakNotMatched(fs)",
  "join.loneSurrogateVarFails",
  "join.sharedMatcherReorder",
  "join.protoVarNameLost",
])

let failures = 0
function check(ok: boolean, what: string): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`)
  if (!ok) failures += 1
}

async function docsExample(): Promise<void> {
  const root = path.join(FUZZ_TMP, "selftest-docs")
  rmSync(root, { recursive: true, force: true })
  for (const f of ["content/en/hello.md", "content/en/about.md", "content/fr/hello.md", "content/de/hello.md", "templates/en.html", "templates/fr.html"]) {
    mkdirSync(path.dirname(path.join(root, f)), { recursive: true })
    writeFileSync(path.join(root, f), f)
  }
  const build = new Build()
  const labels: string[] = []
  build.each({
    matchersByName: {
      page: new FileMatcherForSelftest(root, "content/<lang>/<slug>.md", "time"),
      template: new FileMatcherForSelftest(root, "templates/<lang>.html", "time"),
    },
    *tasks(vars) {
      yield new Task({ id: `page:${vars.lang}/${vars.slug}`, run: async () => {} })
    },
  })
  const result = await build.run()
  for (const slot of (build as any).slots.values()) labels.push(slot.group.label)
  const ids = result.executed.map((t) => t.id).sort()
  check(JSON.stringify(ids) === JSON.stringify(["page:en/about", "page:en/hello", "page:fr/hello"]), `docs example tasks ${JSON.stringify(ids)}`)
  check(labels.includes("build.each 1 lang=en slug=hello"), `docs example label ${JSON.stringify(labels)}`)
  rmSync(root, { recursive: true, force: true })
}

async function batch(plant: string | undefined): Promise<{ unknown: number; total: number }> {
  if (plant === undefined) delete process.env.FUZZ_PLANT
  else process.env.FUZZ_PLANT = plant
  let unknown = 0
  let total = 0
  const scenarios = plant === undefined ? ["pattern", "join-mem", "fs"] : [plant === "join" ? "join-mem" : plant]
  for (const scenario of scenarios) {
    for (let seed = 1; seed <= 60; seed++) {
      const log = new CaseLog()
      const rng = new Rng(seed * 7919 + 13)
      if (scenario === "pattern") runPatternCase(rng, log, 100)
      else if (scenario === "join-mem") await runJoinMemCase(rng, log, 25)
      else await runFsCase(rng, log, seed)
      for (const f of log.findings) {
        total += 1
        if (!KNOWN.has(f.code)) unknown += 1
        if (!KNOWN.has(f.code) && plant === undefined) console.log(`  unexpected ${scenario}:${seed} ${f.code}: ${f.detail.slice(0, 300)}`)
      }
    }
  }
  return { unknown, total }
}

await docsExample()
const clean = await batch(undefined)
check(clean.unknown === 0, `no unknown findings without a plant (${clean.total} known-bug findings)`)
for (const plant of ["pattern", "join", "fs"]) {
  const planted = await batch(plant)
  check(planted.unknown > 0, `plant '${plant}' is detected (${planted.unknown} unknown findings)`)
}
delete process.env.FUZZ_PLANT
rmSync(FUZZ_TMP, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
