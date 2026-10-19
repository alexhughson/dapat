import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"
import { sha256Hex } from "./hash"

/**
 * How a file stamp sees a change.
 * "time": the modified time in nanoseconds and the size. Fast: it reads no bytes.
 *   A touch or a git checkout that keeps the bytes still changes the stamp.
 * "hash": the SHA-256 of the bytes. It reads each file in full.
 */
export type FileStampMode = "time" | "hash"

/** The options that `file()`, `directory()`, and `pathPrefix()` accept. */
export interface FileStampOptions {
  stamp?: FileStampMode
}

/** The stamp mode in `opts`. Default "time". Throws for an unknown mode. */
export function stampMode(opts: FileStampOptions | undefined): FileStampMode {
  const mode = opts?.stamp ?? "time"
  if (mode !== "time" && mode !== "hash") {
    throw new Error(`stamp must be "time" or "hash", not ${JSON.stringify(mode)}`)
  }
  return mode
}

/** The stamp of one file. null when the path is not a readable file. */
export async function stampFile(filePath: string, mode: FileStampMode): Promise<string | null> {
  if (mode === "hash") {
    let bytes: Uint8Array
    try {
      bytes = await readFile(filePath)
    } catch {
      return null
    }
    return sha256Hex(bytes)
  }
  let info
  try {
    info = await stat(filePath, { bigint: true })
  } catch {
    return null
  }
  if (!info.isFile()) return null
  return `${info.mtimeNs}:${info.size}`
}

/**
 * The SHA-256 of the sorted lines `<relative path>=<file stamp>` for every file under `root`.
 * null when `root` cannot be read.
 */
export async function stampTree(root: string, mode: FileStampMode): Promise<string | null> {
  const files = await walkFiles(root)
  if (files === null) return null
  const lines: string[] = []
  for (const filePath of files) {
    const stamp = await stampFile(filePath, mode)
    // A file that went away during the walk is not under the root now.
    if (stamp === null) continue
    const rel = path.relative(root, filePath)
    lines.push(`${rel}=${stamp}`)
  }
  return hashLines(lines)
}

/** The SHA-256 of the sorted lines. An empty list has a stamp too. */
export function hashLines(lines: string[]): string {
  const sorted = [...lines]
  sorted.sort()
  return sha256Hex(new TextEncoder().encode(sorted.join("\n")))
}

/** The absolute path of every file under `root`, at any depth. null when `root` cannot be read. */
export async function walkFiles(root: string): Promise<string[] | null> {
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
