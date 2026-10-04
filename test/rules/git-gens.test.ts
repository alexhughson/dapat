import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { $ } from "bun"
import { Build, MemoryStore } from "../../src/index"
import {
  capture,
  FieldGen,
  FileOutput,
  FilePattern,
  JsonStore,
  RuleBuild,
} from "../../contrib"
import {
  GitBranches,
  GitCommitArtifact,
  GitCommits,
} from "../../examples/git-gens"
import {
  addLineCountRule,
  gitGrepCount,
  sumGrepCounts,
} from "../../examples/git-line-count"

const temps: string[] = []

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dapat-git-"))
  temps.push(dir)
  return dir
}

async function makeRepo(): Promise<{
  repo: string
  shared: string
  mainOnly: string
  featureOnly: string
}> {
  const repo = await tempDir()
  await $`git -C ${repo} init -b main`.quiet()
  await $`git -C ${repo} config user.email test@example.com`.quiet()
  await $`git -C ${repo} config user.name test`.quiet()

  await writeFile(path.join(repo, "a.txt"), "one\n")
  await $`git -C ${repo} add a.txt`.quiet()
  await $`git -C ${repo} commit -m shared`.quiet()
  const shared = (await $`git -C ${repo} rev-parse HEAD`.text()).trim()

  await writeFile(path.join(repo, "b.txt"), "two\n")
  await $`git -C ${repo} add b.txt`.quiet()
  await $`git -C ${repo} commit -m main-only`.quiet()
  const mainOnly = (await $`git -C ${repo} rev-parse HEAD`.text()).trim()

  await $`git -C ${repo} checkout -b feature ${shared}`.quiet()
  await writeFile(path.join(repo, "c.txt"), "three\n")
  await $`git -C ${repo} add c.txt`.quiet()
  await $`git -C ${repo} commit -m feature-only`.quiet()
  const featureOnly = (await $`git -C ${repo} rev-parse HEAD`.text()).trim()

  await $`git -C ${repo} checkout main`.quiet()

  return { repo, shared, mainOnly, featureOnly }
}

function sortedIds(tasks: readonly { id: string }[]): string[] {
  const ids: string[] = []
  for (const task of tasks) {
    ids.push(task.id)
  }
  ids.sort()
  return ids
}

/** FieldGen list mode sorts artifacts by id; id ends with @sha. */
function shasInIdOrder(commits: GitCommitArtifact[]): string[] {
  const shas: string[] = []
  for (const commit of commits) {
    shas.push(commit.sha)
  }
  return shas
}

