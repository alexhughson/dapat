// Not exported from index.ts yet. A file matcher will build on this.

export type Vars = Record<string, string>

type Part = { kind: "lit"; value: string } | { kind: "var"; name: string } | { kind: "star" }

type Segment =
  | { kind: "lit"; value: string }
  | { kind: "star" }
  | { kind: "rest" }
  | { kind: "mix"; parts: Part[] }

/**
 * A `/`-separated template such as `content/<lang>/<slug>.md` or `notes/<topic>/*.md`.
 * `<name>` binds a var, `*` matches within one segment, and `**` matches any number of segments.
 */
export class KeyPattern {
  readonly template: string
  readonly varNames: readonly string[]
  readonly hasGlob: boolean
  private readonly segments: Segment[]

  constructor(template: string) {
    this.template = template
    this.segments = splitTemplate(template).map(parseSegment)
    const meta = collectMeta(this.segments)
    this.varNames = meta.varNames
    this.hasGlob = meta.hasGlob
  }

  /** Literal key up to the first var or glob. Always ends with `/` when non-empty. */
  staticPrefix(): string {
    const lit: string[] = []
    for (const segment of this.segments) {
      if (segment.kind !== "lit") break
      lit.push(segment.value)
    }
    if (lit.length === 0) return ""
    return `${lit.join("/")}/`
  }

  match(key: string): Vars | null {
    return matchSegments(this.segments, splitTemplate(key))
  }

  render(vars: Vars): string {
    if (!hasAllVars(this.varNames, vars)) {
      throw new Error(`pattern '${this.template}' missing vars to render`)
    }
    const out: string[] = []
    for (const segment of this.segments) {
      if (segment.kind === "lit") {
        out.push(segment.value)
        continue
      }
      if (segment.kind === "star" || segment.kind === "rest") {
        throw new Error(`pattern '${this.template}' cannot render a glob`)
      }
      out.push(renderMix(segment.parts, vars))
    }
    return out.join("/")
  }

  /** Literal key up to the first glob or unbound name. Always ends with `/` when non-empty. */
  boundPrefix(vars: Vars): string {
    const lit = boundPrefixSegments(this.segments, vars)
    if (lit.length === 0) return ""
    return `${lit.join("/")}/`
  }
}

function splitTemplate(template: string): string[] {
  const parts = template.split("/")
  const out: string[] = []
  for (const part of parts) {
    if (part.length > 0) out.push(part)
  }
  return out
}

function parseSegment(raw: string): Segment {
  if (raw === "**") return { kind: "rest" }
  if (raw === "*") return { kind: "star" }
  const parts: Part[] = []
  const token = /<([A-Za-z_][A-Za-z0-9_]*)>|\*/g
  let last = 0
  let found = false
  let match = token.exec(raw)
  while (match) {
    found = true
    if (match.index > last) {
      parts.push({ kind: "lit", value: raw.slice(last, match.index) })
    }
    if (match[0] === "*") {
      parts.push({ kind: "star" })
    } else {
      parts.push({ kind: "var", name: match[1]! })
    }
    last = match.index + match[0].length
    match = token.exec(raw)
  }
  if (!found) return { kind: "lit", value: raw }
  if (last < raw.length) {
    parts.push({ kind: "lit", value: raw.slice(last) })
  }
  return { kind: "mix", parts }
}

function collectMeta(segments: Segment[]): {
  varNames: string[]
  hasGlob: boolean
} {
  const names: string[] = []
  let glob = false
  for (const segment of segments) {
    if (segment.kind === "star" || segment.kind === "rest") glob = true
    if (segment.kind === "mix") {
      for (const part of segment.parts) {
        if (part.kind === "var" && !names.includes(part.name)) {
          names.push(part.name)
        }
        if (part.kind === "star") glob = true
      }
    }
  }
  return { varNames: names, hasGlob: glob }
}

function matchSegments(pat: Segment[], pathSegs: string[]): Vars | null {
  return walk(0, 0, {})

  function walk(pi: number, sj: number, vars: Vars): Vars | null {
    if (pi === pat.length && sj === pathSegs.length) return vars
    if (pi === pat.length) return null
    const segment = pat[pi]
    if (segment.kind === "rest") {
      for (let n = 0; n <= pathSegs.length - sj; n++) {
        const got = walk(pi + 1, sj + n, vars)
        if (got) return got
      }
      return null
    }
    if (sj >= pathSegs.length) return null
    if (segment.kind === "lit") {
      if (pathSegs[sj] !== segment.value) return null
      return walk(pi + 1, sj + 1, vars)
    }
    if (segment.kind === "star") {
      return walk(pi + 1, sj + 1, vars)
    }
    const next = matchMix(segment.parts, pathSegs[sj]!, vars)
    if (!next) return null
    return walk(pi + 1, sj + 1, next)
  }
}

function matchMix(parts: Part[], value: string, vars: Vars): Vars | null {
  let source = "^"
  const names: string[] = []
  for (const part of parts) {
    if (part.kind === "lit") {
      source += escapeRe(part.value)
    } else if (part.kind === "star") {
      source += ".*"
    } else {
      source += "(.+)"
      names.push(part.name)
    }
  }
  source += "$"
  const match = new RegExp(source).exec(value)
  if (!match) return null
  const out: Vars = {}
  for (const key of Object.keys(vars)) {
    out[key] = vars[key]!
  }
  for (let i = 0; i < names.length; i++) {
    const name = names[i]!
    const captured = match[i + 1]!
    if (out[name] !== undefined && out[name] !== captured) return null
    out[name] = captured
  }
  return out
}

function boundPrefixSegments(segments: Segment[], vars: Vars): string[] {
  const lit: string[] = []
  for (const segment of segments) {
    if (segment.kind === "lit") {
      lit.push(segment.value)
      continue
    }
    if (segment.kind === "star" || segment.kind === "rest") break
    let stop = false
    for (const part of segment.parts) {
      if (part.kind === "star") {
        stop = true
        break
      }
      if (part.kind === "var" && vars[part.name] === undefined) {
        stop = true
        break
      }
    }
    if (stop) break
    lit.push(renderMix(segment.parts, vars))
  }
  return lit
}

function renderMix(parts: Part[], vars: Vars): string {
  let out = ""
  for (const part of parts) {
    if (part.kind === "lit") {
      out += part.value
    } else if (part.kind === "var") {
      out += vars[part.name]
    } else {
      throw new Error("cannot render a glob segment")
    }
  }
  return out
}

function hasAllVars(names: readonly string[], vars: Vars): boolean {
  for (const name of names) {
    if (vars[name] === undefined) return false
  }
  return true
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
