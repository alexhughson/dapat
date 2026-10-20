/**
 * KeyPattern misses a key when a var appears two times and the first place could bind it in
 * more than one way. Each segment is one regex with independent greedy groups, and a later
 * conflict never makes it try another split (src/pattern.ts matchMix, lines 162-188).
 * Run: bun fuzz/repros/pattern-repeated-var.ts
 */
import { KeyPattern } from "../../src/pattern"

const cases: [string, string, Record<string, string>][] = [
  // Same var two times in one segment: a="a-b" fits, but the regex gives a="a-b-a", a="b".
  ["d/<a>-<a>.txt", "d/a-b-a-b.txt", { a: "a-b" }],
  // Same var in two segments: the first segment binds a="x-y" greedily, the second needs a="x".
  ["d/<a>-<b>/<a>.txt", "d/x-y-z/x.txt", { a: "x", b: "y-z" }],
]
let bugs = 0
for (const [template, key, expected] of cases) {
  const got = new KeyPattern(template).match(key)
  const ok = got !== null && JSON.stringify(got) === JSON.stringify(expected)
  console.log(`${ok ? "OK " : "BUG"} ${template} on ${key}: got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`)
  if (!ok) bugs += 1
}
process.exit(bugs === 0 ? 0 : 1)
