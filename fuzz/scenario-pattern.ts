/** KeyPattern (src/pattern.ts) against the oracle matcher in oracle.ts. Pure strings, no files. */
import { KeyPattern } from "../src/pattern"
import { valueOfKind, VALUE_KINDS } from "./names"
import { oracleAccepts, oracleAllBindings, oracleVarNames, splitKey } from "./oracle"
import type { Rng } from "./rng"
import { CaseLog, hasLoneSurrogate, show } from "./types"

const VAR_NAMES = ["a", "b", "c", "lang", "slug"]
// Names that are also members of Object.prototype. Used in a few templates only.
const PROTO_NAMES = ["constructor", "__proto__", "toString"]
const LITERALS = ["content", "x", "md", ".md", ".txt", "-", "_", "v", "a.b", " ", "%", "#", "<1>", "<>", "pages"]

type GenPart = { kind: "lit"; text: string } | { kind: "var"; name: string } | { kind: "star" }
type GenSegment = { kind: "lit"; text: string } | { kind: "star" } | { kind: "rest" } | { kind: "mix"; parts: GenPart[] }

function genTemplate(rng: Rng): { template: string; segments: GenSegment[] } {
  const deep = rng.chance(0.05)
  const count = deep ? rng.range(10, 40) : rng.range(1, 5)
  const segments: GenSegment[] = []
  for (let i = 0; i < count; i++) {
    const roll = rng.next()
    if (roll < 0.3) segments.push({ kind: "lit", text: rng.pick(LITERALS) })
    else if (roll < 0.38) segments.push({ kind: "star" })
    else if (roll < 0.45) segments.push({ kind: "rest" })
    else {
      const parts: GenPart[] = []
      const partCount = rng.range(1, 4)
      for (let p = 0; p < partCount; p++) {
        const r = rng.next()
        if (r < 0.35) parts.push({ kind: "lit", text: rng.pick(LITERALS.filter((l) => l !== "<1>" && l !== "<>" || rng.chance(0.5))) })
        else if (r < 0.9) parts.push({ kind: "var", name: rng.chance(0.01) ? rng.pick(PROTO_NAMES) : rng.pick(VAR_NAMES) })
        else parts.push({ kind: "star" })
      }
      segments.push({ kind: "mix", parts })
    }
  }
  const texts: string[] = []
  for (const segment of segments) {
    if (segment.kind === "lit") texts.push(segment.text)
    else if (segment.kind === "star") texts.push("*")
    else if (segment.kind === "rest") texts.push("**")
    else {
      let text = ""
      for (const part of segment.parts) {
        if (part.kind === "lit") text += part.text
        else if (part.kind === "var") text += `<${part.name}>`
        else text += "*"
      }
      texts.push(text)
    }
  }
  // Merge "**" written as a part of a mix: a mix of only stars renders as "*" or "**"; keep it, both parsers see the same text.
  const lead = rng.chance(0.2) ? "/" : ""
  return { template: lead + texts.join("/"), segments }
}

function genValue(rng: Rng): string {
  const roll = rng.next()
  if (roll < 0.05) return rng.pick(["x\ny", "a\rb", "a\u2028b", "\n"])
  if (roll < 0.5) {
    let kind = rng.pick(VALUE_KINDS)
    // Long values make the oracle search slow; keep them rare.
    if (kind === "long" && rng.chance(0.9)) kind = "plain"
    return valueOfKind(rng, kind)
  }
  return rng.pick(["a", "b", "en", "x", "a-b", "v1", "1"])
}

function genKey(rng: Rng, segments: GenSegment[]): string {
  const bound = new Map<string, string>()
  const out: string[] = []
  for (const segment of segments) {
    if (segment.kind === "lit") out.push(segment.text)
    else if (segment.kind === "star") out.push(genValue(rng))
    else if (segment.kind === "rest") {
      const n = rng.range(0, 3)
      for (let i = 0; i < n; i++) out.push(genValue(rng))
    } else {
      let text = ""
      for (const part of segment.parts) {
        if (part.kind === "lit") text += part.text
        else if (part.kind === "star") text += rng.chance(0.3) ? "" : genValue(rng)
        else {
          let value = bound.get(part.name)
          if (value === undefined || rng.chance(0.1)) {
            value = genValue(rng)
            bound.set(part.name, value)
          }
          text += value
        }
      }
      out.push(text)
    }
  }
  // Mutations, so that many keys do not match.
  const roll = rng.next()
  if (roll < 0.1 && out.length > 0) out.splice(rng.int(out.length), 1)
  else if (roll < 0.2) out.splice(rng.int(out.length + 1), 0, genValue(rng))
  else if (roll < 0.3 && out.length > 0) {
    const i = rng.int(out.length)
    out[i] = out[i] + rng.pick(["x", ".", "-", "́"])
  }
  return (rng.chance(0.2) ? "/" : "") + out.join("/")
}

