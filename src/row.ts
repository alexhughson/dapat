import type { Artifact } from "./artifact"

/** The values that a matcher reads from one thing it found, by var name. */
export type Vars = Readonly<Record<string, string>>

/**
 * One thing that a matcher found. `vars` is also the key of the row:
 * a later row with the same vars replaces it.
 */
export type MatchRow = {
  vars: Vars
  data: Artifact | readonly Artifact[]
}

export type RowEvent =
  | { kind: "put"; row: MatchRow } // a new row, or a new version of the row with these vars
  | { kind: "drop"; vars: Vars } // the row with these vars is gone
