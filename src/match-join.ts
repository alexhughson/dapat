import type { MatchedArtifact, Vars } from "./matched-artifact"
import type { TaskGroup } from "./task-group"

/** The JSON list of the var values of a match, in its matcher's varNames order. */
type VarsKey = string

/** The values of some join var names, in a fixed order, as a JSON list like a VarsKey. */
type JoinKey = string

/** The current match of one vars key of one matcher. */
export type StoredMatch = {
  matched: MatchedArtifact
  // A found event with the same artifact ids does nothing.
  artifactIds: string
  // The joined sets that hold this match.
  sets: Set<JoinedSet>
}

/** One match of each matcher, where the var names that two matchers share have the same values. */
export type JoinedSet = {
  // The vars of all its matches, in the union var name order of the build.each.
  vars: Vars
  membersByName: Map<string, StoredMatch>
  group: TaskGroup
}

/**
 * One index of a matcher: its matches by the values of some of its var names.
 * A changed match of another matcher finds its partners here.
 */
type JoinIndex = {
  lookupVarNames: readonly string[]
  matchesByJoinKey: Map<JoinKey, Set<StoredMatch>>
}

/**
 * The matches of one matcher in one build.each. It has one index for each set of
 * var names that the join looks it up by, so a matcher can have several indexes.
 */
export class MatchTable {
  private readonly matchesByVarsKey = new Map<VarsKey, StoredMatch>()
  // By the JSON of lookupVarNames. Two join steps with the same var names share one index.
  private readonly indexesByVarNames = new Map<string, JoinIndex>()

  constructor(
    readonly name: string,
    readonly varNames: readonly string[],
    private readonly eachNumber: number,
  ) {}

  addIndex(lookupVarNames: readonly string[]): void {
    const indexName = JSON.stringify(lookupVarNames)
    if (this.indexesByVarNames.has(indexName)) return
    this.indexesByVarNames.set(indexName, { lookupVarNames, matchesByJoinKey: new Map() })
  }

  /** The match with these vars. Throws if the var names are not this matcher's varNames. */
  get(vars: Vars): StoredMatch | undefined {
    return this.matchesByVarsKey.get(this.varsKeyOf(vars))
  }

  /** Adds a match with new vars. A match with known vars changes in place, so it needs no put. */
  put(stored: StoredMatch): void {
    this.matchesByVarsKey.set(this.varsKeyOf(stored.matched.vars), stored)
    for (const index of this.indexesByVarNames.values()) {
      const joinKey = keyOfVars(stored.matched.vars, index.lookupVarNames)
      let matches = index.matchesByJoinKey.get(joinKey)
      if (matches === undefined) {
        matches = new Set()
        index.matchesByJoinKey.set(joinKey, matches)
      }
      matches.add(stored)
    }
  }

  delete(stored: StoredMatch): void {
    this.matchesByVarsKey.delete(this.varsKeyOf(stored.matched.vars))
    for (const index of this.indexesByVarNames.values()) {
      const joinKey = keyOfVars(stored.matched.vars, index.lookupVarNames)
      const matches = index.matchesByJoinKey.get(joinKey)!
      matches.delete(stored)
      if (matches.size === 0) {
        index.matchesByJoinKey.delete(joinKey)
      }
    }
  }

  /** The matches whose lookupVarNames have the values in `vars`. */
  lookup(lookupVarNames: readonly string[], vars: Vars): ReadonlySet<StoredMatch> {
    const index = this.indexesByVarNames.get(JSON.stringify(lookupVarNames))!
    return index.matchesByJoinKey.get(keyOfVars(vars, lookupVarNames)) ?? new Set()
  }

  /** The number of join keys in all indexes. A join key with no match is deleted, so this is 0 when the table is empty. */
  get joinKeyCount(): number {
    let count = 0
    for (const index of this.indexesByVarNames.values()) {
      count += index.matchesByJoinKey.size
    }
    return count
  }

