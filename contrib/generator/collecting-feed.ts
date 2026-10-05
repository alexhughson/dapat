import type { Vars } from "../filebuild/vars"
import type { Feed, GeneratorValue } from "./types"

export type CollectedRow<V extends GeneratorValue> = {
  vars: Vars
  artifact: V
}

/** In-memory `Feed` for examples and tests before `RuleBuild` wires slots. */
export class CollectingFeed<V extends GeneratorValue> implements Feed<V> {
  readonly rows: CollectedRow<V>[] = []

  set(vars: Vars, artifact: V): void {
    this.rows.push({ vars, artifact })
  }

  delete(_vars: Vars): void {
    // walk-driven inputs remove rows in RuleBuild; not used in row-only demos
  }

  listen(): void {
    // file walk uses listen in a later slice
  }
}
