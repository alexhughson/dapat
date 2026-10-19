import { Artifact } from "../../src/artifact"
import { dirId, resolveDirPath } from "./id"
import { stampMode, stampTree, walkFiles, type FileStampMode, type FileStampOptions } from "./stamp"

export class DirectoryArtifact extends Artifact<string[]> {
  readonly path: string
  readonly id: string
  readonly stampMode: FileStampMode

  constructor(p: string, opts?: FileStampOptions) {
    super()
    this.path = resolveDirPath(p)
    this.id = dirId(this.path)
    this.stampMode = stampMode(opts)
  }

  get coversOthers(): boolean {
    return true
  }

  covers(other: Artifact): boolean {
    if (other.id === this.id) return true
    return other.id.startsWith(this.id)
  }

  /** The SHA-256 of the sorted lines `<relative path>=<file stamp>`. null when the directory is missing. */
  async stamp(): Promise<string | null> {
    return stampTree(this.path, this.stampMode)
  }

  async read(): Promise<string[]> {
    const files = await walkFiles(this.path)
    if (files === null) {
      throw new Error(`missing directory ${this.path}`)
    }
    return files
  }
}

export function directory(p: string, opts?: FileStampOptions): DirectoryArtifact {
  return new DirectoryArtifact(p, opts)
}
