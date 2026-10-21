import type { Dirent } from "node:fs"
import * as fsPromises from "node:fs/promises"
import path from "node:path"
import type { Vars } from "../../src/matched-artifact"
import { DEFAULT_PATTERN_SYNTAX, KeyPattern, type PatternSyntax } from "../../src/pattern"
import * as stamp from "./stamp"
import type { FileStampOptions } from "./stamp"

/**
 * One part of the pattern, for the scan: a literal name, a part with vars or `*` that filters
 * the names of one folder, or `**`, which takes the files under a folder at any depth.
 */
type ScanSegment = { kind: "literal"; name: string } | { kind: "names"; pattern: KeyPattern } | { kind: "anyDepth" }

/**
 * The characters that have a special meaning in a file pattern. Each one you leave out keeps its default.
 * Use other characters when a folder or file name in the pattern holds `<`, `>`, or `*`.
 */
export interface FilePatternSyntax {
  /** The text before a var name. Default `<`. */
  varStart?: string
  /** The text after a var name. Default `>`. */
  varEnd?: string
  /** The glob that matches any text in one part of the path. Default `*`. */
  anyName?: string
  /** The glob part that matches zero or more folders. Default `**`. */
  anyFolders?: string
}

/** The options of FileMatcher and FileGroupMatcher. */
export interface FileMatcherOptions extends FileStampOptions {
  syntax?: FilePatternSyntax
}

/**
 * A file pattern such as `content/<lang>/<slug>.md` or `site/<lang>/**\/*.html`, after its checks.
 * FileMatcher and FileGroupMatcher use it: it tells the vars of a path, and it finds the files on disk.
 * A relative pattern resolves against the working directory when you create it.
 */
export class FilePattern {
  /** The pattern after normalization, for example `content/<lang>/<slug>.md`. */
  readonly pattern: string
  /** The absolute folder that the pattern is relative to: the working directory, or `/` for an absolute pattern. */
  readonly root: string
  readonly varNames: readonly string[]
  /** True when the pattern has a `*` or a `**`. */
  readonly hasGlob: boolean
  /** True when a var is in the part of the first `*` or `**`, or in a part after it. */
  readonly hasVarAtOrAfterGlob: boolean
  /** The syntax of the pattern, with the defaults for each character that the caller left out. */
  readonly syntax: PatternSyntax
  private readonly keyPattern: KeyPattern
  // The parts that the scan walks one at a time, in order: the parts up to the first `**`, or all parts.
  private readonly segments: ScanSegment[]

