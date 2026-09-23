import { readdir } from "node:fs/promises"
import path from "node:path"
import { Artifact } from "../../src/artifact"
import { sha256Hex } from "./hash"
import { dirId, resolveDirPath } from "./id"
import { pathOrderStamp } from "./stamp"

export class DirectoryArtifact extends Artifact<string[]> {
  readonly path: string
  readonly id: string

  constructor(p: string) {
    super()
    this.path = resolveDirPath(p)
    this.id = dirId(this.path)
  }

  get coversOthers(): boolean {
    return true
  }

  covers(other: Artifact): boolean {
    if (other.id === this.id) return true
    return other.id.startsWith(this.id)
  }

  async orderStamp(): Promise<bigint | null> {
    const files = await walkFiles(this.path)
    if (files === null) return null
    let max = await pathOrderStamp(this.path)
    if (max === null) return null
    for (const filePath of files) {
      const order = await pathOrderStamp(filePath)
      if (order === null) continue
      if (order > max) max = order
    }
    return max
  }

  async contentStamp(): Promise<string | null> {
    const files = await walkFiles(this.path)
    if (files === null) return null
    const lines: string[] = []
    for (const filePath of files) {
      const rel = path.relative(this.path, filePath)
      const bytes = await Bun.file(filePath).bytes()
      const digest = sha256Hex(bytes)
      lines.push(`${rel}=${digest}`)
    }
    lines.sort()
    return sha256Hex(new TextEncoder().encode(lines.join("\n")))
  }

  async read(): Promise<string[]> {
    const files = await walkFiles(this.path)
    if (files === null) {
      throw new Error(`missing directory ${this.path}`)
    }
    return files
  }
}

export function directory(p: string): DirectoryArtifact {
  return new DirectoryArtifact(p)
}

async function walkFiles(root: string): Promise<string[] | null> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return null
  }
  const files: string[] = []
  const stack: { dir: string; items: typeof entries }[] = [
    { dir: root, items: entries },
  ]
  while (stack.length > 0) {
    const frame = stack.pop()
    if (!frame) break
    for (const entry of frame.items) {
      const full = path.join(frame.dir, entry.name)
      if (entry.isDirectory()) {
        const child = await readdir(full, { withFileTypes: true })
        stack.push({ dir: full, items: child })
      } else if (entry.isFile()) {
        files.push(full)
      }
    }
  }
  return files
}
