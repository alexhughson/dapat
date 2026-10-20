/**
 * Real files in a temp folder, the real SqliteStore, a new Build (and new matchers) for each build.
 * Between builds the case adds, edits, deletes, renames, and touches files. During a build, tasks
 * write new matching files (feeders), delete matching files (deleters), and rewrite their own
 * inputs (rewriters, a second build.each over the same folder).
 *
 * The oracle lists the files on disk with its own walk, matches them with its own pattern rule,
 * joins them by brute force, and keeps its own model of the store records, from its own stamps.
 * It then says which tasks the build must hold, which must run, which must skip, and what each
 * output file must contain.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs"
import { readdir } from "node:fs/promises"
import path from "node:path"
import { Build, Matcher, Task, type ArtifactEvent, type Result } from "../src/index"
import { FileArtifact, FilesystemPrefix } from "../contrib/fs"
import { SqliteStore } from "../contrib/store"
import { KeyPattern } from "../src/pattern"
import { valueOfKind, VALUE_KINDS, type ValueKind } from "./names"
import {
  oracleAllBindings,
  oracleJoin,
  oracleListFiles,
  oracleRender,
  oracleStamp,
  oracleVarNames,
  readTextOrNull,
  setKeyOf,
  shortHash,
  splitKey,
  unionVarNames,
  copyVars,
  type OJoinedSet,
  type OMatch,
  type OMatcherSpec,
  type OVars,
} from "./oracle"
import { hashString, type Rng } from "./rng"
import { CaseLog, show } from "./types"
import { createHash } from "node:crypto"

export const FUZZ_TMP = path.join(
  process.env.FUZZ_TMP ?? "/tmp/claude-0/-home-user-dapat/a7c9920b-8d51-553c-9cb1-6e200daea5ae/scratchpad/fuzz-tmp",
  `run-${process.pid}`,
)

// ---------------------------------------------------------------- the file matcher (user code, built on KeyPattern)

type Mode = "time" | "hash"

/**
 * Finds files under `root` whose key (path relative to root) fits `template`.
 * Without a glob, one file is one match. With a glob, all files with the same vars form one
 * list match, sorted by path. It also follows produced and deleted events during the run.
 */
class FileMatcher extends Matcher<any> {
  readonly varNames: readonly string[]
  private readonly pattern: KeyPattern
  private readonly listMode: boolean
  // varsKey -> the matching paths (absolute), for the list mode and for gone.
  private readonly pathsByVarsKey = new Map<string, { vars: Record<string, string>; paths: Set<string> }>()
  scanCount = 0

  constructor(
    readonly root: string,
    readonly template: string,
    private readonly mode: Mode,
    // Like the Posts example of DOCS.md section 10: a declared output is found when it is promised.
    private readonly findOnPromised = false,
  ) {
    super()
    this.pattern = new KeyPattern(template)
    this.varNames = this.pattern.varNames
    this.listMode = this.pattern.hasGlob
  }

  async scan(): Promise<void> {
    this.scanCount += 1
    const start = path.join(this.root, this.pattern.staticPrefix())
    let names: string[] = []
    try {
      names = await readdir(start)
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw error
    }
    if (names.includes("SCANERR")) throw new Error(`scan error: SCANERR in ${start}`)
    const files = await walk(start)
    files.sort()
    for (const file of files) this.add(file, false)
    for (const entry of this.pathsByVarsKey.values()) this.sendEntry(entry)
  }

  override receiveArtifactEvent(event: ArtifactEvent): void {
    if (this.findOnPromised && event.kind === "promised" && event.output instanceof FileArtifact) {
      const entry = this.add(event.output.path, true)
      if (entry !== null) this.sendEntry(entry)
    }
    if (event.kind === "produced" && event.artifact instanceof FileArtifact) {
      const entry = this.add(event.artifact.path, true)
      if (entry !== null) this.sendEntry(entry)
    }
    if (event.kind === "deleted" && event.artifact instanceof FileArtifact) {
      this.remove(event.artifact.path)
    }
  }

  private keyOf(file: string): string | null {
    const rel = path.relative(this.root, file)
    if (rel.startsWith("..")) return null
    return rel.split(path.sep).join("/")
  }

  private add(file: string, _live: boolean): { vars: Record<string, string>; paths: Set<string> } | null {
    const key = this.keyOf(file)
    if (key === null) return null
    const vars = this.pattern.match(key)
    if (vars === null) return null
    const varsKey = JSON.stringify(this.varNames.map((n) => vars[n]))
    let entry = this.pathsByVarsKey.get(varsKey)
    if (entry === undefined) {
      entry = { vars, paths: new Set() }
      this.pathsByVarsKey.set(varsKey, entry)
    }
    entry.paths.add(file)
    return entry
  }

