import type { Vars } from "../filebuild/vars"
import { FixedRowArtifact } from "./fixed-row"
import { InputGen, type Feed, type Row } from "./types"

export type StubRow = {
  vars: Vars
  row: Row
}

/**
 * Example generator: emits a fixed list of rows. No git or filesystem scan.
 */
export class StubRowGenerator extends InputGen<FixedRowArtifact> {
  readonly varNames: readonly string[]

  constructor(
    private readonly rows: readonly StubRow[],
    varNames?: readonly string[],
  ) {
    super()
    this.varNames = varNames ?? inferVarNames(rows)
  }

  async start(feed: Feed<FixedRowArtifact>): Promise<void> {
    for (const { vars, row } of this.rows) {
      feed.set(vars, new FixedRowArtifact(vars, row))
    }
  }
}

function inferVarNames(rows: readonly StubRow[]): string[] {
  const names = new Set<string>()
  for (const { vars } of rows) {
    for (const key of Object.keys(vars)) {
      names.add(key)
    }
  }
  return [...names].sort()
}
