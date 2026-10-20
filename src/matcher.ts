import type { ArtifactEvent } from "./build"
import { Emitter } from "./emitter"
import type { RowEvent } from "./row"

/**
 * Finds things and sends one row for each of them to its listeners.
 * Subclass it for files, S3 objects, list items.
 */
export abstract class Matcher extends Emitter<RowEvent> {
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
