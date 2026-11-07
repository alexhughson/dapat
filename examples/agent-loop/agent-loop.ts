// An agent loop with tool calls, as a dapat build. Each turn is a file.
//
//   inbox/<session>.txt                       you write the question
//   requests/<session>/<turn>/request.json    the chat request of this turn: model, tools, messages
//   replies/<session>/<turn>/reply.json       the reply of the model: text, tool calls, or both
//
//   start:<session>                    question → request of turn 0
//   model:<session>/<turn>             request → reply (one call to the model through OpenRouter)
//   tools:<session>/<turn>/<nextTurn>  runs each tool call of the reply, and writes the request of the
//                                      next turn with the results. No tool call: the loop ends.
//
// The number of turns is known only at run time. Each new request file makes the next model task.
// The model and the tools are in each request file, so a change to either runs the session again.
//
// Set OPENROUTER_API_KEY, then run it from an empty folder. The second run calls the model zero times.
import { existsSync } from "node:fs"
import path from "node:path"
import { Build } from "dapat"
import { FileArtifact, FileMatcher, FileTemplate, FolderTemplate, JsonStore } from "dapat/contrib"
import { ComputedVarsMatcher } from "./computed-vars-matcher"

const MODEL = "deepseek/deepseek-v4.1-flash"

// The shapes of the OpenAI chat completions API with tools, which OpenRouter uses for each model.
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } }
type Message =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string }
type ToolDefinition = { type: "function"; function: { name: string; description: string; parameters: object } }
type ChatRequest = { model: string; tools: ToolDefinition[]; messages: Message[] }

// The tools that the model can call. Each one is a local function of the arguments that the model sends.
const temperatures: Record<string, number> = { paris: 21, london: 15, tokyo: 26 }
const tools: Record<string, { definition: ToolDefinition; run: (args: Record<string, unknown>) => string }> = {
  get_temperature: {
    definition: {
      type: "function",
      function: {
        name: "get_temperature",
        description: "The temperature in a city now, in degrees Celsius.",
        parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      },
    },
    run: (args) => {
      const city = String(args.city)
      const celsius = temperatures[city.toLowerCase()]
      if (celsius === undefined) return `no data for ${city}`
      return String(celsius)
    },
  },
  celsius_to_fahrenheit: {
    definition: {
      type: "function",
      function: {
        name: "celsius_to_fahrenheit",
        description: "Converts degrees Celsius to degrees Fahrenheit.",
        parameters: { type: "object", properties: { celsius: { type: "number" } }, required: ["celsius"] },
      },
    },
    run: (args) => String((Number(args.celsius) * 9) / 5 + 32),
  },
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
  await Bun.write("inbox/demo.txt", "Is it warmer in Paris or in Tokyo now? Give both in Fahrenheit.\n")
}

const build = new Build({ store: new JsonStore(".dapat/state.json") })

build.each({
  name: "start",
  matchersByName: { question: new FileMatcher("inbox/<session>.txt") },
  outputsByName: { request: new FileTemplate("requests/<session>/0/request.json") },
  async run({ matched, outputs }) {
    const question = await Bun.file(matched.question.data.path).text()
    const toolDefinitions: ToolDefinition[] = []
    for (const tool of Object.values(tools)) {
      toolDefinitions.push(tool.definition)
    }
    const request: ChatRequest = {
      model: MODEL,
      tools: toolDefinitions,
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
    const request: ChatRequest = JSON.parse(await Bun.file(matched.request.data.path).text())
    const reply = await callModel(request)
    await Bun.write(outputs.reply.path, JSON.stringify(reply, null, 2))
  },
})

// No tool call means the loop ends, so the next turn may not exist. That is why the output is a folder:
// a declared file would start a new turn on every build, until build.run() rejects with "send limit".
// This task is the only writer of that folder. A folder with two writers makes tasks rerun.
build.each({
  name: "tools",
  matchersByName: {
    request: new FileMatcher("requests/<session>/<turn>/request.json"),
    // nextTurn = turn + 1 names the folder of the next request. A pattern cannot compute it.
    reply: new ComputedVarsMatcher(new FileMatcher("replies/<session>/<turn>/reply.json"), {
      nextTurn: (vars) => String(Number(vars.turn) + 1),
    }),
  },
  outputsByName: { nextTurnFolder: new FolderTemplate("requests/<session>/<nextTurn>/") },
  async run({ matched, outputs, ctx }) {
    const request: ChatRequest = JSON.parse(await Bun.file(matched.request.data.path).text())
    const reply: Message = JSON.parse(await Bun.file(matched.reply.data.path).text())
    if (reply.role !== "assistant") {
      throw new Error(`the reply has the role '${reply.role}', not 'assistant'`)
    }
    if (reply.tool_calls === undefined || reply.tool_calls.length === 0) {
      console.log(`answer for ${matched.request.vars.session}: ${reply.content}`)
      return
    }
    const nextMessages: Message[] = [...request.messages, reply]
    for (const call of reply.tool_calls) {
      const tool = tools[call.function.name]
      if (tool === undefined) {
        throw new Error(`the model called an unknown tool '${call.function.name}'`)
      }
      const result = tool.run(JSON.parse(call.function.arguments))
      console.log(`${matched.request.vars.session} turn ${matched.request.vars.turn}: ${call.function.name}(${call.function.arguments}) = ${result}`)
      nextMessages.push({ role: "tool", tool_call_id: call.id, content: result })
    }
    const nextRequest: ChatRequest = { ...request, messages: nextMessages }
    const nextRequestFile = new FileArtifact(path.join(outputs.nextTurnFolder.path, "request.json"))
    await Bun.write(nextRequestFile.path, JSON.stringify(nextRequest, null, 2))
    ctx.produced(nextRequestFile)
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
