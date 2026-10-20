import type { Matcher } from "./matcher"
import type { MatchRow, RowEvent, Vars } from "./row"
import type { Task } from "./task"

/** What `tasks` gets: the row of each input, by input name. */
export type RuleInput<I extends Record<string, Matcher>> = {
  readonly [K in keyof I]: MatchRow
}

export type RuleConfig<I extends Record<string, Matcher>> = {
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
export class Rule<I extends Record<string, Matcher>> {
  private readonly inputName: string
  private readonly matcher: Matcher

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

  /** Subscribes to the matcher. From then on, each row change gives the build new tasks. */
  listen(): void {
    this.matcher.subscribe((event) => this.hear(event))
  }

  private hear(event: RowEvent): void {
    if (event.kind === "drop") {
      const owner = this.ownerOf(event.vars)
      this.setTasks(owner, [])
      return
    }
    const row = event.row
    const owner = this.ownerOf(row.vars)
    // The rule has one input, so the input object holds only that row.
    const input = { [this.inputName]: row } as RuleInput<I>
    const tasks: Task[] = []
    for (const task of this.config.tasks(row.vars, input)) {
      tasks.push(task)
    }
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
