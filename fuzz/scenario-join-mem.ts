/**
 * build.each with several matchers, in-memory artifacts (test/mem.ts), real Build and MemoryStore.
 * Every matcher event is logged at send time. The oracle replays the log in order (one FIFO queue,
 * as DOCS.md section 10 says), recomputes the matches and the brute-force join from scratch, and
 * compares the tasks the build holds, the tasks() calls, the group labels, and what ran.
 */
import { Build, Matcher, MemoryStore, Task, type ArtifactEvent, type Result } from "../src/index"
import { Mem } from "../test/mem"
import { valuePool } from "./names"
import {
  oracleConnected,
  oracleJoin,
  oracleLabel,
  setKeyOf,
  unionVarNames,
  type OJoinedSet,
  type OMatch,
  type OMatcherSpec,
  type OVars,
  newVars,
  copyVars,
} from "./oracle"
import { hashString, type Rng } from "./rng"
import { CaseLog, hasLoneSurrogate, show } from "./types"

// ---------------------------------------------------------------- the matcher under test

type SentEvent = { kind: "found"; matched: { vars: OVars; data: Mem | Mem[] } } | { kind: "gone"; vars: OVars }

type LogEntry = { matcherIndex: number; event: SentEvent; origin: string }

class FuzzMatcher extends Matcher<any> {
  scanEvents: SentEvent[] = []
  constructor(
    readonly index: number,
    readonly varNames: readonly string[],
    private readonly sendLog: LogEntry[],
    private readonly scanRng: Rng,
  ) {
    super()
  }

  emit(event: SentEvent, origin: string): void {
    this.sendLog.push({ matcherIndex: this.index, event, origin })
    this.send(event as any)
  }

  async scan(): Promise<void> {
    for (const event of this.scanEvents) {
      if (this.scanRng.chance(0.3)) await Promise.resolve()
      this.emit(event, "scan")
    }
  }
}

// ---------------------------------------------------------------- the case plan

type Topology = "single" | "pair" | "chain" | "star" | "cycle" | "allShared" | "random" | "loneVar"

type EachPlan = {
  number: number
  // Indexes into the case's matcher list, with a name for each.
  names: string[]
  matcherIndexes: number[]
  specs: OMatcherSpec[]
  union: string[]
}

type Plan = {
  topology: Topology
  varNamesByMatcher: string[][]
  eaches: EachPlan[]
  valuesByVar: Map<string, string[]>
  idMode: "full" | "partial" | "fixed"
  partialVar: string
  throwSalt: number
  throwRate: number
  reentrantRate: number
  subscriberRate: number
  inRunEventRate: number
  taskFailRate: number
  addedTaskIds: string[]
  surrogateCase: boolean
  protoCase: boolean
  // When true, the case avoids the triggers of bugs already found, so that other bugs stay visible.
  avoidKnown: boolean
  // Two build.each calls share a matcher, and some sends are nested (from tasks() or a subscriber).
  sharedNested: boolean
  badVarsRate: number
}

const BASE_VARS = ["a", "b", "c", "d", "e"]

function planTopology(rng: Rng, topology: Topology, varPool: string[]): string[][] {
  const k = rng.range(2, 5)
  switch (topology) {
    case "single":
      return [rng.shuffle(varPool.slice(0, rng.range(1, 3)))]
    case "loneVar":
      return [[varPool[0]!]]
    case "pair":
      return [rng.shuffle([varPool[0]!, varPool[1]!]), [varPool[0]!]]
    case "chain": {
      const out: string[][] = []
      for (let i = 0; i < k; i++) out.push(rng.shuffle([varPool[i % varPool.length]!, varPool[(i + 1) % varPool.length]!]))
      return out
    }
    case "cycle": {
      const out: string[][] = []
      const n = Math.min(k + 1, varPool.length)
      for (let i = 0; i < n; i++) out.push(rng.shuffle([varPool[i]!, varPool[(i + 1) % n]!]))
      return out
    }
    case "star": {
      const leaves = Math.min(k, varPool.length)
      const center = rng.shuffle(varPool.slice(0, leaves))
      const out: string[][] = [center]
      for (let i = 0; i < leaves; i++) out.push([center[i]!])
      return rng.shuffle(out)
    }
    case "allShared": {
      const shared = varPool.slice(0, rng.range(1, 3))
      const out: string[][] = []
      for (let i = 0; i < k; i++) out.push(rng.shuffle([...shared]))
      return out
    }
    case "random": {
      while (true) {
        const out: string[][] = []
        for (let i = 0; i < k; i++) {
          const names = varPool.filter(() => rng.chance(0.4))
          if (names.length === 0) names.push(rng.pick(varPool))
          out.push(names)
        }
        const specs = out.map((varNames, i) => ({ name: `m${i}`, varNames }))
        if (oracleConnected(specs)) return out
      }
    }
  }
}

