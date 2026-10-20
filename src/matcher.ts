import type { ArtifactEvent } from "./build"
import { Emitter } from "./emitter"
import type { RowData, RowEvent } from "./row"

/**
 * Finds things and sends one row for each of them to its listeners.
 * Subclass it for files, S3 objects, list items. `D` is the data of each row,
 * so a rule gets typed data: `Matcher<FileArtifact>` gives `input.page.data: FileArtifact`.
 */
export abstract class Matcher<D extends RowData = RowData> extends Emitter<RowEvent<D>> {
  /** The var names of every row. Known before any scan. */
  abstract readonly varNames: readonly string[]

  /** Looks at the world now and sends a `put` for each thing it finds. This is where I/O goes. */
  abstract scan(signal: AbortSignal): Promise<void>

  /**
   * Hears each artifact event of the build. A matcher that can see the new artifact
   * sends a row change here. It must be fast and do no I/O.
   * Default: rows never change during a run.
   */
  sendArtifact(_event: ArtifactEvent): void {}
}

/**
 * Any matcher, whatever its data type. Emitter keeps its listeners in a private field
 * typed by the event, so TypeScript treats `D` as invariant: a `Matcher<FileArtifact>` is
 * neither a `Matcher<RowData>` nor a `Matcher<never>`. Only `any` accepts every `D`.
 * Rules still get the real type of each input through `DataOf`.
 */
export type AnyMatcher = Matcher<any>

/** The row data type of a matcher: `FileArtifact` for a `Matcher<FileArtifact>`. */
export type DataOf<M> = M extends Matcher<infer D> ? D : never
