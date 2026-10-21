import { afterEach, describe, expect, test } from "bun:test"
import * as fsPromises from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Build, Task, type Result } from "dapat"
import { FileArtifact, FileMatcher, JsonStore } from "dapat/contrib"
import * as model from "./model"
import * as pipeline from "./pipeline"

const temps: string[] = []

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await fsPromises.rm(dir, { recursive: true, force: true })
  }
})

async function tempRoot(): Promise<string> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "dapat-agent-loop-"))
  temps.push(dir)
  return dir
}

async function writeText(filePath: string, text: string): Promise<void> {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true })
  await fsPromises.writeFile(filePath, text)
}

/** One build of the agent loop, as run.ts does it: a new Build and the store on disk. */
async function runLoop(root: string): Promise<Result> {
  const store = new JsonStore(path.join(root, ".dapat/state.json"))
  const build = new Build({ store })
  pipeline.addAgentLoop(build, root, model.fakeModel)
  const result = await build.run()
  const failures: string[] = []
  for (const [task, error] of result.failed) {
    failures.push(`${task.id}: ${error.message}`)
  }
  expect(failures).toEqual([])
  expect(result.errors).toEqual([])
  expect(result.success).toBe(true)
  return result
}

function ids(tasks: readonly Task[]): string[] {
  const out: string[] = []
  for (const task of tasks) {
    out.push(task.id)
  }
  out.sort()
  return out
}

/** Every task of one session that runs turns 0 to lastTurn. */
function sessionTasks(sid: string, lastTurn: number): string[] {
  const out = [`answer:${sid}`, `seed:${sid}`]
  for (let turn = 0; turn <= lastTurn; turn++) {
    out.push(`think:${sid}/${turn}`, `act:${sid}/${turn}`, `advance:${sid}/${turn}`)
  }
  out.sort()
  return out
}

function sorted(list: string[]): string[] {
  const out = [...list]
  out.sort()
  return out
}

const INTRO_QUESTION = "What is dapat, what is a stamp, and what is a task?\n"
const DAPAT_NOTE = "search dapat: dapat is a build library: a task runs again only when its inputs change."
const STAMP_NOTE = "search stamp: a stamp is a short text that changes when the bytes of a file change."
const TASK_NOTE = "search task: a task reads input artifacts and writes output artifacts."
const MATCHER_NOTE = "search matcher: a matcher finds artifacts, such as files, and gives a set of vars for each one."

