// An agent loop as a dapat build. Each turn is a file, so a rerun with no edits calls the model zero times.
//
//   inbox/<sid>.txt              you write the question
//   prompts/<sid>/<n>/prompt.txt seed writes turn 0; advance:<sid>/<n-1> writes the others
//   turns/<sid>/<n>/step.json    think:<sid>/<n> asks the model: tool calls, or the answer
//
// The number of turns is known only at run time. Each new prompt file makes the next think task.
// Run it two times from an empty folder: the second run skips each task. Edit inbox/demo.txt to rerun.
import { existsSync } from "node:fs"
import path from "node:path"
import { Build } from "dapat"
import { FileArtifact, FileMatcher, FileTemplate, FolderTemplate, JsonStore } from "dapat/contrib"
import { LambdaFileMatcher } from "./lambda-file-matcher"

type Step = { kind: "tools"; terms: string[] } | { kind: "answer"; text: string }

// A fake model: it searches one new term on each turn, then answers. Swap in a real model call here.
// The model is not a task input, so a new model reruns nothing; put its name in the prompt to change that.
async function model(prompt: string): Promise<Step> {
  const terms = ["dapat", "stamp"]
  for (const term of terms) {
    if (!prompt.includes(`${term}:`)) {
      return { kind: "tools", terms: [term] }
    }
  }
  return { kind: "answer", text: prompt }
}

function search(term: string): string {
  return `${term}: notes about ${term}`
}

if (!existsSync("inbox")) {
  await Bun.write("inbox/demo.txt", "What is dapat?\n")
}

const build = new Build({ store: new JsonStore(".dapat/state.json") })

build.each({
  name: "seed",
  matchersByName: { question: new FileMatcher("inbox/<sid>.txt") },
  outputsByName: { prompt: new FileTemplate("prompts/<sid>/0/prompt.txt") },
  async run({ matched, outputs }) {
    await Bun.write(outputs.prompt.path, await Bun.file(matched.question.data.path).text())
  },
})

build.each({
  name: "think",
  matchersByName: { prompt: new FileMatcher("prompts/<sid>/<n>/prompt.txt") },
  outputsByName: { step: new FileTemplate("turns/<sid>/<n>/step.json") },
  async run({ matched, outputs }) {
    const reply = await model(await Bun.file(matched.prompt.data.path).text())
    await Bun.write(outputs.step.path, JSON.stringify(reply))
  },
})

// The vars of a step file: turns/<sid>/<n>/step.json gives { sid, n, next }, where next is n + 1.
// A pattern cannot compute next, so this matcher takes a function.
function stepVars(relativePath: string) {
  const parts = relativePath.split("/")
  if (parts.length !== 3 || parts[2] !== "step.json") {
    return null
  }
  const sid = parts[0]!
  const n = parts[1]!
  return { sid, n, next: String(Number(n) + 1) }
}

// advance writes the next prompt only when the model asked for tools. An output that may not be
// written must be a folder: a declared file would make the next turn at the start of each build,
// and that turn the next one, until build.run() rejects with "send limit".
// The folder of turn n+1 has one writer, this task. A shared folder makes tasks rerun.
build.each({
  name: "advance",
  matchersByName: {
    prompt: new FileMatcher("prompts/<sid>/<n>/prompt.txt"),
    step: new LambdaFileMatcher("turns", ["sid", "n", "next"], stepVars),
  },
  outputsByName: { nextPrompt: new FolderTemplate("prompts/<sid>/<next>/") },
  async run({ matched, outputs, ctx }) {
    const reply: Step = JSON.parse(await Bun.file(matched.step.data.path).text())
    if (reply.kind === "answer") {
      return
    }
    let text = await Bun.file(matched.prompt.data.path).text()
    for (const term of reply.terms) {
      text += `${search(term)}\n`
    }
    const next = new FileArtifact(path.join(outputs.nextPrompt.path, "prompt.txt"))
    await Bun.write(next.path, text)
    ctx.produced(next)
  },
})

const result = await build.run()
const executedIds: string[] = []
for (const task of result.executed) {
  executedIds.push(task.id)
}
console.log("executed:", executedIds.sort())
console.log("skipped:", result.skipped.length)
if (!result.success) {
  for (const [task, error] of result.failed) {
    console.error(`${task.id}: ${error.message}`)
  }
  process.exit(1)
}
