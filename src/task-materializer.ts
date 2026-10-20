import type { Artifact } from "./artifact"
import type { AnyMatcher, DataOf } from "./matcher"
import type { MatchedArtifact, MatchedArtifactEvent, MatchedData, Vars } from "./matched-artifact"
import { JoinIndex, MatchTable, joinFrom, planJoins, type BaseSet, type JoinStep, type JoinedSet, type StoredMatch } from "./match-join"
import type { Task } from "./task"
import { TaskGroup } from "./task-group"

/**
 * What `tasks` gets: the matched artifact of each matcher, by name, with the data type of that matcher.
 * A matcher in `R`, the required names, always has one. Another matcher can have none.
 */
export type MatchedByName<M extends Record<string, AnyMatcher>, R extends keyof M & string = keyof M & string> = {
  readonly [K in keyof M]: K extends R ? MatchedArtifact<DataOf<M[K]>> : MatchedArtifact<DataOf<M[K]>> | undefined
}

/**
 * The vars that `tasks` gets. With every matcher required, each var has a value. Else a var of a
 * matcher that is not required is undefined in a set with no match of it.
 */
export type JoinedVars<M extends Record<string, AnyMatcher>, R extends keyof M & string = keyof M & string> = [
  Exclude<keyof M, R>,
] extends [never]
  ? Vars
  : Readonly<Record<string, string | undefined>>

export type TaskMaterializerConfig<M extends Record<string, AnyMatcher>, R extends keyof M & string = keyof M & string> = {
  /** The matchers to listen to, by name. Their matches join on the var names that they share. */
  matchersByName: M
  /**
   * The matchers that each joined set must have a match of. Left out: every matcher.
   * Each other matcher left-joins onto them, in name order, and is undefined in a set where it has no match.
   */
  required?: readonly R[]
  /**
   * Gives the tasks for one joined set of matches. It can give any number of tasks.
   * A var of a matcher that is not required is undefined when the set has no match of it.
   */
  tasks: (vars: JoinedVars<M, R>, matched: MatchedByName<M, R>) => Iterable<Task>
}

/** Gives the new tasks of one group to the build. The build applies them in steps: see Build.setTasksOfGroups. */
type SetGroupTasks = (group: TaskGroup, tasks: readonly Task[]) => void

/** A matcher that is not required, and how it finds the base sets that its matches can join. */
type OptionalMatcher = {
  table: MatchTable
  // Its var names that a required matcher has, in its varNames order.
  sharedVarNames: readonly string[]
  // Its var names that a required matcher or an earlier matcher that is not required has: the ON of its LEFT JOIN.
  // A match joins a branch only when the branch has a value for each of these, and the values are equal.
  onVarNames: readonly string[]
  // Every base set, by the values of sharedVarNames. A base set is here also while this matcher has no match for it.
  baseIndex: JoinIndex<BaseSet>
}

/** One branch of the chain of left joins of a base set. */
type Branch = {
  vars: Record<string, string>
  optionalMembersByName: Map<string, StoredMatch>
}

/**
 * A materialized view of the matches: listens to the found and gone events of its matchers,
 * joins their matches on shared var names, and keeps one task list in the build for each joined set.
 * The required matchers join to base sets. The matchers that are not required left-join onto
 * each base set, one after the other in name order, so a base set can have several joined sets.
 * Each joined set has one task group, so `setGroupTasks` replaces the tasks
 * of a set that changes and removes the tasks of a set that is gone.
 * The build never calls `hear` while another `hear` runs (see build.each).
 */
export class TaskMaterializer<M extends Record<string, AnyMatcher>, R extends keyof M & string> {
  private readonly tablesByName = new Map<string, MatchTable>()
  // For each required matcher: the join steps from one of its matches to the other required matchers.
  private readonly joinStepsByName: Map<string, JoinStep[]>
  // In name order.
  private readonly optionalMatchersByName = new Map<string, OptionalMatcher>()
  // The var names of all matchers: in name order, then varNames order, each one time.
  private readonly unionVarNames: string[] = []

