// The agent loop as a dapat pipeline. Each file is one step of one session:
//
//   inbox/<sid>.txt                          the question; you write it
//   prompts/<sid>/<n>/prompt.txt             the prompt of turn n; seed writes turn 0, advance writes the others
//   turns/<sid>/<n>/step.json                the reply of the model for turn n: tool calls, or the answer
//   turns/<sid>/<n>/results/<call id>.txt    one file for each tool call of turn n
//   answers/<sid>.txt                        the final answer
//
// Only advance:<sid>/<n-1> writes into prompts/<sid>/<n>/. See README.md for why this folder has one writer.
import * as fsPromises from "node:fs/promises"
import path from "node:path"
import { Build, Task, type Context } from "dapat"
import { FileArtifact, FileMatcher, FilesystemPrefix } from "dapat/contrib"
import * as model from "./model"

export function addAgentLoop(build: Build, root: string, think: model.Model): void {
  build.each({
    matchersByName: { inbox: new FileMatcher(path.join(root, "inbox/<sid>.txt")) },
    *tasks(vars, matched) {
      const question = matched.inbox.data
      const firstPrompt = new FileArtifact(path.join(root, "prompts", vars.sid, "0", "prompt.txt"))
      yield new Task({
        id: `seed:${vars.sid}`,
        inputs: [question],
        outputs: [firstPrompt],
        run: async () => {
          const text = await Bun.file(question.path).text()
          await Bun.write(firstPrompt.path, text)
        },
      })

      // The folder inputs make answer wait for every task that writes a prompt or a turn of this
      // session, also for the tasks that the loop adds during the run.
      const prompts = new FilesystemPrefix(path.join(root, "prompts", vars.sid))
      const turns = new FilesystemPrefix(path.join(root, "turns", vars.sid))
      const answer = new FileArtifact(path.join(root, "answers", `${vars.sid}.txt`))
      yield new Task({
        id: `answer:${vars.sid}`,
        inputs: [prompts, turns],
        outputs: [answer],
        run: async () => {
          const text = await readAnswer(path.join(root, "turns", vars.sid))
          await Bun.write(answer.path, text)
        },
      })
    },
  })

  build.each({
    matchersByName: { prompt: new FileMatcher(path.join(root, "prompts/<sid>/<n>/prompt.txt")) },
    *tasks(vars, matched) {
      const prompt = matched.prompt.data
      const step = new FileArtifact(path.join(root, "turns", vars.sid, vars.n, "step.json"))
      yield new Task({
        id: `think:${vars.sid}/${vars.n}`,
        inputs: [prompt],
        outputs: [step],
        run: async () => {
          const promptText = await Bun.file(prompt.path).text()
          const modelStep = think(promptText)
          await Bun.write(step.path, JSON.stringify(modelStep, null, 2))
        },
      })
    },
  })

  build.each({
    matchersByName: { step: new FileMatcher(path.join(root, "turns/<sid>/<n>/step.json")) },
    *tasks(vars, matched) {
      const step = matched.step.data
      const prompt = new FileArtifact(path.join(root, "prompts", vars.sid, vars.n, "prompt.txt"))
      const results = new FilesystemPrefix(path.join(root, "turns", vars.sid, vars.n, "results"))
      const nextTurn = Number(vars.n) + 1
      const nextPromptFolder = new FilesystemPrefix(path.join(root, "prompts", vars.sid, String(nextTurn)))

      // The names of the result files are known only after the model replies, so act declares
      // the folder and reports each file with ctx.produced.
      yield new Task({
        id: `act:${vars.sid}/${vars.n}`,
        inputs: [step],
        outputs: [results],
        run: async (ctx) => {
          await clearFolder(results, ctx)
          const modelStep = await readStep(step.path)
          if (modelStep.kind === "answer") {
            return
          }
          for (const call of modelStep.calls) {
            const result = new FileArtifact(path.join(results.path, `${call.id}.txt`))
            await Bun.write(result.path, `${call.name} ${call.term}: ${model.search(call.term)}\n`)
            ctx.produced(result)
          }
        },
      })

      // advance writes the next prompt only when the model asked for tools. A declared output that
      // may not be written must be a folder. When the model answers, advance does not delete an
      // old next prompt from a longer loop. See README.md for both rules.
      yield new Task({
        id: `advance:${vars.sid}/${vars.n}`,
        inputs: [prompt, step, results],
        outputs: [nextPromptFolder],
        run: async (ctx) => {
          const modelStep = await readStep(step.path)
          if (modelStep.kind === "answer") {
            return
          }
          const resultPaths = await results.list()
          resultPaths.sort()
          let observations = ""
          for (const resultPath of resultPaths) {
            observations += await Bun.file(resultPath).text()
          }
          const promptText = await Bun.file(prompt.path).text()
          const next = new FileArtifact(path.join(nextPromptFolder.path, "prompt.txt"))
          await Bun.write(next.path, model.nextPrompt(promptText, observations))
          ctx.produced(next)
        },
      })
    },
  })
}

/**
 * Deletes every file in a folder that only this task writes. A run with fewer tool calls than
 * the run before must not leave old result files, because advance reads the whole folder.
 * No matcher watches this folder, so the deletes do not remove any task during the run.
 */
async function clearFolder(folder: FilesystemPrefix, ctx: Context): Promise<void> {
  const oldPaths = await folder.list()
  for (const oldPath of oldPaths) {
    await fsPromises.rm(oldPath)
    ctx.deleted(new FileArtifact(oldPath))
  }
}

async function readStep(stepPath: string): Promise<model.ModelStep> {
  const text = await Bun.file(stepPath).text()
  return JSON.parse(text) as model.ModelStep
}

/**
 * Follows the turns of one session from turn 0 to the first step that is an answer.
 * The turns folder can hold turns after that step, from an older run with a longer loop.
 * dapat does not delete them, so this reads the chain and not the highest turn number.
 */
async function readAnswer(turnsFolder: string): Promise<string> {
  let turn = 0
  for (;;) {
    const stepPath = path.join(turnsFolder, String(turn), "step.json")
    const exists = await fsPromises.exists(stepPath)
    if (!exists) {
      throw new Error(`turn ${turn} has no step: ${stepPath}`)
    }
    const modelStep = await readStep(stepPath)
    if (modelStep.kind === "answer") {
      return `${modelStep.text}\n`
    }
    turn += 1
  }
}
