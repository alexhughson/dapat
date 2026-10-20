import * as fsPromises from "node:fs/promises"
import path from "node:path"
import type { ArtifactEvent } from "../../src/build"
import type { Vars } from "../../src/matched-artifact"
import { Matcher } from "../../src/matcher"
import { KeyPattern } from "../../src/pattern"
import { FileArtifact } from "./file"
import { stampMode, type FileStampMode, type FileStampOptions } from "./stamp"

/** What the matcher knows about one file that fits its pattern. */
type KnownFile = {
  vars: Vars
  filePath: string
  // True when the scan found the file, or a task produced it, and no task deleted it after that.
  onDisk: boolean
  // The ids of the tasks that declare the file as an output now.
  promisedBy: Set<string>
  // True when the matcher sent `found` for the file and no `gone` after that.
  sent: boolean
}

/**
 * Finds the files that fit a pattern such as `content/<lang>/<slug>.md`, and sends one
 * match for each file: `{ vars: { lang, slug }, data: FileArtifact }`.
 * A relative pattern resolves against the current working directory when you create the matcher,
 * as the path of a `FileArtifact` does.
 * A file has a match while the file is on disk, as far as the matcher knows, or while a task
 * declares it as an output.
 */
export class FileMatcher extends Matcher<FileArtifact> {
  /** The pattern after normalization, for example `content/<lang>/<slug>.md`. */
  readonly pattern: string
  /** The absolute folder that the pattern is relative to: the working directory, or `/` for an absolute pattern. */
  readonly root: string
  readonly varNames: readonly string[]
  /** The stamp mode of each `FileArtifact` that the matcher sends. */
  readonly stampMode: FileStampMode
  private readonly keyPattern: KeyPattern
  // The number of `/`-separated parts of the pattern.
  private readonly segmentCount: number
  // The literal folder of the pattern before its first var, relative to the root. Empty or ends with `/`.
  private readonly staticPrefix: string
  // Each file that fits the pattern and that the matcher knows about, by absolute path.
  private readonly knownFiles = new Map<string, KnownFile>()

  constructor(pattern: string, opts?: FileStampOptions) {
    super()
    if (pattern.length === 0) {
      throw new Error("FileMatcher: the pattern is empty")
    }
    const normalized = path.posix.normalize(pattern)
    const segments = splitSegments(normalized)
    if (segments.length === 0) {
      throw new Error(`FileMatcher pattern '${pattern}' names no file`)
    }
    const keyPattern = new KeyPattern(normalized)
    if (keyPattern.hasGlob) {
      throw new Error(
        `FileMatcher pattern '${pattern}': '*' and '**' are not supported yet; use a <name> var for each part that changes`,
      )
    }
    let root = process.cwd()
    if (path.posix.isAbsolute(normalized)) {
      root = "/"
    }
    this.pattern = normalized
    this.root = root
    this.keyPattern = keyPattern
    this.varNames = keyPattern.varNames
    this.segmentCount = segments.length
    this.staticPrefix = keyPattern.staticPrefix()
    this.stampMode = stampMode(opts)
  }

  /**
   * The vars of the file at `filePath`, or null when the file does not fit the pattern.
   * A relative `filePath` resolves against the working directory.
   */
  match(filePath: string): Vars | null {
    const absolutePath = path.resolve(filePath)
    const relativePath = path.relative(this.root, absolutePath)
    if (path.isAbsolute(relativePath)) return null
    const key = relativePath.split(path.sep).join("/")
    return this.keyPattern.match(key)
  }

  /**
   * Reads the folders of the pattern and sends `found` for each file that fits it.
   * A folder that does not exist has no files. A symlink to a file counts as that file.
   */
  async scan(signal: AbortSignal): Promise<void> {
    const filePaths: string[] = []
    const prefixSegmentCount = splitSegments(this.staticPrefix).length
    const depthBelowPrefix = this.segmentCount - prefixSegmentCount
    if (depthBelowPrefix === 0) {
      // The pattern has no var, so it names one file.
      const filePath = path.join(this.root, this.pattern)
      const kind = await kindOfPath(filePath)
      if (kind === "file") filePaths.push(filePath)
    } else {
      const startFolder = path.join(this.root, this.staticPrefix)
      await collectFiles(startFolder, depthBelowPrefix, filePaths, signal)
    }
    if (signal.aborted) return
    for (const filePath of filePaths) {
      const known = this.knownFileFor(filePath)
      if (known === null) continue
      known.onDisk = true
      this.sendChange(known)
    }
  }

