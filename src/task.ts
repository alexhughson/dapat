import { Artifact } from "./artifact"
import { Prefix } from "./prefix"

export type Ref = Artifact | Prefix

export function isPrefix(ref: Ref): ref is Prefix {
  return ref instanceof Prefix
}

export function isArtifact(ref: Ref): ref is Artifact {
  return ref instanceof Artifact
}

export interface Context {
  readonly signal: AbortSignal
  add(task: Task): void
  remove(id: string): void
  produced(artifact: Artifact): void
}

export interface TaskInit {
  id: string
  inputs?: Ref[]
  outputs?: Ref[]
  run: (ctx: Context) => Promise<void>
}

export class Task {
  readonly id: string
  readonly inputs: readonly Ref[]
  readonly outputs: readonly Ref[]
  readonly run: (ctx: Context) => Promise<void>

  constructor(init: TaskInit) {
    this.id = init.id
    this.inputs = init.inputs ? [...init.inputs] : []
    this.outputs = init.outputs ? [...init.outputs] : []
    this.run = init.run
  }
}
