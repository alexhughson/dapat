// An agent loop with tool calls, as a dapat build. Each turn is a file.
//
//   inbox/<session>.txt                         you write the question
//   messages/<session>/<turn>/messages.json     the conversation that the model gets on this turn
//   replies/<session>/<turn>/reply.json         the reply of the model: text, tool calls, or both
//
//   start:<session>                    question → messages of turn 0
//   model:<session>/<turn>             messages → reply (the model call)
//   tools:<session>/<turn>/<nextTurn>  runs each tool call of the reply, and writes the messages of
//                                      the next turn with the results. No tool call: the loop ends.
//
// The number of turns is known only at run time. Each new messages file makes the next model task.
// Run it twice from an empty folder: the second run calls the model zero times. Edit inbox/demo.txt and
// the session runs again.
import { existsSync } from "node:fs"
import path from "node:path"
import { Build } from "dapat"
import { FileArtifact, FileMatcher, FileTemplate, FolderTemplate, JsonStore } from "dapat/contrib"
import { ComputedVarsMatcher } from "./computed-vars-matcher"

// The message shapes of a chat API with tool use, such as the Claude Messages API.
type TextBlock = { type: "text"; text: string }
type ToolUse = { type: "tool_use"; id: string; name: string; input: Record<string, string> }
type ToolResult = { type: "tool_result"; tool_use_id: string; content: string }
type Message = { role: "user"; content: (TextBlock | ToolResult)[] } | { role: "assistant"; content: (TextBlock | ToolUse)[] }

const tools: Record<string, { description: string; run: (input: Record<string, string>) => string }> = {
  get_weather: {
    description: "The temperature in a city, in degrees Celsius. Input: { city }",
    run: (input) => (input.city === "Paris" ? "20" : "15"),
  },
  celsius_to_fahrenheit: {
    description: "Converts degrees Celsius to degrees Fahrenheit. Input: { celsius }",
    run: (input) => String((Number(input.celsius) * 9) / 5 + 32),
  },
}

// A fake model, so the example runs with no API key. It asks for the weather, then for the
// conversion, then answers. To use a real model, send `messages` and `toolList` to its API.
// The model is not a task input, so a new model reruns nothing; put its name in the messages to change that.
async function callModel(messages: Message[], _toolList: { name: string; description: string }[]): Promise<Message> {
  const question = messages[0]!.content[0] as TextBlock
  const results: string[] = []
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "tool_result") results.push(block.content)
    }
  }
  if (results.length === 0) {
    const cityMatch = /in ([A-Z][a-z]+)/.exec(question.text)
    const city = cityMatch === null ? "Paris" : cityMatch[1]!
    return { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: { city } }] }
  }
  if (results.length === 1) {
    const input = { celsius: results[0]! }
    return { role: "assistant", content: [{ type: "tool_use", id: "call_2", name: "celsius_to_fahrenheit", input }] }
  }
  return { role: "assistant", content: [{ type: "text", text: `It is ${results[1]} °F.` }] }
}

if (!existsSync("inbox")) {
  await Bun.write("inbox/demo.txt", "What is the temperature in Paris, in Fahrenheit?\n")
}

const build = new Build({ store: new JsonStore(".dapat/state.json") })

build.each({
  name: "start",
  matchersByName: { question: new FileMatcher("inbox/<session>.txt") },
  outputsByName: { messages: new FileTemplate("messages/<session>/0/messages.json") },
  async run({ matched, outputs }) {
    const question = await Bun.file(matched.question.data.path).text()
    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: question.trim() }] }]
    await Bun.write(outputs.messages.path, JSON.stringify(messages, null, 2))
  },
})

build.each({
  name: "model",
  matchersByName: { messages: new FileMatcher("messages/<session>/<turn>/messages.json") },
  outputsByName: { reply: new FileTemplate("replies/<session>/<turn>/reply.json") },
  async run({ matched, outputs }) {
    const messages: Message[] = JSON.parse(await Bun.file(matched.messages.data.path).text())
    const toolList: { name: string; description: string }[] = []
    for (const [name, tool] of Object.entries(tools)) {
      toolList.push({ name, description: tool.description })
    }
    const reply = await callModel(messages, toolList)
    await Bun.write(outputs.reply.path, JSON.stringify(reply, null, 2))
  },
})

// No tool call means the loop ends, so the next turn may not exist. That is why the output is a folder:
// a declared file would start a new turn on every build, until build.run() rejects with "send limit".
// This task is the only writer of that folder. A folder with two writers makes tasks rerun.
build.each({
  name: "tools",
  matchersByName: {
    messages: new FileMatcher("messages/<session>/<turn>/messages.json"),
    // nextTurn = turn + 1 names the folder of the next messages. A pattern cannot compute it.
    reply: new ComputedVarsMatcher(new FileMatcher("replies/<session>/<turn>/reply.json"), {
      nextTurn: (vars) => String(Number(vars.turn) + 1),
    }),
  },
  outputsByName: { nextTurnFolder: new FolderTemplate("messages/<session>/<nextTurn>/") },
  async run({ matched, outputs, ctx }) {
    const messages: Message[] = JSON.parse(await Bun.file(matched.messages.data.path).text())
    const reply: Message = JSON.parse(await Bun.file(matched.reply.data.path).text())
    const results: ToolResult[] = []
    for (const block of reply.content) {
      if (block.type !== "tool_use") continue
      const tool = tools[block.name]
      if (tool === undefined) throw new Error(`the model called an unknown tool '${block.name}'`)
      results.push({ type: "tool_result", tool_use_id: block.id, content: tool.run(block.input) })
    }
    if (results.length === 0) {
      const texts: string[] = []
      for (const block of reply.content) {
        if (block.type === "text") texts.push(block.text)
      }
      console.log(`answer for ${matched.messages.vars.session}: ${texts.join(" ")}`)
      return
    }
    const nextMessages: Message[] = [...messages, reply, { role: "user", content: results }]
    const nextMessagesFile = new FileArtifact(path.join(outputs.nextTurnFolder.path, "messages.json"))
    await Bun.write(nextMessagesFile.path, JSON.stringify(nextMessages, null, 2))
    ctx.produced(nextMessagesFile)
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