  /** `matcherName` is the class name at the start of each error message. */
  constructor(pattern: string, matcherName: string, syntaxOption?: FilePatternSyntax) {
    const syntax = resolveSyntax(syntaxOption, matcherName)
    const anyFolders = syntax.anyFolders
    if (pattern.length === 0) {
      throw new Error(`${matcherName}: the pattern is empty`)
    }
    for (const part of pattern.split("/")) {
      if (part === "..") {
        throw new Error(
          `${matcherName} pattern '${pattern}': a '..' part is not allowed; for a folder above the working directory, use path.resolve to make the pattern absolute`,
        )
      }
      if (part !== anyFolders && part.includes(anyFolders)) {
        throw new Error(
          `${matcherName} pattern '${pattern}': '${anyFolders}' must be a whole part, as in 'a/${anyFolders}/b'`,
        )
      }
    }
    const varToken = varTokenRegexOf(syntax)
    const textOutsideVars = pattern.replace(varToken, "")
    if (textOutsideVars.includes(syntax.varStart) || textOutsideVars.includes(syntax.varEnd)) {
      throw new Error(
        `${matcherName} pattern '${pattern}': each '${syntax.varStart}' and '${syntax.varEnd}' must enclose a var name of letters, digits, and '_' that does not start with a digit`,
      )
    }
    const normalized = path.posix.normalize(pattern)
    const segmentTexts = splitSegments(normalized)
    if (segmentTexts.length === 0) {
      throw new Error(`${matcherName} pattern '${pattern}' names no file`)
    }
    const lastText = segmentTexts[segmentTexts.length - 1]!
    if (lastText === anyFolders) {
      throw new Error(
        `${matcherName} pattern '${pattern}': the last part must name files, not '${anyFolders}'; use '${anyFolders}/${syntax.anyName}' for every file`,
      )
    }
    const keyPattern = new KeyPattern(normalized, syntax)
    let root = process.cwd()
    if (path.posix.isAbsolute(normalized)) {
      root = "/"
    }
    this.pattern = normalized
    this.root = root
    this.syntax = syntax
    this.keyPattern = keyPattern
    this.varNames = keyPattern.varNames
    this.hasGlob = keyPattern.hasGlob
    let globSeen = false
    let varAtOrAfterGlob = false
    // True after a `**`. The scan takes every file under that folder, and `match` checks the parts after it.
    let anyDepthSeen = false
    this.segments = []
    for (const text of segmentTexts) {
      const segmentPattern = new KeyPattern(text, syntax)
      if (segmentPattern.hasGlob) globSeen = true
      if (globSeen && segmentPattern.varNames.length > 0) varAtOrAfterGlob = true
      if (anyDepthSeen) continue
      if (text === anyFolders) {
        anyDepthSeen = true
        this.segments.push({ kind: "anyDepth" })
      } else if (segmentPattern.varNames.length === 0 && !segmentPattern.hasGlob) {
        this.segments.push({ kind: "literal", name: text })
      } else {
        this.segments.push({ kind: "names", pattern: segmentPattern })
      }
    }
    this.hasVarAtOrAfterGlob = varAtOrAfterGlob
  }

  /** The vars of the file at the absolute `filePath`, or null when the file does not fit the pattern. */
  match(filePath: string): Vars | null {
    const relativePath = path.relative(this.root, filePath)
    if (path.isAbsolute(relativePath)) return null
    // The pattern has no '..' part, so a file outside the root never fits. A var must not take '..'.
    if (relativePath === "..") return null
    if (relativePath.startsWith(`..${path.sep}`)) return null
    const key = relativePath.split(path.sep).join("/")
    return this.keyPattern.match(key)
  }

  /**
   * The absolute path of each file on disk that can fit the pattern. The caller checks each path with `match`.
   * A literal part is joined to the path with no read. A part with a var or a `*` reads the folder.
   * At a `**`, it takes every file under the folder, at any depth, as `FilesystemPrefix.list` does.
   * A folder that is missing, that is not a folder, or that is a link loop, adds no file.
   * The files of a part come in name order. Below a `**`, the order is the order of the folder reads.
   */
  async collectFiles(signal: AbortSignal): Promise<string[]> {
    const filePaths: string[] = []
    await collectFilesBelow(this.root, this.segments, 0, filePaths, signal)
    return filePaths
  }
}

const SYNTAX_KEYS = ["varStart", "varEnd", "anyName", "anyFolders"] as const

/**
 * The syntax with the default for each character that `syntaxOption` leaves out. Throws for a syntax
 * that has no single parse: an empty marker, a marker with a `/`, `anyName` or `anyFolders` that is
 * `.` or `..`, two markers that are equal, and a marker that holds another marker. Only `anyFolders`
 * can hold `anyName`, as `**` holds `*`.
 */
