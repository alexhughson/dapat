import { Prefix } from "../../src/prefix"
import { dirId, resolveDirPath } from "./id"
import { hashLines } from "../hash"
import { stampMode, stampTree, walkFiles, type FileStampMode, type FileStampOptions } from "./stamp"

/** A folder on disk. A task can read it, write into it, and list the files under it. */
export class FilesystemPrefix extends Prefix {
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
   * A missing folder is an empty region, so it has the stamp of an empty list.
   * Throws when the path is a file, not a folder, and for every error other than a missing path.
   */
  async stamp(): Promise<string | null> {
    const stamp = await stampTree(this.path, this.stampMode)
    if (stamp === null) return hashLines([])
    return stamp
  }

  /**
   * The absolute path of every file under the folder, at any depth, as the stamp sees them.
   * A missing folder is an empty list. Throws when the path is a file, and for every other error.
   */
  async list(): Promise<string[]> {
    const files = await walkFiles(this.path)
    if (files === null) return []
    return files
  }
}

export function folder(p: string, opts?: FileStampOptions): FilesystemPrefix {
  return new FilesystemPrefix(p, opts)
}
