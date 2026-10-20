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

/**
 * One result of the join of the required matchers: one match of each, where the var names that
 * two of them share have the same values. The matchers that are not required left-join onto it.
 */
export type BaseSet = {
  // The vars of its required matches.
  vars: Vars
  requiredMembersByName: Map<string, StoredMatch>
  // For each matcher that is not required: its current matches that agree with `vars`. Empty when it has none.
  optionalMatchesByName: Map<string, Set<StoredMatch>>
  // The joined sets that the chain of left joins gives now, by the JSON of their vars in union order.
  joinedSetsByVarsKey: Map<string, JoinedSet>
}

/** A base set with the matches that the left joins add to it. It has the task group. */
export type JoinedSet = {
  base: BaseSet
  // Its key in base.joinedSetsByVarsKey.
  varsKey: string
  // The vars of all its matches, in the union var name order of the build.each.
  // A var of a matcher that is not required and has no match in the set is not here.
  vars: Vars
  // A matcher that is not required is not here when the set has no match of it.
  membersByName: Map<string, StoredMatch>
  group: TaskGroup
}

/**
 * Items by the values of some var names. A MatchTable keeps its matches in these indexes,
 * so a changed match of another matcher finds its partners here. A matcher that is not
 * required keeps the base sets in one, by the var names that it shares with the required matchers.
 */
export class JoinIndex<T> {
  private readonly itemsByJoinKey = new Map<JoinKey, Set<T>>()

  constructor(readonly lookupVarNames: readonly string[]) {}

  /** `vars` must have a value for each of lookupVarNames. */
  add(vars: Vars, item: T): void {
    const joinKey = keyOfVars(vars, this.lookupVarNames)
    let items = this.itemsByJoinKey.get(joinKey)
    if (items === undefined) {
      items = new Set()
      this.itemsByJoinKey.set(joinKey, items)
    }
    items.add(item)
  }

  delete(vars: Vars, item: T): void {
    const joinKey = keyOfVars(vars, this.lookupVarNames)
    const items = this.itemsByJoinKey.get(joinKey)!
    items.delete(item)
    if (items.size === 0) {
      this.itemsByJoinKey.delete(joinKey)
    }
  }

  /** The items whose lookupVarNames have the values in `vars`. */
  lookup(vars: Vars): ReadonlySet<T> {
    return this.itemsByJoinKey.get(keyOfVars(vars, this.lookupVarNames)) ?? new Set()
  }

  /** A join key with no item is deleted, so this is 0 when the index is empty. */
  get joinKeyCount(): number {
    return this.itemsByJoinKey.size
  }
}

/**
 * The matches of one matcher in one build.each. It has one index for each set of
 * var names that the join looks it up by, so a matcher can have several indexes.
 */
export class MatchTable {
  private readonly matchesByVarsKey = new Map<VarsKey, StoredMatch>()
  // By the JSON of lookupVarNames. Two join steps with the same var names share one index.
  private readonly indexesByVarNames = new Map<string, JoinIndex<StoredMatch>>()

  constructor(
    readonly name: string,
    readonly varNames: readonly string[],
    private readonly eachNumber: number,
  ) {}

  addIndex(lookupVarNames: readonly string[]): void {
    const indexName = JSON.stringify(lookupVarNames)
    if (this.indexesByVarNames.has(indexName)) return
    this.indexesByVarNames.set(indexName, new JoinIndex(lookupVarNames))
  }

  /** The match with these vars. Throws if the var names are not this matcher's varNames. */
  get(vars: Vars): StoredMatch | undefined {
    return this.matchesByVarsKey.get(this.varsKeyOf(vars))
  }

  /** Adds a match with new vars. A match with known vars changes in place, so it needs no put. */
  put(stored: StoredMatch): void {
    this.matchesByVarsKey.set(this.varsKeyOf(stored.matched.vars), stored)
    for (const index of this.indexesByVarNames.values()) {
      index.add(stored.matched.vars, stored)
    }
  }

  delete(stored: StoredMatch): void {
    this.matchesByVarsKey.delete(this.varsKeyOf(stored.matched.vars))
    for (const index of this.indexesByVarNames.values()) {
      index.delete(stored.matched.vars, stored)
    }
  }

  /** The matches whose lookupVarNames have the values in `vars`. */
  lookup(lookupVarNames: readonly string[], vars: Vars): ReadonlySet<StoredMatch> {
    return this.indexesByVarNames.get(JSON.stringify(lookupVarNames))!.lookup(vars)
  }

  /** The number of join keys in all indexes. A join key with no match is deleted, so this is 0 when the table is empty. */
  get joinKeyCount(): number {
    let count = 0
    for (const index of this.indexesByVarNames.values()) {
      count += index.joinKeyCount
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
        `matcher '${this.name}' of build.each ${this.eachNumber} sent vars ` +
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
 * `tables` are the required matchers. Throws if they do not form one connected group by shared var names.
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
        `build.each ${eachNumber}: the required matchers [${unplacedNames.join(", ")}] share no var name with required matcher ` +
          `'${start.name}' or its required partners; each required matcher must share a var name with another required matcher, ` +
          `and a matcher that is not required does not connect them`,
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