  constructor(
    readonly number: number,
    private readonly config: TaskMaterializerConfig<M, R>,
    private readonly setGroupTasks: SetGroupTasks,
  ) {
    const names = Object.keys(config.matchersByName)
    if (names.length === 0) {
      throw new Error(`build.each ${number} has no matcher; build.each needs at least one matcher`)
    }
    const requiredNames = new Set<string>(config.required ?? names)
    if (requiredNames.size === 0) {
      throw new Error(`build.each ${number}: required is empty; name at least one matcher, or leave required out to require every matcher`)
    }
    for (const name of requiredNames) {
      if (!names.includes(name)) {
        throw new Error(`build.each ${number}: required names '${name}', which is not a name in matchersByName`)
      }
    }
    const namesByMatcher = new Map<AnyMatcher, string>()
    const requiredTables: MatchTable[] = []
    const optionalTables: MatchTable[] = []
    const requiredVarNames = new Set<string>()
    for (const name of names) {
      const matcher = config.matchersByName[name]!
      const otherName = namesByMatcher.get(matcher)
      if (otherName !== undefined) {
        throw new Error(`build.each ${number}: '${otherName}' and '${name}' are one matcher object; give each name its own matcher`)
      }
      namesByMatcher.set(matcher, name)
      const table = new MatchTable(name, matcher.varNames, number)
      this.tablesByName.set(name, table)
      for (const varName of table.varNames) {
        if (!this.unionVarNames.includes(varName)) this.unionVarNames.push(varName)
      }
      if (requiredNames.has(name)) {
        requiredTables.push(table)
        for (const varName of table.varNames) {
          requiredVarNames.add(varName)
        }
      } else {
        optionalTables.push(table)
      }
    }
    const earlierVarNames = new Set(requiredVarNames)
    for (const table of optionalTables) {
      const sharedVarNames: string[] = []
      const onVarNames: string[] = []
      for (const varName of table.varNames) {
        if (requiredVarNames.has(varName)) sharedVarNames.push(varName)
        if (earlierVarNames.has(varName)) onVarNames.push(varName)
      }
      for (const varName of table.varNames) {
        earlierVarNames.add(varName)
      }
      table.addIndex(sharedVarNames)
      this.optionalMatchersByName.set(table.name, { table, sharedVarNames, onVarNames, baseIndex: new JoinIndex(sharedVarNames) })
    }
    this.joinStepsByName = planJoins(requiredTables, number)
  }

  hear(matcherName: string, event: MatchedArtifactEvent): void {
    const table = this.tablesByName.get(matcherName)!
    const optional = this.optionalMatchersByName.get(matcherName)
    if (event.kind === "gone") {
      if (optional === undefined) {
        this.hearGone(table, event.vars)
      } else {
        this.hearOptionalGone(optional, event.vars)
      }
      return
    }
    const found = event.matched
    const artifactIds = artifactIdsOf(found.data)
    const current = table.get(found.vars)
    if (current !== undefined) {
      if (current.artifactIds === artifactIds) return
      // The vars are the same, so the match is in the same joined sets. Only their tasks change.
      current.matched = found
      current.artifactIds = artifactIds
      for (const set of current.sets) {
        this.giveTasks(set)
      }
      return
    }
    const stored: StoredMatch = { matched: found, artifactIds, sets: new Set() }
    table.put(stored)
    if (optional !== undefined) {
      for (const base of optional.baseIndex.lookup(found.vars)) {
        this.refreshJoinedSets(base)
      }
      return
    }
    const joinSteps = this.joinStepsByName.get(matcherName)!
    for (const joined of joinFrom(table, stored, joinSteps)) {
      const vars: Vars = joined.vars
      const base: BaseSet = {
        vars,
        requiredMembersByName: joined.membersByName,
        joinedSetsByVarsKey: new Map(),
      }
      for (const optionalMatcher of this.optionalMatchersByName.values()) {
        optionalMatcher.baseIndex.add(vars, base)
      }
      this.refreshJoinedSets(base)
    }
  }

  /** Forgets the match of a required matcher and removes each base set that holds it, with its joined sets. */
  private hearGone(table: MatchTable, vars: Vars): void {
    const gone = table.get(vars)
    if (gone === undefined) return
    table.delete(gone)
    const goneBases = new Set<BaseSet>()
    for (const set of gone.sets) {
      goneBases.add(set.base)
    }
    for (const base of goneBases) {
      for (const optionalMatcher of this.optionalMatchersByName.values()) {
        optionalMatcher.baseIndex.delete(base.vars, base)
      }
      for (const set of base.joinedSetsByVarsKey.values()) {
        this.removeJoinedSet(set)
      }
    }
  }

  /** Forgets the match of a matcher that is not required. Each base set that could join it stays, and gets new joined sets. */
  private hearOptionalGone(optional: OptionalMatcher, vars: Vars): void {
    const gone = optional.table.get(vars)
    if (gone === undefined) return
    optional.table.delete(gone)
    for (const base of optional.baseIndex.lookup(gone.matched.vars)) {
      this.refreshJoinedSets(base)
    }
  }

  /**
   * The chain of LEFT JOINs of the base set, as in SQL. Each matcher that is not required, in name order,
   * joins each branch on its onVarNames. Each match that agrees makes one branch. With no match that agrees,
   * the matcher is undefined in the branch and adds no var. A branch with no value for an ON var
   * agrees with no match, as NULL equals nothing in SQL.
   * Reads the matches from the tables, so the caller changes the table before it calls this.
   */
  private leftJoinChain(base: BaseSet): Branch[] {
    let branches: Branch[] = [{ vars: { ...base.vars }, optionalMembersByName: new Map() }]
    for (const [optionalName, optionalMatcher] of this.optionalMatchersByName) {
      const matches = optionalMatcher.table.lookup(optionalMatcher.sharedVarNames, base.vars)
      const longerBranches: Branch[] = []
      for (const branch of branches) {
        let joinedOne = false
        for (const match of matches) {
          let agrees = true
          for (const varName of optionalMatcher.onVarNames) {
            if (!Object.hasOwn(branch.vars, varName) || branch.vars[varName] !== match.matched.vars[varName]) agrees = false
          }
          if (!agrees) continue
          joinedOne = true
          const optionalMembersByName = new Map(branch.optionalMembersByName)
          optionalMembersByName.set(optionalName, match)
          longerBranches.push({ vars: { ...branch.vars, ...match.matched.vars }, optionalMembersByName })
        }
        if (!joinedOne) longerBranches.push(branch)
      }
      branches = longerBranches
    }
    return branches
  }

