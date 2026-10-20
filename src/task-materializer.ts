import type { Artifact } from "./artifact"
import type { AnyMatcher, DataOf } from "./matcher"
import type { MatchedArtifact, MatchedArtifactEvent, MatchedData, Vars } from "./matched-artifact"
import type { Task } from "./task"

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

type SetTasks = (owner: string, tasks: readonly Task[]) => void

/**
 * A materialized view of the matches: listens to the found and gone events of its one matcher,
 * and keeps one task list in the build for each matched artifact.
 * Each match is one owner, `<number>:<vars key>`, so `setTasks` replaces the tasks
 * of a match that changes and removes the tasks of a match that is gone.
 */
export class TaskMaterializer<M extends Record<string, AnyMatcher>> {
  readonly matcher: AnyMatcher
  private readonly matcherName: string
  // The artifact ids of the current match of each owner. A found event with the same ids does nothing.
  private readonly artifactIdsByOwner = new Map<string, string>()

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
      const owner = this.ownerOf(event.vars)
      this.artifactIdsByOwner.delete(owner)
      this.setTasks(owner, [])
      return
    }
    const found = event.matched
    const owner = this.ownerOf(found.vars)
    const artifactIds = artifactIdsOf(found.data)
    if (this.artifactIdsByOwner.get(owner) === artifactIds) return
    // There is one matcher, so the object holds only its match.
    const matched = { [this.matcherName]: found } as MatchedByName<M>
    const tasks: Task[] = []
    for (const task of this.config.tasks(found.vars, matched)) {
      tasks.push(task)
    }
    // Set before setTasks: its events can make the matcher find this artifact again.
    this.artifactIdsByOwner.set(owner, artifactIds)
    this.setTasks(owner, tasks)
  }

  /** `<number>:<values>`: the var values in varNames order, each URI-encoded, joined with "/". */
  private ownerOf(vars: Vars): string {
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
    return `${this.number}:${parts.join("/")}`
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
