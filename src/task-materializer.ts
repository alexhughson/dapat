import type { Artifact } from "./artifact"
import type { AnyMatcher, DataOf } from "./matcher"
import type { MatchedArtifact, MatchedArtifactEvent, MatchedData, Vars } from "./matched-artifact"
import { MatchTable, joinFrom, planJoins, type JoinStep, type JoinedSet, type StoredMatch } from "./match-join"
import type { Task } from "./task"
import { TaskGroup } from "./task-group"

/** What `tasks` gets: the matched artifact of each matcher, by name, with the data type of that matcher. */
export type MatchedByName<M extends Record<string, AnyMatcher>> = {
  readonly [K in keyof M]: MatchedArtifact<DataOf<M[K]>>
}

export type TaskMaterializerConfig<M extends Record<string, AnyMatcher>> = {
  /** The matchers to listen to, by name. Their matches join on the var names that they share. */
  matchersByName: M
  /** Gives the tasks for one joined set of matches. It can give any number of tasks. */
  tasks: (vars: Vars, matched: MatchedByName<M>) => Iterable<Task>
}

type SetTasks = (group: TaskGroup, tasks: readonly Task[]) => void

/**
 * A materialized view of the matches: listens to the found and gone events of its matchers,
 * joins their matches on shared var names, and keeps one task list in the build for each joined set.
 * Each joined set has one task group, so `setTasks` replaces the tasks
 * of a set that changes and removes the tasks of a set that is gone.
 * The build never calls `hear` while another `hear` runs (see build.each).
 */
export class TaskMaterializer<M extends Record<string, AnyMatcher>> {
  private readonly tablesByName = new Map<string, MatchTable>()
  private readonly joinStepsByName: Map<string, JoinStep[]>
  // The var names of all matchers: in name order, then varNames order, each one time.
  private readonly unionVarNames: string[] = []

  constructor(
    readonly number: number,
    private readonly config: TaskMaterializerConfig<M>,
    private readonly setTasks: SetTasks,
  ) {
    const names = Object.keys(config.matchersByName)
    if (names.length === 0) {
      throw new Error(`build.each ${number} has no matcher; build.each needs at least one matcher`)
    }
    const namesByMatcher = new Map<AnyMatcher, string>()
    const tables: MatchTable[] = []
    for (const name of names) {
      const matcher = config.matchersByName[name]!
      const otherName = namesByMatcher.get(matcher)
      if (otherName !== undefined) {
        throw new Error(`build.each ${number}: '${otherName}' and '${name}' are one matcher object; give each name its own matcher`)
      }
      namesByMatcher.set(matcher, name)
      const table = new MatchTable(name, matcher.varNames, number)
      tables.push(table)
      this.tablesByName.set(name, table)
      for (const varName of table.varNames) {
        if (!this.unionVarNames.includes(varName)) this.unionVarNames.push(varName)
      }
    }
    this.joinStepsByName = planJoins(tables, number)
  }

  hear(matcherName: string, event: MatchedArtifactEvent): void {
    const table = this.tablesByName.get(matcherName)!
    if (event.kind === "gone") {
      this.hearGone(table, event.vars)
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
    const joinSteps = this.joinStepsByName.get(matcherName)!
    for (const joined of joinFrom(table, stored, joinSteps)) {
      const vars: Record<string, string> = {}
      for (const varName of this.unionVarNames) {
        vars[varName] = joined.vars[varName]!
      }
      const set: JoinedSet = { vars, membersByName: joined.membersByName, group: new TaskGroup(this.labelOf(vars)) }
      for (const member of set.membersByName.values()) {
        member.sets.add(set)
      }
      this.giveTasks(set)
    }
  }

  /** Forgets the match and removes the tasks of each joined set that holds it. */
  private hearGone(table: MatchTable, vars: Vars): void {
    const gone = table.get(vars)
    if (gone === undefined) return
    table.delete(gone)
    for (const set of gone.sets) {
      for (const member of set.membersByName.values()) {
        if (member !== gone) member.sets.delete(set)
      }
      this.setTasks(set.group, [])
    }
  }

  /** Gives the build the tasks of the set, from its current matches. */
  private giveTasks(set: JoinedSet): void {
    const matched: Record<string, MatchedArtifact> = {}
    for (const [name, member] of set.membersByName) {
      matched[name] = member.matched
    }
    const tasks: Task[] = []
    for (const task of this.config.tasks(set.vars, matched as MatchedByName<M>)) {
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
