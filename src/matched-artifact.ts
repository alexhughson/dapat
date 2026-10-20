import type { Artifact } from "./artifact"

/** The values that a matcher reads from one thing it found, by var name. */
export type Vars = Readonly<Record<string, string>>

/** What a matched artifact holds: one artifact, or a list of artifacts. */
export type MatchedData = Artifact | readonly Artifact[]

/**
 * One thing that a matcher found. `vars` is also its key: a later
 * matched artifact with the same vars replaces it.
 */
export type MatchedArtifact<D extends MatchedData = MatchedData> = {
  vars: Vars
  data: D
}

export type MatchedArtifactEvent<D extends MatchedData = MatchedData> =
  | { kind: "found"; matched: MatchedArtifact<D> } // a new match, or a new version of the match with these vars
  | { kind: "gone"; vars: Vars } // the match with these vars is gone
