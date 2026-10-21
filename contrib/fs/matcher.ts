import type { ArtifactEvent } from "../../src/build"
import { Matcher } from "../../src/matcher"
import type { FileArtifact } from "./file"
import { FileMatchStates, type FileMatchChange } from "./file-match-states"
import { FilePattern, type FilePatternOptions } from "./file-pattern"
import { stampMode } from "./stamp"

/**
 * Finds the files that fit a pattern such as `content/<lang>/<slug>.md`, and sends one
 * match for each file: `{ vars: { lang, slug }, data: FileArtifact }`.
 * A relative pattern resolves against the current working directory when you create the matcher,
 * as the path of a `FileArtifact` does.
 * A file has a match while the file is on disk, as far as the matcher knows, or while a task
 * declares it as an output.
 * The `syntax` option sets other characters for the vars and the globs, for a path that holds `<`, `>`, or `*`.
 */
export class FileMatcher extends Matcher<FileArtifact> {
  /** The pattern after normalization, for example `content/<lang>/<slug>.md`. */
  readonly pattern: string
  /** The absolute folder that the pattern is relative to: the working directory, or `/` for an absolute pattern. */
  readonly root: string
  readonly varNames: readonly string[]
  private readonly filePattern: FilePattern
  private readonly fileStates: FileMatchStates

  constructor(pattern: string, opts?: FilePatternOptions) {
    super()
    const filePattern = new FilePattern(pattern, "FileMatcher", opts?.syntax)
    if (filePattern.hasGlob) {
      const syntax = filePattern.syntax
      const varExample = `${syntax.varStart}name${syntax.varEnd}`
      throw new Error(
        `FileMatcher pattern '${pattern}': '${syntax.anyName}' and '${syntax.anyFolders}' are not allowed; use a var such as ${varExample} for each part that changes, or FileGroupMatcher for one match with a list of files`,
      )
    }
    this.filePattern = filePattern
    this.pattern = filePattern.pattern
    this.root = filePattern.root
    this.varNames = filePattern.varNames
    this.fileStates = new FileMatchStates(filePattern, stampMode(opts))
  }

  /**
   * Reads the folders of the pattern and sends `found` for each file that fits it.
   * It joins a literal part to the path with no read, and reads a folder only for a part with a var.
   * A folder that does not exist has no files. A symlink to a file counts as that file.
   */
  async scan(signal: AbortSignal): Promise<void> {
    const filePaths = await this.filePattern.collectFiles(signal)
    if (signal.aborted) return
    for (const filePath of filePaths) {
      const change = this.fileStates.foundOnDisk(filePath)
      this.sendChange(change)
    }
  }

  /**
   * `promised` and `produced` of a `FileArtifact` that fits the pattern make a match.
   * `deleted` and `withdrawn` remove it, unless the file is still on disk or a task still declares it.
   */
  override receiveArtifactEvent(event: ArtifactEvent): void {
    const change = this.fileStates.receive(event)
    this.sendChange(change)
  }

  private sendChange(change: FileMatchChange | null): void {
    if (change === null) return
    const file = change.file
    if (change.kind === "found") {
      this.send({ kind: "found", matched: { vars: file.vars, data: file.artifact } })
      return
    }
    this.send({ kind: "gone", vars: file.vars })
  }
}
