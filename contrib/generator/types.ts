import type { Artifact } from "../../src/artifact"
import type { Vars } from "../filebuild/vars"

/** Payload a rule task reads from one generated input row. */
export type Row = Readonly<Record<string, string>>

export type GeneratorValue = Artifact<unknown> | readonly Artifact<unknown>[]

/**
 * Produces task-variable bindings for a rule input slot.
 * The rule engine calls `start`; the generator calls `feed.set`.
 */
export interface Generator<V extends GeneratorValue = GeneratorValue> {
  readonly varNames: readonly string[]
  start(feed: Feed<V>): Promise<void>
}

export interface Feed<V extends GeneratorValue> {
  set(vars: Vars, value: V): void
  delete(vars: Vars): void
}

/** Same hook as `Generator`; name used inside the rules engine. */
export type InputGen<V extends GeneratorValue = GeneratorValue> = Generator<V>
