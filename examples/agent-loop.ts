// Agent loop as FileBuild rematch, not a while:
//   inbox → prompt → tools.json → result/* (glob + produced) → next prompt
// think() is a fake model. templates bind <sid> and <n>; the next turn is
// produced as turns/<sid>/<n+1>/prompt.txt under a glob output prefix.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { FileBuild, FilePattern } from "../contrib/filebuild"
import { FileArtifact } from "../contrib/fs/file"
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
  const files = new FileBuild(build, { root })

  files.rule({
    name: "seed",
    inputs: { inbox: new FilePattern("inbox/<sid>.txt") },
    outputs: { prompt: new FilePattern("turns/<sid>/0/prompt.txt") },
    run: async (ctx) => {
      const body = await ctx.file("inbox").read()
      await writeFile(ctx.outputFile("prompt").path, body)
    },
  })

  files.rule({
    name: "think",
    inputs: { prompt: new FilePattern("turns/<sid>/<n>/prompt.txt") },
    outputs: { tools: new FilePattern("turns/<sid>/<n>/tools.json") },
    run: async (ctx) => {
      thinkRuns += 1
      const prompt = new TextDecoder().decode(await ctx.file("prompt").read())
      const calls = think(prompt)
      await writeFile(ctx.outputFile("tools").path, JSON.stringify(calls))
    },
  })

  files.rule({
    name: "dispatch",
    inputs: { tools: new FilePattern("turns/<sid>/<n>/tools.json") },
    outputs: { results: new FilePattern("turns/<sid>/<n>/result/*.txt") },
    run: async (ctx) => {
      const calls = parseCalls(await ctx.file("tools").read())
      const resultDir = path.join(root, "turns", ctx.vars.sid!, ctx.vars.n!, "result")
      if (calls.length === 0) {
        const nonePath = path.join(resultDir, "none.txt")
        await writeFile(nonePath, "none")
        ctx.produced(new FileArtifact(nonePath))
        return
      }
      for (const call of calls) {
        const resultPath = path.join(resultDir, `${call.id}.txt`)
        await writeFile(resultPath, `${call.name}:${call.arg}`)
        ctx.produced(new FileArtifact(resultPath))
      }
    },
  })

  files.rule({
    name: "gather",
    inputs: {
      tools: new FilePattern("turns/<sid>/<n>/tools.json"),
      results: new FilePattern("turns/<sid>/<n>/result/*.txt"),
    },
    outputs: { reply: new FilePattern("turns/<sid>/<n>/reply.txt") },
    run: async (ctx) => {
      const tools = new TextDecoder().decode(await ctx.file("tools").read())
      const parts: string[] = [tools]
      for (const file of ctx.files("results")) {
        parts.push(new TextDecoder().decode(await file.read()))
      }
      await writeFile(ctx.outputFile("reply").path, parts.join("\n"))
    },
  })

  files.rule({
    name: "advance",
    inputs: {
      tools: new FilePattern("turns/<sid>/<n>/tools.json"),
      reply: new FilePattern("turns/<sid>/<n>/reply.txt"),
    },
    outputs: { more: new FilePattern("turns/<sid>/**") },
    run: async (ctx) => {
      const calls = parseCalls(await ctx.file("tools").read())
      const reply = new TextDecoder().decode(await ctx.file("reply").read())
      if (calls.length === 0) {
        const donePath = path.join(root, "turns", ctx.vars.sid!, "done.txt")
        await writeFile(donePath, "ok")
        ctx.produced(new FileArtifact(donePath))
        return
      }
      const n = Number(ctx.vars.n)
      const nextPath = path.join(root, "turns", ctx.vars.sid!, String(n + 1), "prompt.txt")
      await mkdir(path.dirname(nextPath), { recursive: true })
      await writeFile(nextPath, `What is dapat?\n## Observations\n${reply}`)
      ctx.produced(new FileArtifact(nextPath))
    },
  })

  const result = await files.run()
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
