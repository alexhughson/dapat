/**
 * KeyPattern never matches when a var is named like a member of Object.prototype
 * ("constructor", "toString", "__proto__"). matchMix builds the vars in a plain object and
 * checks `out[name] !== undefined`, which reads the inherited member (src/pattern.ts line 181).
 * Run: bun fuzz/repros/pattern-proto-var-name.ts
 */
import { KeyPattern } from "../../src/pattern"

let bugs = 0
for (const name of ["slug", "constructor", "toString", "__proto__"]) {
  const got = new KeyPattern(`posts/<${name}>.md`).match("posts/hello.md")
  const ok = got !== null && Object.hasOwn(got, name) && got[name] === "hello"
  console.log(`${ok ? "OK " : "BUG"} posts/<${name}>.md on posts/hello.md: ${got === null ? "null" : JSON.stringify(Object.entries(got))}`)
  if (!ok) bugs += 1
}
process.exit(bugs === 0 ? 0 : 1)
