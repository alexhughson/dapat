import type { Vars } from "../filebuild/vars"
import { FixedRowArtifact } from "./fixed-row"
import type { Feed, Generator } from "./types"

export type StubRow = {
  vars: Vars
  row: Readonly<Record<string, string>>
}

/**
 * Example generator: emits a fixed list of rows. No git or filesystem scan.
 */
export class StubRowGenerator implements Generator<FixedRowArtifact> {
  readonly varNames: readonly string[]

  constructor(
    private readonly rows: readonly StubRow[],
    varNames: readonly string[] = inferVarNames(rows),
  ) {
    this.varNames = varNames
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