  private remove(file: string): void {
    const key = this.keyOf(file)
    if (key === null) return
    const vars = this.pattern.match(key)
    if (vars === null) return
    const varsKey = JSON.stringify(this.varNames.map((n) => vars[n]))
    const entry = this.pathsByVarsKey.get(varsKey)
    if (entry === undefined) return
    entry.paths.delete(file)
    if (entry.paths.size === 0) {
      this.pathsByVarsKey.delete(varsKey)
      this.send({ kind: "gone", vars: entry.vars })
      return
    }
    this.sendEntry(entry)
  }

  private sendEntry(entry: { vars: Record<string, string>; paths: Set<string> }): void {
    const sorted = [...entry.paths].sort()
    if (this.listMode) {
      const data = sorted.map((p) => new FileArtifact(p, { stamp: this.mode }))
      this.send({ kind: "found", matched: { vars: { ...entry.vars }, data } })
      return
    }
    // Without a glob, the vars name one path.
    this.send({ kind: "found", matched: { vars: { ...entry.vars }, data: new FileArtifact(sorted[0]!, { stamp: this.mode }) } })
  }
}

/** The same matcher class, for the self-test's docs example. */
export { FileMatcher as FileMatcherForSelftest }

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return out
    throw error
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(full)))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

// ---------------------------------------------------------------- the case plan

type FsTopology = "single" | "pair" | "chain" | "star" | "allShared" | "deep" | "glob"

type FsPlan = {
  topology: FsTopology
  templates: string[]
  specs: OMatcherSpec[]
  union: string[]
  mode: Mode
  values: string[]
  valueKinds: ValueKind[]
  feeders: boolean
  deleters: boolean
  rewriter: boolean
  rewriterSharesMatcher: boolean
  indexTask: boolean
  reopenStore: boolean
  avoidKnown: boolean
  // Every file the case writes gets a whole-second mtime, like a file system with coarse times.
  coarseTimes: boolean
  findOnPromised: boolean
}

function templatesOf(topology: FsTopology): string[] {
  switch (topology) {
    case "single":
      return ["m0/<a>/<b>.txt"]
    case "pair":
      return ["m0/<lang>/<slug>.md", "m1/<lang>.html"]
    case "chain":
      return ["m0/<a>/<b>.txt", "m1/<b>/<c>.txt", "m2/<c>.txt"]
    case "star":
      return ["m0/<a>/<b>/x.txt", "m1/<a>.txt", "m2/<b>.txt"]
    case "allShared":
      return ["m0/<a>.txt", "m1/<a>.md"]
    case "deep":
      return ["m0/d1/d2/d3/d4/d5/d6/d7/d8/d9/d10/d11/d12/<a>/<b>.txt", "m1/<a>.md"]
    case "glob":
      return ["m0/<a>/**/*.txt", "m1/<a>.md"]
  }
}

function makeFsPlan(rng: Rng): FsPlan {
  const avoidKnown = process.env.FUZZ_KNOWN === "1" ? false : rng.chance(0.85)
  const topology = rng.pick<FsTopology>(["single", "pair", "chain", "star", "allShared", "deep", "glob"])
  const templates = templatesOf(topology)
  const specs = templates.map((t, i) => ({ name: `m${i}`, varNames: oracleVarNames(t) }))
  const values: string[] = []
  const valueKinds: ValueKind[] = []
  const wanted = rng.range(2, 4)
  while (values.length < wanted) {
    const kind: ValueKind = rng.chance(0.4) ? rng.pick(VALUE_KINDS) : "plain"
    let value = valueOfKind(rng, kind)
    if (!avoidKnown && rng.chance(0.1)) value = "line\nbreak"
    if (value.startsWith("g_") || value.startsWith("x_") || value.includes("TERR")) continue
    if (values.includes(value)) continue
    values.push(value)
    valueKinds.push(kind)
  }
  const findOnPromised = rng.chance(0.4)
  let rewriterSharesMatcher = rng.chance(0.5)
  // A send from receiveArtifactEvent during a hear, with one matcher in two build.each calls,
  // is the known reorder bug (fuzz/repros/shared-matcher-reorder.ts).
  if (avoidKnown && findOnPromised) rewriterSharesMatcher = false
  return {
    topology,
    templates,
    specs,
    union: unionVarNames(specs),
    mode: rng.chance(0.5) ? "time" : "hash",
    values,
    valueKinds,
    feeders: rng.chance(0.5),
    deleters: rng.chance(0.4),
    rewriter: rng.chance(0.4),
    rewriterSharesMatcher,
    indexTask: rng.chance(0.25),
    reopenStore: rng.chance(0.5),
    avoidKnown,
    coarseTimes: rng.chance(0.4),
    findOnPromised,
  }
}

/** The vars of M0 that no other matcher has. A feeder and a deleter prefix only these. */
function ownVarsOfFirst(plan: FsPlan): string[] {
  const own: string[] = []
  for (const name of plan.specs[0]!.varNames) {
    let shared = false
    for (let i = 1; i < plan.specs.length; i++) if (plan.specs[i]!.varNames.includes(name)) shared = true
    if (!shared) own.push(name)
  }
  return own
}