function makePlan(rng: Rng): Plan {
  const avoidKnown = process.env.FUZZ_KNOWN === "1" ? false : rng.chance(0.7)
  const topology = rng.pick<Topology>(["single", "pair", "chain", "star", "cycle", "allShared", "random", "random", "loneVar"])
  const protoCase = !avoidKnown && rng.chance(0.05)
  const varPool = rng.shuffle([...BASE_VARS])
  if (protoCase) varPool[0] = "__proto__"
  else if (rng.chance(0.05)) varPool[0] = rng.pick(["constructor", "toString", "hasOwnProperty", "x y", "\u00e9"])
  const varNamesByMatcher = planTopology(rng, topology, varPool)
  const valuesByVar = new Map<string, string[]>()
  const surrogateCase = !avoidKnown && rng.chance(0.05)
  for (const name of varPool) {
    const pool = valuePool(rng, rng.range(1, 3), 0.25).values
    if (surrogateCase && rng.chance(0.5)) pool.push("\uD800x")
    valuesByVar.set(name, pool)
  }
  // One or two build.each calls. The second may share matcher objects with the first.
  const eaches: EachPlan[] = []
  const firstIndexes = varNamesByMatcher.map((_v, i) => i)
  eaches.push(eachPlanOf(1, firstIndexes, varNamesByMatcher))
  if (rng.chance(0.25)) {
    const subsetSize = rng.range(1, firstIndexes.length)
    const start = rng.int(firstIndexes.length - subsetSize + 1)
    const subset = firstIndexes.slice(start, start + subsetSize)
    const specs = subset.map((i) => ({ name: `m${i}`, varNames: varNamesByMatcher[i]! }))
    if (oracleConnected(specs)) eaches.push(eachPlanOf(2, subset, varNamesByMatcher))
  }
  const firstUnion = eaches[0]!.union
  let reentrantRate = rng.chance(0.5) ? rng.pick([0.05, 0.2, 0.5]) : 0
  let subscriberRate = rng.chance(0.4) ? rng.pick([0.05, 0.2]) : 0
  if (avoidKnown && eaches.length > 1) {
    reentrantRate = 0
    subscriberRate = 0
  }
  return {
    avoidKnown,
    sharedNested: eaches.length > 1 && (reentrantRate > 0 || subscriberRate > 0),
    topology,
    varNamesByMatcher,
    eaches,
    valuesByVar,
    idMode: rng.chance(0.85) ? "full" : rng.chance(0.7) ? "partial" : "fixed",
    partialVar: rng.pick(firstUnion),
    throwSalt: rng.int(1_000_000),
    throwRate: rng.chance(0.1) ? 0.05 : 0,
    reentrantRate,
    subscriberRate,
    inRunEventRate: rng.chance(0.6) ? rng.pick([0.1, 0.3, 0.6]) : 0,
    taskFailRate: rng.chance(0.2) ? 0.1 : 0,
    addedTaskIds: [],
    surrogateCase,
    protoCase,
    badVarsRate: rng.chance(0.05) ? 0.05 : 0,
  }
}

function eachPlanOf(number: number, indexes: number[], varNamesByMatcher: string[][]): EachPlan {
  const names = indexes.map((i) => `m${i}`)
  const specs = indexes.map((i) => ({ name: `m${i}`, varNames: varNamesByMatcher[i]! }))
  return { number, names, matcherIndexes: indexes, specs, union: unionVarNames(specs) }
}

// ---------------------------------------------------------------- the tasks() generator (shared by build and oracle)

type TaskSpec = { id: string; inputIds: string[] }

function idPartOf(plan: Plan, each: EachPlan, vars: OVars): string {
  if (plan.idMode === "fixed") return "fixed"
  if (plan.idMode === "partial") return JSON.stringify(vars[plan.partialVar] ?? "")
  return setKeyOf(each.union, vars)
}

/** The task specs of one joined set. The count and the ids depend only on the vars. */
function taskSpecsOf(plan: Plan, each: EachPlan, vars: OVars, dataIdsByName: Map<string, string[]>): TaskSpec[] {
  const count = hashString(`${each.number}|${setKeyOf(each.union, vars)}`) % 3
  const inputIds: string[] = []
  for (const name of each.names) {
    for (const id of artifactIdsOnly(dataIdsByName.get(name)!)) inputIds.push(id)
  }
  const specs: TaskSpec[] = []
  for (let j = 0; j < count; j++) {
    // In "fixed" mode the id leaves out the build.each number, so two build.each calls can clash too.
    const eachPart = plan.idMode === "fixed" ? "" : `e${each.number}:`
    specs.push({ id: `t${j}:${eachPart}${idPartOf(plan, each, vars)}`, inputIds })
  }
  return specs
}

function tasksThrowFor(plan: Plan, each: EachPlan, vars: OVars): boolean {
  if (plan.throwRate === 0) return false
  const h = hashString(`${plan.throwSalt}|${each.number}|${setKeyOf(each.union, vars)}`)
  return h % 1000 < plan.throwRate * 1000
}

// A list match starts with this marker, so a list of one artifact differs from the artifact alone.
const LIST = "[list]"

function dataIdsOf(data: Mem | Mem[]): string[] {
  if (Array.isArray(data)) return [LIST, ...data.map((m) => m.id)]
  return [data.id]
}

function artifactIdsOnly(dataIds: string[]): string[] {
  return dataIds.filter((id) => id !== LIST)
}

function dataFromIds(dataIds: string[], memOf: (id: string) => Mem): Mem | Mem[] {
  if (dataIds[0] === LIST) return artifactIdsOnly(dataIds).map(memOf)
  return memOf(dataIds[0]!)
}

// ---------------------------------------------------------------- the oracle replay

type OracleEach = { plan: EachPlan; matches: Map<string, Map<string, OMatch>> }

type CallKey = string

type FatalReason = "throw" | "clash" | "badVars" | "surrogate"

type ReplayResult = {
  // The build may hit any of `reasons` first: the order of sets inside one event is not specified.
  fatal: null | { reasons: FatalReason[]; entryIndex: number; detail: string }
  // The expected tasks() calls for each log entry (canonical keys).
  callsByEntry: CallKey[][]
  setsByEach: Map<number, OJoinedSet[]>
}

function matchKeyOf(varNames: readonly string[], vars: OVars): string {
  return JSON.stringify(varNames.map((name) => vars[name]))
}

function sameVarNames(varNames: readonly string[], vars: OVars): boolean {
  const given = Object.keys(vars)
  if (given.length !== varNames.length) return false
  for (const name of varNames) if (!Object.hasOwn(vars, name)) return false
  return true
}

function callKeyOf(eachNumber: number, set: { vars: OVars; membersByName: Map<string, OMatch> }, names: string[]): CallKey {
  const data: string[][] = []
  for (const name of names) data.push(set.membersByName.get(name)!.dataIds)
  return show([eachNumber, set.vars, data])
}

