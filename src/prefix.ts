import type { Artifact } from "./artifact"

/**
 * A region of artifact ids. Subclass this for path prefixes, S3 prefixes,
 * table ranges. A prefix has no body, but it has a stamp.
 *
 * In inputs: wait until current writers this prefix covers have finished.
 * In outputs: this task may create some children. Call ctx.produced(child).
 */
export abstract class Prefix {
  abstract readonly id: string

  /**
   * A string that changes when anything under the prefix changes.
   * The subclass chooses how, for example a hash of each child id and stamp.
   * An empty or missing region is a real stamp, for example the hash of an empty list.
   * Returns null when the prefix cannot tell what is under it. Then each task
   * that uses the prefix runs. A throw fails the task that the build stamps this prefix for.
   *
   * Default: null. A prefix that is only an id string cannot list its children,
   * so a skip could hide a change under it. Running on every build is the safe choice.
   */
  async stamp(): Promise<string | null> {
    return null
  }

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

/**
 * Prefix whose region is an id string. It cannot list what is under it,
 * so its stamp is null, and a task that uses it runs on every build.
 */
export class IdPrefix extends Prefix {
  constructor(readonly id: string) {
    super()
  }
}
