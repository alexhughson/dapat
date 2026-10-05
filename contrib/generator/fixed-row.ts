import { Artifact } from "../../src/artifact"
import { varsKey, type Vars } from "../filebuild/vars"
import type { Row } from "./types"

export class FixedRowArtifact extends Artifact<Row> {
  readonly id: string

  constructor(
    readonly vars: Vars,
    readonly row: Row,
  ) {
    super()
    this.id = `row:${varsKey(vars)}`
  }

  async orderStamp(): Promise<bigint | null> {
    return null
  }

  async contentStamp(): Promise<string | null> {
    return JSON.stringify(this.row)
  }

  async read(): Promise<Row> {
    return this.row
  }
}
