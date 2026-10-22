import type { Vars } from "./matched-artifact"
import type { Ref } from "./task"

/**
 * Makes one artifact or prefix from the vars of a joined set.
 * `build.each` expands each template of `outputsByName` for each joined set, and gives the results to `tasks`.
 * Example: a file template `site/<lang>/<slug>.html` with `{ lang: "en", slug: "hi" }` gives the file `site/en/hi.html`.
 */
export interface ArtifactTemplate<R extends Ref = Ref> {
  /** The var names that `expand` reads. `build.each` calls `expand` only for a set that has a value for each of them. */
  readonly varNames: readonly string[]
  expand(vars: Vars): R
  /** Every ref that `expand` can give, as one ref. Left out: the build.each gets no gate task for this template. */
  region?(): Ref
}

/** The ref type of a template: `FileArtifact` for an `ArtifactTemplate<FileArtifact>`. */
export type RefOf<T> = T extends ArtifactTemplate<infer R> ? R : never
