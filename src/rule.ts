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

/** What a rule may call on the build. */
export type RuleHost = {
  setTasks(owner: string, tasks: readonly Task[]): void
  /** Makes the error fatal for the build, as a subscriber error is. */
  fail(error: Error): void
}

/**
 * Listens to the matcher of its one input, and gives the build the tasks of each row.
 * Each row is one owner, `<rule number>:<row key>`, so `setTasks` replaces the tasks
 * of a row that changes and removes the tasks of a row that is dropped.
 */
export class Rule<I extends Record<string, AnyMatcher>> {
  private readonly inputName: string
  private readonly matcher: AnyMatcher
  // The current row of each owner. A put with the same data as the current row does nothing.
  private readonly rows = new Map<string, MatchRow>()

  constructor(
    readonly number: number,
    private readonly config: RuleConfig<I>,
    private readonly host: RuleHost,
  ) {
    const names = Object.keys(config.inputs)
    if (names.length !== 1) {
      throw new Error(`rule ${number} has ${names.length} inputs; a rule needs exactly one input`)
    }
    this.inputName = names[0]!
    this.matcher = config.inputs[this.inputName]!
  }

  get matchers(): readonly AnyMatcher[] {
    return [this.matcher]
  }

  /** Subscribes to the matcher. From then on, each row change gives the build new tasks. */
  listen(): void {
    this.matcher.subscribe((event) => this.hear(event))
  }

  /**
   * A rule error is fatal for the build, like a subscriber error. The build records it
   * here, so a matcher that catches errors cannot hide it. The matcher's send does not
   * throw, as a build call that causes a failing send does not throw.
   */
  private hear(event: RowEvent): void {
    try {
      this.apply(event)
    } catch (error) {
      this.host.fail(toError(error))
    }
  }

  private apply(event: RowEvent): void {
    if (event.kind === "drop") {
      const owner = this.ownerOf(event.vars)
      this.rows.delete(owner)
      this.host.setTasks(owner, [])
      return
    }
    const row = event.row
    const owner = this.ownerOf(row.vars)
    const current = this.rows.get(owner)
    if (current !== undefined && sameData(current.data, row.data)) return
    // The rule has one input, so the input object holds only that row.
    const input = { [this.inputName]: row } as RuleInput<I>
    const tasks: Task[] = []
    for (const task of this.config.tasks(row.vars, input)) {
      tasks.push(task)
    }
    // The row is current before setTasks, because setTasks sends events, and a matcher
    // can put the same row again while it hears them. If setTasks throws, it changed
    // nothing, so the old row is current again.
    this.rows.set(owner, row)
    try {
      this.host.setTasks(owner, tasks)
    } catch (error) {
      if (current === undefined) {
        this.rows.delete(owner)
      } else {
        this.rows.set(owner, current)
      }
      throw error
    }
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

/** True when both hold the same artifact ids, in the same order. A list never equals one artifact. */
function sameData(a: RowData, b: RowData): boolean {
  if (!isList(a) && !isList(b)) return a.id === b.id
  if (!isList(a) || !isList(b)) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.id !== b[i]!.id) return false
  }
  return true
}

function isList(data: RowData): data is readonly Artifact[] {
  return Array.isArray(data)
}

function toError(value: unknown): Error {
  if (value instanceof Error) return value
  return new Error(String(value))
}