  private varsKeyOf(vars: Vars): VarsKey {
    const given = Object.keys(vars)
    let sameNames = given.length === this.varNames.length
    for (const name of this.varNames) {
      if (!Object.hasOwn(vars, name)) sameNames = false
    }
    if (!sameNames) {
      throw new Error(
        `matcher '${this.name}' of build.each ${this.eachNumber} matched an artifact with vars ` +
          `[${given.join(", ")}]; its varNames are [${this.varNames.join(", ")}]`,
      )
    }
    return keyOfVars(vars, this.varNames)
  }
}

/**
 * One step of the join from a changed match: look up the matches of `table` whose
 * `lookupVarNames` have the values that the earlier steps found. `lookupVarNames` holds
 * every var of `table` that an earlier step has, so each match that the lookup gives agrees
 * with every earlier match, and needs no other check.
 */
export type JoinStep = {
  table: MatchTable
  lookupVarNames: readonly string[]
}

/** A joined set before it has a task group. */
export type JoinedMembers = {
  vars: Record<string, string>
  membersByName: Map<string, StoredMatch>
}

/**
 * For each matcher, the join steps that start from one of its matches, in an order where
 * each step shares a var name with an earlier one. Adds the index that each step needs.
 * Throws if the matchers do not form one connected group by shared var names.
 */
export function planJoins(tables: readonly MatchTable[], eachNumber: number): Map<string, JoinStep[]> {
  const stepsByName = new Map<string, JoinStep[]>()
  for (const start of tables) {
    const steps: JoinStep[] = []
    const placedNames = new Set<string>([start.name])
    const boundVarNames = new Set<string>(start.varNames)
    let placedOne = true
    while (placedOne) {
      placedOne = false
      for (const table of tables) {
        if (placedNames.has(table.name)) continue
        const lookupVarNames: string[] = []
        for (const varName of table.varNames) {
          if (boundVarNames.has(varName)) lookupVarNames.push(varName)
        }
        if (lookupVarNames.length === 0) continue
        table.addIndex(lookupVarNames)
        steps.push({ table, lookupVarNames })
        placedNames.add(table.name)
        for (const varName of table.varNames) {
          boundVarNames.add(varName)
        }
        placedOne = true
      }
    }
    const unplacedNames: string[] = []
    for (const table of tables) {
      if (!placedNames.has(table.name)) unplacedNames.push(`'${table.name}'`)
    }
    if (unplacedNames.length > 0) {
      throw new Error(
        `build.each ${eachNumber}: the matchers [${unplacedNames.join(", ")}] share no var name with matcher '${start.name}' ` +
          `or its partners; each matcher must share a var name with another matcher`,
      )
    }
    stepsByName.set(start.name, steps)
  }
  return stepsByName
}

/** Every joined set that holds `start`, a match of `table`. */
export function joinFrom(table: MatchTable, start: StoredMatch, steps: readonly JoinStep[]): JoinedMembers[] {
  let partialSets: JoinedMembers[] = [
    { vars: { ...start.matched.vars }, membersByName: new Map([[table.name, start]]) },
  ]
  for (const step of steps) {
    const longerSets: JoinedMembers[] = []
    for (const partial of partialSets) {
      for (const partner of step.table.lookup(step.lookupVarNames, partial.vars)) {
        const vars = { ...partial.vars, ...partner.matched.vars }
        const membersByName = new Map(partial.membersByName)
        membersByName.set(step.table.name, partner)
        longerSets.push({ vars, membersByName })
      }
    }
    partialSets = longerSets
  }
  return partialSets
}

/**
 * The JSON list of the values of `varNames`, in that order.
 * JSON, not encodeURIComponent: that throws on a lone surrogate, and a var value can hold one.
 */
function keyOfVars(vars: Vars, varNames: readonly string[]): string {
  const values: string[] = []
  for (const name of varNames) {
    values.push(vars[name]!)
  }
  return JSON.stringify(values)
}
