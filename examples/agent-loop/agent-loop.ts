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
import { Build, Task } from "dapat"
import { FileArtifact, FileMatcher, FilesystemPrefix, JsonStore } from "dapat/contrib"

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
  matchersByName: { question: new FileMatcher("inbox/<sid>.txt") },
  *tasks(vars, matched) {
    const prompt = new FileArtifact(`prompts/${vars.sid}/0/prompt.txt`)
    yield new Task({
      id: `seed:${vars.sid}`,
      inputs: [matched.question.data],
      outputs: [prompt],
      run: async () => {
        await Bun.write(prompt.path, await Bun.file(matched.question.data.path).text())
      },
    })
  },
})

build.each({
  matchersByName: { prompt: new FileMatcher("prompts/<sid>/<n>/prompt.txt") },
  *tasks(vars, matched) {
    const prompt = matched.prompt.data
    const step = new FileArtifact(`turns/${vars.sid}/${vars.n}/step.json`)
    // The next prompt folder has one writer: this task. A shared folder makes tasks rerun.
    const nextFolder = new FilesystemPrefix(`prompts/${vars.sid}/${Number(vars.n) + 1}`)

    yield new Task({
      id: `think:${vars.sid}/${vars.n}`,
      inputs: [prompt],
      outputs: [step],
      run: async () => {
        const reply = await model(await Bun.file(prompt.path).text())
        await Bun.write(step.path, JSON.stringify(reply))
      },
    })

    // advance writes the next prompt only when the model asked for tools. An output that may not be
    // written must be a folder: a declared file would make the next turn at the start of each build,
    // and that turn the next one, until build.run() rejects with "send limit".
    yield new Task({
      id: `advance:${vars.sid}/${vars.n}`,
      inputs: [prompt, step],
      outputs: [nextFolder],
      run: async (ctx) => {
        const reply: Step = JSON.parse(await Bun.file(step.path).text())
        if (reply.kind === "answer") {
          return
        }
        let text = await Bun.file(prompt.path).text()
        for (const term of reply.terms) {
          text += `${search(term)}\n`
        }
        const next = new FileArtifact(path.join(nextFolder.path, "prompt.txt"))
        await Bun.write(next.path, text)
        ctx.produced(next)
      },
    })
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