/** Feeders and deleters need M0 to hold every var, an own var, and no glob. */
function canFeed(plan: FsPlan): boolean {
  if (plan.topology === "glob") return false
  if (ownVarsOfFirst(plan).length === 0) return false
  for (const name of plan.union) if (!plan.specs[0]!.varNames.includes(name)) return false
  return true
}

function isDerived(vars: OVars): boolean {
  for (const value of Object.values(vars)) if (value.startsWith("g_") || value.startsWith("x_")) return true
  return false
}

/** The file that a feeder ("g_") or a deleter ("x_") of a set targets: M0's template with its own vars prefixed. */
function derivedKey(plan: FsPlan, vars: OVars, prefix: string): string {
  const own = ownVarsOfFirst(plan)
  const changed = copyVars(vars)
  for (const name of own) changed[name] = prefix + changed[name]
  return oracleRender(plan.templates[0]!, changed)!
}

// ---------------------------------------------------------------- task kinds

type TaskKind = "main" | "feed" | "del" | "rw" | "index"

type ExpectedTask = {
  id: string
  kind: TaskKind
  inputs: string[] // absolute paths; a prefix input ends with "/"
  outputs: string[]
  // For main tasks: the joined set.
  set?: OJoinedSet
}

function mainIdOf(plan: FsPlan, vars: OVars): string {
  return `job:${setKeyOf(plan.union, vars)}`
}

function outPathOf(caseDir: string, taskId: string): string {
  return path.join(caseDir, "out", `${shortHash(taskId)}.txt`)
}

function wantsFeeder(plan: FsPlan, vars: OVars): boolean {
  return plan.feeders && canFeed(plan) && !isDerived(vars) && hashString(setKeyOf(plan.union, vars)) % 3 === 0
}

function wantsDeleter(plan: FsPlan, vars: OVars): boolean {
  return plan.deleters && canFeed(plan) && !isDerived(vars) && hashString(setKeyOf(plan.union, vars)) % 4 === 1
}

function wantsRewriter(plan: FsPlan, match: OMatch, key: string): boolean {
  if (!plan.rewriter || plan.topology === "glob") return false
  return !isDerived(match.vars)
}

/** The leading literal segments of a template, with a trailing "/" (my own reading of the template). */
function literalFolderOf(template: string): string {
  const lit: string[] = []
  for (const seg of splitKey(template)) {
    if (seg.includes("<") || seg.includes("*")) break
    lit.push(seg)
  }
  // The last literal piece may be a file name; a template always ends in a var or glob segment here.
  return lit.length === 0 ? "" : `${lit.join("/")}/`
}

/** The expected output of a main task, from the contents of its inputs. */
function mainOutput(taskId: string, root: string, inputs: string[], contents: (string | null)[]): string {
  const parts: [string, string | null][] = []
  for (let i = 0; i < inputs.length; i++) parts.push([path.relative(root, inputs[i]!), contents[i]!])
  return JSON.stringify({ id: taskId, inputs: parts })
}

// ---------------------------------------------------------------- oracle: from disk to expected tasks

type DiskView = { files: string[]; matchesByName: Map<string, OMatch[]>; sets: OJoinedSet[]; tasks: Map<string, ExpectedTask> }

function oracleView(plan: FsPlan, caseDir: string): DiskView {
  const world = path.join(caseDir, "w")
  const files = oracleListFiles(world)
  const matchesByName = new Map<string, OMatch[]>()
  const rewriterMatches: { match: OMatch; key: string }[] = []
  for (let i = 0; i < plan.templates.length; i++) {
    const template = plan.templates[i]!
    const byVars = new Map<string, OMatch>()
    for (const key of files) {
      const bindings = oracleAllBindings(template, key, 2)
      if (bindings === null || bindings.length === 0) continue
      if (bindings.length > 1) throw new Error(`fs templates must not be ambiguous: ${template} ${key}`)
      const vars = bindings[0]!
      const varsKey = JSON.stringify(plan.specs[i]!.varNames.map((n) => vars[n]))
      const existing = byVars.get(varsKey)
      if (existing === undefined) byVars.set(varsKey, { vars, dataIds: [path.join(world, key)] })
      else existing.dataIds.push(path.join(world, key))
    }
    const matches = [...byVars.values()]
    for (const m of matches) m.dataIds.sort()
    matchesByName.set(`m${i}`, matches)
    if (i === 0) for (const m of matches) if (m.dataIds.length === 1) rewriterMatches.push({ match: m, key: m.dataIds[0]! })
  }
  const sets = oracleJoin(plan.specs, matchesByName)
  const tasks = new Map<string, ExpectedTask>()
  for (const set of sets) {
    const inputs: string[] = []
    for (const spec of plan.specs) inputs.push(...set.membersByName.get(spec.name)!.dataIds)
    const id = mainIdOf(plan, set.vars)
    tasks.set(id, { id, kind: "main", inputs, outputs: [outPathOf(caseDir, id)], set })
    if (wantsFeeder(plan, set.vars)) {
      const fid = `feed:${setKeyOf(plan.union, set.vars)}`
      tasks.set(fid, { id: fid, kind: "feed", inputs, outputs: [path.join(world, derivedKey(plan, set.vars, "g_"))] })
    }
    if (wantsDeleter(plan, set.vars)) {
      const did = `del:${setKeyOf(plan.union, set.vars)}`
      tasks.set(did, { id: did, kind: "del", inputs, outputs: [path.join(world, derivedKey(plan, set.vars, "x_"))] })
    }
  }
  for (const { match, key } of rewriterMatches) {
    if (!wantsRewriter(plan, match, key)) continue
    const rid = `rw:${key}`
    tasks.set(rid, { id: rid, kind: "rw", inputs: [key], outputs: [key] })
  }
  if (plan.indexTask) {
    tasks.set("index", { id: "index", kind: "index", inputs: [path.join(world, "m0") + "/"], outputs: [indexPathOf(caseDir)] })
  }
  return { files, matchesByName, sets, tasks }
}

