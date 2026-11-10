// An agent loop as a dapat build. Each model call and each tool call is one task that writes one file.
//
//   inbox/<session>.txt                       you write the question
//   requests/<session>/<turn>/request.json    the chat request of this turn: model, tools, messages
//   replies/<session>/<turn>/reply.json       the reply of the model: text, tool calls, or both
//   calls/<session>/<turn>/<call>.json        one tool call of the reply: the tool name and the arguments
//   results/<session>/<turn>/<call>.txt       the text that the tool returned for that call
//
//   start:<session>                   question → request of turn 0
//   model:<session>/<turn>            request → reply (one call to the model through OpenRouter)
//   calls:<session>/<turn>            reply → one call file for each tool call. No tool call: no file,
//                                     so the turn gets no later task, and the loop ends.
//   tool:<session>/<turn>/<call>      call file + notes/ → result file (runs one tool, see tools.ts)
//   next:<session>/<turn>/<nextTurn>  request + reply + every result of the turn → request of the next turn
//
// The tool calls of one turn run at the same time. When a tool throws, only its own session stops,
// and the next run starts again at that call. A second run with no edit calls the model zero times.
// dapat deletes no file: after an edit to a question, the files of the old turns stay, and their
// tasks skip. To start a session again from an empty state, delete its folders.
//
// Set OPENROUTER_API_KEY, then run it from an empty folder. The first run writes a sample question
// and the notes that the tools read.
import { existsSync } from "node:fs"
import path from "node:path"
import { Build } from "dapat"
import { FileArtifact, FileGroupMatcher, FileMatcher, FileTemplate, FolderTemplate, JsonStore } from "dapat/contrib"
import { ComputedVarsMatcher } from "./computed-vars-matcher"
import { tools, type ToolDefinition } from "./tools"

const MODEL = "deepseek/deepseek-v4.1-flash"
const MAX_TURNS = 8

type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } }
type Message =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string }
type ChatRequest = { model: string; tools: ToolDefinition[]; messages: Message[] }

async function readJson<T>(file: FileArtifact): Promise<T> {
  return JSON.parse(await Bun.file(file.path).text())
}

async function callModel(request: ChatRequest): Promise<Message> {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(request),
  })
  const text = await response.text()
  if (response.status !== 200) {
    throw new Error(`OpenRouter: ${response.status}: ${text.slice(0, 500)}`)
  }
  const body = JSON.parse(text) as { choices: { message: Message }[] }
  return body.choices[0]!.message
}

if (process.env.OPENROUTER_API_KEY === undefined) {
  console.error("set OPENROUTER_API_KEY to an OpenRouter API key")
  process.exit(2)
}
if (!existsSync("inbox")) {
  await Bun.write("notes/mon.md", "Ran 5.2 km along the river.\n")
  await Bun.write("notes/wed.md", "Rest day. Stretching only.\n")
  await Bun.write("notes/thu.md", "Ran 8 km, with hills.\n")
  await Bun.write("notes/sat.md", "Long run: 14.5 km.\n")
  await Bun.write("inbox/demo.txt", "How many kilometres did I run this week? Read my training notes.\n")
}

const build = new Build({ store: new JsonStore(".dapat/state.json") })

build.each({
  name: "start",
  matchersByName: { question: new FileMatcher("inbox/<session>.txt") },
  outputsByName: { request: new FileTemplate("requests/<session>/0/request.json") },
  async run({ matched, outputs }) {
    const question = await Bun.file(matched.question.data.path).text()
    const request: ChatRequest = {
      model: MODEL,
      tools: Object.values(tools).map((tool) => tool.definition),
      messages: [{ role: "user", content: question.trim() }],
    }
    await Bun.write(outputs.request.path, JSON.stringify(request, null, 2))
  },
})

build.each({
  name: "model",
  matchersByName: { request: new FileMatcher("requests/<session>/<turn>/request.json") },
  outputsByName: { reply: new FileTemplate("replies/<session>/<turn>/reply.json") },
  async run({ matched, outputs }) {
    const request = await readJson<ChatRequest>(matched.request.data)
    const reply = await callModel(request)
    await Bun.write(outputs.reply.path, JSON.stringify(reply, null, 2))
  },
})