function replay(plan: Plan, sendLog: LogEntry[], noteShape: (example: string) => void = () => {}): ReplayResult {
  const eaches: OracleEach[] = plan.eaches.map((each) => ({
    plan: each,
    matches: new Map(each.names.map((name) => [name, new Map<string, OMatch>()])),
  }))
  const callsByEntry: CallKey[][] = []
  const setsOf = (e: OracleEach) => {
    const lists = new Map<string, OMatch[]>()
    for (const [name, table] of e.matches) lists.set(name, [...table.values()])
    return oracleJoin(e.plan.specs, lists)
  }
  let currentSets = new Map<number, OJoinedSet[]>()
  for (const e of eaches) currentSets.set(e.plan.number, [])

  for (let entryIndex = 0; entryIndex < sendLog.length; entryIndex++) {
    const entry = sendLog[entryIndex]!
    const calls: CallKey[] = []
    callsByEntry.push(calls)
    // One send reaches each build.each that uses the matcher, in build.each order.
    for (const e of eaches) {
      const position = e.plan.matcherIndexes.indexOf(entry.matcherIndex)
      if (position < 0) continue
      const name = e.plan.names[position]!
      const varNames = e.plan.specs[position]!.varNames
      const table = e.matches.get(name)!
      const event = entry.event
      const vars = event.kind === "found" ? event.matched.vars : event.vars
      if (!sameVarNames(varNames, vars)) {
        return { fatal: { reasons: ["badVars"], entryIndex, detail: show(vars) }, callsByEntry, setsByEach: currentSets }
      }
      for (const value of Object.values(vars)) {
        if (hasLoneSurrogate(value)) {
          return { fatal: { reasons: ["surrogate"], entryIndex, detail: show(vars) }, callsByEntry, setsByEach: currentSets }
        }
      }
      const key = matchKeyOf(varNames, vars)
      const before = currentSets.get(e.plan.number)!
      const beforeKeys = new Set(before.map((s) => s.key))
      let changedMatchKey: string | null = null
      if (event.kind === "gone") {
        table.delete(key)
      } else {
        const dataIds = dataIdsOf(event.matched.data)
        const current = table.get(key)
        // Self-test plant: a wrong rule where a found with the same ids replaces the tasks.
        const plantSameIds = process.env.FUZZ_PLANT === "join"
        if (current !== undefined && show(current.dataIds) === show(dataIds) && !plantSameIds) continue
        if (current !== undefined && show(artifactIdsOnly(current.dataIds)) === show(artifactIdsOnly(dataIds))) {
          noteShape(`found ${show(vars)}: data ${show(current.dataIds)} then ${show(dataIds)}`)
        }
        if (current !== undefined) changedMatchKey = key
        table.set(key, { vars: copyVars(vars), dataIds })
      }
      const after = setsOf(e)
      currentSets.set(e.plan.number, after)
      // tasks() runs for each new set, and for each set that holds a match with new data.
      const reasons: FatalReason[] = []
      let detail = ""
      for (const set of after) {
        const member = set.membersByName.get(name)!
        const isNew = !beforeKeys.has(set.key)
        const holdsChanged = changedMatchKey !== null && matchKeyOf(varNames, member.vars) === changedMatchKey
        if (!isNew && !holdsChanged) continue
        calls.push(callKeyOf(e.plan.number, set, e.plan.names))
        if (tasksThrowFor(plan, e.plan, set.vars) && !reasons.includes("throw")) {
          reasons.push("throw")
          detail += ` throw at ${set.key}`
        }
      }
      // A clash: two live sets (or a set and a build.add task) give one task id.
      const owners = new Map<string, string>()
      for (const id of plan.addedTaskIds) owners.set(id, "build.add")
      for (const other of eaches) {
        for (const set of currentSets.get(other.plan.number)!) {
          const dataIdsByName = new Map<string, string[]>()
          for (const [n, m] of set.membersByName) dataIdsByName.set(n, m.dataIds)
          for (const spec of taskSpecsOf(plan, other.plan, set.vars, dataIdsByName)) {
            const owner = `${other.plan.number}|${set.key}`
            const existing = owners.get(spec.id)
            if (existing !== undefined && existing !== owner && !reasons.includes("clash")) {
              reasons.push("clash")
              detail += ` clash on ${spec.id}`
            }
            owners.set(spec.id, owner)
          }
        }
      }
      if (reasons.length > 0) return { fatal: { reasons, entryIndex, detail }, callsByEntry, setsByEach: currentSets }
    }
  }
  return { fatal: null, callsByEntry, setsByEach: currentSets }
}

// ---------------------------------------------------------------- the case

type TaskMeta = { eachNumber: number; vars: OVars; inputIds: string[]; mems: Mem[] }

type Exec = { task: Task; meta: TaskMeta; values: (string | null)[]; ok: boolean; current: boolean }

export async function runJoinMemCase(rng: Rng, log: CaseLog, steps: number): Promise<void> {
  const plan = makePlan(rng)
  await runPlannedCase(rng, log, steps, plan)
  // Findings in a case that keeps a known trigger get the code of that known bug.
  if (plan.protoCase || plan.sharedNested) {
    for (const finding of log.findings) {
      if (finding.code === "join.loneSurrogateVarFails" || finding.code === "exception") continue
      if (plan.protoCase) finding.code = "join.protoVarNameLost"
      else finding.code = "join.sharedMatcherReorder"
    }
  }
}

