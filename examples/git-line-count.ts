import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Build, MemoryStore } from "../src/index"
import { FileOutput, RuleBuild, capture } from "../contrib"
import { GitCommits } from "./git-gens"

/**
 * `git grep -c "" <sha>` lists per-file line counts. Exit 1 means no
 * matching lines (count 0). Any other nonzero exit is an error.
 */
export async function gitGrepCount(
  repoPath: string,
  sha: string,
): Promise<string> {
  const proc = Bun.spawn(["git", "-C", repoPath, "grep", "-c", "", sha], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const text = await new Response(proc.stdout).text()
  const code = await proc.exited
  if (code !== 0 && code !== 1) {
    const err = await new Response(proc.stderr).text()
    throw new Error(`git grep -c "" ${sha} failed (exit ${code}): ${err}`)
  }
  return text
}

export function sumGrepCounts(text: string): number {
  let total = 0
  for (const line of text.split("\n")) {
    if (line.length === 0) continue
    total += Number(line.slice(line.lastIndexOf(":") + 1))
  }
  return total
}

/** DOCS 11.8 motivating rule: one count file per commit sha. */
export function addLineCountRule(
  rules: RuleBuild,
  repo: string,
  root: string,
): void {
  rules.rule({
    name: "count",
    inputs: { commit: new GitCommits(repo, { commit: capture("sha") }) },
    outputs: { count: new FileOutput("counts/<sha>.txt", { root }) },
    run: async (ctx) => {
      const sha = ctx.inputs.commit.sha
      const text = await gitGrepCount(repo, sha)
      const total = sumGrepCounts(text)
      await Bun.write(ctx.outputs.count.path, String(total))
    },
  })
}

if (import.meta.main) {
  const repo = path.resolve(process.argv[2] ?? process.cwd())
  const out = await mkdtemp(path.join(tmpdir(), "dapat-ex-git-count-"))

  try {
    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)
    addLineCountRule(rules, repo, out)

    const result = await rules.run()
    if (!result.success) {
      for (const [task, err] of result.failed) {
        console.error(task.id, err)
      }
      throw new Error("build failed")
    }

    const ids = result.executed.map((t) => t.id)
    ids.sort()
    console.log(`repo = ${repo}`)
    console.log(`commits counted = ${ids.length}`)
    if (ids.length > 0) {
      const first = ids[0]!
      const sha = first.slice("count:sha=".length)
      const body = await Bun.file(path.join(out, "counts", `${sha}.txt`)).text()
      console.log(`sample ${first} → ${body} lines`)
    }
  } finally {
    await rm(out, { recursive: true, force: true })
  }
}
