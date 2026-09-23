import { readFile, stat } from "node:fs/promises"
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

  async orderStamp(): Promise<bigint | null> {
    try {
      const info = await stat(this.path, { bigint: true })
      if (!info.isFile()) return null
      return info.mtimeNs
    } catch {
      return null
    }
  }

  async contentStamp(): Promise<string | null> {
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
