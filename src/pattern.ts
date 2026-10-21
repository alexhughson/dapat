// Not exported from index.ts. FileMatcher in contrib/fs/matcher.ts builds on this.

export type Vars = Record<string, string>

/**
 * The characters of a pattern that have a special meaning. `varStart` and `varEnd` enclose a var name,
 * `anyName` matches text in one segment, and `anyFolders` is a whole segment that matches any number of segments.
 * Each other character of a template is a literal. The caller checks the syntax: this file does not.
 */
export type PatternSyntax = {
  varStart: string
  varEnd: string
  anyName: string
  anyFolders: string
}

/** The default syntax: `<name>`, `*`, and `**`. */
export const DEFAULT_PATTERN_SYNTAX: PatternSyntax = {
  varStart: "<",
  varEnd: ">",
  anyName: "*",
  anyFolders: "**",
}

type Part = { kind: "lit"; value: string } | { kind: "var"; name: string } | { kind: "star" }

type Segment =
  | { kind: "lit"; value: string }
  | { kind: "star" }
  | { kind: "rest" }
  | { kind: "mix"; parts: Part[] }

/**
 * A `/`-separated template such as `content/<lang>/<slug>.md` or `notes/<topic>/*.md`.
 * `<name>` binds a var, `*` matches within one segment, and `**` matches any number of segments.
 * Keys are relative: a leading `/` is ignored, so a caller strips its root before it matches a key.
 * A `syntax` replaces these characters. Then `<`, `>`, and `*` are literals, unless the syntax uses them.
 */
export class KeyPattern {
  readonly template: string
  readonly varNames: readonly string[]
  readonly hasGlob: boolean
  /**
   * The text of each literal part, in order: the text between the vars and the globs. A caller that must
   * reject a stray `varStart` or `varEnd` checks these texts, so that one tokenizer decides the parse.
   */
  readonly literalTexts: readonly string[]
  readonly syntax: PatternSyntax
  private readonly segments: Segment[]
  private readonly keyRegex: RegExp

