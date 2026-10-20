import type { Artifact } from "./artifact"

/** The values that a matcher reads from one thing it found, by var name. */
export type Vars = Readonly<Record<string, string>>

/** What a row holds: one artifact, or a list of artifacts. */
export type RowData = Artifact | readonly Artifact[]

/**
 * One thing that a matcher found. `vars` is also the key of the row:
 * a later row with the same vars replaces it.
 */
export type MatchRow<D extends RowData = RowData> = {
  vars: Vars
  data: D
}

export type RowEvent<D extends RowData = RowData> =
  | { kind: "put"; row: MatchRow<D> } // a new row, or a new version of the row with these vars
  | { kind: "drop"; vars: Vars } // the row with these vars is gone
