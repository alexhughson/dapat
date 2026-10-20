/**
 * The independent oracle. Nothing here imports the matcher, join, or pattern code of dapat.
 * It is written from DOCS.md section 10 and the doc comment of src/pattern.ts.
 */
import { createHash } from "node:crypto"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

export type OVars = Record<string, string>

/** A vars object with no prototype, so that a var named "__proto__" is a plain key here. */
export function newVars(): OVars {
  return Object.create(null) as OVars
}

/** A copy of vars with no prototype. */
export function copyVars(vars: OVars): OVars {
  const out = newVars()
  for (const name of Object.keys(vars)) out[name] = vars[name]!
  return out
}

// ---------------------------------------------------------------- patterns

type OPart = { kind: "lit"; text: string } | { kind: "var"; name: string } | { kind: "star" }
type OSegment = { kind: "rest" } | { kind: "star" } | { kind: "parts"; parts: OPart[] }

const VAR_NAME_START = /[A-Za-z_]/
const VAR_NAME_CHAR = /[A-Za-z0-9_]/

/** Splits on "/" and drops empty pieces, so a leading "/" is ignored. */
export function splitKey(key: string): string[] {
  const pieces = key.split("/")
  const kept: string[] = []
  for (const piece of pieces) {
    if (piece !== "") kept.push(piece)
  }
  return kept
}

/** Parses one segment by hand: `<name>` is a var, `*` is a star, everything else is literal. */
function parseOracleSegment(raw: string): OSegment {
  if (raw === "**") return { kind: "rest" }
  if (raw === "*") return { kind: "star" }
  const parts: OPart[] = []
  let literal = ""
  let i = 0
  while (i < raw.length) {
    const ch = raw[i]!
    if (ch === "*") {
      if (literal !== "") parts.push({ kind: "lit", text: literal })
      literal = ""
      parts.push({ kind: "star" })
      i += 1
      continue
    }
    if (ch === "<") {
      let j = i + 1
      let validName = j < raw.length && VAR_NAME_START.test(raw[j]!)
      if (validName) {
        j += 1
        while (j < raw.length && VAR_NAME_CHAR.test(raw[j]!)) j += 1
        validName = j < raw.length && raw[j] === ">"
      }
      if (validName) {
        if (literal !== "") parts.push({ kind: "lit", text: literal })
        literal = ""
        parts.push({ kind: "var", name: raw.slice(i + 1, j) })
        i = j + 1
        continue
      }
    }
    literal += ch
    i += 1
  }
  if (literal !== "") parts.push({ kind: "lit", text: literal })
  return { kind: "parts", parts }
}

export function oracleVarNames(template: string): string[] {
  const names: string[] = []
  for (const raw of splitKey(template)) {
    const segment = parseOracleSegment(raw)
    if (segment.kind !== "parts") continue
    for (const part of segment.parts) {
      if (part.kind === "var" && !names.includes(part.name)) names.push(part.name)
    }
  }
  return names
}

/**
 * Distinct bindings of the template vars that make the template match the key, at most `cap`.
 * A var matches one or more characters inside one segment. A `*` part matches zero or more
 * characters inside one segment. A `*` segment matches one segment. `**` matches zero or more segments.
 * A var that appears twice must bind the same text.
 * Returns null when the search gave up (too many ways to try); the caller then skips the key.
 */
