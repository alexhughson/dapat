import { createReadStream } from "node:fs"
import { readdir, readFile, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { hashLines, sha256Hex } from "../hash"

/**
 * How a file stamp sees a change.
 * "hash" (the default): the SHA-256 of the bytes. It reads each file in full.
 *   A rewrite with the same bytes keeps the stamp.
 * "time": the modified time in nanoseconds and the size. Fast: it reads no bytes.
 *   A touch, a rewrite with the same bytes, or a git checkout still changes the stamp.
 */
export type FileStampMode = "time" | "hash"

/** The options that `FileArtifact` and `FilesystemPrefix` accept. */
export interface FileStampOptions {
  stamp?: FileStampMode
}

// The number of files that one batch stats at the same time in "time" mode.
const STAT_BATCH = 256
// The number of files that one batch reads at the same time in "hash" mode.
const HASH_BATCH = 8
// A file larger than this is streamed into the hash, not read whole.
const STREAM_FROM = 1024 * 1024

/** The stamp mode in `opts`. Default "hash". Throws for an unknown mode. */
export function stampMode(opts: FileStampOptions | undefined): FileStampMode {
  const mode = opts?.stamp ?? "hash"
  if (mode !== "time" && mode !== "hash") {
    throw new Error(`stamp must be "time" or "hash", not ${JSON.stringify(mode)}`)
  }
  return mode
}

/**
 * The stamp of one file. It follows a symlink to its target.
 * null when the file is missing. Throws when the path is not a file, and for every other error.
 */
export async function stampFile(filePath: string, mode: FileStampMode): Promise<string | null> {
  let info
  try {
    info = await stat(filePath, { bigint: true })
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
  if (!info.isFile()) {
    throw new Error(`not a file: ${filePath}`)
  }
  if (mode === "time") {
    return `${info.mtimeNs}:${info.size}`
  }
  const identity = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
  const cached = hashCache.get(filePath)
  if (cached !== undefined && cached.identity === identity) {
    return cached.hash
  }
  const pending = hashOrNull(filePath, info.size)
  hashCache.set(filePath, { identity, hash: pending })
  try {
    return await pending
  } catch (error) {
    // A failed read must not stay in the cache.
    if (hashCache.get(filePath)?.hash === pending) {
      hashCache.delete(filePath)
    }
    throw error
  }
}

/**
 * The hash of each file that this process read, by path, with the stat identity at that time.
 * Many tasks can read one input, and each task stamps it. With this cache, the file is hashed
 * one time while its stat stays the same. The entry holds the promise, so tasks that stamp
 * the file at the same time share one read.
 * The cache trusts the stat identity only inside one process, as "time" does in all cases.
 * A new process hashes each file again, so the stamp is still the hash of the bytes.
 * Edge case: a write that keeps the device, inode, size, mtime, and ctime is not seen.
 */
const hashCache = new Map<string, { identity: string; hash: Promise<string | null> }>()

async function hashOrNull(filePath: string, size: bigint): Promise<string | null> {
  try {
    return await hashFile(filePath, size)
  } catch (error) {
    // The file went away after the stat.
    if (isMissing(error)) return null
    throw error
  }
}

async function hashFile(filePath: string, size: bigint): Promise<string> {
  if (size < BigInt(STREAM_FROM)) {
    const bytes = await readFile(filePath)
    return sha256Hex(bytes)
  }
  const hasher = new Bun.CryptoHasher("sha256")
  const stream = createReadStream(filePath, { highWaterMark: STREAM_FROM })
  for await (const chunk of stream) {
    hasher.update(chunk as Uint8Array)
  }
  return hasher.digest("hex")
}

/**
 * The SHA-256 of the sorted lines `<relative path>=<file stamp>` for every file under `root`.
 * null when `root` is missing. Throws when `root` is not a folder, and for every other error.
 */
export async function stampTree(root: string, mode: FileStampMode): Promise<string | null> {
  const files = await walkFiles(root)
  if (files === null) return null
  let batchSize = STAT_BATCH
  if (mode === "hash") {
    batchSize = HASH_BATCH
  }
  const lines: string[] = []
  for (let start = 0; start < files.length; start += batchSize) {
    const batch = files.slice(start, start + batchSize)
    const pending: Promise<string | null>[] = []
    for (const filePath of batch) {
      pending.push(stampFile(filePath, mode))
    }
    const stamps = await Promise.all(pending)
    for (let i = 0; i < batch.length; i++) {
      const stamp = stamps[i]
      // A file that went away during the walk is not under the root now.
      if (stamp === null || stamp === undefined) continue
      const rel = path.relative(root, batch[i]!)
      lines.push(`${rel}=${stamp}`)
    }
  }
  return hashLines(lines)
}

/**
 * The absolute path of every file under `root`, at any depth. It follows symlinks:
 * a link to a file counts as that file, and a link to a folder is walked.
 * A link back to a folder above it is not walked again.
 * null when `root` is missing. Throws when `root` is not a folder, and for every other error.
 */
export async function walkFiles(root: string): Promise<string[] | null> {
  let rootReal: string
  try {
    rootReal = await realpath(root)
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
  const files: string[] = []
  const found = await walkInto(root, rootReal, new Set<string>(), files)
  if (!found) return null
  return files
}

/**
 * Adds the files under `dir` to `files`. `ancestors` holds the real paths of the
 * folders above `dir`, so a symlink loop stops. Returns false when `dir` is missing.
 */
async function walkInto(
  dir: string,
  dirReal: string,
  ancestors: Set<string>,
  files: string[],
): Promise<boolean> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
  const below = new Set(ancestors)
  below.add(dirReal)
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isFile()) {
      files.push(full)
      continue
    }
    let isDir = entry.isDirectory()
    if (entry.isSymbolicLink()) {
      let target
      try {
        target = await stat(full)
      } catch (error) {
        // A link that cannot resolve adds no file: a broken link, a link to itself,
        // two links that point at each other, or a link through a file.
        if (isUnresolvedLink(error)) continue
        throw error
      }
      if (target.isFile()) {
        files.push(full)
        continue
      }
      isDir = target.isDirectory()
    }
    // Sockets, pipes, and devices have no stamp.
    if (!isDir) continue
    let childReal: string
    try {
      childReal = await realpath(full)
    } catch (error) {
      if (isUnresolvedLink(error)) continue
      throw error
    }
    if (below.has(childReal)) continue
    // A folder that went away during the walk adds no files.
    await walkInto(full, childReal, below, files)
  }
  return true
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT"
}

/** True for the errors of a link inside the walk that points at nothing. Only used below the root. */
function isUnresolvedLink(error: unknown): boolean {
  const code = errorCode(error)
  if (code === "ENOENT") return true
  if (code === "ELOOP") return true
  if (code === "ENOTDIR") return true
  return false
}

function errorCode(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return undefined
  return (error as { code?: unknown }).code
}