/** True when one segment of the template has the same var name two times. */
function repeatsVarInSegment(template: string): boolean {
  for (const raw of splitKey(template)) {
    const names = [...raw.matchAll(/<([A-Za-z_][A-Za-z0-9_]*)>/g)].map((m) => m[1])
    if (new Set(names).size !== names.length) return true
  }
  return false
}

/** True when the template has some var name two times, in one segment or in two. */
function repeatsVarAnywhere(template: string): boolean {
  const names = [...template.matchAll(/<([A-Za-z_][A-Za-z0-9_]*)>/g)].map((m) => m[1])
  return new Set(names).size !== names.length
}

const LINE_BREAK = /[\n\r\u2028\u2029]/

export function runPatternCase(rng: Rng, log: CaseLog, keysPerTemplate: number): void {
  const { template, segments } = genTemplate(rng)
  const pattern = new KeyPattern(template)
  log.op("pattern.template")
  const libNames = [...pattern.varNames]
  const oracleNames = oracleVarNames(template)
  if (show(libNames) !== show(oracleNames)) {
    log.fail("pattern.varNames", `template ${show(template)}: lib ${show(libNames)} oracle ${show(oracleNames)}`)
  }
  for (let k = 0; k < keysPerTemplate; k++) {
    const key = genKey(rng, segments)
    log.op("pattern.match")
    const lib = pattern.match(key)
    const oracle = oracleAllBindings(template, key)
    const where = `template ${show(template)} key ${show(key)}`
    if (oracle === null) {
      log.note("oracle gave up (too many splits)", where)
      continue
    }
    if (oracle.length > 1) log.note("needs-decision: pattern ambiguous binding", `${where}: oracle bindings ${show(oracle)}, lib ${show(lib)}`)
    if (oracle.length === 0) {
      if (lib !== null) log.fail("pattern.falseMatch", `${where}: lib ${show(lib)}, oracle none`)
      continue
    }
    if (lib === null) {
      let code = "pattern.missedMatch"
      if (LINE_BREAK.test(key)) code = "pattern.lineBreakNotMatched"
      else if (PROTO_NAMES.some((name) => template.includes(`<${name}>`))) code = "pattern.objectPrototypeVarName"
      else if (repeatsVarInSegment(template)) code = "pattern.repeatedVarNoBacktrack"
      else if (repeatsVarAnywhere(template)) code = "pattern.repeatedVarNoBacktrack"
      log.fail(code, `${where}: lib null, oracle ${show(oracle)}`)
      continue
    }
    const accepted = oracleAccepts(template, key, lib)
    if (accepted === false) log.fail("pattern.wrongBinding", `${where}: lib ${show(lib)} does not match; oracle ${show(oracle)}`)
    for (const value of Object.values(lib)) {
      if (hasLoneSurrogate(value)) log.note("needs-decision: pattern splits a surrogate pair", `${where}: lib ${show(lib)}`)
    }
    const normalized = splitKey(key).join("/")
    const prefix = pattern.staticPrefix()
    if (!(normalized + "/").startsWith(prefix)) log.fail("pattern.staticPrefix", `${where}: prefix ${show(prefix)}`)
    const bound = pattern.boundPrefix(lib)
    if (!(normalized + "/").startsWith(bound)) log.fail("pattern.boundPrefix", `${where}: boundPrefix ${show(bound)}`)
    if (!pattern.hasGlob) {
      const rendered = pattern.render(lib)
      if (rendered !== normalized) log.fail("pattern.render", `${where}: render ${show(rendered)}`)
    }
  }
}
