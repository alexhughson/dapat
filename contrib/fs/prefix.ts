import { Prefix } from "../../src/prefix"
import { dirId, resolveDirPath } from "./id"

export class PathPrefix extends Prefix {
  readonly path: string
  readonly id: string

  constructor(p: string) {
    super()
    this.path = resolveDirPath(p)
    this.id = dirId(this.path)
  }
}

export function pathPrefix(p: string): PathPrefix {
  return new PathPrefix(p)
}
