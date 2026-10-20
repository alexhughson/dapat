/** Sums the summary files that `run.ts --out` wrote. Run: bun fuzz/aggregate.ts <file>... */
const totals = { cases: 0, totalOps: 0, wallSeconds: 0 }
const counts: Record<string, number> = {}
const notes: Record<string, number> = {}
const noteExamples: Record<string, string> = {}
const findings: Record<string, { count: number; seeds: string[]; first: string }> = {}
const opsByScenario: Record<string, number> = {}
const seedsByScenario: Record<string, string[]> = {}
for (const file of process.argv.slice(2)) {
  const s = JSON.parse(await Bun.file(file).text())
  totals.cases += s.cases
  totals.totalOps += s.totalOps
  totals.wallSeconds += s.wallSeconds
  const scenario = s.scenarios.join(",")
  opsByScenario[scenario] = (opsByScenario[scenario] ?? 0) + s.totalOps
  ;(seedsByScenario[scenario] ??= []).push(s.seeds)
  for (const [k, v] of Object.entries(s.counts as Record<string, number>)) counts[k] = (counts[k] ?? 0) + v
  for (const [k, v] of Object.entries(s.notes as Record<string, number>)) notes[k] = (notes[k] ?? 0) + v
  for (const [k, v] of Object.entries(s.noteExamples as Record<string, string>)) noteExamples[k] ??= v
  for (const [k, v] of Object.entries(s.findings as Record<string, { count: number; seeds: string[]; first: string }>)) {
    const f = (findings[k] ??= { count: 0, seeds: [], first: v.first })
    f.count += v.count
    for (const seed of v.seeds) if (f.seeds.length < 10) f.seeds.push(seed)
  }
}
console.log(JSON.stringify({ ...totals, opsByScenario, seedsByScenario, counts, notes, noteExamples, findings }, null, 1))