describe("agent loop example", () => {
  test("runs each turn until the model answers, then skips everything on a rerun", async () => {
    const root = await tempRoot()
    await writeText(path.join(root, "inbox/intro.txt"), INTRO_QUESTION)

    // The model asks for dapat and stamp on turn 0, for task on turn 1, and answers on turn 2.
    const first = await runLoop(root)
    expect(ids(first.executed)).toEqual(sessionTasks("intro", 2))
    expect(ids(first.skipped)).toEqual([])

    const answer = await Bun.file(path.join(root, "answers/intro.txt")).text()
    expect(answer).toBe(`${DAPAT_NOTE}\n${STAMP_NOTE}\n${TASK_NOTE}\n`)
    const turn0Results = await fsPromises.readdir(path.join(root, "turns/intro/0/results"))
    expect(sorted(turn0Results)).toEqual(["1.txt", "2.txt"])
    const turn3Prompt = Bun.file(path.join(root, "prompts/intro/3/prompt.txt"))
    expect(await turn3Prompt.exists()).toBe(false)

    const second = await runLoop(root)
    expect(ids(second.executed)).toEqual([])
    expect(ids(second.skipped)).toEqual(sessionTasks("intro", 2))
  })

  test("a new question runs only the tasks of its own session", async () => {
    const root = await tempRoot()
    await writeText(path.join(root, "inbox/intro.txt"), INTRO_QUESTION)
    await runLoop(root)

    await writeText(path.join(root, "inbox/matcher.txt"), "What is a matcher?\n")
    const result = await runLoop(root)
    expect(ids(result.executed)).toEqual(sessionTasks("matcher", 1))
    expect(ids(result.skipped)).toEqual(sessionTasks("intro", 2))
    const answer = await Bun.file(path.join(root, "answers/matcher.txt")).text()
    expect(answer).toBe(`${MATCHER_NOTE}\n`)
  })

  test("an edited question runs its session again, and a longer loop adds turns", async () => {
    const root = await tempRoot()
    await writeText(path.join(root, "inbox/intro.txt"), "What is dapat?\n")
    const first = await runLoop(root)
    expect(ids(first.executed)).toEqual(sessionTasks("intro", 1))

    // Each prompt holds the question, so every turn of the session runs again.
    // Turns 2 and 3 are new, because the model now needs two tool turns.
    await writeText(path.join(root, "inbox/intro.txt"), INTRO_QUESTION)
    const second = await runLoop(root)
    expect(ids(second.executed)).toEqual(sessionTasks("intro", 2))

    const answer = await Bun.file(path.join(root, "answers/intro.txt")).text()
    expect(answer).toBe(`${DAPAT_NOTE}\n${STAMP_NOTE}\n${TASK_NOTE}\n`)
  })

  test("a shorter loop leaves the old later turns on disk, and the answer still comes from the new chain", async () => {
    const root = await tempRoot()
    await writeText(path.join(root, "inbox/intro.txt"), INTRO_QUESTION)
    await runLoop(root)

    // Now the model answers on turn 1. dapat does not delete prompts/intro/2/prompt.txt,
    // so the matcher still finds turn 2. Its tasks have the same inputs as before, so they skip.
    await writeText(path.join(root, "inbox/intro.txt"), "What is a task?\n")
    const result = await runLoop(root)
    expect(ids(result.executed)).toEqual(sessionTasks("intro", 1))
    expect(ids(result.skipped)).toEqual(["act:intro/2", "advance:intro/2", "think:intro/2"])

    const answer = await Bun.file(path.join(root, "answers/intro.txt")).text()
    expect(answer).toBe(`${TASK_NOTE}\n`)

    const third = await runLoop(root)
    expect(ids(third.executed)).toEqual([])
  })

  test("a turn whose prompt is gone gets no act or advance task", async () => {
    const root = await tempRoot()
    await writeText(path.join(root, "inbox/intro.txt"), "What is a stamp?\n")
    await runLoop(root)

    // turns/intro/0 and turns/intro/1 stay. Without the join on the prompt, act:intro/1 would exist
    // at the scan, skip with the old step.json, and advance:intro/1 would read old results.
    await fsPromises.rm(path.join(root, "prompts"), { recursive: true })
    await writeText(path.join(root, "inbox/intro.txt"), INTRO_QUESTION)
    const result = await runLoop(root)
    expect(ids(result.executed)).toEqual(sessionTasks("intro", 2))

    const answer = await Bun.file(path.join(root, "answers/intro.txt")).text()
    expect(answer).toBe(`${DAPAT_NOTE}\n${STAMP_NOTE}\n${TASK_NOTE}\n`)
    const rerun = await runLoop(root)
    expect(ids(rerun.executed)).toEqual([])
  })

  test("an exact next-prompt output makes the build add turns until the send limit", async () => {
    // This is a cut-down rule with only advance, not the example pipeline.
    // advance declares the file prompts/<sid>/<n+1>/prompt.txt, not its folder.
    // Each declared output sends a promised event at the scan, so the prompt matcher
    // finds turn n+1 before any task runs, which adds advance for turn n+1, and so on.
    const root = await tempRoot()
    await writeText(path.join(root, "prompts/s/0/prompt.txt"), "What is dapat?\n")
    const build = new Build({ sendLimit: 50 })
    build.each({
      matchersByName: { prompt: new FileMatcher(path.join(root, "prompts/<sid>/<n>/prompt.txt")) },
      *tasks(vars, matched) {
        const nextTurn = Number(vars.n) + 1
        const next = new FileArtifact(path.join(root, "prompts", vars.sid, String(nextTurn), "prompt.txt"))
        yield new Task({
          id: `advance:${vars.sid}/${vars.n}`,
          inputs: [matched.prompt.data],
          outputs: [next],
          run: async () => {},
        })
      },
    })
    await expect(build.run()).rejects.toThrow("send limit")
  })
})
