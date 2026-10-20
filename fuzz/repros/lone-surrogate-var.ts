/**
 * A var value with a lone UTF-16 surrogate makes build.each fail the whole build with a URIError.
 * The join keys use encodeURIComponent (src/match-join.ts line 205), which throws on a lone
 * surrogate. DOCS.md types vars as plain strings and does not forbid this.
 *
 * It is reachable from a real file name: KeyPattern splits by UTF-16 code units, so the template
 * "emoji/<a><b>.txt" binds a="\uD83D", b="\uDE00" for the file "emoji/😀.txt".
 * Run: bun fuzz/repros/lone-surrogate-var.ts
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Build, Matcher, Task } from "../../src/index"
import { FileArtifact } from "../../contrib/fs"
import { KeyPattern } from "../../src/pattern"

const root = mkdtempSync(path.join(tmpdir(), "dapat-repro-"))
mkdirSync(path.join(root, "emoji"))
writeFileSync(path.join(root, "emoji", "\u{1F600}.txt"), "smile")

class EmojiFiles extends Matcher<FileArtifact> {
  readonly pattern = new KeyPattern("emoji/<a><b>.txt")
  readonly varNames = this.pattern.varNames
  async scan(): Promise<void> {
    const key = "emoji/\u{1F600}.txt"
    const vars = this.pattern.match(key)!
    console.log(`KeyPattern vars: ${JSON.stringify(vars)}`)
    this.send({ kind: "found", matched: { vars, data: new FileArtifact(path.join(root, key)) } })
  }
}

const build = new Build()
build.each({
  matchersByName: { file: new EmojiFiles() },
  *tasks(vars, matched) {
    yield new Task({ id: `copy:${vars.a}${vars.b}`, inputs: [matched.file.data], run: async () => {} })
  },
})
let code = 0
try {
  const result = await build.run()
  console.log(`OK: ran ${result.executed.length} task(s)`)
} catch (error) {
  console.log(`BUG: run() rejected: ${String(error)}`)
  code = 1
}
rmSync(root, { recursive: true, force: true })
process.exit(code)
