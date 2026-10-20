/**
 * KeyPattern does not match a file name that holds a line break (\n, \r, U+2028, U+2029).
 * Such names are legal on Linux. The regex for a segment uses "." without the "s" flag,
 * so "(.+)" and ".*" stop at a line break (src/pattern.ts lines 165-172).
 * Run: bun fuzz/repros/pattern-line-break.ts
 */
import { KeyPattern } from "../../src/pattern"

let bugs = 0
for (const name of ["a\nb", "a\rb", "a\u2028b"]) {
  const key = `notes/${name}.md`
  const viaVar = new KeyPattern("notes/<slug>.md").match(key)
  const viaStar = new KeyPattern("notes/*.md").match(key)
  const ok = viaVar !== null && viaVar.slug === name && viaStar !== null
  console.log(`${ok ? "OK " : "BUG"} ${JSON.stringify(key)}: <slug> gives ${JSON.stringify(viaVar)}, * gives ${JSON.stringify(viaStar)}`)
  if (!ok) bugs += 1
}
process.exit(bugs === 0 ? 0 : 1)
