import type { Artifact } from "./artifact"

/**
 * A region of artifact ids. Subclass this for path prefixes, S3 prefixes,
 * table ranges. A prefix has no body and no stamp.
 *
 * In inputs: wait until current writers this prefix covers have finished.
 * In outputs: this task may create some children. Call ctx.produced(child).
 */
export abstract class Prefix {
  abstract readonly id: string

  /**
   * Default: same id, or `artifact.id` starts with `this.id`.
   * End ids with a delimiter (`file:out/`) so `out` does not cover `outgoing`.
   */
  covers(artifact: Artifact): boolean {
    if (artifact.id === this.id) return true
    return artifact.id.startsWith(this.id)
  }

  overlaps(other: Prefix): boolean {
    if (this.id === other.id) return true
    if (this.id.startsWith(other.id)) return true
    if (other.id.startsWith(this.id)) return true
    return false
  }
}

/** Prefix whose region is an id string. */
export class IdPrefix extends Prefix {
  constructor(readonly id: string) {
    super()
  }
}