export function oracleAllBindings(template: string, key: string, cap = 2, given?: OVars): OVars[] | null {
  const segments = splitKey(template).map(parseOracleSegment)
  const keySegs = splitKey(key)
  const seen = new Set<string>()
  const results: OVars[] = []
  let budget = 200_000
  let gaveUp = false

  function record(vars: OVars): void {
    const sortedNames = Object.keys(vars).sort()
    const canonical = JSON.stringify(sortedNames.map((name) => [name, vars[name]]))
    if (seen.has(canonical)) return
    seen.add(canonical)
    results.push(copyVars(vars))
  }

  function spend(): boolean {
    budget -= 1
    if (budget < 0) gaveUp = true
    return !gaveUp && results.length < cap
  }

  // States that gave no binding. A state is the place in the template and key, and the vars bound so far.
  const dead = new Set<string>()

  function stateKey(si: number, ki: number, pi: number, pos: number, vars: OVars): string {
    return `${si}|${ki}|${pi}|${pos}|${JSON.stringify(Object.entries(vars).sort())}`
  }

  function walkSegments(si: number, ki: number, vars: OVars): void {
    if (!spend()) return
    if (si === segments.length) {
      if (ki === keySegs.length) record(vars)
      return
    }
    const state = stateKey(si, ki, -1, -1, vars)
    if (dead.has(state)) return
    const before = results.length
    walkSegmentsInner(si, ki, vars)
    if (results.length === before && !gaveUp) dead.add(state)
  }

  function walkSegmentsInner(si: number, ki: number, vars: OVars): void {
    const segment = segments[si]!
    if (segment.kind === "rest") {
      for (let take = 0; take <= keySegs.length - ki; take++) {
        walkSegments(si + 1, ki + take, vars)
      }
      return
    }
    if (segment.kind === "star") {
      // Self-test plant: a wrong rule where "*" may also match no segment.
      if (process.env.FUZZ_PLANT === "pattern") walkSegments(si + 1, ki, vars)
      if (ki >= keySegs.length) return
      walkSegments(si + 1, ki + 1, vars)
      return
    }
    if (ki >= keySegs.length) return
    walkParts(si, ki, segment.parts, 0, 0, vars)
  }

  /** Matches the parts of segment `si` against key segment `ki`, from part `pi` at `pos`. */
  function walkParts(si: number, ki: number, parts: OPart[], pi: number, pos: number, vars: OVars): void {
    if (!spend()) return
    const text = keySegs[ki]!
    if (pi === parts.length) {
      if (pos === text.length) walkSegments(si + 1, ki + 1, vars)
      return
    }
    const state = stateKey(si, ki, pi, pos, vars)
    if (dead.has(state)) return
    const before = results.length
    const part = parts[pi]!
    if (part.kind === "lit") {
      if (text.startsWith(part.text, pos)) walkParts(si, ki, parts, pi + 1, pos + part.text.length, vars)
    } else if (part.kind === "star") {
      for (let end = pos; end <= text.length; end++) walkParts(si, ki, parts, pi + 1, end, vars)
    } else {
      const bound = vars[part.name]
      if (bound !== undefined) {
        if (bound.length > 0 && text.startsWith(bound, pos)) walkParts(si, ki, parts, pi + 1, pos + bound.length, vars)
      } else {
        for (let end = pos + 1; end <= text.length; end++) {
          const next = copyVars(vars)
          next[part.name] = text.slice(pos, end)
          walkParts(si, ki, parts, pi + 1, end, next)
        }
      }
    }
    if (results.length === before && !gaveUp) dead.add(state)
  }

  walkSegments(0, 0, given === undefined ? newVars() : copyVars(given))
  if (gaveUp && results.length === 0) return null
  return results
}

/** True when the template matches the key with exactly these values for its vars. */
export function oracleAccepts(template: string, key: string, vars: OVars): boolean | null {
  const names = oracleVarNames(template)
  const given = Object.keys(vars)
  if (given.length !== names.length) return false
  for (const name of names) if (!Object.hasOwn(vars, name)) return false
  for (const name of names) if (vars[name] === "") return false
  const found = oracleAllBindings(template, key, 1, vars)
  if (found === null) return null
  return found.length > 0
}

/** Renders a template with no glob. Returns null if a var value is missing. */
export function oracleRender(template: string, vars: OVars): string | null {
  const out: string[] = []
  for (const raw of splitKey(template)) {
    const segment = parseOracleSegment(raw)
    if (segment.kind !== "parts") return null
    let text = ""
    for (const part of segment.parts) {
      if (part.kind === "lit") text += part.text
      else if (part.kind === "var") {
        const value = vars[part.name]
        if (value === undefined) return null
        text += value
      } else return null
    }
    out.push(text)
  }
  return out.join("/")
}

// ---------------------------------------------------------------- joins

