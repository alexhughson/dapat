import type { Dirent } from "node:fs"
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
  // The stamp mode of each `FileArtifact` that the matcher sends.
  private readonly stampMode: FileStampMode
  private readonly keyPattern: KeyPattern
  // One entry for each `/`-separated part of the pattern, in order.
  private readonly segments: ScanSegment[]
  // Each file that has a match now, by absolute path. A file with no match has no record.
  private readonly knownFiles = new Map<string, KnownFile>()

  constructor(pattern: string, opts?: FileStampOptions) {
    super()
    if (pattern.length === 0) {
      throw new Error("FileMatcher: the pattern is empty")
    }
    for (const part of pattern.split("/")) {
      if (part === "..") {
        throw new Error(
          `FileMatcher pattern '${pattern}': a '..' part is not allowed; give an absolute pattern, for example from path.resolve`,
        )
      }
    }
    const textOutsideVars = pattern.replace(VAR_TOKEN, "")
    if (textOutsideVars.includes("<") || textOutsideVars.includes(">")) {
      throw new Error(
        `FileMatcher pattern '${pattern}': each '<' and '>' must enclose a var name of letters, digits, and '_' that does not start with a digit`,
      )
    }
    const normalized = path.posix.normalize(pattern)
    const segmentTexts = splitSegments(normalized)
    if (segmentTexts.length === 0) {
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
    this.stampMode = stampMode(opts)
    this.segments = []
    for (const text of segmentTexts) {
      const segmentPattern = new KeyPattern(text)
      if (segmentPattern.varNames.length === 0) {
        this.segments.push({ kind: "literal", name: text })
      } else {
        this.segments.push({ kind: "vars", pattern: segmentPattern })
      }
    }
  }

  /** The vars of the file at the absolute `filePath`, or null when the file does not fit the pattern. */
  private match(filePath: string): Vars | null {
    const relativePath = path.relative(this.root, filePath)
    if (path.isAbsolute(relativePath)) return null
    // The pattern has no '..' part, so a file outside the root never fits. A var must not take '..'.
    if (relativePath === "..") return null
    if (relativePath.startsWith(`..${path.sep}`)) return null
    const key = relativePath.split(path.sep).join("/")
    return this.keyPattern.match(key)
  }

  /**
   * Reads the folders of the pattern and sends `found` for each file that fits it.
   * It joins a literal part to the path with no read, and reads a folder only for a part with a var.
   * A folder that does not exist has no files. A symlink to a file counts as that file.
   */
  async scan(signal: AbortSignal): Promise<void> {
    const filePaths: string[] = []
    await collectFiles(this.root, this.segments, 0, filePaths, signal)
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
    if (hasMatch) return
    // A file with no match needs no record. A later event makes a new one.
    this.knownFiles.delete(known.filePath)
    if (known.sent) {
      known.sent = false
      this.send({ kind: "gone", vars: known.vars })
    }
  }
}

/** A var token of KeyPattern: `<` and a name of letters, digits, and `_` that does not start with a digit, and `>`. */
const VAR_TOKEN = /<[A-Za-z_][A-Za-z0-9_]*>/g

/** One part of the pattern: a literal name, or a part with one or more vars. */
type ScanSegment = { kind: "literal"; name: string } | { kind: "vars"; pattern: KeyPattern }

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
 * Adds to `filePaths` each file below `folder` that fits `segments` from `index` on, in name order.
 * A literal part is joined with no read. A part with vars reads the folder, and stats only symlinks.
 * The name check of a part is only a filter: `match` checks the whole path later, for a var that comes twice.
 * A folder that is missing, or that is not a folder, adds no file.
 */
async function collectFiles(
  folder: string,
  segments: readonly ScanSegment[],
  index: number,
  filePaths: string[],
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return
  const segment = segments[index]!
  const isLast = index === segments.length - 1
  if (segment.kind === "literal") {
    const childPath = path.join(folder, segment.name)
    if (!isLast) {
      await collectFiles(childPath, segments, index + 1, filePaths, signal)
      return
    }
    const kind = await kindOfPath(childPath)
    if (kind === "file") filePaths.push(childPath)
    return
  }
  let entries: Dirent[]
  try {
    entries = await fsPromises.readdir(folder, { withFileTypes: true })
  } catch (error) {
    if (isMissingPath(error)) return
    throw error
  }
  entries.sort(compareNames)
  for (const entry of entries) {
    if (segment.pattern.match(entry.name) === null) continue
    const childPath = path.join(folder, entry.name)
    let kind: "file" | "folder" | "other" = "other"
    if (entry.isSymbolicLink()) {
      kind = await kindOfPath(childPath)
    } else if (entry.isFile()) {
      kind = "file"
    } else if (entry.isDirectory()) {
      kind = "folder"
    }
    if (isLast) {
      if (kind === "file") filePaths.push(childPath)
      continue
    }
    if (kind === "folder") {
      await collectFiles(childPath, segments, index + 1, filePaths, signal)
    }
  }
}

function compareNames(left: Dirent, right: Dirent): number {
  if (left.name < right.name) return -1
  if (left.name > right.name) return 1
  return 0
}

/** "file" or "folder", after symlinks. "other" for a missing path, a broken link, a socket, or a device. */
async function kindOfPath(fullPath: string): Promise<"file" | "folder" | "other"> {
  let info
  try {
    info = await fsPromises.stat(fullPath)
  } catch (error) {
    if (isMissingPath(error)) return "other"
    if (errorCode(error) === "ELOOP") return "other"
    throw error
  }
  if (info.isFile()) return "file"
  if (info.isDirectory()) return "folder"
  return "other"
}

/** True for the errors of a path that is not there, or that goes through a file. */
function isMissingPath(error: unknown): boolean {
  const code = errorCode(error)
  if (code === "ENOENT") return true
  if (code === "ENOTDIR") return true
  return false
}

function errorCode(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return undefined
  return (error as { code?: unknown }).code
}
