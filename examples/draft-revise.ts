import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  FileArtifact,
  FileGlob,
  FileOutput,
  FilePattern,
  RuleBuild,
} from "../contrib"
import { Build, MemoryStore } from "../src/index"

const model = {
  draft: async (
    brief: FileArtifact,
    guide: FileArtifact,
    process: FileArtifact,
  ): Promise<string> => {
    const parts = [brief.path, guide.path, process.path]
    return `DRAFT:${parts.map((p) => path.basename(p)).join("|")}`
  },
  revise: async (
    draft: FileArtifact,
    feedback: FileArtifact,
    attachments: FileArtifact[],
  ): Promise<string> => {
    const names: string[] = []
    for (const file of attachments) {
      names.push(path.basename(file.path))
    }
    return `REVISE:${path.basename(draft.path)}|${path.basename(feedback.path)}|${names.join(",")}`
  },
}

const root = await mkdtemp(path.join(tmpdir(), "dapat-ex-draft-"))

try {
  const files = [
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
  ]
  for (const rel of files) {
    const full = path.join(root, rel)
    await mkdir(path.dirname(full), { recursive: true })
    await writeFile(full, `${rel}\n`)
  }

  const build = new Build({ store: new MemoryStore() })
  const rules = new RuleBuild(build)

  rules.rule({
    name: "draft",
    inputs: {
      brief: new FilePattern("inputs/<section>.md", { root }),
      guide: new FilePattern("generic/<specialty>.md", { root }),
      process: new FilePattern("process/<specialty>/<section>.md", { root }),
    },
    outputs: {
      draft: new FileOutput("drafts/<specialty>/<section>.md", { root }),
    },
    run: async (ctx) => {
      const text = await model.draft(
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
      attachments: new FileGlob("attachments/<specialty>/<section>/**", {
        root,
      }),
    },
    optional: ["feedback", "attachments"],
    outputs: {
      final: new FileOutput("final/<specialty>/<section>.md", { root }),
    },
    run: async (ctx) => {
      if (ctx.inputs.feedback === undefined) {
        await Bun.write(ctx.outputs.final.path, await ctx.inputs.draft.read())
        return
      }
      const attachments = ctx.inputs.attachments ?? []
      const text = await model.revise(
        ctx.inputs.draft,
        ctx.inputs.feedback,
        attachments,
      )
      await Bun.write(ctx.outputs.final.path, text)
    },
  })

  const result = await rules.run()
  if (!result.success) {
    throw new Error("build failed")
  }

  const lawIntro = await Bun.file(
    path.join(root, "final/law/intro.md"),
  ).text()
  const lawCosts = await Bun.file(
    path.join(root, "final/law/costs.md"),
  ).text()
  console.log(`tasks executed = ${result.executed.length}`)
  console.log(`final/law/intro.md = ${lawIntro}`)
  console.log(`final/law/costs.md starts with ${lawCosts.slice(0, 20)}`)
} finally {
  await rm(root, { recursive: true, force: true })
}
