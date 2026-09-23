import type { Artifact } from "../../src/artifact"
import type { Prefix } from "../../src/prefix"
import type { Vars } from "./vars"

/** One stamped byte artifact that a pattern bound. */
export type Item = Artifact<Uint8Array>

export type ItemInput = Item | Item[] | undefined

/**
 * Pattern that FileBuild can scan and join as an input.
 * FilePattern and S3Pattern implement this. GitCommitPattern does too.
 */
export interface InputPattern {
  readonly optional: boolean
  readonly list: boolean
  readonly varNames: readonly string[]
  listenPrefix(root: string): Prefix
  matchId(id: string, root: string): Vars | null
  artifact(id: string, root: string): Item
  scan(root: string): Promise<string[]>
  sortKey(artifact: Item): string
}

/**
 * Pattern that FileBuild can render as an output.
 * FilePattern and S3Pattern implement this.
 */
export interface OutputPattern {
  readonly list: boolean
  readonly varNames: readonly string[]
  listenPrefix(root: string): Prefix
  renderId(vars: Vars, root: string): string
  artifact(id: string, root: string): Item
  boundPrefix(vars: Vars, root: string): Prefix
  prepareOutput(artifact: Item): Promise<void>
  preparePrefix(prefix: Prefix): Promise<void>
}