// The number of tool calls is known only when the reply exists, so the output is a folder, and the
// task reports each call file that it writes. Each report makes the tool task of that call.
build.each({
  name: "calls",
  matchersByName: { reply: new FileMatcher("replies/<session>/<turn>/reply.json") },
  outputsByName: { callsFolder: new FolderTemplate("calls/<session>/<turn>/") },
  async run({ vars, matched, outputs, ctx }) {
    const reply = await readJson<Message>(matched.reply.data)
    const toolCalls = (reply.role === "assistant" && reply.tool_calls) || []
    if (toolCalls.length === 0) {
      console.log(`answer for ${vars.session}: ${reply.content}`)
    }
    for (const [index, toolCall] of toolCalls.entries()) {
      const callFile = new FileArtifact(path.join(outputs.callsFolder.path, `${index}.json`))
      await Bun.write(callFile.path, JSON.stringify(toolCall, null, 2))
      ctx.produced(callFile)
    }
  },
})

// The note tools read notes/, so the list of its files is an input: an edit to a note runs the tool
// calls again, and `next` runs again only for a result that changed.
build.each({
  name: "tool",
  matchersByName: {
    call: new FileMatcher("calls/<session>/<turn>/<call>.json"),
    notes: new FileGroupMatcher("notes/*"),
  },
  required: ["call"],
  outputsByName: { result: new FileTemplate("results/<session>/<turn>/<call>.txt") },
  async run({ vars, matched, outputs }) {
    const toolCall = await readJson<ToolCall>(matched.call.data)
    const tool = tools[toolCall.function.name]
    // The model gets the text for an unknown tool as the result, so it can correct the call.
    const result =
      tool === undefined
        ? `there is no tool named ${toolCall.function.name}`
        : await tool.run(JSON.parse(toolCall.function.arguments))
    console.log(`${vars.session} turn ${vars.turn}: ${toolCall.function.name}(${toolCall.function.arguments}) = ${JSON.stringify(result)}`)
    await Bun.write(outputs.result.path, result)
  },
})

// `results` is one match with the list of every result file of the turn, so this task waits for
// every tool task of the turn.
build.each({
  name: "next",
  matchersByName: {
    request: new FileMatcher("requests/<session>/<turn>/request.json"),
    // A pattern cannot compute turn + 1, which names the folder of the next request.
    reply: new ComputedVarsMatcher(new FileMatcher("replies/<session>/<turn>/reply.json"), {
      nextTurn: (vars) => String(Number(vars.turn) + 1),
    }),
    results: new FileGroupMatcher("results/<session>/<turn>/*.txt"),
  },
  // A folder, because a declared file would get its `model` task before this task runs. With a
  // folder, the next turn starts only at the report of the request file.
  outputsByName: { nextTurnFolder: new FolderTemplate("requests/<session>/<nextTurn>/") },
  async run({ vars, matched, outputs, ctx }) {
    const request = await readJson<ChatRequest>(matched.request.data)
    const reply = await readJson<Message>(matched.reply.data)
    // After an edit to the question, the result files of the old reply can still be there, so the
    // reply decides which results go into the next request.
    const toolCalls = (reply.role === "assistant" && reply.tool_calls) || []
    if (toolCalls.length === 0) {
      return
    }
    if (Number(vars.nextTurn) >= MAX_TURNS) {
      throw new Error(`session '${vars.session}' has no answer after ${MAX_TURNS} turns`)
    }
    const nextMessages: Message[] = [...request.messages, reply]
    for (const [index, toolCall] of toolCalls.entries()) {
      const resultFile = matched.results.data.find((file) => path.basename(file.path) === `${index}.txt`)
      if (resultFile === undefined) {
        throw new Error(`turn ${vars.turn} of '${vars.session}' has no result for call ${index}`)
      }
      const content = await Bun.file(resultFile.path).text()
      nextMessages.push({ role: "tool", tool_call_id: toolCall.id, content })
    }
    const nextRequest: ChatRequest = { ...request, messages: nextMessages }
    const nextRequestFile = new FileArtifact(path.join(outputs.nextTurnFolder.path, "request.json"))
    await Bun.write(nextRequestFile.path, JSON.stringify(nextRequest, null, 2))
    ctx.produced(nextRequestFile)
  },
})

const result = await build.run()
console.log("executed:", result.executed.map((task) => task.id).sort())
console.log("skipped:", result.skipped.length)
if (!result.success) {
  for (const [task, error] of result.failed) {
    console.error(`${task.id}: ${error.message}`)
  }
  process.exit(1)
}
