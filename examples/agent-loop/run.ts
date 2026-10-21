// Runs the agent loop in a folder: bun run examples/agent-loop/run.ts <folder>
// The folder needs inbox/<sid>.txt files. Copy examples/agent-loop/sample/ to start.
// The build state goes in <folder>/.dapat/state.json, so a second run with no edits runs nothing.
import path from "node:path"
import { Build } from "dapat"
import { JsonStore } from "dapat/contrib"
import * as model from "./model"
import * as pipeline from "./pipeline"

const folderArgument = process.argv[2]
if (folderArgument === undefined) {
  console.error("usage: bun run examples/agent-loop/run.ts <folder>")
  process.exit(2)
}
const root = path.resolve(folderArgument)

const store = new JsonStore(path.join(root, ".dapat/state.json"))
const build = new Build({ store })
pipeline.addAgentLoop(build, root, model.fakeModel)
const result = await build.run()

const executedIds: string[] = []
for (const task of result.executed) {
  executedIds.push(task.id)
}
executedIds.sort()
const skippedIds: string[] = []
for (const task of result.skipped) {
  skippedIds.push(task.id)
}
skippedIds.sort()
console.log("executed:", executedIds)
console.log("skipped:", skippedIds)

if (!result.success) {
  for (const [task, error] of result.failed) {
    console.error(`${task.id}: ${error.message}`)
  }
  for (const error of result.errors) {
    console.error(error.message)
  }
  process.exit(1)
}
