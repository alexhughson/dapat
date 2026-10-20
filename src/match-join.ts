import type { AnyMatcher } from "./matcher"
import type { MatchedArtifact, Vars } from "./matched-artifact"

/** The var values of a match in its matcher's varNames order, each URI-encoded, joined with "/". */
export type VarsKey = string

/** The values of some join var names, in a fixed order, encoded like a VarsKey. */
type JoinKey = string

/** The current match of one vars key. */
export type StoredMatch = {
  matched: MatchedArtifact
  // A found event with the same artifact ids does nothing.
  artifactIds: string
  // The keys of the joined sets that hold this match.
  setKeys: Set<string>
}

/**
 * One lookup of the join: the vars keys of the matches of one matcher, by the values
 * of some of its var names. A changed match of another matcher finds its partners here.
 */
type JoinIndex = {
  lookupVarNames: readonly string[]
  varsKeysByJoinKey: Map<JoinKey, Set<VarsKey>>
}

/** The matches of one matcher in one build.each, and the indexes that the join looks them up by. */
export class MatchTable {
  readonly varNames: readonly string[]
  private readonly matchesByVarsKey = new Map<VarsKey, StoredMatch>()
  // By the JSON of lookupVarNames. Two join steps with the same var names share one index.
  private readonly indexesByVarNames = new Map<string, JoinIndex>()

  constructor(
    readonly name: string,
    readonly matcher: AnyMatcher,
    private readonly eachNumber: number,
  ) {
    this.varNames = matcher.varNames
  }

  addIndex(lookupVarNames: readonly string[]): void {
    const indexName = JSON.stringify(lookupVarNames)
    if (this.indexesByVarNames.has(indexName)) return
    this.indexesByVarNames.set(indexName, { lookupVarNames, varsKeysByJoinKey: new Map() })
  }

  get(varsKey: VarsKey): StoredMatch | undefined {
    return this.matchesByVarsKey.get(varsKey)
  }

  /** Adds a match with new vars. A match with known vars changes in place, so it needs no put. */
  put(varsKey: VarsKey, stored: StoredMatch): void {
    this.matchesByVarsKey.set(varsKey, stored)
    for (const index of this.indexesByVarNames.values()) {
      const joinKey = keyOfVars(stored.matched.vars, index.lookupVarNames)
      let varsKeys = index.varsKeysByJoinKey.get(joinKey)
      if (varsKeys === undefined) {
        varsKeys = new Set()
        index.varsKeysByJoinKey.set(joinKey, varsKeys)
      }
      varsKeys.add(varsKey)
    }
  }

  delete(varsKey: VarsKey): void {
    const stored = this.matchesByVarsKey.get(varsKey)
    if (stored === undefined) return
    this.matchesByVarsKey.delete(varsKey)
    for (const index of this.indexesByVarNames.values()) {
      const joinKey = keyOfVars(stored.matched.vars, index.lookupVarNames)
      const varsKeys = index.varsKeysByJoinKey.get(joinKey)
      if (varsKeys === undefined) continue
      varsKeys.delete(varsKey)
      if (varsKeys.size === 0) {
        index.varsKeysByJoinKey.delete(joinKey)
      }
    }
  }

  /** The vars keys of the matches whose lookupVarNames have the values in `vars`. */
  lookup(lookupVarNames: readonly string[], vars: Vars): ReadonlySet<VarsKey> {
    const index = this.indexesByVarNames.get(JSON.stringify(lookupVarNames))!
    const joinKey = keyOfVars(vars, lookupVarNames)
    return index.varsKeysByJoinKey.get(joinKey) ?? new Set()
  }

  /** The vars key of a match. Throws if its var names are not this matcher's varNames. */
  varsKeyOf(vars: Vars): VarsKey {
    const given = Object.keys(vars)
    let sameNames = given.length === this.varNames.length
    for (const name of this.varNames) {
      if (!Object.hasOwn(vars, name)) {
        sameNames = false
        break
      }
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

/** A joined set before it has a task group: its vars, and the vars key of the match of each matcher. */
export type JoinedMatches = {
  vars: Record<string, string>
  varsKeyByName: Map<string, VarsKey>
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
    if (placedNames.size < tables.length) {
      const joined: string[] = []
      const apart: string[] = []
      for (const table of tables) {
        if (placedNames.has(table.name)) {
          joined.push(`'${table.name}'`)
        } else {
          apart.push(`'${table.name}'`)
        }
      }
      throw new Error(
        `build.each ${eachNumber}: the matchers [${joined.join(", ")}] share no var name with the matchers ` +
          `[${apart.join(", ")}]; each matcher must share a var name with another matcher, or the join is a cross product`,
      )
    }
    stepsByName.set(start.name, steps)
  }
  return stepsByName
}

/** Every joined set that holds the match `startVarsKey` of `start`. */
export function joinFrom(start: MatchTable, startVarsKey: VarsKey, steps: readonly JoinStep[]): JoinedMatches[] {
  const startMatch = start.get(startVarsKey)!
  let partialSets: JoinedMatches[] = [
    {
      vars: { ...startMatch.matched.vars },
      varsKeyByName: new Map([[start.name, startVarsKey]]),
    },
  ]
  for (const step of steps) {
    const longerSets: JoinedMatches[] = []
    for (const partial of partialSets) {
      const partnerKeys = step.table.lookup(step.lookupVarNames, partial.vars)
      for (const partnerKey of partnerKeys) {
        const partner = step.table.get(partnerKey)!
        const vars = { ...partial.vars, ...partner.matched.vars }
        const varsKeyByName = new Map(partial.varsKeyByName)
        varsKeyByName.set(step.table.name, partnerKey)
        longerSets.push({ vars, varsKeyByName })
      }
    }
    partialSets = longerSets
  }
  return partialSets
}

/** The values of `varNames` in that order, each URI-encoded, joined with "/". */
export function keyOfVars(vars: Vars, varNames: readonly string[]): string {
  const parts: string[] = []
  for (const name of varNames) {
    parts.push(encodeURIComponent(vars[name]!))
  }
  return parts.join("/")
}
