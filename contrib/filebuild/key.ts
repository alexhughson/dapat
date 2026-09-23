import { hasAllVars, type Vars } from "./vars"

export type Part = { kind: "lit"; value: string } | { kind: "var"; name: string } | { kind: "star" }

export type Segment =
  | { kind: "lit"; value: string }
  | { kind: "star" }
  | { kind: "rest" }
  | { kind: "mix"; parts: Part[] }

/** `/`-separated key template. Files add a filesystem root on top. */
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
    return matchSegments(this.segments, splitKey(key))
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

export function splitTemplate(template: string): string[] {
  const parts = template.split("/")
  const out: string[] = []
  for (const part of parts) {
    if (part.length > 0) out.push(part)
  }
  return out
}

export function splitKey(key: string): string[] {
  return splitTemplate(key)
}

export function parseSegment(raw: string): Segment {
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

export function collectMeta(segments: Segment[]): {
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

export function matchSegments(pat: Segment[], pathSegs: string[]): Vars | null {
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

export function matchMix(parts: Part[], value: string, vars: Vars): Vars | null {
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

export function boundPrefixSegments(segments: Segment[], vars: Vars): string[] {
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

export function renderMix(parts: Part[], vars: Vars): string {
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

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
