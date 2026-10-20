/**
 * One stamped value. Subclass this for files, S3 objects, DB rows.
 * For a folder of values, subclass `Prefix` instead.
 */
export abstract class Artifact<T = unknown> {
  abstract readonly id: string

  /**
   * A string that changes when the value changes, for example a hash.
   * Returns null when the artifact does not exist.
   * The build compares stamps for equality only.
   * A throw fails the task that the build stamps this artifact for.
   */
  abstract stamp(): Promise<string | null>
  abstract read(): Promise<T>
}
