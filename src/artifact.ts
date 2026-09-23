/**
 * One stamped value. Subclass this for files, S3 objects, DB rows, listings.
 *
 * A listing that must wait for writers overrides `covers` so it includes
 * those writers' outputs. The build then waits for those tasks before
 * it stamps this artifact.
 */
export abstract class Artifact<T = unknown> {
  abstract readonly id: string

  abstract orderStamp(): Promise<bigint | null>
  abstract contentStamp(): Promise<string | null>
  abstract read(): Promise<T>

  covers(other: Artifact): boolean {
    return other.id === this.id
  }

  /**
   * True when `covers` can match an artifact other than this one.
   * A directory listing returns true. Ordinary files leave this false
   * so the build does not scan every output for each file input.
   */
  get coversOthers(): boolean {
    return false
  }
}
