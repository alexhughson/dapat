import type { Artifact } from "./artifact"
import type { AnyMatcher, DataOf } from "./matcher"
import type { MatchRow, RowData, RowEvent, Vars } from "./row"
import type { Task } from "./task"

/** What `tasks` gets: the row of each input, by input name, with the data type of its matcher. */
export type RuleInput<I extends Record<string, AnyMatcher>> = {
  readonly [K in keyof I]: MatchRow<DataOf<I[K]>>
}

export type RuleConfig<I extends Record<string, AnyMatcher>> = {
  /** The matchers that the rule listens to, by name. For now a rule has exactly one input. */
  inputs: I
  /** Gives the tasks for one row. A row can give any number of tasks. */
  tasks: (vars: Vars, input: RuleInput<I>) => Iterable<Task>
}

type SetTasks = (owner: string, tasks: readonly Task[]) => void

/**
 * Listens to the matcher of its one input, and gives the build the tasks of each row.
 * Each row is one owner, `<rule number>:<row key>`, so `setTasks` replaces the tasks
 * of a row that changes and removes the tasks of a row that is dropped.
 */
export class Rule<I extends Record<string, AnyMatcher>> {
  readonly matcher: AnyMatcher
  private readonly inputName: string
  // The data key of the current row of each owner. A put with the same key does nothing.
  private readonly keys = new Map<string, string>()

  constructor(
    readonly number: number,
    private readonly config: RuleConfig<I>,
    private readonly setTasks: SetTasks,
  ) {
    const names = Object.keys(config.inputs)
    if (names.length !== 1) {
      throw new Error(`rule ${number} has ${names.length} inputs; a rule needs exactly one input`)
    }
    this.inputName = names[0]!
    this.matcher = config.inputs[this.inputName]!
  }

  hear(event: RowEvent): void {
    if (event.kind === "drop") {
      const owner = this.ownerOf(event.vars)
      this.keys.delete(owner)
      this.setTasks(owner, [])
      return
    }
    const row = event.row
    const owner = this.ownerOf(row.vars)
    const key = dataKey(row.data)
    if (this.keys.get(owner) === key) return
    // The rule has one input, so the input object holds only that row.
    const input = { [this.inputName]: row } as RuleInput<I>
    const tasks: Task[] = []
    for (const task of this.config.tasks(row.vars, input)) {
      tasks.push(task)
    }
    // Set before setTasks: its events can make the matcher put this row again.
    this.keys.set(owner, key)
    this.setTasks(owner, tasks)
  }

  /** `<rule number>:<values>`: the var values in varNames order, each URI-encoded, joined with "/". */
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
        `input '${this.inputName}' of rule ${this.number} sent a row with vars ` +
          `[${given.join(", ")}]; its matcher's varNames are [${varNames.join(", ")}]`,
      )
    }
    return `${this.number}:${parts.join("/")}`
  }
}

/** The artifact ids of the data. Two rows with the same key hold the same data. */
function dataKey(data: RowData): string {
  if (Array.isArray(data)) {
    const ids: string[] = []
    for (const artifact of data as readonly Artifact[]) {
      ids.push(artifact.id)
    }
    return JSON.stringify(ids)
  }
  return JSON.stringify((data as Artifact).id)
}
