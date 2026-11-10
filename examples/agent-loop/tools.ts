// The tools that the model can call. Each one is a local function of the arguments that the model
// sends, and returns the text that the model gets back. The note tools read the folder notes/.
import { readdir } from "node:fs/promises"
import path from "node:path"

// The shape of a tool definition in the OpenAI chat completions API, which OpenRouter uses.
export type ToolDefinition = {
  type: "function"
  function: { name: string; description: string; parameters: object }
}
export type Tool = { definition: ToolDefinition; run: (args: Record<string, unknown>) => Promise<string> }

function define(name: string, description: string, properties: object, run: Tool["run"]): Tool {
  const parameters = { type: "object", properties, required: Object.keys(properties) }
  return { definition: { type: "function", function: { name, description, parameters } }, run }
}

export const tools: Record<string, Tool> = {
  list_notes: define("list_notes", "The file names of the notes.", {}, async () => {
    const names = await readdir("notes")
    return names.sort().join("\n")
  }),
  read_note: define(
    "read_note",
    "The text of one note.",
    { name: { type: "string", description: "A file name from list_notes." } },
    async (args) => {
      // basename keeps the read inside notes/, whatever name the model sends
      const file = Bun.file(path.join("notes", path.basename(String(args.name))))
      if (!(await file.exists())) {
        return `there is no note named ${args.name}`
      }
      return await file.text()
    },
  ),
  add: define(
    "add",
    "The sum of a list of numbers.",
    { numbers: { type: "array", items: { type: "number" } } },
    async (args) => {
      if (!Array.isArray(args.numbers)) {
        return "numbers must be a list of numbers"
      }
      let sum = 0
      for (const value of args.numbers) {
        sum += Number(value)
      }
      return String(Math.round(sum * 1000) / 1000)
    },
  ),
}
