import type { Artifact } from "./artifact"
import type { AnyMatcher, DataOf } from "./matcher"
import type { MatchedArtifact, MatchedArtifactEvent, MatchedData, Vars } from "./matched-artifact"
import type { Task } from "./task"
import { TaskGroup } from "./task-group"

/** What `tasks` gets: the matched artifact of each matcher, by name, with the data type of that matcher. */
export type MatchedByName<M extends Record<string, AnyMatcher>> = {
  readonly [K in keyof M]: MatchedArtifact<DataOf<M[K]>>
}

export type TaskMaterializerConfig<M extends Record<string, AnyMatcher>> = {
  /** The matchers to listen to, by name. For now there is exactly one. */
  matchersByName: M
  /** Gives the tasks for one matched artifact. It can give any number of tasks. */
  tasks: (vars: Vars, matched: MatchedByName<M>) => Iterable<Task>
}

type SetTasks = (group: TaskGroup, tasks: readonly Task[]) => void

/** The current match of one vars key. */
type Match = {
  group: TaskGroup
  // A found event with the same artifact ids does nothing.
  artifactIds: string
}

/**
 * A materialized view of the matches: listens to the found and gone events of its one matcher,
 * and keeps one task list in the build for each matched artifact.
 * Each match has one task group, so `setTasks` replaces the tasks
 * of a match that changes and removes the tasks of a match that is gone.
 */
export class TaskMaterializer<M extends Record<string, AnyMatcher>> {
  readonly matcher: AnyMatcher
  private readonly matcherName: string
  private readonly matchesByVarsKey = new Map<string, Match>()

  constructor(
    readonly number: number,
    private readonly config: TaskMaterializerConfig<M>,
    private readonly setTasks: SetTasks,
  ) {
    const names = Object.keys(config.matchersByName)
    if (names.length !== 1) {
      throw new Error(`build.each ${number} has ${names.length} matchers; build.each needs exactly one matcher`)
    }
    this.matcherName = names[0]!
    this.matcher = config.matchersByName[this.matcherName]!
  }

  hear(event: MatchedArtifactEvent): void {
    if (event.kind === "gone") {
      const goneKey = this.varsKeyOf(event.vars)
      const gone = this.matchesByVarsKey.get(goneKey)
      if (gone === undefined) return
      this.matchesByVarsKey.delete(goneKey)
      this.setTasks(gone.group, [])
      return
    }
    const found = event.matched
    const varsKey = this.varsKeyOf(found.vars)
    const artifactIds = artifactIdsOf(found.data)
    const current = this.matchesByVarsKey.get(varsKey)
    let group: TaskGroup
    if (current === undefined) {
      group = new TaskGroup(this.labelOf(found.vars))
    } else {
      if (current.artifactIds === artifactIds) return
      group = current.group
    }
    // There is one matcher, so the object holds only its match.
    const matched = { [this.matcherName]: found } as MatchedByName<M>
    const tasks: Task[] = []
    for (const task of this.config.tasks(found.vars, matched)) {
      tasks.push(task)
    }
    // Set before setTasks: its events can make the matcher find this artifact again.
    this.matchesByVarsKey.set(varsKey, { group, artifactIds })
    this.setTasks(group, tasks)
  }

  /** The var values in varNames order, each URI-encoded, joined with "/". Throws if the var names are wrong. */
  private varsKeyOf(vars: Vars): string {
    const varNames = this.matcher.varNames
    const given = Object.keys(vars)
    let sameNames = given.length === varNames.length
    const parts: string[] = []
    for (const name of varNames) {
      if (!Object.hasOwn(vars, name)) {
        sameNames = false
        break
      }
      parts.push(encodeURIComponent(vars[name]!))
    }
    if (!sameNames) {
      throw new Error(
        `matcher '${this.matcherName}' of build.each ${this.number} matched an artifact with vars ` +
          `[${given.join(", ")}]; its varNames are [${varNames.join(", ")}]`,
      )
    }
    return parts.join("/")
  }

  /** `build.each <number> <name>=<value> ...`, in varNames order. Only for error messages. */
  private labelOf(vars: Vars): string {
    const parts: string[] = [`build.each ${this.number}`]
    for (const name of this.matcher.varNames) {
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
