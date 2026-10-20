import type { Artifact } from "./artifact"
import type { AnyMatcher, DataOf } from "./matcher"
import type { MatchedArtifact, MatchedArtifactEvent, MatchedData, Vars } from "./matched-artifact"
import { MatchTable, joinFrom, keyOfVars, planJoins, type JoinStep, type StoredMatch, type VarsKey } from "./match-join"
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

/** The union vars of a joined set, in unionVarNames order, encoded like a VarsKey. */
type SetKey = string

/** One match of each matcher, where the var names that two matchers share have the same values. */
type JoinedSet = {
  // The vars of all its matches, in unionVarNames order.
  vars: Vars
  varsKeyByName: ReadonlyMap<string, VarsKey>
  group: TaskGroup
  // False when a match of the set changed and the group does not have its new tasks yet.
  tasksAreCurrent: boolean
}

/**
 * A materialized view of the matches: listens to the found and gone events of its matchers,
 * joins their matches on shared var names, and keeps one task list in the build for each joined set.
 * Each joined set has one task group, so `setTasks` replaces the tasks
 * of a set that changes and removes the tasks of a set that is gone.
 */
export class TaskMaterializer<M extends Record<string, AnyMatcher>> {
  private readonly tablesByName = new Map<string, MatchTable>()
  private readonly joinStepsByName: Map<string, JoinStep[]>
  // The var names of all matchers: in name order, then varNames order, each one time.
  private readonly unionVarNames: string[] = []
  private readonly setsByKey = new Map<SetKey, JoinedSet>()

  constructor(
    readonly number: number,
    private readonly config: TaskMaterializerConfig<M>,
    private readonly setTasks: SetTasks,
  ) {
    const names = Object.keys(config.matchersByName)
    if (names.length === 0) {
      throw new Error(`build.each ${number} has no matcher; build.each needs at least one matcher`)
    }
    const tables: MatchTable[] = []
    for (const name of names) {
      const table = new MatchTable(name, config.matchersByName[name]!, number)
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
    const varsKey = table.varsKeyOf(found.vars)
    const artifactIds = artifactIdsOf(found.data)
    const current = table.get(varsKey)
    if (current !== undefined) {
      if (current.artifactIds === artifactIds) return
      // The vars are the same, so the match is in the same joined sets. Only their tasks change.
      current.matched = found
      current.artifactIds = artifactIds
      const changedSetKeys = [...current.setKeys]
      for (const setKey of changedSetKeys) {
        this.setsByKey.get(setKey)!.tasksAreCurrent = false
      }
      this.giveTasks(changedSetKeys)
      return
    }
    const stored: StoredMatch = { matched: found, artifactIds, setKeys: new Set() }
    table.put(varsKey, stored)
    const joinSteps = this.joinStepsByName.get(matcherName)!
    const newSetKeys: SetKey[] = []
    for (const joined of joinFrom(table, varsKey, joinSteps)) {
      const vars: Record<string, string> = {}
      for (const varName of this.unionVarNames) {
        vars[varName] = joined.vars[varName]!
      }
      const setKey = keyOfVars(vars, this.unionVarNames)
      const group = new TaskGroup(this.labelOf(vars))
      this.setsByKey.set(setKey, { vars, varsKeyByName: joined.varsKeyByName, group, tasksAreCurrent: false })
      for (const [name, memberVarsKey] of joined.varsKeyByName) {
        this.tablesByName.get(name)!.get(memberVarsKey)!.setKeys.add(setKey)
      }
      newSetKeys.push(setKey)
    }
    this.giveTasks(newSetKeys)
  }

  /** Forgets the match and removes the tasks of each joined set that holds it. */
  private hearGone(table: MatchTable, vars: Vars): void {
    const varsKey = table.varsKeyOf(vars)
    const gone = table.get(varsKey)
    if (gone === undefined) return
    table.delete(varsKey)
    // Forget every set before setTasks: its events can make a matcher send again.
    const goneGroups: TaskGroup[] = []
    for (const setKey of gone.setKeys) {
      const set = this.setsByKey.get(setKey)!
      this.setsByKey.delete(setKey)
      for (const [name, memberVarsKey] of set.varsKeyByName) {
        if (name === table.name) continue
        this.tablesByName.get(name)!.get(memberVarsKey)!.setKeys.delete(setKey)
      }
      goneGroups.push(set.group)
    }
    for (const group of goneGroups) {
      this.setTasks(group, [])
    }
  }

  /**
   * Gives the build the tasks of each set that is not current. The events of one setTasks
   * can make a matcher send again, and that send can change or remove a later set in the list,
   * or give it its tasks already. So each set is looked up again just before its turn.
   */
  private giveTasks(setKeys: readonly SetKey[]): void {
    for (const setKey of setKeys) {
      const set = this.setsByKey.get(setKey)
      if (set === undefined) continue
      if (set.tasksAreCurrent) continue
      // Mark before setTasks: its events can make a matcher find the same artifacts again.
      set.tasksAreCurrent = true
      const matched: Record<string, MatchedArtifact> = {}
      for (const [name, memberVarsKey] of set.varsKeyByName) {
        matched[name] = this.tablesByName.get(name)!.get(memberVarsKey)!.matched
      }
      const tasks: Task[] = []
      for (const task of this.config.tasks(set.vars, matched as MatchedByName<M>)) {
        tasks.push(task)
      }
      this.setTasks(set.group, tasks)
    }
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
