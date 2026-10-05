import type { Artifact } from "../../src/artifact"
import type { ArtifactEvent } from "../../src/build"
import type { Prefix } from "../../src/prefix"
import type { Vars } from "../filebuild/vars"

/** Payload a rule task reads from one generated input row. */
export type Row = Readonly<Record<string, string>>

export type GeneratorValue = Artifact<unknown> | readonly Artifact<unknown>[]

/**
 * Row-shaped rule input. Subclass and implement `start`; call `feed.set` from there.
 *
 * Reference: `StubRowGenerator` in `./stub-row.ts`, runnable `examples/stub-generator.ts`.
 *
 * @example
 * ```ts
 * class LocaleRows extends InputGen<FixedRowArtifact> {
 *   readonly varNames = ["locale"]
 *   async start(feed: Feed<FixedRowArtifact>) {
 *     feed.set({ locale: "fr" }, new FixedRowArtifact({ locale: "fr" }, { greeting: "bonjour" }))
 *   }
 * }
 * ```
 */
export abstract class InputGen<V extends GeneratorValue = GeneratorValue> {
  abstract readonly varNames: readonly string[]
  abstract start(feed: Feed<V>): Promise<void>
}

/** Same contract as `InputGen`; name used in contrib docs and exports. */
export type Generator<V extends GeneratorValue = GeneratorValue> = InputGen<V>

/**
 * Callback surface the engine gives each input slot during `InputGen.start`.
 *
 * Row-only generators (for example `StubRowGenerator`) usually call `set` only.
 * Walk-driven inputs (future `FilePattern.start`) also use `listen` and `delete`.
 *
 * @example Minimal feed — see `examples/stub-generator.ts` and `test/generator/stub-row.test.ts`.
 */
export interface Feed<V extends GeneratorValue> {
  set(vars: Vars, value: V): void
  delete(vars: Vars): void
  listen(
    prefix: Prefix,
    fn: (event: ArtifactEvent) => void | Promise<void>,
  ): void
}
