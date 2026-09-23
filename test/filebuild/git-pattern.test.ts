import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Build } from "../../src/index"
import { FileBuild, FilePattern, GitCommitPattern } from "../../contrib/filebuild"
import { GitCommitArtifact } from "../../contrib/git/commit"
import { gitCommitId, resolveRepoPath } from "../../contrib/git/id"
import { git } from "../../contrib/git/run"
import { SqliteStore } from "../../contrib/store"

const temps: string[] = []

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dapat-git-pattern-"))
  temps.push(dir)
  return dir
}

async function initRepo(): Promise<string> {
  const repo = await tempDir()
  await git(["init"], { cwd: repo })
  await git(["config", "user.email", "test@example.com"], { cwd: repo })
  await git(["config", "user.name", "Test"], { cwd: repo })
  return repo
}

async function commitFile(
  repo: string,
  rel: string,
  body: string,
  message: string,
): Promise<string> {
  const full = path.join(repo, rel)
  await writeFile(full, body)
  await git(["add", rel], { cwd: repo })
  await git(["commit", "-m", message], { cwd: repo })
  const sha = (await git(["rev-parse", "HEAD"], { cwd: repo })).trim()
  return sha
}

describe("GitCommitPattern", () => {
  test("scan returns every commit", async () => {
    const repo = await initRepo()
    const first = await commitFile(repo, "a.txt", "one\n", "first")
    const second = await commitFile(repo, "a.txt", "one\ntwo\n", "second")

    const pattern = new GitCommitPattern(".")
    const ids = await pattern.scan(repo)
    expect(ids).toEqual([
      gitCommitId(resolveRepoPath(repo), second),
      gitCommitId(resolveRepoPath(repo), first),
    ])
  })

  test("matchId and artifact round trip", async () => {
    const repo = await initRepo()
    const sha = await commitFile(repo, "a.txt", "hi\n", "init")
    const abs = resolveRepoPath(repo)
    const id = gitCommitId(abs, sha)

    const pattern = new GitCommitPattern(".")
    const vars = pattern.matchId(id, repo)
    expect(vars).toEqual({ sha })

    const artifact = pattern.artifact(id, repo)
    expect(artifact).toBeInstanceOf(GitCommitArtifact)
    expect(artifact.id).toBe(id)
    if (!(artifact instanceof GitCommitArtifact)) {
      throw new Error("expected GitCommitArtifact")
    }
    expect(artifact.sha).toBe(sha)
    expect(artifact.repo).toBe(abs)
    expect(await artifact.contentStamp()).toBe(sha)
  })

  test("resolveRepoPath rejects a path that contains '#'", () => {
    expect(() => resolveRepoPath("/tmp/foo#bar")).toThrow(
      "repo path '/tmp/foo#bar' contains '#'",
    )
  })

  test("scan with a bad rev rejects with git stderr", async () => {
    const repo = await initRepo()
    await commitFile(repo, "a.txt", "hi\n", "init")
    const pattern = new GitCommitPattern(".", { rev: "no-such-branch" })
    let message = ""
    try {
      await pattern.scan(repo)
    } catch (error) {
      if (!(error instanceof Error)) throw error
      message = error.message
    }
    expect(message.length).toBeGreaterThan(0)
    expect(message).toContain("git rev-list no-such-branch failed:")
    expect(message.toLowerCase()).toContain("no-such-branch")
  })

  test("FileBuild writes one line-count file per commit and skips on rerun", async () => {
    const repo = await initRepo()
    const first = await commitFile(repo, "a.txt", "a\nb\n", "first")
    const second = await commitFile(repo, "a.txt", "a\nb\nc\n", "second")
    const storePath = path.join(repo, "state.sqlite")

    const makeBuild = () => {
      const build = new Build({ store: new SqliteStore(storePath) })
      const files = new FileBuild(build, { root: repo })
      files.rule({
        name: "count",
        inputs: { commit: new GitCommitPattern(".") },
        outputs: { out: new FilePattern("out/<sha>.txt") },
        run: async (ctx) => {
          const commit = ctx.item("commit")
          if (!(commit instanceof GitCommitArtifact)) {
            throw new Error("expected GitCommitArtifact")
          }
          const total = await countTextLines(commit.repo, commit.sha)
          await Bun.write(ctx.outputFile("out").path, `${total}\n`)
        },
      })
      return files
    }

    const firstRun = await makeBuild().run()
    expect(firstRun.success).toBe(true)
    expect(firstRun.executed.length).toBe(2)
    expect(firstRun.skipped.length).toBe(0)
    expect(await Bun.file(path.join(repo, "out", `${first}.txt`)).text()).toBe("2\n")
    expect(await Bun.file(path.join(repo, "out", `${second}.txt`)).text()).toBe("3\n")

    const secondRun = await makeBuild().run()
    expect(secondRun.success).toBe(true)
    expect(secondRun.executed.length).toBe(0)
    expect(secondRun.skipped.length).toBe(2)

    const third = await commitFile(repo, "a.txt", "a\nb\nc\nd\n", "third")
    const thirdRun = await makeBuild().run()
    expect(thirdRun.success).toBe(true)
    expect(thirdRun.executed.length).toBe(1)
    expect(thirdRun.skipped.length).toBe(2)
    expect(thirdRun.executed[0]!.id).toContain(third)
    expect(await Bun.file(path.join(repo, "out", `${third}.txt`)).text()).toBe("4\n")
  })
})

async function countTextLines(repo: string, sha: string): Promise<number> {
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
    throw new Error(`git grep failed: ${detail}`)
  }
  let total = 0
  const lines = stdout.split("\n")
  for (const line of lines) {
    if (line.length === 0) continue
    const colon = line.lastIndexOf(":")
    if (colon < 0) {
      throw new Error(`unexpected git grep line: ${line}`)
    }
    const count = Number(line.slice(colon + 1))
    if (!Number.isFinite(count)) {
      throw new Error(`unexpected git grep line: ${line}`)
    }
    total += count
  }
  return total
}