describe("git FieldGen generators", () => {
  test("one task per commit", async () => {
    const { repo, shared, mainOnly, featureOnly } = await makeRepo()
    const out = await tempDir()
    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)
    rules.rule({
      name: "all",
      inputs: {
        commit: new GitCommits(repo, { commit: capture("sha") }),
      },
      outputs: { count: new FileOutput("counts/<sha>.txt", { root: out }) },
      run: async (ctx) => {
        await Bun.write(ctx.outputs.count.path, ctx.inputs.commit.sha)
      },
    })
    const result = await rules.run()
    expect(result.success).toBe(true)
    expect(sortedIds(result.executed)).toEqual(
      [
        `all:sha=${featureOnly}`,
        `all:sha=${mainOnly}`,
        `all:sha=${shared}`,
      ].sort(),
    )
  })

  test("branch main filter", async () => {
    const { repo, shared, mainOnly } = await makeRepo()
    const out = await tempDir()
    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)
    rules.rule({
      name: "main",
      inputs: {
        commit: new GitCommits(repo, {
          branch: "main",
          commit: capture("sha"),
        }),
      },
      outputs: { count: new FileOutput("main/<sha>.txt", { root: out }) },
      run: async (ctx) => {
        await Bun.write(ctx.outputs.count.path, "main")
      },
    })
    const result = await rules.run()
    expect(sortedIds(result.executed)).toEqual(
      [`main:sha=${mainOnly}`, `main:sha=${shared}`].sort(),
    )
  })

  test("branch and commit pairs", async () => {
    const { repo, shared, mainOnly, featureOnly } = await makeRepo()
    const out = await tempDir()
    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)
    rules.rule({
      name: "pair",
      inputs: {
        commit: new GitCommits(repo, {
          branch: capture("branch"),
          commit: capture("sha"),
        }),
      },
      outputs: {
        count: new FileOutput("pair/<branch>/<sha>.txt", { root: out }),
      },
      run: async (ctx) => {
        await Bun.write(ctx.outputs.count.path, "pair")
      },
    })
    const result = await rules.run()
    expect(sortedIds(result.executed)).toEqual(
      [
        `pair:branch=feature,sha=${featureOnly}`,
        `pair:branch=feature,sha=${shared}`,
        `pair:branch=main,sha=${mainOnly}`,
        `pair:branch=main,sha=${shared}`,
      ].sort(),
    )
  })

  test("branch lists with sha order", async () => {
    const { repo, shared, mainOnly, featureOnly } = await makeRepo()
    const out = await tempDir()
    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)
    const lists: Record<string, string[]> = {}
    rules.rule({
      name: "list",
      inputs: {
        commits: new GitCommits(repo, { branch: capture("branch") }),
      },
      outputs: {
        count: new FileOutput("list/<branch>.txt", { root: out }),
      },
      run: async (ctx) => {
        lists[ctx.vars.branch!] = shasInIdOrder(ctx.inputs.commits)
        await Bun.write(
          ctx.outputs.count.path,
          String(ctx.inputs.commits.length),
        )
      },
    })
    const result = await rules.run()
    expect(result.success).toBe(true)

    const mainExpected = [mainOnly, shared].sort()
    const featureExpected = [featureOnly, shared].sort()
    expect(lists["main"]).toEqual(mainExpected)
    expect(lists["feature"]).toEqual(featureExpected)
  })

  test("notes join required", async () => {
    const { repo } = await makeRepo()
    const notesRoot = await tempDir()
    await mkdir(path.join(notesRoot, "branchNotes"), { recursive: true })
    await writeFile(
      path.join(notesRoot, "branchNotes", "main.md"),
      "main notes",
    )

    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)
    rules.rule({
      name: "notes-req",
      inputs: {
        branch: new GitBranches(repo, { branch: capture("branch") }),
        notes: new FilePattern("branchNotes/<branch>.md", {
          root: notesRoot,
        }),
      },
      outputs: {
        out: new FileOutput("req/<branch>.txt", { root: notesRoot }),
      },
      run: async (ctx) => {
        await Bun.write(ctx.outputs.out.path, "req")
      },
    })
    const result = await rules.run()
    expect(sortedIds(result.executed)).toEqual(["notes-req:branch=main"])
  })

  test("notes join optional", async () => {
    const { repo } = await makeRepo()
    const notesRoot = await tempDir()
    await mkdir(path.join(notesRoot, "branchNotes"), { recursive: true })
    await writeFile(
      path.join(notesRoot, "branchNotes", "main.md"),
      "main notes",
    )

    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)
    const saw: Record<string, boolean> = {}
    rules.rule({
      name: "notes-opt",
      inputs: {
        branch: new GitBranches(repo, { branch: capture("branch") }),
        notes: new FilePattern("branchNotes/<branch>.md", {
          root: notesRoot,
        }),
      },
      optional: ["notes"],
      outputs: {
        out: new FileOutput("opt/<branch>.txt", { root: notesRoot }),
      },
      run: async (ctx) => {
        saw[ctx.vars.branch!] = ctx.inputs.notes !== undefined
        await Bun.write(ctx.outputs.out.path, "opt")
      },
    })
    const result = await rules.run()
    expect(sortedIds(result.executed).sort()).toEqual([
      "notes-opt:branch=feature",
      "notes-opt:branch=main",
    ])
    expect(saw["main"]).toBe(true)
    expect(saw["feature"]).toBe(false)
  })

  test("store skips old commits and runs only a new commit", async () => {
    const { repo } = await makeRepo()
    const out = await tempDir()
    const storePath = path.join(out, "state.json")

    const firstBuild = new Build({ store: new JsonStore(storePath) })
    const firstRules = new RuleBuild(firstBuild)
    firstRules.rule({
      name: "count",
      inputs: {
        commit: new GitCommits(repo, { commit: capture("sha") }),
      },
      outputs: {
        count: new FileOutput("skip/<sha>.txt", { root: out }),
      },
      run: async (ctx) => {
        await Bun.write(ctx.outputs.count.path, "1")
      },
    })
    const first = await firstRules.run()
    expect(first.executed.length).toBe(3)

    await writeFile(path.join(repo, "d.txt"), "four\n")
    await $`git -C ${repo} add d.txt`.quiet()
    await $`git -C ${repo} commit -m new`.quiet()
    const neu = (await $`git -C ${repo} rev-parse HEAD`.text()).trim()

    const secondBuild = new Build({ store: new JsonStore(storePath) })
    const secondRules = new RuleBuild(secondBuild)
    secondRules.rule({
      name: "count",
      inputs: {
        commit: new GitCommits(repo, { commit: capture("sha") }),
      },
      outputs: {
        count: new FileOutput("skip/<sha>.txt", { root: out }),
      },
      run: async (ctx) => {
        await Bun.write(ctx.outputs.count.path, "1")
      },
    })
    const second = await secondRules.run()
    expect(sortedIds(second.executed)).toEqual([`count:sha=${neu}`])
    expect(second.skipped.length).toBe(3)
  })

  test("line count rule writes exact counts per commit", async () => {
    // Shared commit: a.txt only → 1 line. Each branch tip adds one file → 2.
    const { repo, shared, mainOnly, featureOnly } = await makeRepo()
    const out = await tempDir()
    const build = new Build({ store: new MemoryStore() })
    const rules = new RuleBuild(build)
    addLineCountRule(rules, repo, out)

    const result = await rules.run()
    expect(result.success).toBe(true)
    expect(await Bun.file(path.join(out, "counts", `${shared}.txt`)).text()).toBe(
      "1",
    )
    expect(
      await Bun.file(path.join(out, "counts", `${mainOnly}.txt`)).text(),
    ).toBe("2")
    expect(
      await Bun.file(path.join(out, "counts", `${featureOnly}.txt`)).text(),
    ).toBe("2")
  })

  test("gitGrepCount treats exit 1 as zero matches and throws on other errors", async () => {
    const { repo, shared } = await makeRepo()
    const text = await gitGrepCount(repo, shared)
    expect(sumGrepCounts(text)).toBe(1)

    await expect(gitGrepCount(repo, "0".repeat(40))).rejects.toThrow(/failed/)
  })

  test("FieldGen single mode throws on conflicting artifact ids", async () => {
    class Conflicting extends FieldGen<
      "k",
      "k",
      GitCommitArtifact,
      { k: ReturnType<typeof capture> }
    > {
      constructor() {
        super({ k: capture("k") }, ["k"])
      }
      protected async records() {
        return [
          {
            fields: { k: "same" },
            artifact: new GitCommitArtifact("/r", "aaa"),
          },
          {
            fields: { k: "same" },
            artifact: new GitCommitArtifact("/r", "bbb"),
          },
        ]
      }
    }
    const build = new Build()
    const rules = new RuleBuild(build)
    rules.rule({
      name: "bad",
      inputs: { x: new Conflicting() },
      outputs: { out: new FileOutput("out/<k>.txt") },
      run: async () => {},
    })
    await expect(rules.load()).rejects.toThrow(/different artifact ids/)
  })
})
