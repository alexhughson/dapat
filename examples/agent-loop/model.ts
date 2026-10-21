// A fake model and fake tools for the agent loop example. Both are pure functions of their input,
// so the same prompt gives the same step on every run, and a test can say which tasks run.
// Replace `fakeModel` with a call to a real model; the pipeline does not change.

export type ToolCall = { id: string; name: "search"; term: string }

/** One reply of the model: tool calls to run, or the final answer. Never both. */
export type ModelStep = { kind: "tools"; calls: ToolCall[] } | { kind: "answer"; text: string }

export type Model = (prompt: string) => ModelStep

const NOTES: Record<string, string> = {
  dapat: "dapat is a build library: a task runs again only when its inputs change.",
  stamp: "a stamp is a short text that changes when the bytes of a file change.",
  matcher: "a matcher finds artifacts, such as files, and gives a set of vars for each one.",
  task: "a task reads input artifacts and writes output artifacts.",
}

/** The search tool. It looks up one term in a fixed table of notes. */
export function search(term: string): string {
  const note = NOTES[term]
  if (note === undefined) {
    return `no note for '${term}'`
  }
  return note
}

const OBSERVATIONS_HEADING = "## Observations"
const MAX_CALLS_PER_STEP = 2

/**
 * The fake model. It asks `search` for each known term in the question that has no observation yet,
 * at most two terms in one step. When every term has an observation, it answers with the observations.
 */
export function fakeModel(prompt: string): ModelStep {
  const headingIndex = prompt.indexOf(OBSERVATIONS_HEADING)
  let question = prompt
  let observations = ""
  if (headingIndex !== -1) {
    question = prompt.slice(0, headingIndex)
    observations = prompt.slice(headingIndex + OBSERVATIONS_HEADING.length)
  }

  const words = question.toLowerCase().match(/[a-z]+/g) ?? []
  const unseenTerms: string[] = []
  for (const word of words) {
    const isKnown = NOTES[word] !== undefined
    const isSeen = observations.includes(`search ${word}:`)
    if (isKnown && !isSeen && !unseenTerms.includes(word)) {
      unseenTerms.push(word)
    }
  }

  if (unseenTerms.length === 0) {
    const text = observations.trim()
    if (text === "") {
      return { kind: "answer", text: "I have no notes for this question." }
    }
    return { kind: "answer", text }
  }

  const calls: ToolCall[] = []
  for (const term of unseenTerms.slice(0, MAX_CALLS_PER_STEP)) {
    calls.push({ id: String(calls.length + 1), name: "search", term })
  }
  return { kind: "tools", calls }
}

/** The next prompt: the question and every observation so far, under one heading. */
export function nextPrompt(prompt: string, newObservations: string): string {
  let base = prompt
  if (!prompt.includes(OBSERVATIONS_HEADING)) {
    base = `${prompt.trimEnd()}\n${OBSERVATIONS_HEADING}\n`
  }
  return `${base}${newObservations}`
}
