import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  DirOutput,
  FileArtifact,
  FileGlob,
  FileOutput,
  FilePattern,
  RuleBuild,
} from "../contrib"
import { Build, MemoryStore } from "../src/index"

type Call = { id: string; name: string; arg: string }

function think(prompt: string): Call[] {
  if (prompt.includes("## Observations")) return []
  return [{ id: "1", name: "search", arg: "dapat" }]
}

function parseCalls(bytes: Uint8Array): Call[] {
  return JSON.parse(new TextDecoder().decode(bytes)) as Call[]
}

const root = await mkdtemp(path.join(tmpdir(), "dapat-ex-agent-"))
let thinkRuns = 0

try {
  await mkdir(path.join(root, "inbox"), { recursive: true })
  await writeFile(path.join(root, "inbox/demo.txt"), "What is dapat?")

  const build = new Build({ store: new MemoryStore() })
  const rules = new RuleBuild(build)

  rules.rule({
    name: "seed",
    inputs: { inbox: new FilePattern("inbox/<sid>.txt", { root }) },
    outputs: { prompt: new FileOutput("turns/<sid>/0/prompt.txt", { root }) },
    run: async (ctx) => {
      const body = await ctx.inputs.inbox.read()
      await Bun.write(ctx.outputs.prompt.path, body)
    },
  })

  rules.rule({
    name: "think",
    inputs: { prompt: new FilePattern("turns/<sid>/<n>/prompt.txt", { root }) },
    outputs: { tools: new FileOutput("turns/<sid>/<n>/tools.json", { root }) },
    run: async (ctx) => {
      thinkRuns += 1
      const prompt = new TextDecoder().decode(await ctx.inputs.prompt.read())
      const calls = think(prompt)
      await Bun.write(ctx.outputs.tools.path, JSON.stringify(calls))
    },
  })

  rules.rule({
    name: "dispatch",
    inputs: { tools: new FilePattern("turns/<sid>/<n>/tools.json", { root }) },
    outputs: { results: new DirOutput("turns/<sid>/<n>/result/", { root }) },
    run: async (ctx) => {
      const calls = parseCalls(await ctx.inputs.tools.read())
      if (calls.length === 0) {
        const nonePath = path.join(ctx.outputs.results.path, "none.txt")
        await Bun.write(nonePath, "none")
        ctx.produced(new FileArtifact(nonePath))
        return
      }
      for (const call of calls) {
        const resultPath = path.join(ctx.outputs.results.path, `${call.id}.txt`)
        await Bun.write(resultPath, `${call.name}:${call.arg}`)
        ctx.produced(new FileArtifact(resultPath))
      }
    },
  })

  rules.rule({
    name: "gather",
    inputs: {
      tools: new FilePattern("turns/<sid>/<n>/tools.json", { root }),
      results: new FileGlob("turns/<sid>/<n>/result/*.txt", { root }),
    },
    outputs: { reply: new FileOutput("turns/<sid>/<n>/reply.txt", { root }) },
    run: async (ctx) => {
      const tools = new TextDecoder().decode(await ctx.inputs.tools.read())
      const parts: string[] = [tools]
      for (const file of ctx.inputs.results) {
        parts.push(new TextDecoder().decode(await file.read()))
      }
      await Bun.write(ctx.outputs.reply.path, parts.join("\n"))
    },
  })

  rules.rule({
    name: "advance",
    inputs: {
      tools: new FilePattern("turns/<sid>/<n>/tools.json", { root }),
      reply: new FilePattern("turns/<sid>/<n>/reply.txt", { root }),
    },
    outputs: { more: new DirOutput("turns/<sid>/", { root }) },
    run: async (ctx) => {
      const calls = parseCalls(await ctx.inputs.tools.read())
      const reply = new TextDecoder().decode(await ctx.inputs.reply.read())
      if (calls.length === 0) {
        const donePath = path.join(ctx.outputs.more.path, "done.txt")
        await Bun.write(donePath, "ok")
        ctx.produced(new FileArtifact(donePath))
        return
      }
      const n = Number(ctx.vars.n)
      const nextPath = path.join(
        ctx.outputs.more.path,
        String(n + 1),
        "prompt.txt",
      )
      await mkdir(path.dirname(nextPath), { recursive: true })
      await Bun.write(nextPath, `What is dapat?\n## Observations\n${reply}`)
      ctx.produced(new FileArtifact(nextPath))
    },
  })

  const result = await rules.run()
  if (!result.success) {
    throw new Error("build failed")
  }
  if (thinkRuns !== 2) {
    throw new Error(`think ran ${thinkRuns} times, expected 2`)
  }

  const tools0 = await Bun.file(path.join(root, "turns/demo/0/tools.json")).text()
  const tools1 = await Bun.file(path.join(root, "turns/demo/1/tools.json")).text()
  const reply0 = await Bun.file(path.join(root, "turns/demo/0/reply.txt")).text()
  const reply1 = await Bun.file(path.join(root, "turns/demo/1/reply.txt")).text()
  const done = await Bun.file(path.join(root, "turns/demo/done.txt")).text()
  if (JSON.parse(tools0).length !== 1) {
    throw new Error(`turn 0 tools should have one call: ${tools0}`)
  }
  if (tools1 !== "[]") {
    throw new Error(`turn 1 tools should be []: ${tools1}`)
  }
  if (done !== "ok") {
    throw new Error("missing turns/demo/done.txt")
  }

  console.log(`think runs = ${thinkRuns}`)
  console.log(`turns/demo/0/tools.json = ${tools0}`)
  console.log(`turns/demo/0/reply.txt = ${reply0}`)
  console.log(`turns/demo/1/tools.json = ${tools1}`)
  console.log(`turns/demo/1/reply.txt = ${reply1}`)
  console.log(`turns/demo/done.txt = ${done}`)
} finally {
  await rm(root, { recursive: true, force: true })
}
