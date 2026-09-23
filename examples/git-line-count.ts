// Count text lines in every commit of this repo. A second run with the same
// SqliteStore skips every commit whose sha is unchanged.

import path from "node:path"
import { mkdir } from "node:fs/promises"
import { FileBuild, FilePattern, GitCommitPattern } from "../contrib/filebuild"
import { GitCommitArtifact } from "../contrib/git"
import { SqliteStore } from "../contrib/store"
import { Build } from "../src/index"

const root = path.resolve(import.meta.dir, "..")
const statePath = path.join(root, ".dapat", "git-line-count.sqlite")
await mkdir(path.dirname(statePath), { recursive: true })

const build = new Build({ store: new SqliteStore(statePath) })
const files = new FileBuild(build, { root })

files.rule({
  name: "line-count",
  inputs: { commit: new GitCommitPattern(".") },
  outputs: { count: new FilePattern("out/line-counts/<sha>.txt") },
  run: async (ctx) => {
    const commit = ctx.item("commit")
    if (!(commit instanceof GitCommitArtifact)) {
      throw new Error("input 'commit' is not a GitCommitArtifact")
    }
    const counts = await countLinesInCommit(commit.repo, commit.sha)
    const lines: string[] = []
    lines.push(`total ${counts.total}`)
    for (const file of counts.files) {
      lines.push(`${file.path} ${file.count}`)
    }
    await Bun.write(ctx.outputFile("count").path, `${lines.join("\n")}\n`)
  },
})

const result = await files.run()
console.log("success:", result.success)
console.log(
  "executed:",
  result.executed.map((task) => task.id),
)
console.log(
  "skipped:",
  result.skipped.map((task) => task.id),
)
if (!result.success) {
  for (const [task, error] of result.failed) {
    console.error(`failed ${task.id}:`, error)
  }
  process.exit(1)
}

type FileCount = { path: string; count: number }

async function countLinesInCommit(
  repo: string,
  sha: string,
): Promise<{ total: number; files: FileCount[] }> {
  // git grep -c exits 1 when nothing matches; that is not an error here.
  const proc = Bun.spawn(["git", "grep", "-I", "-c", "", sha], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  if (exitCode !== 0 && exitCode !== 1) {
    const detail = stderr.trim().length > 0 ? stderr.trim() : `exit ${exitCode}`
    throw new Error(`git grep -I -c '' ${sha} failed: ${detail}`)
  }

  const files: FileCount[] = []
  let total = 0
  const lines = stdout.split("\n")
  for (const line of lines) {
    if (line.length === 0) continue
    const parsed = parseGrepCountLine(line, sha)
    files.push(parsed)
    total += parsed.count
  }
  return { total, files }
}

function parseGrepCountLine(line: string, sha: string): FileCount {
  // With a revision, git prints "<sha>:<path>:<count>".
  const prefix = `${sha}:`
  let body = line
  if (body.startsWith(prefix)) {
    body = body.slice(prefix.length)
  }
  const colon = body.lastIndexOf(":")
  if (colon < 0) {
    throw new Error(`unexpected git grep -c line: ${line}`)
  }
  const filePath = body.slice(0, colon)
  const countText = body.slice(colon + 1)
  const count = Number(countText)
  if (!Number.isFinite(count)) {
    throw new Error(`unexpected git grep -c line: ${line}`)
  }
  return { path: filePath, count }
}
