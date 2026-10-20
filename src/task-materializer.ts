import type { Artifact } from "./artifact"
import type { AnyMatcher, DataOf } from "./matcher"
import type { MatchedArtifact, MatchedArtifactEvent, MatchedData, Vars } from "./matched-artifact"
import { JoinIndex, MatchTable, joinFrom, planJoins, type JoinStep, type JoinedSet, type StoredMatch } from "./match-join"
import type { Task } from "./task"
import { TaskGroup } from "./task-group"

/**
 * What `tasks` gets: the matched artifact of each matcher, by name, with the data type of that matcher.
 * A matcher in `R`, the required names, always has one. Another matcher can have none.
 */
export type MatchedByName<M extends Record<string, AnyMatcher>, R extends keyof M & string = keyof M & string> = {
  readonly [K in keyof M]: K extends R ? MatchedArtifact<DataOf<M[K]>> : MatchedArtifact<DataOf<M[K]>> | undefined
}

export type TaskMaterializerConfig<M extends Record<string, AnyMatcher>, R extends keyof M & string = keyof M & string> = {
  /** The matchers to listen to, by name. Their matches join on the var names that they share. */
  matchersByName: M
  /**
   * The matchers that each joined set must have a match of. Left out: every matcher.
   * Each other matcher can use only var names of these, and is undefined in a set where it has no match.
   */
  required?: readonly R[]
  /** Gives the tasks for one joined set of matches. It can give any number of tasks. */
  tasks: (vars: Vars, matched: MatchedByName<M, R>) => Iterable<Task>
}

type SetTasks = (group: TaskGroup, tasks: readonly Task[]) => void

/**
 * A materialized view of the matches: listens to the found and gone events of its matchers,
 * joins their matches on shared var names, and keeps one task list in the build for each joined set.
 * Each joined set has one task group, so `setTasks` replaces the tasks
 * of a set that changes and removes the tasks of a set that is gone.
 * The build never calls `hear` while another `hear` runs (see build.each).
 */
export class TaskMaterializer<M extends Record<string, AnyMatcher>, R extends keyof M & string> {
  private readonly tablesByName = new Map<string, MatchTable>()
  // For each required matcher: the join steps from one of its matches to the other required matchers.
  private readonly joinStepsByName: Map<string, JoinStep[]>
  // For each matcher that is not required: every joined set, by the values of that matcher's var names.
  // A set is here also while that matcher has no match for it, so a later found finds the set.
  private readonly setIndexesByOptionalName = new Map<string, JoinIndex<JoinedSet>>()
  // The var names of all matchers: in name order, then varNames order, each one time.
  private readonly unionVarNames: string[] = []

  constructor(
    readonly number: number,
    private readonly config: TaskMaterializerConfig<M, R>,
    private readonly setTasks: SetTasks,
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
    // A matcher that is not required has no var of its own, so it has at most one match for
    // each joined set, and it never adds sets. A matcher with no var has the same match for every set.
    for (const table of optionalTables) {
      const extraVarNames: string[] = []
      for (const varName of table.varNames) {
        if (!requiredVarNames.has(varName)) extraVarNames.push(varName)
      }
      if (extraVarNames.length > 0) {
        throw new Error(
          `build.each ${number}: matcher '${table.name}' is not required, so it can use only var names of the required matchers; ` +
            `it also has [${extraVarNames.join(", ")}]`,
        )
      }
      table.addIndex(table.varNames)
      this.setIndexesByOptionalName.set(table.name, new JoinIndex(table.varNames))
    }
    this.joinStepsByName = planJoins(requiredTables, number)
  }

  hear(matcherName: string, event: MatchedArtifactEvent): void {
    const table = this.tablesByName.get(matcherName)!
    const optionalSetIndex = this.setIndexesByOptionalName.get(matcherName)
    if (event.kind === "gone") {
      if (optionalSetIndex === undefined) {
        this.hearGone(table, event.vars)
      } else {
        this.hearOptionalGone(table, event.vars)
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
    if (optionalSetIndex !== undefined) {
      // The sets exist without this match. It joins each of them.
      for (const set of optionalSetIndex.lookup(found.vars)) {
        set.membersByName.set(matcherName, stored)
        stored.sets.add(set)
        this.giveTasks(set)
      }
      return
    }
    const joinSteps = this.joinStepsByName.get(matcherName)!
    for (const joined of joinFrom(table, stored, joinSteps)) {
      const varEntries: [string, string][] = []
      for (const varName of this.unionVarNames) {
        varEntries.push([varName, joined.vars[varName]!])
      }
      // fromEntries makes each var an own property, also a var named __proto__.
      const vars: Vars = Object.fromEntries(varEntries)
      const set: JoinedSet = { vars, membersByName: joined.membersByName, group: new TaskGroup(this.labelOf(vars)) }
      for (const [optionalName, setIndex] of this.setIndexesByOptionalName) {
        setIndex.add(vars, set)
        const optionalTable = this.tablesByName.get(optionalName)!
        for (const optionalMatch of optionalTable.lookup(optionalTable.varNames, vars)) {
          set.membersByName.set(optionalName, optionalMatch)
        }
      }
      for (const member of set.membersByName.values()) {
        member.sets.add(set)
      }
      this.giveTasks(set)
    }
  }

  /** Forgets the match of a required matcher and removes the tasks of each joined set that holds it. */
  private hearGone(table: MatchTable, vars: Vars): void {
    const gone = table.get(vars)
    if (gone === undefined) return
    table.delete(gone)
    for (const set of gone.sets) {
      for (const member of set.membersByName.values()) {
        if (member !== gone) member.sets.delete(set)
      }
      for (const setIndex of this.setIndexesByOptionalName.values()) {
        setIndex.delete(set.vars, set)
      }
      this.setTasks(set.group, [])
    }
  }

  /** Forgets the match of a matcher that is not required. Each set that held it stays, without it, and gets new tasks. */
  private hearOptionalGone(table: MatchTable, vars: Vars): void {
    const gone = table.get(vars)
    if (gone === undefined) return
    table.delete(gone)
    for (const set of gone.sets) {
      set.membersByName.delete(table.name)
      this.giveTasks(set)
    }
  }

  /** The join keys in the indexes of all matchers and of the joined sets. 0 when no match is left. */
  get joinKeyCount(): number {
    let count = 0
    for (const table of this.tablesByName.values()) {
      count += table.joinKeyCount
    }
    for (const setIndex of this.setIndexesByOptionalName.values()) {
      count += setIndex.joinKeyCount
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
    for (const task of this.config.tasks(set.vars, matched as MatchedByName<M, R>)) {
      tasks.push(task)
    }
    this.setTasks(set.group, tasks)
  }

  /** `build.each <number> <name>=<value> ...`, in unionVarNames order. Only for error messages. */
  private labelOf(vars: Vars): string {
    const parts: string[] = [`build.each ${this.number}`]
    for (const name of this.unionVarNames) {
      parts.push(`${name}=${vars[name]}`)
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