async function runPlannedCase(rng: Rng, log: CaseLog, steps: number, plan: Plan): Promise<void> {
  log.op(`join.topology.${plan.topology}`)
  if (plan.eaches.length > 1) log.op("join.twoEaches")
  if (plan.idMode !== "full") log.op(`join.idMode.${plan.idMode}`)

  // The artifact pool: one canonical Mem for each id.
  const memPool = new Map<string, Mem>()
  for (let i = 0; i < 12; i++) memPool.set(`mem:${i}`, new Mem(`mem:${i}`, `v${rng.int(3)}`))
  const store = new MemoryStore()

  const sendLog: LogEntry[] = []
  const matchers = plan.varNamesByMatcher.map((varNames, i) => new FuzzMatcher(i, varNames, sendLog, rng.fork()))
  const build = new Build({ store })
  const metaByTask = new WeakMap<Task, TaskMeta>()
  const actualCalls: { key: CallKey; logLength: number }[] = []
  const execs: Exec[] = []
  const eventRng = rng.fork()
  let nestedSends = 0
  // What has been sent, by matcher: used only to choose the next event, never as the oracle.
  const sentView = plan.varNamesByMatcher.map(() => new Map<string, { vars: OVars; dataIds: string[] }>())

  // Error cases for the build.each config. Each one must throw, and the case then ends.
  if (rng.chance(0.04)) {
    checkConfigErrors(rng, log)
    return
  }

  // build.add tasks first, one of them maybe with the id of a joined set.
  if (rng.chance(0.15)) {
    const each = plan.eaches[0]!
    const vars: OVars = newVars()
    for (const name of each.union) vars[name] = rng.pick(plan.valuesByVar.get(name)!)
    const id = plan.idMode === "fixed" ? `t0:${idPartOf(plan, each, vars)}` : `t0:e1:${idPartOf(plan, each, vars)}`
    plan.addedTaskIds.push(id)
    build.add(new Task({ id, run: async () => {} }))
    log.op("join.addedTaskMayClash")
  }

  for (const each of plan.eaches) {
    const matchersByName: Record<string, FuzzMatcher> = {}
    for (let i = 0; i < each.names.length; i++) matchersByName[each.names[i]!] = matchers[each.matcherIndexes[i]!]!
    build.each({
      matchersByName,
      *tasks(vars, matched) {
        const dataIdsByName = new Map<string, string[]>()
        const mems: Mem[] = []
        for (const name of each.names) {
          const data = (matched as any)[name].data as Mem | Mem[]
          dataIdsByName.set(name, dataIdsOf(data))
          for (const mem of Array.isArray(data) ? data : [data]) mems.push(mem)
        }
        const membersByName = new Map<string, OMatch>()
        for (const name of each.names) membersByName.set(name, { vars: {}, dataIds: dataIdsByName.get(name)! })
        actualCalls.push({ key: callKeyOf(each.number, { vars: { ...vars }, membersByName }, each.names), logLength: sendLog.length })
        log.op("join.tasksCall")
        // A cap on nested sends: tasks() that sends on every call feeds itself without end
        // (DOCS.md section 10: a build.each that feeds itself is not bounded).
        if (nestedSends < 150 && eventRng.chance(plan.reentrantRate)) {
          nestedSends += 1
          log.op("join.reentrantFromTasks")
          sendRandomEvent("tasks()")
        }
        if (tasksThrowFor(plan, each, vars)) {
          log.op("join.tasksThrow")
          throw new Error(`tasks() threw for ${setKeyOf(each.union, vars)}`)
        }
        for (const spec of taskSpecsOf(plan, each, vars, dataIdsByName)) {
          const meta: TaskMeta = { eachNumber: each.number, vars: { ...vars }, inputIds: spec.inputIds, mems }
          const task: Task = new Task({
            id: spec.id,
            inputs: mems,
            run: async () => {
              const slot = (build as any).slots.get(spec.id)
              const current = slot !== undefined && slot.task === task
              if (!current) log.fail("join.staleStart", `task ${spec.id} started after it was replaced or removed`)
              const exec: Exec = { task, meta, values: mems.map((m) => m.value), ok: false, current }
              execs.push(exec)
              log.op("join.taskRun")
              if (nestedSends < 150 && eventRng.chance(plan.inRunEventRate)) {
                nestedSends += 1
                if (eventRng.chance(0.5)) await new Promise((r) => setTimeout(r, 0))
                log.op("join.eventDuringRun")
                sendRandomEvent("task.run")
              }
              if (eventRng.chance(0.3)) await Promise.resolve()
              if (plan.taskFailRate > 0 && hashString(spec.id) % 10 === 0) throw new Error(`task ${spec.id} fails`)
              exec.ok = true
            },
          })
          metaByTask.set(task, meta)
          yield task
        }
      },
    })
  }

  if (plan.subscriberRate > 0) {
    build.subscribe((event: ArtifactEvent) => {
      if (event.kind !== "promised") return
      if (nestedSends < 150 && eventRng.chance(plan.subscriberRate)) {
        nestedSends += 1
        log.op("join.eventFromSubscriber")
        sendRandomEvent("subscriber")
      }
    })
  }

  function randomVars(matcherIndex: number): OVars {
    const vars: OVars = newVars()
    for (const name of plan.varNamesByMatcher[matcherIndex]!) vars[name] = eventRng.pick(plan.valuesByVar.get(name)!)
    return vars
  }

  function randomData(): Mem | Mem[] {
    const ids = [...memPool.keys()]
    if (eventRng.chance(0.75)) return memPool.get(eventRng.pick(ids))!
    const list: Mem[] = []
    const n = eventRng.int(4)
    for (let i = 0; i < n; i++) list.push(memPool.get(eventRng.pick(ids))!)
    return list
  }

  function sendTracked(matcherIndex: number, event: SentEvent, origin: string): void {
    const varNames = plan.varNamesByMatcher[matcherIndex]!
    const vars = event.kind === "found" ? event.matched.vars : event.vars
    if (event.kind === "found") sentView[matcherIndex]!.set(matchKeyOf(varNames, vars), { vars, dataIds: dataIdsOf(event.matched.data) })
    else sentView[matcherIndex]!.delete(matchKeyOf(varNames, vars))
    matchers[matcherIndex]!.emit(event, origin)
  }

  function sendRandomEvent(origin: string): void {
    const matcherIndex = eventRng.int(matchers.length)
    const known = [...sentView[matcherIndex]!.values()]
    const roll = eventRng.next()
    if (plan.badVarsRate > 0 && eventRng.chance(plan.badVarsRate)) {
      const vars = randomVars(matcherIndex)
      if (eventRng.chance(0.5)) vars["zzExtra"] = "1"
      else delete vars[Object.keys(vars)[0]!]
      log.op("join.event.badVars")
      matchers[matcherIndex]!.emit({ kind: "found", matched: { vars, data: randomData() } }, origin)
      return
    }
    if (roll < 0.35 || known.length === 0) {
      log.op("join.event.found")
      sendTracked(matcherIndex, { kind: "found", matched: { vars: randomVars(matcherIndex), data: randomData() } }, origin)
    } else if (roll < 0.5) {
      // Same artifact ids, in new objects.
      const pick = eventRng.pick(known)
      // New Mem objects with the same ids, in the same shape.
      const sameIds = dataFromIds(pick.dataIds, (id) => new Mem(id, memPool.get(id)!.value))
      log.op("join.event.foundSameIds")
      sendTracked(matcherIndex, { kind: "found", matched: { vars: { ...pick.vars }, data: sameIds } }, origin)
    } else if (roll < 0.65) {
      const pick = eventRng.pick(known)
      log.op("join.event.foundNewData")
      sendTracked(matcherIndex, { kind: "found", matched: { vars: { ...pick.vars }, data: randomData() } }, origin)
    } else if (roll < 0.8) {
      const pick = eventRng.pick(known)
      log.op("join.event.gone")
      sendTracked(matcherIndex, { kind: "gone", vars: { ...pick.vars } }, origin)
    } else if (roll < 0.87) {
      log.op("join.event.goneMaybeUnknown")
      sendTracked(matcherIndex, { kind: "gone", vars: randomVars(matcherIndex) }, origin)
    } else if (roll < 0.94) {
      // The same event object two times.
      const event: SentEvent = { kind: "found", matched: { vars: randomVars(matcherIndex), data: randomData() } }
      log.op("join.event.sameEventTwice")
      sendTracked(matcherIndex, event, origin)
      sendTracked(matcherIndex, event, origin)
    } else {
      // Rapid churn: found, gone, found again with other data.
      const vars = randomVars(matcherIndex)
      log.op("join.event.churn")
      sendTracked(matcherIndex, { kind: "found", matched: { vars, data: randomData() } }, origin)
      sendTracked(matcherIndex, { kind: "gone", vars: { ...vars } }, origin)
      sendTracked(matcherIndex, { kind: "found", matched: { vars: { ...vars }, data: randomData() } }, origin)
    }
  }

  // ---- steps before run(): each top-level send, then a full comparison.
  let expectedFatal: ReplayResult["fatal"] = null
  const preSteps = rng.int(steps + 1)
  for (let step = 0; step < preSteps; step++) {
    const callsBefore = actualCalls.length
    const logBefore = sendLog.length
    sendRandomEvent("top")
    log.op("join.step")
    const result = replay(plan, sendLog)
    checkCalls(log, result, actualCalls, callsBefore, logBefore, sendLog.length, plan)
    if (result.fatal !== null) {
      expectedFatal = result.fatal
      break
    }
    checkBuildState(log, plan, build, result, metaByTask)
    if (log.findings.length > 0) return
  }

  // Some events come from the scans.
  if (expectedFatal === null) {
    for (const matcher of matchers) {
      const n = rng.int(4)
      for (let i = 0; i < n; i++) {
        const vars = randomVars(matcher.index)
        matcher.scanEvents.push({ kind: "found", matched: { vars, data: randomData() } })
      }
    }
  }

  // ---- run()
  let result: Result | null = null
  let rejection: unknown = null
  // Sometimes two run() calls at once: the second must wait for the same scans (DOCS.md, Build.run).
  const twoRuns = rng.chance(0.2)
  const runs = twoRuns ? [build.run(), build.run()] : [build.run()]
  const settled = await Promise.allSettled(runs)
  const first = settled[0]!
  if (first.status === "fulfilled") result = first.value
  else rejection = first.reason
  if (twoRuns) {
    log.op("join.twoRunsAtOnce")
    const second = settled[1]!
    if (second.status !== first.status) {
      log.fail("join.concurrentRunsDisagree", `first run() ${first.status}, second ${second.status}: ${String(second.status === "rejected" ? second.reason : first.status === "rejected" ? first.reason : "")}`)
    }
  }
  log.op("join.run")
  const final = replay(plan, sendLog, (example) => log.note("needs-decision: single artifact vs list of one", example))
  if (final.fatal !== null) {
    checkFatal(log, plan, final, rejection, actualCalls, sendLog)
    return
  }
  if (rejection !== null) {
    log.fail(classifyRejection(rejection, plan), `run() rejected but the oracle expects success: ${String(rejection)} | topology ${plan.topology} | log tail ${show(sendLog.slice(-3))}`)
    return
  }
  checkAllCalls(log, final, actualCalls, plan)
  checkBuildState(log, plan, build, final, metaByTask)
  checkFirstRun(log, plan, build, result!, metaByTask, execs)
  if (log.findings.length > 0) return

  // A second run() of the same build starts nothing new.
  const execsBefore = execs.length
  await build.run()
  log.op("join.secondRun")
  if (execs.length !== execsBefore) log.fail("join.secondRunRan", `second run() ran ${execs.length - execsBefore} tasks`)

  // ---- restart: a new Build and new matchers over the same store. The scans send the final matches.
  await restartAndCheck(rng, log, plan, final, memPool, store, execs, metaByTask, build)
}