function resolveSyntax(syntaxOption: FilePatternSyntax | undefined, matcherName: string): PatternSyntax {
  if (syntaxOption === undefined) return DEFAULT_PATTERN_SYNTAX
  const syntax: PatternSyntax = {
    varStart: syntaxOption.varStart ?? DEFAULT_PATTERN_SYNTAX.varStart,
    varEnd: syntaxOption.varEnd ?? DEFAULT_PATTERN_SYNTAX.varEnd,
    anyName: syntaxOption.anyName ?? DEFAULT_PATTERN_SYNTAX.anyName,
    anyFolders: syntaxOption.anyFolders ?? DEFAULT_PATTERN_SYNTAX.anyFolders,
  }
  for (const key of SYNTAX_KEYS) {
    const marker: unknown = syntax[key]
    if (typeof marker !== "string") {
      throw new Error(`${matcherName} syntax: ${key} must be a string, not ${typeof marker}`)
    }
    if (marker.length === 0) {
      throw new Error(`${matcherName} syntax: ${key} is empty`)
    }
    if (marker.includes("/")) {
      throw new Error(`${matcherName} syntax: ${key} '${marker}' holds '/', which separates the parts of a path`)
    }
  }
  for (const key of ["anyName", "anyFolders"] as const) {
    const marker = syntax[key]
    if (marker === "." || marker === "..") {
      throw new Error(`${matcherName} syntax: ${key} cannot be '${marker}', because it is a part of a path`)
    }
  }
  for (const outerKey of SYNTAX_KEYS) {
    for (const innerKey of SYNTAX_KEYS) {
      if (outerKey === innerKey) continue
      const outer = syntax[outerKey]
      const inner = syntax[innerKey]
      if (outer === inner) {
        throw new Error(`${matcherName} syntax: ${outerKey} and ${innerKey} are both '${outer}'`)
      }
      if (outerKey === "anyFolders" && innerKey === "anyName") continue
      if (outer.includes(inner)) {
        throw new Error(`${matcherName} syntax: ${outerKey} '${outer}' holds ${innerKey} '${inner}', so a pattern has no single parse`)
      }
    }
  }
  return syntax
}

/** A var token: `varStart`, a name of letters, digits, and `_` that does not start with a digit, and `varEnd`. */
function varTokenRegexOf(syntax: PatternSyntax): RegExp {
  const start = escapeRegex(syntax.varStart)
  const end = escapeRegex(syntax.varEnd)
  return new RegExp(`${start}[A-Za-z_][A-Za-z0-9_]*${end}`, "g")
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
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
 * Adds to `filePaths` each file below `folder` that can fit `segments` from `index` on.
 * A literal part is joined with no read. A part with vars or `*` reads the folder, and stats only symlinks
 * and entries whose type the filesystem does not report.
 * The name check of a part is only a filter: `match` checks the whole path later, for a var that comes twice.
 */
async function collectFilesBelow(
  folder: string,
  segments: readonly ScanSegment[],
  index: number,
  filePaths: string[],
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return
  const segment = segments[index]!
  const isLast = index === segments.length - 1
  if (segment.kind === "anyDepth") {
    const folderKind = await kindOfPath(folder)
    if (folderKind !== "folder") return
    const filesUnder = await stamp.walkFiles(folder)
    if (signal.aborted) return
    if (filesUnder === null) return
    for (const filePath of filesUnder) {
      filePaths.push(filePath)
    }
    return
  }
  if (segment.kind === "literal") {
    const childPath = path.join(folder, segment.name)
    if (!isLast) {
      await collectFilesBelow(childPath, segments, index + 1, filePaths, signal)
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
    let kind: "file" | "folder" | "other"
    if (entry.isFile()) {
      kind = "file"
    } else if (entry.isDirectory()) {
      kind = "folder"
    } else {
      kind = await kindOfPath(childPath)
    }
    if (isLast) {
      if (kind === "file") filePaths.push(childPath)
      continue
    }
    if (kind === "folder") {
      await collectFilesBelow(childPath, segments, index + 1, filePaths, signal)
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
    throw error
  }
  if (info.isFile()) return "file"
  if (info.isDirectory()) return "folder"
  return "other"
}

/** True for the errors of a path that is not there, that goes through a file, or that is a link loop. */
function isMissingPath(error: unknown): boolean {
  const code = errorCode(error)
  if (code === "ENOENT") return true
  if (code === "ENOTDIR") return true
  if (code === "ELOOP") return true
  return false
}

function errorCode(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return undefined
  return (error as { code?: unknown }).code
}
