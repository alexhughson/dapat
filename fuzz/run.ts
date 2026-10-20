/**
 * The fuzz runner.
 *   bun fuzz/run.ts --scenario join-mem --seed 7            one case, prints its findings
 *   bun fuzz/run.ts --scenario all --from 1 --to 500        a campaign over a seed range
 *   bun fuzz/run.ts --selftest                              checks that the harness finds a planted mistake
 * Each case is fully decided by (scenario, seed), so a failure replays with --scenario X --seed N.
 */
import { rm } from "node:fs/promises"
import { Rng } from "./rng"
import { CaseLog, type Finding } from "./types"
import { runPatternCase } from "./scenario-pattern"
import { runJoinMemCase } from "./scenario-join-mem"
import { runFsCase, FUZZ_TMP } from "./scenario-fs"

type Scenario = "pattern" | "join-mem" | "fs"
const SCENARIOS: Scenario[] = ["pattern", "join-mem", "fs"]

async function runCase(scenario: Scenario, seed: number): Promise<CaseLog> {
  const log = new CaseLog()
  const rng = new Rng(seed * 2654435761 + SCENARIOS.indexOf(scenario))
  try {
    if (scenario === "pattern") runPatternCase(rng, log, 300)
    else if (scenario === "join-mem") await runJoinMemCase(rng, log, 60)
    else await runFsCase(rng, log, seed)
  } catch (error) {
    // Never swallowed: an unexpected exception is a finding (or a harness bug to fix).
    const stack = error instanceof Error ? error.stack ?? String(error) : String(error)
    log.fail("exception", stack)
  }
  return log
}

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`)
  if (at < 0) return undefined
  return process.argv[at + 1]
}

async function main(): Promise<void> {
  const scenarioArg = arg("scenario") ?? "all"
  const scenarios: Scenario[] = scenarioArg === "all" ? SCENARIOS : (scenarioArg.split(",") as Scenario[])
  const single = arg("seed")
  const from = Number(single ?? arg("from") ?? 1)
  const to = Number(single ?? arg("to") ?? from)
  const verbose = single !== undefined || process.argv.includes("--verbose")
  const started = Date.now()
  let totalOps = 0
  const counts: Record<string, number> = {}
  const notes: Record<string, number> = {}
  const noteExamples: Record<string, string> = {}
  const findingsByCode = new Map<string, { count: number; first: string; seeds: string[] }>()
  let cases = 0
  for (const scenario of scenarios) {
    for (let seed = from; seed <= to; seed++) {
      const caseStart = Date.now()
      const log = await runCase(scenario, seed)
      const caseMs = Date.now() - caseStart
      if (caseMs > 3000) console.error(`slow case ${scenario}:${seed} took ${caseMs} ms`)
      cases += 1
      totalOps += log.ops
      for (const [k, v] of Object.entries(log.counts)) counts[k] = (counts[k] ?? 0) + v
      for (const [k, v] of Object.entries(log.notes)) notes[k] = (notes[k] ?? 0) + v
      for (const [k, v] of Object.entries(log.noteExamples)) if (noteExamples[k] === undefined) noteExamples[k] = v
      for (const finding of log.findings) addFinding(findingsByCode, finding, `${scenario}:${seed}`)
      if (verbose) for (const f of log.findings) console.log(`[${scenario} seed ${seed}] ${f.code}: ${f.detail}`)
    }
  }
  const summary = {
    scenarios,
    seeds: `${from}..${to}`,
    cases,
    totalOps,
    wallSeconds: (Date.now() - started) / 1000,
    counts: Object.fromEntries(Object.entries(counts).sort()),
    notes,
    noteExamples,
    findings: Object.fromEntries(
      [...findingsByCode].map(([code, v]) => [code, { count: v.count, seeds: v.seeds.slice(0, 8), first: v.first }]),
    ),
  }
  const outFile = arg("out")
  if (outFile !== undefined) await Bun.write(outFile, JSON.stringify(summary, null, 1))
  else console.log(JSON.stringify(summary, null, 1))
  await rm(FUZZ_TMP, { recursive: true, force: true })
}

function addFinding(map: Map<string, { count: number; first: string; seeds: string[] }>, finding: Finding, where: string): void {
  const entry = map.get(finding.code) ?? { count: 0, first: finding.detail, seeds: [] }
  entry.count += 1
  if (!entry.seeds.includes(where)) entry.seeds.push(where)
  map.set(finding.code, entry)
}

await main()