/** The input state as the store sees it: each distinct artifact id with its stamp, sorted. */
function inputStateOf(ids: string[], values: (string | null)[]): string {
  const byId = new Map<string, string | null>()
  for (let i = 0; i < ids.length; i++) byId.set(ids[i]!, values[i]!)
  return show([...byId].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)))
}

function classifyRejection(error: unknown, plan: Plan): string {
  const text = String(error)
  if (text.includes("URIError")) return "join.loneSurrogateVarFails"
  return "join.unexpectedReject"
}

function checkCalls(
  log: CaseLog,
  result: ReplayResult,
  actualCalls: { key: CallKey; logLength: number }[],
  callsBefore: number,
  logBefore: number,
  logAfter: number,
  plan: Plan,
): void {
  const expected: CallKey[] = []
  const lastEntry = result.fatal !== null ? result.fatal.entryIndex : logAfter - 1
  for (let i = logBefore; i <= Math.min(lastEntry, logAfter - 1); i++) expected.push(...(result.callsByEntry[i] ?? []))
  const actual = actualCalls.slice(callsBefore).map((c) => c.key)
  if (result.fatal !== null) {
    // The fatal entry may stop part way: the actual calls are a subset of the expected calls.
    const remaining = [...expected]
    for (const key of actual) {
      const at = remaining.indexOf(key)
      if (at < 0) {
        log.fail("join.callAfterFatalOrUnexpected", `call ${key} is not expected; fatal ${show(result.fatal)}`)
        return
      }
      remaining.splice(at, 1)
    }
    return
  }
  const a = [...actual].sort()
  const e = [...expected].sort()
  if (show(a) !== show(e)) {
    log.fail(plan.protoCase ? "join.protoVarNameLost" : "join.tasksCalls", `tasks() calls differ.\nexpected ${show(e)}\nactual   ${show(a)}\nlog ${show(log.ops)} topology ${plan.topology}`)
  }
}