function indexPathOf(caseDir: string): string {
  return path.join(caseDir, "w", "m0", "zz_index.dat")
}

/** My own prefix stamp: SHA-256 of the sorted lines `<relative path>=<file stamp>` (from DOCS.md). */
function oraclePrefixStamp(dir: string, mode: Mode, override?: { file: string; stamp: string | null }): string {
  const lines: string[] = []
  for (const rel of oracleListFiles(dir)) {
    const full = path.join(dir, rel)
    let stamp = oracleStamp(full, mode)
    if (override !== undefined && full === override.file) stamp = override.stamp
    if (stamp === null) continue
    lines.push(`${rel}=${stamp}`)
  }
  if (override !== undefined && override.stamp !== null && !lines.some((l) => l.startsWith(`${path.relative(dir, override.file)}=`))) {
    lines.push(`${path.relative(dir, override.file)}=${override.stamp}`)
  }
  lines.sort()
  return createHash("sha256").update(lines.join("\n")).digest("hex")
}

// ---------------------------------------------------------------- the case

type ModelRecord = { inputs: Map<string, string | null>; outputs: Map<string, string | null> }

type ExecLog = { id: string; kind: TaskKind; contents?: (string | null)[] }

export async function runFsCase(rng: Rng, log: CaseLog, seed: number): Promise<void> {
  const plan = makeFsPlan(rng)
  const caseDir = path.join(FUZZ_TMP, `case-${seed}-${process.hrtime.bigint()}`)
  try {
    await runFsCaseIn(rng, log, plan, caseDir)
  } finally {
    rmSync(caseDir, { recursive: true, force: true })
  }
  if (!plan.avoidKnown && plan.values.some((v) => v.includes("\n"))) {
    for (const finding of log.findings) if (finding.code !== "exception") finding.code = "pattern.lineBreakNotMatched(fs)"
  } else if (plan.findOnPromised && plan.rewriter && plan.rewriterSharesMatcher) {
    for (const finding of log.findings) if (finding.code !== "exception") finding.code = "join.sharedMatcherReorder(fs)"
  }
}

async function runFsCaseIn(rng: Rng, log: CaseLog, plan: FsPlan, caseDir: string): Promise<void> {
  log.op(`fs.topology.${plan.topology}`)
  if (plan.findOnPromised) log.op("fs.findOnPromised")
  if (plan.rewriter) log.op(plan.rewriterSharesMatcher ? "fs.twoEachesOneMatcher" : "fs.twoEachesTwoMatchers")
  log.op(`fs.mode.${plan.mode}`)
  coarse = plan.coarseTimes
  if (coarse) log.op("fs.coarseTimes")
  const world = path.join(caseDir, "w")
  mkdirSync(world, { recursive: true })
  mkdirSync(path.join(caseDir, "out"), { recursive: true })
  const dbPath = path.join(caseDir, "state", "db.sqlite")
  const model = new Map<string, ModelRecord>()
  // Files whose last edit kept the size and the modification time (DOCS.md section 13, "time" limit).
  const sneaky = new Set<string>()
  let store: SqliteStore | null = null

  // The first files.
  const initial = rng.range(2, 10)
  for (let i = 0; i < initial; i++) opAdd(rng, log, plan, world, false)

  const builds = rng.range(3, 8)
  for (let buildNumber = 1; buildNumber <= builds; buildNumber++) {
    if (buildNumber > 1) {
      const noChange = rng.chance(0.3)
      if (noChange) log.op("fs.noChangeBuild")
      else {
        const opCount = rng.range(1, 5)
        for (let i = 0; i < opCount; i++) randomOp(rng, log, plan, world, sneaky)
      }
    }
    if (store === null || plan.reopenStore) {
      if (store !== null) store.close()
      store = new SqliteStore(dbPath)
      if (buildNumber > 1) log.op("fs.storeReopened")
    }
    const ok = await oneBuild(rng, log, plan, caseDir, store, model, sneaky, buildNumber)
    log.op("fs.build")
    if (!ok || log.findings.length > 0) break
  }
  if (store !== null) store.close()
}

function valueFor(rng: Rng, plan: FsPlan): string {
  return rng.pick(plan.values)
}

