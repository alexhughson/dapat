import type { ArtifactEvent } from "./build"
import { Emitter } from "./emitter"
import type { MatchedArtifactEvent, MatchedData } from "./matched-artifact"

/**
 * Finds things and sends one matched artifact for each of them to its listeners.
 * Subclass it for files, S3 objects, list items. `D` is the data of each match, so
 * `build.each` gets typed data: `Matcher<FileArtifact>` gives `matched.page.data: FileArtifact`.
 */
export abstract class Matcher<D extends MatchedData = MatchedData> extends Emitter<MatchedArtifactEvent<D>> {
  /** The var names of every match. Known before any scan. */
  abstract readonly varNames: readonly string[]

  /** Looks at the world now and sends `found` for each thing it finds. This is where I/O goes. */
  abstract scan(signal: AbortSignal): Promise<void>

  /**
   * Gets each artifact event of the build. A matcher that can see the new artifact
   * sends `found` or `gone` here. It must be fast and do no I/O.
   * Default: matches never change during a run.
   */
  receiveArtifactEvent(_event: ArtifactEvent): void {}
}

/**
 * Any matcher, whatever its data type. Emitter keeps its listeners in a private field
 * typed by the event, so TypeScript treats `D` as invariant: a `Matcher<FileArtifact>` is
 * neither a `Matcher<MatchedData>` nor a `Matcher<never>`. Only `any` accepts every `D`.
 * `build.each` still gets the real type of each matcher through `DataOf`.
 */
export type AnyMatcher = Matcher<any>

/** The data type of a matcher: `FileArtifact` for a `Matcher<FileArtifact>`. */
export type DataOf<M> = M extends Matcher<infer D> ? D : never