function checkAllCalls(log: CaseLog, result: ReplayResult, actualCalls: { key: CallKey }[], plan: Plan): void {
  const expected: CallKey[] = []
  for (const calls of result.callsByEntry) expected.push(...calls)
  const a = actualCalls.map((c) => c.key).sort()
  const e = expected.sort()
  if (show(a) !== show(e)) {
    const missing = e.filter((k) => !a.includes(k)).slice(0, 5)
    const extra = a.filter((k) => !e.includes(k)).slice(0, 5)
    log.fail(plan.protoCase ? "join.protoVarNameLost" : "join.tasksCallsTotal", `tasks() calls over the whole run differ: ${a.length} actual, ${e.length} expected. missing ${show(missing)} extra ${show(extra)}`)
  }
}

/** The tasks the build holds must be exactly the tasks of the oracle's joined sets, with their data. */
function checkBuildState(log: CaseLog, plan: Plan, build: Build, result: ReplayResult, metaByTask: WeakMap<Task, TaskMeta>): void {
  const slots = (build as any).slots as Map<string, { task: Task; group: { label: string } }>
  const expectedIds = new Set<string>(plan.addedTaskIds)
  const groupBySet = new Map<string, unknown>()
  for (const each of plan.eaches) {
    for (const set of result.setsByEach.get(each.number)!) {
      const dataIdsByName = new Map<string, string[]>()
      for (const [n, m] of set.membersByName) dataIdsByName.set(n, m.dataIds)
      const specs = taskSpecsOf(plan, each, set.vars, dataIdsByName)
      for (const spec of specs) {
        expectedIds.add(spec.id)
        const slot = slots.get(spec.id)
        if (slot === undefined) {
          log.fail("join.missingTask", `task ${spec.id} of set ${set.key} is not in the build`)
          continue
        }
        const meta = metaByTask.get(slot.task)
        if (meta === undefined) {
          log.fail("join.foreignTask", `task ${spec.id} has no meta`)
          continue
        }
        if (show(meta.vars) !== show(set.vars)) {
          let code = "join.wrongVars"
          if (plan.protoCase) code = "join.protoVarNameLost"
          log.fail(code, `task ${spec.id}: vars ${show(meta.vars)}, expected ${show(set.vars)} (union ${show(each.union)})`)
        }
        if (show(meta.inputIds) !== show(spec.inputIds)) {
          log.fail("join.staleData", `task ${spec.id}: inputs ${show(meta.inputIds)}, expected ${show(spec.inputIds)}`)
        }
        const label = oracleLabel(each.number, each.union, set.vars)
        if (slot.group.label !== label) {
          log.fail(plan.protoCase ? "join.protoVarNameLost" : "join.label", `task ${spec.id}: group label ${show(slot.group.label)}, expected ${show(label)}`)
        }
        const setId = `${each.number}|${set.key}`
        const known = groupBySet.get(setId)
        if (known !== undefined && known !== slot.group) log.fail("join.groupSplit", `set ${setId} has two groups`)
        groupBySet.set(setId, slot.group)
      }
    }
  }
  const seenGroups = new Map<unknown, string>()
  for (const [setId, group] of groupBySet) {
    const other = seenGroups.get(group)
    if (other !== undefined) log.fail("join.groupShared", `sets ${other} and ${setId} share one group`)
    seenGroups.set(group, setId)
  }
  for (const id of slots.keys()) {
    if (!expectedIds.has(id)) log.fail("join.extraTask", `the build holds task ${id}, which no joined set gives`)
  }
}

