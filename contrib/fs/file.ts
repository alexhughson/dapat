import { readFile } from "node:fs/promises"
import { Artifact } from "../../src/artifact"
import { sha256Hex } from "./hash"
import { fileId, resolveFilePath } from "./id"

export class FileArtifact extends Artifact<Uint8Array> {
  readonly path: string
  readonly id: string

  constructor(p: string) {
    super()
    this.path = resolveFilePath(p)
    this.id = fileId(this.path)
  }

  /** The SHA-256 hex of the bytes. */
  async stamp(): Promise<string | null> {
    try {
      const bytes = await readFile(this.path)
      return sha256Hex(bytes)
    } catch {
      return null
    }
  }

  async read(): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.path))
  }
}

export function file(p: string): FileArtifact {
  return new FileArtifact(p)
}
