import { Prefix } from "../../src/prefix"
import { dirId, resolveDirPath } from "./id"
import { hashLines } from "../hash"
import { stampMode, stampTree, type FileStampMode, type FileStampOptions } from "./stamp"

export class PathPrefix extends Prefix {
  readonly path: string
  readonly id: string
  readonly stampMode: FileStampMode

  constructor(p: string, opts?: FileStampOptions) {
    super()
    this.path = resolveDirPath(p)
    this.id = dirId(this.path)
    this.stampMode = stampMode(opts)
  }

  /**
   * The SHA-256 of the sorted lines `<relative path>=<file stamp>` for every file under the path.
   * A missing directory is an empty region, so it has the stamp of an empty list.
   * Throws when the path is a file, not a folder, and for every error other than a missing path.
   */
  async stamp(): Promise<string | null> {
    const stamp = await stampTree(this.path, this.stampMode)
    if (stamp === null) return hashLines([])
    return stamp
  }
}

export function pathPrefix(p: string, opts?: FileStampOptions): PathPrefix {
  return new PathPrefix(p, opts)
}