function checkFatal(
  log: CaseLog,
  plan: Plan,
  final: ReplayResult,
  rejection: unknown,
  actualCalls: { key: CallKey }[],
  sendLog: LogEntry[],
): void {
  const fatal = final.fatal!
  log.op(`join.fatal.${fatal.reasons.join("+")}`)
  if (fatal.reasons.includes("surrogate")) {
    // The docs allow any string as a var value. dapat rejects instead: a finding, counted by code.
    if (rejection !== null) log.fail("join.loneSurrogateVarFails", `run() rejected with ${String(rejection)} for vars ${fatal.detail}`)
    return
  }
  if (rejection === null) {
    log.fail("join.fatalNotReported", `oracle expects a fatal ${show(fatal)}, but run() resolved`)
    return
  }
  const text = String(rejection)
  const textByReason: Record<string, string> = {
    throw: "tasks() threw",
    clash: "is in two groups",
    badVars: "matched an artifact with vars",
  }
  if (!fatal.reasons.some((reason) => text.includes(textByReason[reason]!))) {
    log.fail("join.wrongFatal", `expected one of ${show(fatal.reasons)} (${fatal.detail}), got ${text}`)
  }
  // No tasks() call may happen for an entry after the fatal one.
  const allowed: CallKey[] = []
  for (let i = 0; i <= fatal.entryIndex; i++) allowed.push(...(final.callsByEntry[i] ?? []))
  for (const call of actualCalls) {
    const at = allowed.indexOf(call.key)
    if (at < 0) {
      log.fail("join.callAfterFatal", `tasks() call ${call.key} after the fatal entry ${fatal.entryIndex}`)
      return
    }
    allowed.splice(at, 1)
  }
}

function checkFirstRun(
  log: CaseLog,
  plan: Plan,
  build: Build,
  result: Result,
  metaByTask: WeakMap<Task, TaskMeta>,
  execs: Exec[],
): void {
  const slots = (build as any).slots as Map<string, { task: Task; phase: string }>
  const executed = new Set(result.executed)
  const skipped = new Set(result.skipped)
  const failed = result.failed
  for (const [id, slot] of slots) {
    if (slot.phase !== "completed") log.fail("join.notFinished", `task ${id} is ${slot.phase} after run()`)
    if (plan.addedTaskIds.includes(id)) continue
    const task = slot.task
    const meta = metaByTask.get(task)!
    const willFail = plan.taskFailRate > 0 && hashString(id) % 10 === 0
    if (willFail) {
      if (!failed.has(task) && !skipped.has(task)) log.fail("join.failNotReported", `task ${id} should fail`)
      continue
    }
    if (executed.has(task)) {
      const ran = execs.filter((e) => e.task === task && e.ok)
      if (ran.length !== 1) log.fail("join.execCount", `task ${id} is in executed but ran ${ran.length} times`)
      continue
    }
    if (skipped.has(task)) {
      // A skip in the first build is right only when an earlier run of this id, with the same input values, recorded.
      // The record keys input stamps by artifact id, so the order and repeats of inputs are not in it.
      const now = inputStateOf(meta.inputIds, meta.mems.map((m) => m.value))
      const earlier = execs.some((e) => e.task.id === id && e.ok && e.current && inputStateOf(e.meta.inputIds, e.values) === now)
      const sameList = execs.some((e) => e.task.id === id && e.ok && e.current && show([e.meta.inputIds, e.values]) === show([meta.inputIds, meta.mems.map((m) => m.value)]))
      if (earlier && !sameList) log.note("needs-decision: skip ignores input order and repeats", `task ${id}: ran with ${show(execs.filter((e) => e.task.id === id).map((e) => e.meta.inputIds))}, skipped with ${show(meta.inputIds)}`)
      if (!earlier) {
        const runs = execs.filter((e) => e.task.id === id).map((e) => ({ inputs: e.meta.inputIds, values: e.values, ok: e.ok, current: e.current }))
        log.fail("join.wrongSkip", `task ${id} skipped in the first build with no earlier run of the same inputs. now ${show([meta.inputIds, meta.mems.map((m) => m.value)])}; runs of this id ${show(runs)}`)
      }
      continue
    }
    log.fail("join.liveTaskDidNotRun", `live task ${id} has outcome ${show((build as any).outcomes.get(task))}`)
  }
}

