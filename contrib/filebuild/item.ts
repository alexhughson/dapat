import type { Artifact } from "../../src/artifact"
import type { Prefix } from "../../src/prefix"
import type { Vars } from "./vars"

/** One file or S3 object that a pattern bound. */
export type Item = Artifact<Uint8Array>

export type ItemInput = Item | Item[] | undefined

/**
 * Path or S3 key template that FileBuild can join, scan, and listen on.
 * FilePattern and S3Pattern implement this.
 */
export interface ItemPattern {
  readonly optional: boolean
  readonly list: boolean
  readonly varNames: readonly string[]
  listenPrefix(root: string): Prefix
  boundPrefix(vars: Vars, root: string): Prefix
  matchId(id: string, root: string): Vars | null
  renderId(vars: Vars, root: string): string
  artifact(id: string, root: string): Item
  scan(root: string): Promise<string[]>
  prepareOutput(artifact: Item): Promise<void>
  sortKey(artifact: Item): string
}