  constructor(template: string, syntax: PatternSyntax = DEFAULT_PATTERN_SYNTAX) {
    this.template = template
    this.syntax = syntax
    this.segments = []
    const token = tokenRegexOf(syntax)
    for (const raw of splitTemplate(template)) {
      this.segments.push(parseSegment(raw, template, syntax, token))
    }
    const meta = collectMeta(this.segments)
    this.varNames = meta.varNames
    this.hasGlob = meta.hasGlob
    this.literalTexts = literalTextsOf(this.segments)
    this.keyRegex = keyRegexOf(this.segments)
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
    let slashedKey = ""
    for (const segment of splitTemplate(key)) {
      slashedKey += `/${segment}`
    }
    const match = this.keyRegex.exec(slashedKey)
    if (match === null) return null
    const groups = match.groups ?? {}
    const entries: [string, string][] = []
    for (const name of this.varNames) {
      entries.push([name, groups[name]!])
    }
    // fromEntries makes each var an own property, also a var named __proto__.
    return Object.fromEntries(entries)
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

/**
 * The regex of one token of a segment: a var, as group 1, or `anyName`.
 * A var comes first, so a var wins when a var and `anyName` start at the same character.
 */
function tokenRegexOf(syntax: PatternSyntax): RegExp {
  const varSource = `${escapeRe(syntax.varStart)}([A-Za-z_][A-Za-z0-9_]*)${escapeRe(syntax.varEnd)}`
  const anyNameSource = escapeRe(syntax.anyName)
  return new RegExp(`${varSource}|${anyNameSource}`, "g")
}

function parseSegment(raw: string, template: string, syntax: PatternSyntax, token: RegExp): Segment {
  if (raw === syntax.anyFolders) return { kind: "rest" }
  if (raw === syntax.anyName) return { kind: "star" }
  const parts: Part[] = []
  token.lastIndex = 0
  let last = 0
  let found = false
  let match = token.exec(raw)
  while (match) {
    found = true
    if (match.index > last) {
      parts.push({ kind: "lit", value: raw.slice(last, match.index) })
    }
    if (match[1] === undefined) {
      parts.push({ kind: "star" })
    } else {
      const name = match[1]!
      const previous = parts[parts.length - 1]
      if (previous !== undefined && previous.kind === "var" && previous.name === name) {
        const varText = `${syntax.varStart}${name}${syntax.varEnd}`
        throw new Error(`pattern '${template}': the var ${varText} comes twice with nothing between`)
      }
      if (previous !== undefined && previous.kind === "var") {
        const previousText = `${syntax.varStart}${previous.name}${syntax.varEnd}`
        const varText = `${syntax.varStart}${name}${syntax.varEnd}`
        throw new Error(
          `pattern '${template}': the vars ${previousText} and ${varText} have nothing between them, so a key has no single split`,
        )
      }
      parts.push({ kind: "var", name })
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

function literalTextsOf(segments: Segment[]): string[] {
  const texts: string[] = []
  for (const segment of segments) {
    if (segment.kind === "lit") {
      texts.push(segment.value)
      continue
    }
    if (segment.kind !== "mix") continue
    for (const part of segment.parts) {
      if (part.kind === "lit") texts.push(part.value)
    }
  }
  return texts
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

/**
 * One regex for the whole key, which `match` gives with a `/` before each segment.
 * A var that comes again is a backreference, so the regex tries every split until all
 * places of the var agree. `[^/]` also matches line breaks. The `u` flag keeps a surrogate pair whole.
 */
function keyRegexOf(segments: Segment[]): RegExp {
  // For each var name, the number of segments that hold it.
  const segmentCountByVarName = new Map<string, number>()
  for (const segment of segments) {
    if (segment.kind !== "mix") continue
    const namesInSegment = new Set<string>()
    for (const part of segment.parts) {
      if (part.kind === "var") namesInSegment.add(part.name)
    }
    for (const name of namesInSegment) {
      const count = segmentCountByVarName.get(name) ?? 0
      segmentCountByVarName.set(name, count + 1)
    }
  }

  let source = "^"
  const seenVarNames = new Set<string>()
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!
    if (segment.kind === "rest") {
      // Lazy, so `**` takes as few segments as it can.
      source += "(?:/[^/]+)*?"
      continue
    }
    if (segment.kind === "lit") {
      source += `/${escapeRe(segment.value)}`
      continue
    }
    if (segment.kind === "star") {
      source += "/[^/]+"
      continue
    }
    // The parts after the last var that another segment also holds. Only those vars can make
    // a later segment fail, so no other split of these parts can fix that failure.
    let tailStart = 0
    for (let partIndex = 0; partIndex < segment.parts.length; partIndex++) {
      const part = segment.parts[partIndex]!
      if (part.kind === "var" && segmentCountByVarName.get(part.name)! > 1) tailStart = partIndex + 1
    }
    let headSource = "/"
    let tailSource = ""
    for (let partIndex = 0; partIndex < segment.parts.length; partIndex++) {
      const part = segment.parts[partIndex]!
      let partSource: string
      if (part.kind === "lit") {
        partSource = escapeRe(part.value)
      } else if (part.kind === "star") {
        partSource = "[^/]*"
      } else if (seenVarNames.has(part.name)) {
        partSource = `\\k<${part.name}>`
      } else {
        seenVarNames.add(part.name)
        partSource = `(?<${part.name}>[^/]+)`
      }
      if (partIndex < tailStart) {
        headSource += partSource
      } else {
        tailSource += partSource
      }
    }
    source += headSource
    if (tailSource === "") continue
    // A failure later in the key must not try the other splits of the tail: that costs the
    // product of the splits of all segments. A capture in a lookahead keeps the first split
    // that fills the rest of the segment, like an atomic group. A var name cannot hold `$`.
    const groupName = `$tail${index}`
    source += `(?=(?<${groupName}>${tailSource})(?:/|$))\\k<${groupName}>`
  }
  source += "$"
  return new RegExp(source, "u")
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
      if (part.kind === "var" && !Object.hasOwn(vars, part.name)) {
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
    if (!Object.hasOwn(vars, name)) return false
  }
  return true
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