function opAdd(rng: Rng, log: CaseLog, plan: FsPlan, world: string, doomedOrBoom: boolean): void {
  const index = rng.int(plan.templates.length)
  const template = plan.templates[index]!
  const vars = copyVars({})
  for (const name of plan.specs[index]!.varNames) vars[name] = valueFor(rng, plan)
  let key: string
  if (plan.topology === "glob" && index === 0) {
    // m0/<a>/**/*.txt: any depth, any name.
    const depth = rng.int(3)
    const middle: string[] = []
    for (let i = 0; i < depth; i++) middle.push(rng.pick(["s", "t", "deep"]))
    key = ["m0", vars["a"]!, ...middle, `${rng.pick(["p", "q", "r"])}.txt`].join("/")
  } else {
    key = oracleRender(template, vars)!
  }
  const content = rng.chance(0.08) && !doomedOrBoom ? "BOOM" : `c${rng.int(1000)}`
  writeFileIn(world, key, content)
  log.op("fs.op.add")
}

let coarse = false

/** Writes a file the way the case's file system would: with a whole-second mtime when times are coarse. */
function writeCase(full: string, content: string): void {
  writeFileSync(full, content)
  if (coarse) {
    const seconds = Math.floor(Date.now() / 1000)
    utimesSync(full, seconds, seconds)
  }
}

function writeFileIn(world: string, key: string, content: string): void {
  const full = path.join(world, key)
  mkdirSync(path.dirname(full), { recursive: true })
  writeCase(full, content)
}

function matchingKeys(plan: FsPlan, world: string): string[] {
  return oracleListFiles(world).filter((k) => !k.endsWith("zz_index.dat"))
}

function randomOp(rng: Rng, log: CaseLog, plan: FsPlan, world: string, sneaky: Set<string>): void {
  const keys = matchingKeys(plan, world)
  // Remove an error trigger first, most of the time.
  const triggers = keys.filter((k) => k.includes("TERR") || k.endsWith("SCANERR"))
  if (triggers.length > 0 && rng.chance(0.8)) {
    unlinkSync(path.join(world, triggers[0]!))
    log.op("fs.op.removeErrorTrigger")
    return
  }
  const roll = rng.next()
  if (roll < 0.25 || keys.length === 0) return opAdd(rng, log, plan, world, false)
  const key = rng.pick(keys)
  const full = path.join(world, key)
  if (roll < 0.37) {
    writeCase(full, `edited ${rng.int(100000)} ${"z".repeat(rng.int(5))}`)
    sneaky.delete(full)
    log.op("fs.op.edit")
  } else if (roll < 0.44) {
    const old = readFileSync(full, "utf8")
    writeCase(full, sameSizeVariant(old))
    sneaky.delete(full)
    log.op("fs.op.sameSizeEdit")
  } else if (roll < 0.49) {
    // Keeps the size and puts the old modification time back, like `cp -p` or `rsync -t`.
    // Exact only for a whole-second mtime: utimes takes seconds as a double.
    const before = statSync(full, { bigint: true })
    const old = readFileSync(full, "utf8")
    writeFileSync(full, sameSizeVariant(old))
    if (before.mtimeNs % 1_000_000_000n === 0n) {
      const seconds = Number(before.mtimeNs / 1_000_000_000n)
      utimesSync(full, seconds, seconds)
      sneaky.add(full)
      log.op("fs.op.sneakyEdit")
    } else {
      log.op("fs.op.sameSizeEdit")
    }
  } else if (roll < 0.56) {
    const seconds = Math.floor(Date.now() / 1000) + 1 + rng.int(100000)
    utimesSync(full, seconds, seconds)
    log.op("fs.op.touch")
  } else if (roll < 0.68) {
    unlinkSync(full)
    sneaky.delete(full)
    log.op("fs.op.delete")
  } else if (roll < 0.78) {
    // Rename: to a new matching key of the same matcher, or to a name that matches nothing.
    let target: string
    if (rng.chance(0.7)) {
      const segs = splitKey(key)
      const last = segs[segs.length - 1]!
      const ext = last.includes(".") ? last.slice(last.lastIndexOf(".")) : ""
      segs[segs.length - 1] = `${valueFor(rng, plan)}${ext}`
      target = segs.join("/")
    } else target = `${key}.bak`
    if (target !== key) {
      mkdirSync(path.dirname(path.join(world, target)), { recursive: true })
      renameSync(full, path.join(world, target))
      sneaky.delete(full)
    }
    log.op("fs.op.rename")
  } else if (roll < 0.84) {
    // A doomed file: the target of a deleter, if a set has one.
    if (!canFeed(plan)) return opAdd(rng, log, plan, world, false)
    // Prefer a set that has a deleter, so that the deleter really removes a match during the run.
    const view = oracleView(plan, path.dirname(world))
    const withDeleter = view.sets.filter((set) => wantsDeleter(plan, set.vars))
    let vars = copyVars({})
    if (withDeleter.length > 0) vars = copyVars(rng.pick(withDeleter).vars)
    else for (const name of plan.union) vars[name] = valueFor(rng, plan)
    writeFileIn(world, derivedKey(plan, vars, "x_"), "doomed")
    log.op("fs.op.addDoomed")
  } else if (roll < 0.9) {
    const text = readFileSync(full, "utf8")
    if (text.endsWith("!")) {
      writeCase(full, text.slice(0, -1))
      log.op("fs.op.removeRewriteMark")
    } else log.op("fs.op.noop")
  } else if (roll < 0.93) {
    writeCase(full, "BOOM")
    log.op("fs.op.makeTaskFail")
  } else if (roll < 0.96) {
    // A var value that makes tasks() throw.
    const segs = splitKey(key)
    const last = segs[segs.length - 1]!
    const ext = last.includes(".") ? last.slice(last.lastIndexOf(".")) : ""
    segs[segs.length - 1] = `TERR${ext}`
    writeFileIn(world, segs.join("/"), "terr")
    log.op("fs.op.addTasksError")
  } else {
    writeFileIn(world, `${literalFolderOf(rng.pick(plan.templates))}SCANERR`, "scan error")
    log.op("fs.op.addScanError")
  }
}