export type OMatcherSpec = { name: string; varNames: readonly string[] }
export type OMatch = { vars: OVars; dataIds: string[] }
export type OJoinedSet = { vars: OVars; membersByName: Map<string, OMatch>; key: string }

/** The union var names: matcher name order, then varNames order, each name one time. */
export function unionVarNames(specs: readonly OMatcherSpec[]): string[] {
  const names: string[] = []
  for (const spec of specs) {
    for (const name of spec.varNames) {
      if (!names.includes(name)) names.push(name)
    }
  }
  return names
}

/** True when the matchers form one connected group by shared var names (BFS). */
export function oracleConnected(specs: readonly OMatcherSpec[]): boolean {
  if (specs.length <= 1) return true
  const reached = new Set<number>([0])
  const queue = [0]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (let other = 0; other < specs.length; other++) {
      if (reached.has(other)) continue
      const shares = specs[current]!.varNames.some((name) => specs[other]!.varNames.includes(name))
      if (shares) {
        reached.add(other)
        queue.push(other)
      }
    }
  }
  return reached.size === specs.length
}

/**
 * Brute force: every combination of one match per matcher, kept when every pair of
 * chosen matches agrees on each var name they share. No index.
 */
export function oracleJoin(specs: readonly OMatcherSpec[], matchesByName: Map<string, OMatch[]>): OJoinedSet[] {
  const union = unionVarNames(specs)
  const out: OJoinedSet[] = []
  const chosen: OMatch[] = []

  function agrees(candidate: OMatch): boolean {
    for (const earlier of chosen) {
      for (const name of Object.keys(candidate.vars)) {
        if (Object.hasOwn(earlier.vars, name) && earlier.vars[name] !== candidate.vars[name]) return false
      }
    }
    return true
  }

  function pickFrom(index: number): void {
    if (index === specs.length) {
      const vars: OVars = newVars()
      for (const name of union) {
        for (const match of chosen) {
          if (Object.hasOwn(match.vars, name)) {
            vars[name] = match.vars[name]!
            break
          }
        }
      }
      const membersByName = new Map<string, OMatch>()
      for (let i = 0; i < specs.length; i++) membersByName.set(specs[i]!.name, chosen[i]!)
      out.push({ vars, membersByName, key: setKeyOf(union, vars) })
      return
    }
    const spec = specs[index]!
    for (const candidate of matchesByName.get(spec.name) ?? []) {
      if (!agrees(candidate)) continue
      chosen.push(candidate)
      pickFrom(index + 1)
      chosen.pop()
    }
  }

  pickFrom(0)
  return out
}

/** A key for a joined set: its var values in union order. */
export function setKeyOf(union: readonly string[], vars: OVars): string {
  const values: string[] = []
  for (const name of union) values.push(vars[name]!)
  return JSON.stringify(values)
}

export function oracleLabel(eachNumber: number, union: readonly string[], vars: OVars): string {
  const parts = [`build.each ${eachNumber}`]
  for (const name of union) parts.push(`${name}=${vars[name]}`)
  return parts.join(" ")
}

// ---------------------------------------------------------------- files

/** The relative paths of every regular file under `root`, with "/" separators. Missing root: []. */
export function oracleListFiles(root: string): string[] {
  const out: string[] = []
  function visit(dir: string, rel: string): void {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return
      throw error
    }
    for (const entry of entries) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) visit(path.join(dir, entry.name), childRel)
      else if (entry.isFile()) out.push(childRel)
    }
  }
  visit(root, "")
  out.sort()
  return out
}

/** My own file stamp: "time" = mtime ns and size; "hash" = SHA-256 of the bytes. null if missing. */
export function oracleStamp(filePath: string, mode: "time" | "hash"): string | null {
  let info
  try {
    info = statSync(filePath, { bigint: true })
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null
    throw error
  }
  if (mode === "time") return `${info.mtimeNs}:${info.size}`
  return createHash("sha256").update(readFileSync(filePath)).digest("hex")
}

export function readTextOrNull(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8")
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null
    throw error
  }
}

export function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16)
}
