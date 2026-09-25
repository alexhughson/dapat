import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Build } from "../../src"
import {
  DirOutput,
  FileArtifact,
  FileGlob,
  FileOutput,
  FilePattern,
  JsonStore,
  RuleBuild,
} from "../../contrib"

const temps: string[] = []

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dapat-spec-docs-"))
  temps.push(dir)
  return dir
}

function sortedIds(tasks: readonly { id: string }[]): string[] {
  const ids: string[] = []
  for (const task of tasks) {
    ids.push(task.id)
  }
  ids.sort()
  return ids
}

async function writeTree(root: string, relativePaths: string[]): Promise<void> {
  for (const rel of relativePaths) {
    const full = path.join(root, rel)
    await mkdir(path.dirname(full), { recursive: true })
    await writeFile(full, `${rel}\n`)
  }
}

describe("DOCS section 11 samples", () => {
  test("upper then wrap creates mid and out, and wrap waits for upper", async () => {
    const root = await tempDir()
    await mkdir(path.join(root, "src"), { recursive: true })
    await writeFile(path.join(root, "src", "hello.txt"), "hello")

    const store = new JsonStore(path.join(root, ".dapat", "state.json"))
    const build = new Build({ store })
    const rules = new RuleBuild(build)

    rules.rule({
      name: "upper",
      inputs: { src: new FilePattern("src/<name>.txt", { root }) },
      outputs: { mid: new FileOutput("mid/<name>.txt", { root }) },
      run: async (ctx) => {
        const text = new TextDecoder().decode(await ctx.inputs.src.read())
        await Bun.write(ctx.outputs.mid.path, text.toUpperCase())
      },
    })

    rules.rule({
      name: "wrap",
      inputs: { mid: new FilePattern("mid/<name>.txt", { root }) },
      outputs: { out: new FileOutput("out/<name>.txt", { root }) },
      run: async (ctx) => {
        const text = new TextDecoder().decode(await ctx.inputs.mid.read())
        await Bun.write(ctx.outputs.out.path, `[${text}]`)
      },
    })

    const result = await rules.run()
    expect(result.success).toBe(true)
    expect(sortedIds(result.executed)).toEqual([
      "upper:name=hello",
      "wrap:name=hello",
    ])
    expect(await Bun.file(path.join(root, "mid", "hello.txt")).text()).toBe("HELLO")
    expect(await Bun.file(path.join(root, "out", "hello.txt")).text()).toBe("[HELLO]")
  })

  test("11.1 draft/revise table, second run skips all six, feedback change reruns one", async () => {
    const root = await tempDir()
    await writeTree(root, [
      "inputs/intro.md",
      "inputs/costs.md",
      "generic/law.md",
      "generic/tax.md",
      "process/law/intro.md",
      "process/law/costs.md",
      "process/tax/intro.md",
      "feedback/law/intro.md",
      "attachments/law/intro/chart.png",
      "attachments/law/intro/table.csv",
    ])

    const storePath = path.join(root, ".dapat", "state.json")
    await mkdir(path.dirname(storePath), { recursive: true })

    type Brief = { path: string }
    const fakeModel = {
      draft: async (brief: Brief, guide: Brief, process: Brief) => {
        const parts = [brief.path, guide.path, process.path]
        return `DRAFT:${parts.join("|")}`
      },
      revise: async (draft: Brief, feedback: Brief, attachments: Brief[]) => {
        const attachmentPaths: string[] = []
        for (const item of attachments) {
          attachmentPaths.push(item.path)
        }
        return `REVISE:${draft.path}|${feedback.path}|${attachmentPaths.join(",")}`
      },
    }

    const addPipeline = (build: Build, rules: RuleBuild) => {
      rules.rule({
        name: "draft",
        inputs: {
          brief: new FilePattern("inputs/<section>.md", { root }),
          guide: new FilePattern("generic/<specialty>.md", { root }),
          process: new FilePattern("process/<specialty>/<section>.md", { root }),
        },
        outputs: { draft: new FileOutput("drafts/<specialty>/<section>.md", { root }) },
        run: async (ctx) => {
          const text = await fakeModel.draft(
            ctx.inputs.brief,
            ctx.inputs.guide,
            ctx.inputs.process,
          )
          await Bun.write(ctx.outputs.draft.path, text)
        },
      })

      rules.rule({
        name: "revise",
        inputs: {
          draft: new FilePattern("drafts/<specialty>/<section>.md", { root }),
          feedback: new FilePattern("feedback/<specialty>/<section>.md", { root }),
          attachments: new FileGlob("attachments/<specialty>/<section>/**", { root }),
        },
        optional: ["feedback", "attachments"],
        outputs: { final: new FileOutput("final/<specialty>/<section>.md", { root }) },
        run: async (ctx) => {
          if (ctx.inputs.feedback === undefined) {
            await Bun.write(ctx.outputs.final.path, await ctx.inputs.draft.read())
            return
          }
          const attachments = ctx.inputs.attachments ?? []
          const text = await fakeModel.revise(
            ctx.inputs.draft,
            ctx.inputs.feedback,
            attachments,
          )
          await Bun.write(ctx.outputs.final.path, text)
        },
      })
    }

    const firstBuild = new Build({ store: new JsonStore(storePath) })
    const firstRules = new RuleBuild(firstBuild)
    addPipeline(firstBuild, firstRules)
    const first = await firstRules.run()

    expect(first.success).toBe(true)

    const expectedFirst = [
      "draft:section=costs,specialty=law",
      "draft:section=intro,specialty=law",
      "draft:section=intro,specialty=tax",
      "revise:section=costs,specialty=law",
      "revise:section=intro,specialty=law",
      "revise:section=intro,specialty=tax",
    ]
    expect(sortedIds(first.executed)).toEqual(expectedFirst)
    expect(sortedIds(first.skipped)).toEqual([])

    // no draft for tax+costs: process/tax/costs.md is missing
    expect(await Bun.file(path.join(root, "drafts", "tax", "costs.md")).exists()).toBe(
      false,
    )

    const lawIntroFinal = await Bun.file(
      path.join(root, "final", "law", "intro.md"),
    ).text()
    expect(lawIntroFinal.startsWith("REVISE:")).toBe(true)
    expect(lawIntroFinal.includes("chart.png")).toBe(true)
    expect(lawIntroFinal.includes("table.csv")).toBe(true)
    const chartIndex = lawIntroFinal.indexOf("chart.png")
    const tableIndex = lawIntroFinal.indexOf("table.csv")
    expect(chartIndex).toBeLessThan(tableIndex)

    const lawCostsFinal = await Bun.file(
      path.join(root, "final", "law", "costs.md"),
    ).text()
    expect(lawCostsFinal.startsWith("DRAFT:")).toBe(true)

    const taxIntroFinal = await Bun.file(
      path.join(root, "final", "tax", "intro.md"),
    ).text()
    expect(taxIntroFinal.startsWith("DRAFT:")).toBe(true)

    const secondBuild = new Build({ store: new JsonStore(storePath) })
    const secondRules = new RuleBuild(secondBuild)
    addPipeline(secondBuild, secondRules)
    const second = await secondRules.run()

    expect(second.success).toBe(true)
    expect(sortedIds(second.executed)).toEqual([])
    expect(sortedIds(second.skipped)).toEqual(expectedFirst)

    await mkdir(path.join(root, "feedback", "tax"), { recursive: true })
    await writeFile(path.join(root, "feedback", "tax", "intro.md"), "tax notes\n")

    const thirdBuild = new Build({ store: new JsonStore(storePath) })
    const thirdRules = new RuleBuild(thirdBuild)
    addPipeline(thirdBuild, thirdRules)
    const third = await thirdRules.run()

    expect(third.success).toBe(true)
    expect(sortedIds(third.executed)).toEqual([
      "revise:section=intro,specialty=tax",
    ])
    expect(sortedIds(third.skipped)).toEqual([
      "draft:section=costs,specialty=law",
      "draft:section=intro,specialty=law",
      "draft:section=intro,specialty=tax",
      "revise:section=costs,specialty=law",
      "revise:section=intro,specialty=law",
    ])

    const taxIntroAfter = await Bun.file(
      path.join(root, "final", "tax", "intro.md"),
    ).text()
    expect(taxIntroAfter.startsWith("REVISE:")).toBe(true)
    expect(taxIntroAfter.includes("feedback/tax/intro.md")).toBe(true)
  })

  test("11.4 paginate DirOutput announces pages that a later rule can match", async () => {
    const root = await tempDir()
    await mkdir(path.join(root, "inbox"), { recursive: true })
    await writeFile(path.join(root, "inbox", "doc.txt"), "a\nb\nc")

    const build = new Build({ store: new JsonStore(path.join(root, "state.json")) })
    const rules = new RuleBuild(build)

    rules.rule({
      name: "paginate",
      inputs: { src: new FilePattern("inbox/<doc>.txt", { root }) },
      outputs: { pages: new DirOutput("pages/<doc>/", { root }) },
      run: async (ctx) => {
        const text = new TextDecoder().decode(await ctx.inputs.src.read())
        const lines = text.split("\n")
        for (let i = 0; i < lines.length; i++) {
          const page = new FileArtifact(
            path.join(ctx.outputs.pages.path, `${i + 1}.txt`),
          )
          await Bun.write(page.path, lines[i]!)
          ctx.produced(page)
        }
      },
    })

    rules.rule({
      name: "copy-page",
      inputs: { page: new FilePattern("pages/<doc>/<n>.txt", { root }) },
      outputs: { out: new FileOutput("out/<doc>/<n>.txt", { root }) },
      run: async (ctx) => {
        await Bun.write(ctx.outputs.out.path, await ctx.inputs.page.read())
      },
    })

    const result = await rules.run()
    expect(result.success).toBe(true)
    expect(sortedIds(result.executed)).toEqual([
      "copy-page:doc=doc,n=1",
      "copy-page:doc=doc,n=2",
      "copy-page:doc=doc,n=3",
      "paginate:doc=doc",
    ])
    expect(await Bun.file(path.join(root, "out", "doc", "1.txt")).text()).toBe("a")
    expect(await Bun.file(path.join(root, "out", "doc", "2.txt")).text()).toBe("b")
    expect(await Bun.file(path.join(root, "out", "doc", "3.txt")).text()).toBe("c")
  })
})
