import { readFile } from "node:fs/promises"
import { Artifact } from "../../src/artifact"
import { fileId, resolveFilePath } from "./id"
import { stampFile, stampMode, type FileStampMode, type FileStampOptions } from "./stamp"

export class FileArtifact extends Artifact<Uint8Array> {
  readonly path: string
  readonly id: string
  readonly stampMode: FileStampMode

  constructor(p: string, opts?: FileStampOptions) {
    super()
    this.path = resolveFilePath(p)
    this.id = fileId(this.path)
    this.stampMode = stampMode(opts)
  }

  /**
   * "hash" (the default): the SHA-256 hex of the bytes. "time": the modified time in nanoseconds and the size.
   * null when the file is missing. Throws when the path is not a file, and for every other error.
   */
  async stamp(): Promise<string | null> {
    return stampFile(this.path, this.stampMode)
  }

  async read(): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.path))
  }
}
