/** One mismatch between dapat and the oracle, or an unexpected exception. */
export type Finding = { code: string; detail: string }

/** Collects the operations, counters, notes, and findings of one case. */
export class CaseLog {
  ops = 0
  readonly counts: Record<string, number> = {}
  readonly notes: Record<string, number> = {}
  readonly findings: Finding[] = []
  readonly noteExamples: Record<string, string> = {}

  op(name: string, n = 1): void {
    this.ops += n
    this.counts[name] = (this.counts[name] ?? 0) + n
  }

  /** A thing worth counting that is not a bug: a documented limit hit, or a "needs decision" case. */
  note(name: string, example?: string): void {
    this.notes[name] = (this.notes[name] ?? 0) + 1
    if (example !== undefined && this.noteExamples[name] === undefined) this.noteExamples[name] = example.slice(0, 600)
  }

  fail(code: string, detail: string): void {
    this.findings.push({ code, detail: detail.slice(0, 2000) })
  }
}

/** JSON for messages. Line separators are escaped so that a message shows them. */
export function show(value: unknown): string {
  const text = JSON.stringify(value, (_key, v) => (v instanceof Map ? Object.fromEntries(v) : v))
  if (text === undefined) return "undefined"
  return text.replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")
}

export function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1
        continue
      }
      return true
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true
  }
  return false
}