function sameSizeVariant(text: string): string {
  if (text.length === 0) return text
  const last = text[text.length - 1]!
  const swapped = last === "q" ? "w" : "q"
  return text.slice(0, -1) + swapped
}

async function oneBuild(
  rng: Rng,
  log: CaseLog,
  plan: FsPlan,
  caseDir: string,
  store: SqliteStore,
  model: Map<string, ModelRecord>,
  sneaky: Set<string>,
  buildNumber: number,
): Promise<boolean> {
  const world = path.join(caseDir, "w")
  const pre = oracleView(plan, caseDir)
  // Stamps of every file before the build.
  const preStamps = new Map<string, string | null>()
  for (const rel of oracleListFiles(caseDir)) preStamps.set(path.join(caseDir, rel), oracleStamp(path.join(caseDir, rel), plan.mode))
  const preStampOf = (p: string) => (preStamps.has(p) ? preStamps.get(p)! : null)
  const preContents = new Map<string, string | null>()

  // Which error must the build hit?
  const scanError = plan.templates.some((t) => pre.files.includes(`${literalFolderOf(t)}SCANERR`))
  const tasksError = pre.sets.some((s) => Object.values(s.vars).some((v) => v.includes("TERR")))

  const build = new Build({ store })
  const execs: ExecLog[] = []
  const matchers = plan.templates.map((t) => new FileMatcher(world, t, plan.mode, plan.findOnPromised))
  const m0 = matchers[0]!
  const matchersByName: Record<string, FileMatcher> = {}
  for (let i = 0; i < matchers.length; i++) matchersByName[`m${i}`] = matchers[i]!

  build.each({
    matchersByName,
    *tasks(vars, matched) {
      for (const value of Object.values(vars)) if (value.includes("TERR")) throw new Error(`tasks() error for ${show(vars)}`)
      const inputs: FileArtifact[] = []
      for (const spec of plan.specs) {
        const data = (matched as any)[spec.name].data as FileArtifact | FileArtifact[]
        for (const a of Array.isArray(data) ? data : [data]) inputs.push(a)
      }
      const id = mainIdOf(plan, vars)
      const out = new FileArtifact(outPathOf(caseDir, id), { stamp: plan.mode })
      yield new Task({
        id,
        inputs,
        outputs: [out],
        run: async () => {
          const contents = inputs.map((a) => readTextOrNull(a.path))
          execs.push({ id, kind: "main", contents })
          if (contents.some((c) => c !== null && c.includes("BOOM"))) throw new Error(`BOOM in an input of ${id}`)
          writeFileSync(out.path, mainOutput(id, world, inputs.map((a) => a.path), contents))
        },
      })
      if (wantsFeeder(plan, vars)) {
        const target = new FileArtifact(path.join(world, derivedKey(plan, vars, "g_")), { stamp: plan.mode })
        const fid = `feed:${setKeyOf(plan.union, vars)}`
        const explicit = hashString(fid) % 2 === 0
        yield new Task({
          id: fid,
          inputs,
          outputs: [target],
          run: async (ctx) => {
            execs.push({ id: fid, kind: "feed" })
            mkdirSync(path.dirname(target.path), { recursive: true })
            writeFileSync(target.path, `gen ${fid}`)
            // Some feeders report the file themselves; the build reports it again after the run.
            if (explicit) ctx.produced(target)
          },
        })
      }
      if (wantsDeleter(plan, vars)) {
        const target = new FileArtifact(path.join(world, derivedKey(plan, vars, "x_")), { stamp: plan.mode })
        const did = `del:${setKeyOf(plan.union, vars)}`
        yield new Task({
          id: did,
          inputs,
          outputs: [target],
          run: async (ctx) => {
            execs.push({ id: did, kind: "del" })
            let existed = true
            try {
              unlinkSync(target.path)
            } catch (error) {
              if ((error as { code?: string }).code !== "ENOENT") throw error
              existed = false
            }
            // Report it even when it was already gone: a declared output that is not reported as
            // deleted gets a produced event after the run (DOCS.md, Context.deleted), and a matcher
            // would then find a file that does not exist.
            if (!existed) log.op("fs.deleterTargetAbsent")
            ctx.deleted(target)
          },
        })
      }
    },
  })

  if (plan.rewriter) {
    const rwMatcher = plan.rewriterSharesMatcher ? m0 : new FileMatcher(world, plan.templates[0]!, plan.mode, plan.findOnPromised)
    build.each({
      matchersByName: { file: rwMatcher },
      *tasks(vars, matched) {
        const data = matched.file.data
        if (Array.isArray(data)) return
        const file = data as FileArtifact
        if (!wantsRewriter(plan, { vars: copyVars(vars), dataIds: [file.path] }, file.path)) return
        const rid = `rw:${file.path}`
        yield new Task({
          id: rid,
          inputs: [file],
          outputs: [file],
          run: async () => {
            execs.push({ id: rid, kind: "rw" })
            const text = readFileSync(file.path, "utf8")
            if (!text.endsWith("!")) writeFileSync(file.path, `${text}!`)
          },
        })
      },
    })
  }

  if (plan.indexTask) {
    const folder = new FilesystemPrefix(path.join(world, "m0"), { stamp: plan.mode })
    const index = new FileArtifact(indexPathOf(caseDir), { stamp: plan.mode })
    build.add(
      new Task({
        id: "index",
        inputs: [folder],
        outputs: [index],
        run: async () => {
          execs.push({ id: "index", kind: "index" })
          const listed = (await folder.list()).filter((p) => p !== index.path).map((p) => path.relative(world, p)).sort()
          mkdirSync(path.dirname(index.path), { recursive: true })
          writeFileSync(index.path, listed.join("\n"))
        },
      }),
    )
  }

  let result: Result | null = null
  let rejection: unknown = null
  try {
    result = await build.run()
  } catch (error) {
    rejection = error
  }

  // ---- an expected fatal error
  if (scanError || tasksError) {
    log.op(scanError ? "fs.fatal.scan" : "fs.fatal.tasks")
    if (rejection === null) {
      log.fail("fs.fatalNotReported", `build ${buildNumber}: expected a ${scanError ? "scan" : "tasks()"} error, run() resolved`)
      return false
    }
    const text = String(rejection)
    if (!(scanError && text.includes("SCANERR")) && !(tasksError && text.includes("tasks() error"))) {
      log.fail("fs.wrongFatal", `build ${buildNumber}: got ${text}`)
    }
    const ranNonIndex = execs.filter((e) => e.kind !== "index")
    if (execs.length > 0) log.fail("fs.ranAfterFatal", `build ${buildNumber}: ${execs.length} tasks ran after a fatal scan or tasks() error: ${show(ranNonIndex.map((e) => e.id))}`)
    return true
  }
  if (rejection !== null) {
    log.fail("fs.unexpectedReject", `build ${buildNumber}: run() rejected: ${String(rejection)}`)
    return false
  }

  // ---- the end state
  const post = oracleView(plan, caseDir)
  const postStampOf = (p: string) => oracleStamp(p, plan.mode)
  const slots = (build as any).slots as Map<string, { task: Task }>
  const actualIds = [...slots.keys()].sort()
  const expectedIds = [...post.tasks.keys()].sort()
  if (show(actualIds) !== show(expectedIds)) {
    const missing = expectedIds.filter((id) => !slots.has(id))
    const extra = actualIds.filter((id) => !post.tasks.has(id))
    const debug = process.env.FUZZ_DEBUG === "1" ? ` | ran ${show(execs.map((e) => e.id))} | pre files ${show(pre.files)} | post files ${show(post.files)}` : ""
    log.fail("fs.taskSet", `build ${buildNumber}: missing ${show(missing)} extra ${show(extra)}${debug}`)
    return false
  }
  for (const [id, expected] of post.tasks) {
    const task = slots.get(id)!.task
    const inputs = task.inputs.map((r) => (r instanceof FilesystemPrefix ? r.path : (r as FileArtifact).path))
    if (show(inputs) !== show(expected.inputs)) log.fail("fs.taskInputs", `build ${buildNumber}: task ${id} inputs ${show(inputs)} expected ${show(expected.inputs)}`)
  }

  // ---- who ran, who skipped
  const outcomeOf = (id: string) => (build as any).outcomes.get(slots.get(id)!.task) as { type: string } | undefined
  const ranIds = new Set(execs.map((e) => e.id))
  const removedIds = [...pre.tasks.keys()].filter((id) => !post.tasks.has(id))
  // A task that ran must be in the final set: a removed task waited for the task that deleted its match.
  for (const id of ranIds) {
    if (!post.tasks.has(id)) log.fail("fs.ranTaskNotInFinalSet", `build ${buildNumber}: task ${id} ran, but no match on disk gives it at the end`)
  }
  for (const id of removedIds) {
    log.op("fs.removedDuringRun")
    if (ranIds.has(id)) log.fail("fs.removedTaskRan", `build ${buildNumber}: task ${id} ran, but its match was deleted by a task it waits for`)
  }
  for (const [id, expected] of post.tasks) {
    const writesOwnInput = expected.kind === "rw"
    const startStamps = new Map<string, string | null>()
    for (const input of expected.inputs) {
      if (input.endsWith("/")) {
        // The index task: the folder as it was after the other writers, before its own write.
        const own = indexPathOf(caseDir)
        startStamps.set(input, oraclePrefixStamp(input, plan.mode, { file: own, stamp: preStampOf(own) }))
      } else startStamps.set(input, writesOwnInput ? preStampOf(input) : postStampOf(input))
    }
    const record = model.get(id)
    let canSkip = record !== undefined && expected.inputs.length > 0
    if (canSkip) canSkip = sameMap(record!.inputs, startStamps)
    if (canSkip) {
      for (const output of expected.outputs) {
        const stamp = preStampOf(output)
        if (stamp === null || record!.outputs.get(output) !== stamp) canSkip = false
      }
      if (record!.outputs.size !== expected.outputs.length) canSkip = false
    }
    const outcome = outcomeOf(id)?.type
    const boom = expected.kind === "main" && expected.inputs.some((p) => (readTextOrNull(p) ?? "").includes("BOOM"))
    const expectedOutcome = canSkip ? "skipped" : boom ? "failed" : "executed"
    log.op(`fs.outcome.${expectedOutcome}`)
    if (outcome !== expectedOutcome) {
      const why = explainMismatch(plan, expected, record, startStamps, preStampOf, sneaky)
      log.fail(why.code, `build ${buildNumber}: task ${id} (${expected.kind}) ${outcome}, expected ${expectedOutcome}. ${why.detail}`)
      continue
    }
    if (expectedOutcome === "executed") {
      const outputs = new Map<string, string | null>()
      for (const output of expected.outputs) outputs.set(output, postStampOf(output))
      // Self-test plant: a wrong model that forgets to record a run.
      if (process.env.FUZZ_PLANT !== "fs") model.set(id, { inputs: startStamps, outputs })
    }
    if (expected.kind === "index" && expectedOutcome === "executed" && record !== undefined && sameMapExceptOwn(record, startStamps)) {
      log.note("documented: a task that writes into a folder it reads runs again (DOCS.md section 13)", `build ${buildNumber}: index task, mode ${plan.mode}`)
    }
    if (expected.kind === "del" && expectedOutcome === "executed" && record !== undefined) {
      log.note("documented: an output with a null stamp makes the task run (deleter target stays missing)")
    }
  }
  for (const id of removedIds) model.delete(id)

  // ---- nothing stale: every main output fits the current inputs
  for (const [id, expected] of post.tasks) {
    if (expected.kind !== "main") continue
    const outcome = outcomeOf(id)?.type
    if (outcome !== "executed" && outcome !== "skipped") continue
    const contents = expected.inputs.map((p) => readTextOrNull(p))
    const want = mainOutput(id, world, expected.inputs, contents)
    const got = readTextOrNull(outPathOf(caseDir, id))
    if (got === want) continue
    // A skip in "time" mode with equal stamps but new bytes is the documented "time" limit.
    if (plan.mode === "time" && outcome === "skipped") {
      log.note("documented: \"time\" stamp misses an edit that keeps size and mtime (DOCS.md section 13)", `task ${id}: output ${show(got)} but inputs now ${show(contents)}`)
      continue
    }
    log.fail("fs.staleOutput", `build ${buildNumber}: task ${id} (${outcome}) output ${show(got)}, expected ${show(want)}`)
  }
  // After a build in hash mode, a sneaky edit is seen; in time mode it stays missed until the next real edit.
  if (plan.mode === "hash") sneaky.clear()

  // Result fields agree with the outcomes.
  if (result!.success !== (result!.failed.size === 0 && result!.errors.length === 0)) log.fail("fs.successFlag", `success ${result!.success}`)
  return true
}

function sameMap(a: Map<string, string | null>, b: Map<string, string | null>): boolean {
  if (a.size !== b.size) return false
  for (const [k, v] of a) {
    if (!b.has(k)) return false
    if (b.get(k) !== v) return false
  }
  return true
}

function sameMapExceptOwn(record: ModelRecord, start: Map<string, string | null>): boolean {
  return !sameMap(record.inputs, start)
}

function explainMismatch(
  plan: FsPlan,
  expected: ExpectedTask,
  record: ModelRecord | undefined,
  start: Map<string, string | null>,
  preStampOf: (p: string) => string | null,
  _sneaky: Set<string>,
): { code: string; detail: string } {
  const detail = `record ${show(record ? { inputs: [...record.inputs], outputs: [...record.outputs] } : null)} start ${show([...start])} outputs-pre ${show(expected.outputs.map((o) => [o, preStampOf(o)]))}`
  return { code: `fs.outcome.${expected.kind}`, detail }
}
