import type { Vars } from "../filebuild/vars"
import { FixedRowArtifact } from "./fixed-row"
import { InputGen, type Feed } from "./types"

/**
 * One row per value in a fixed list (e.g. locales `fr` and `de`).
 * Stand-in for Story 2 until `RuleBuild` schedules tasks from joined slots.
 */
export class ValuesGenerator extends InputGen<FixedRowArtifact> {
  readonly varNames: readonly string[]

  constructor(
    private readonly varName: string,
    private readonly values: readonly string[],
  ) {
    super()
    this.varNames = [varName]
  }

  async start(feed: Feed<FixedRowArtifact>): Promise<void> {
    for (const value of this.values) {
      const vars: Vars = { [this.varName]: value }
      feed.set(vars, new FixedRowArtifact(vars, {}))
    }
  }
}
