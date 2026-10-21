import type { Vars } from "./matched-artifact"
import type { Ref } from "./task"

/**
 * Makes one artifact or prefix from the vars of a joined set, as a URI template expands to one URI.
 * `build.each` expands each template of `outputsByName` for each joined set.
 * Example: a file template `site/<lang>/<slug>.html` with `{ lang: "en", slug: "hi" }` gives the file `site/en/hi.html`.
 */
export interface ArtifactTemplate<R extends Ref = Ref> {
  /** The var names that `expand` reads. Each one must be a var of a required matcher. */
  readonly varNames: readonly string[]
  expand(vars: Vars): R
}

/** The ref type of a template: `FileArtifact` for an `ArtifactTemplate<FileArtifact>`. */
export type RefOf<T> = T extends ArtifactTemplate<infer R> ? R : never