  /**
   * Makes the joined sets of the base set the result of its chain of LEFT JOINs. A set with the same vars
   * and the same matches does not change. A set with the same vars and other matches gets new tasks in its
   * group. A set with new vars gets a new group. A set whose vars are gone is removed. The build applies
   * the changes of the scans, of one pass of a drain, or of an event sent from outside a drain as one step
   * (see Build.setTasksOfGroups), so a task id can move from a removed set to a new set.
   */
  private refreshJoinedSets(base: BaseSet): void {
    const branches = this.leftJoinChain(base)
    const branchesByVarsKey = new Map<string, Branch>()
    for (const branch of branches) {
      const values: (string | null)[] = []
      for (const varName of this.unionVarNames) {
        values.push(Object.hasOwn(branch.vars, varName) ? branch.vars[varName]! : null)
      }
      branchesByVarsKey.set(JSON.stringify(values), branch)
    }
    for (const [varsKey, set] of base.joinedSetsByVarsKey) {
      if (!branchesByVarsKey.has(varsKey)) this.removeJoinedSet(set)
    }
    for (const [varsKey, branch] of branchesByVarsKey) {
      const membersByName = new Map(base.requiredMembersByName)
      for (const [optionalName, match] of branch.optionalMembersByName) {
        membersByName.set(optionalName, match)
      }
      let set = base.joinedSetsByVarsKey.get(varsKey)
      if (set === undefined) {
        const varEntries: [string, string][] = []
        for (const varName of this.unionVarNames) {
          if (Object.hasOwn(branch.vars, varName)) varEntries.push([varName, branch.vars[varName]!])
        }
        // fromEntries makes each var an own property, also a var named __proto__.
        const vars: Vars = Object.fromEntries(varEntries)
        set = { base, varsKey, vars, membersByName, group: new TaskGroup(this.labelOf(vars)) }
        base.joinedSetsByVarsKey.set(varsKey, set)
      } else {
        let sameMembers = set.membersByName.size === membersByName.size
        for (const [name, member] of membersByName) {
          if (set.membersByName.get(name) !== member) sameMembers = false
        }
        if (sameMembers) continue
        for (const member of set.membersByName.values()) {
          member.sets.delete(set)
        }
        set.membersByName = membersByName
      }
      for (const member of membersByName.values()) {
        member.sets.add(set)
      }
      this.giveTasks(set)
    }
  }

  /** Removes the tasks of the set, and the set from its base set and from each of its matches. */
  private removeJoinedSet(set: JoinedSet): void {
    for (const member of set.membersByName.values()) {
      member.sets.delete(set)
    }
    set.base.joinedSetsByVarsKey.delete(set.varsKey)
    this.setGroupTasks(set.group, [])
  }

  /** The join keys in the indexes of all matchers and of the base sets. 0 when no match is left. */
  get joinKeyCount(): number {
    let count = 0
    for (const table of this.tablesByName.values()) {
      count += table.joinKeyCount
    }
    for (const optionalMatcher of this.optionalMatchersByName.values()) {
      count += optionalMatcher.baseIndex.joinKeyCount
    }
    return count
  }

  /** Gives the build the tasks of the set, from its current matches. */
  private giveTasks(set: JoinedSet): void {
    const matchedEntries: [string, MatchedArtifact][] = []
    for (const [name, member] of set.membersByName) {
      matchedEntries.push([name, member.matched])
    }
    // fromEntries makes each name an own property, also a matcher named __proto__.
    const matched = Object.fromEntries(matchedEntries)
    const tasks: Task[] = []
    for (const task of this.config.tasks(set.vars as JoinedVars<M, R>, matched as MatchedByName<M, R>)) {
      tasks.push(task)
    }
    this.setGroupTasks(set.group, tasks)
  }

  /** `build.each <number> <name>=<value> ...`, for each var of the set, in unionVarNames order. Only for error messages. */
  private labelOf(vars: Vars): string {
    const parts: string[] = [`build.each ${this.number}`]
    for (const name of this.unionVarNames) {
      if (Object.hasOwn(vars, name)) parts.push(`${name}=${vars[name]}`)
    }
    return parts.join(" ")
  }
}

/** The artifact ids of the data. Two matches with the same ids hold the same data. */
function artifactIdsOf(data: MatchedData): string {
  if (Array.isArray(data)) {
    const ids: string[] = []
    for (const artifact of data as readonly Artifact[]) {
      ids.push(artifact.id)
    }
    return JSON.stringify(ids)
  }
  return JSON.stringify((data as Artifact).id)
}