  /**
   * `promised` and `produced` of a `FileArtifact` that fits the pattern make a match.
   * `deleted` and `withdrawn` remove it, unless the file is still on disk or a task still declares it.
   */
  override receiveArtifactEvent(event: ArtifactEvent): void {
    if (event.kind === "promised" || event.kind === "withdrawn") {
      if (!(event.output instanceof FileArtifact)) return
      const known = this.knownFileFor(event.output.path)
      if (known === null) return
      if (event.kind === "promised") {
        known.promisedBy.add(event.taskId)
      } else {
        known.promisedBy.delete(event.taskId)
      }
      this.sendChange(known)
      return
    }
    if (!(event.artifact instanceof FileArtifact)) return
    const known = this.knownFileFor(event.artifact.path)
    if (known === null) return
    if (event.kind === "produced") {
      known.onDisk = true
    } else {
      known.onDisk = false
    }
    this.sendChange(known)
  }

  /** The record of the file at the absolute `filePath`, made when it is new. null when the file does not fit. */
  private knownFileFor(filePath: string): KnownFile | null {
    const existing = this.knownFiles.get(filePath)
    if (existing !== undefined) return existing
    const vars = this.match(filePath)
    if (vars === null) return null
    const known: KnownFile = { vars, filePath, onDisk: false, promisedBy: new Set(), sent: false }
    this.knownFiles.set(filePath, known)
    return known
  }

  /** Sends `found` when the file has a match now and did not before, and `gone` for the reverse. */
  private sendChange(known: KnownFile): void {
    const hasMatch = known.onDisk || known.promisedBy.size > 0
    if (hasMatch && !known.sent) {
      known.sent = true
      const file = new FileArtifact(known.filePath, { stamp: this.stampMode })
      this.send({ kind: "found", matched: { vars: known.vars, data: file } })
      return
    }
    if (!hasMatch && known.sent) {
      known.sent = false
      this.send({ kind: "gone", vars: known.vars })
    }
  }
}

function splitSegments(pattern: string): string[] {
  const segments: string[] = []
  for (const part of pattern.split("/")) {
    if (part.length === 0) continue
    if (part === ".") continue
    segments.push(part)
  }
  return segments
}

/**
 * Adds to `filePaths` each file that is `depth` levels below `folder`, in name order.
 * A folder that is missing, or that is not a folder, adds no file.
 */
async function collectFiles(folder: string, depth: number, filePaths: string[], signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  let names: string[]
  try {
    names = await fsPromises.readdir(folder)
  } catch (error) {
    if (isMissingFolder(error)) return
    throw error
  }
  names.sort()
  for (const name of names) {
    const fullPath = path.join(folder, name)
    const kind = await kindOfPath(fullPath)
    if (depth === 1) {
      if (kind === "file") filePaths.push(fullPath)
      continue
    }
    if (kind === "folder") {
      await collectFiles(fullPath, depth - 1, filePaths, signal)
    }
  }
}

/** "file" or "folder", after symlinks. "other" for a missing path, a broken link, a socket, or a device. */
async function kindOfPath(fullPath: string): Promise<"file" | "folder" | "other"> {
  let info
  try {
    info = await fsPromises.stat(fullPath)
  } catch (error) {
    if (isMissingFolder(error)) return "other"
    if (errorCode(error) === "ELOOP") return "other"
    throw error
  }
  if (info.isFile()) return "file"
  if (info.isDirectory()) return "folder"
  return "other"
}

/** True for the errors of a path that is not there, or that goes through a file. */
function isMissingFolder(error: unknown): boolean {
  const code = errorCode(error)
  if (code === "ENOENT") return true
  if (code === "ENOTDIR") return true
  return false
}

function errorCode(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return undefined
  return (error as { code?: unknown }).code
}