async function restartAndCheck(
  rng: Rng,
  log: CaseLog,
  plan: Plan,
  final: ReplayResult,
  memPool: Map<string, Mem>,
  store: MemoryStore,
  execsBefore: Exec[],
  metaByTaskBefore: WeakMap<Task, TaskMeta>,
  oldBuild: Build,
): Promise<void> {
  // The tasks that ended current and good in the old build: id -> input values then.
  const goodValues = new Map<string, string>()
  const oldSlots = (oldBuild as any).slots as Map<string, { task: Task }>
  const oldOutcomes = (oldBuild as any).outcomes as Map<Task, { type: string }>
  for (const [id, slot] of oldSlots) {
    const outcome = oldOutcomes.get(slot.task)
    const meta = metaByTaskBefore.get(slot.task)
    if (meta === undefined || outcome === undefined) continue
    if (outcome.type !== "executed" && outcome.type !== "skipped") continue
    goodValues.set(id, inputStateOf(meta.inputIds, meta.mems.map((m) => m.value)))
  }
  // Change some values between builds.
  for (const mem of memPool.values()) {
    if (rng.chance(0.2)) {
      mem.write(`v${rng.int(5)}`)
      log.op("join.restart.valueEdit")
    }
  }
  for (let round = 0; round < 2; round++) {
    const sendLog: LogEntry[] = []
    const matchers = plan.varNamesByMatcher.map((varNames, i) => new FuzzMatcher(i, varNames, sendLog, rng.fork()))
    // The scans send the final matches of the old build, in a random order, some of them two times.
    for (const each of plan.eaches) {
      for (const set of final.setsByEach.get(each.number)!) {
        for (let i = 0; i < each.names.length; i++) {
          const member = set.membersByName.get(each.names[i]!)!
          const matcher = matchers[each.matcherIndexes[i]!]!
          const data = dataFromIds(member.dataIds, (id) => memPool.get(id)!)
          matcher.scanEvents.push({ kind: "found", matched: { vars: { ...member.vars }, data } })
        }
      }
    }
    for (const matcher of matchers) rng.shuffle(matcher.scanEvents)
    const build = new Build({ store })
    const metaByTask = new WeakMap<Task, TaskMeta>()
    const ran = new Set<string>()
    for (const id of plan.addedTaskIds) build.add(new Task({ id, run: async () => {} }))
    for (const each of plan.eaches) {
      const matchersByName: Record<string, FuzzMatcher> = {}
      for (let i = 0; i < each.names.length; i++) matchersByName[each.names[i]!] = matchers[each.matcherIndexes[i]!]!
      build.each({
        matchersByName,
        *tasks(vars, matched) {
          const dataIdsByName = new Map<string, string[]>()
          const mems: Mem[] = []
          for (const name of each.names) {
            const data = (matched as any)[name].data as Mem | Mem[]
            dataIdsByName.set(name, dataIdsOf(data))
            for (const mem of Array.isArray(data) ? data : [data]) mems.push(mem)
          }
          for (const spec of taskSpecsOf(plan, each, vars, dataIdsByName)) {
            const task = new Task({
              id: spec.id,
              inputs: mems,
              run: async () => {
                ran.add(spec.id)
                if (plan.taskFailRate > 0 && hashString(spec.id) % 10 === 0) throw new Error("fails")
              },
            })
            metaByTask.set(task, { eachNumber: each.number, vars: { ...vars }, inputIds: spec.inputIds, mems })
            yield task
          }
        },
      })
    }
    const result = await build.run()
    log.op("join.restartBuild")
    const slots = (build as any).slots as Map<string, { task: Task }>
    // Same task set as the old build.
    const oldIds = [...oldSlots.keys()].sort()
    const newIds = [...slots.keys()].sort()
    if (show(oldIds) !== show(newIds)) log.fail("join.restartTaskSet", `restart has tasks ${show(newIds)}, old build ${show(oldIds)}`)
    const skipped = new Set(result.skipped)
    for (const [id, slot] of slots) {
      if (plan.addedTaskIds.includes(id)) continue
      const meta = metaByTask.get(slot.task)!
      const now = inputStateOf(meta.inputIds, meta.mems.map((m) => m.value))
      const willFail = plan.taskFailRate > 0 && hashString(id) % 10 === 0
      if (meta.mems.length === 0) {
        if (!ran.has(id) && !willFail) log.fail("join.noInputSkipped", `task ${id} has no input and did not run`)
        continue
      }
      const before = goodValues.get(id)
      if (before === undefined) continue
      if (before === now) {
        if (!skipped.has(slot.task)) log.fail("join.unchangedRan", `round ${round}: task ${id} has the same inputs ${now} as its last good run, but it ran`)
      } else {
        if (!ran.has(id)) log.fail("join.changedSkipped", `round ${round}: task ${id} inputs changed ${before} -> ${now}, but it did not run`)
      }
    }
    // For the next round: nothing changes, so every good task must skip.
    goodValues.clear()
    for (const [id, slot] of slots) {
      const outcome = (build as any).outcomes.get(slot.task)
      const meta = metaByTask.get(slot.task)
      if (meta === undefined || outcome === undefined) continue
      if (outcome.type !== "executed" && outcome.type !== "skipped") continue
      goodValues.set(id, inputStateOf(meta.inputIds, meta.mems.map((m) => m.value)))
    }
    if (log.findings.length > 0) return
  }
}


// ---------------------------------------------------------------- config errors

function checkConfigErrors(rng: Rng, log: CaseLog): void {
  const noLog: LogEntry[] = []
  const kind = rng.pick(["unconnected", "sameObject", "empty", "otherBuild", "afterRun", "noVarWithOthers"])
  log.op(`join.configError.${kind}`)
  const build = new Build()
  const expectThrow = (fn: () => void, needle: string) => {
    try {
      fn()
    } catch (error) {
      if (!String(error).includes(needle)) log.fail("join.configErrorMessage", `${kind}: ${String(error)} lacks ${show(needle)}`)
      return
    }
    log.fail("join.configErrorNotThrown", `${kind}: build.each did not throw`)
  }
  const tasks = function* () {}
  if (kind === "unconnected") {
    const a = new FuzzMatcher(0, ["a"], noLog, rng.fork())
    const b = new FuzzMatcher(1, ["b"], noLog, rng.fork())
    const c = new FuzzMatcher(2, ["a", "c"], noLog, rng.fork())
    expectThrow(() => build.each({ matchersByName: { a, c, b }, tasks }), "'b'")
  } else if (kind === "sameObject") {
    const a = new FuzzMatcher(0, ["a"], noLog, rng.fork())
    expectThrow(() => build.each({ matchersByName: { x: a, y: a }, tasks }), "one matcher object")
  } else if (kind === "empty") {
    expectThrow(() => build.each({ matchersByName: {}, tasks }), "no matcher")
  } else if (kind === "otherBuild") {
    const a = new FuzzMatcher(0, ["a"], noLog, rng.fork())
    new Build().each({ matchersByName: { a }, tasks })
    expectThrow(() => build.each({ matchersByName: { a }, tasks }), "another Build")
  } else if (kind === "afterRun") {
    void build.run()
    const a = new FuzzMatcher(0, ["a"], noLog, rng.fork())
    expectThrow(() => build.each({ matchersByName: { a }, tasks }), "before the first build.run()")
  } else {
    const a = new FuzzMatcher(0, ["a"], noLog, rng.fork())
    const none = new FuzzMatcher(1, [], noLog, rng.fork())
    expectThrow(() => build.each({ matchersByName: { a, none }, tasks }), "'none'")
  }
}
