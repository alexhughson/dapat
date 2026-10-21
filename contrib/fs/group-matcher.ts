import type { ArtifactEvent } from "../../src/build"
import type { Vars } from "../../src/matched-artifact"
import { Matcher } from "../../src/matcher"
import type { FileArtifact } from "./file"
import { FileMatchStates, type FileMatchChange } from "./file-match-states"
import { FilePattern, type FilePatternOptions } from "./file-pattern"
import { stampMode } from "./stamp"

/** The files that have a match now and have the same vars. */
type FileGroup = {
  // The values of the vars, in varNames order, as JSON.
  key: string
  vars: Vars
  // Sorted by path.
  files: FileArtifact[]
}

/**
 * Finds the files that fit a pattern with `*` or `**`, such as `site/<lang>/**\/*.html`, and sends
 * one match for each value of the vars, with the list of its files:
 * `{ vars: { lang }, data: [FileArtifact, ...] }`, sorted by path.
 * Vars come only in the parts before the first `*` or `**`. A glob does not make a var,
 * so the task reads those names from the path of each file.
 * A file is in the list while the file is on disk, as far as the matcher knows, or while a task
 * declares it as an output, as for FileMatcher. A list that becomes empty sends `gone`.
 * The `syntax` option sets other characters for the vars and the globs, as for FileMatcher.
 */
export class FileGroupMatcher extends Matcher<readonly FileArtifact[]> {
  /** The pattern after normalization, for example `site/<lang>/**\/*.html`. */
  readonly pattern: string
  /** The absolute folder that the pattern is relative to: the working directory, or `/` for an absolute pattern. */
  readonly root: string
  readonly varNames: readonly string[]
  private readonly filePattern: FilePattern
  private readonly fileStates: FileMatchStates
  // Each group with one or more files, by key.
  private readonly groupsByKey = new Map<string, FileGroup>()

  constructor(pattern: string, opts?: FilePatternOptions) {
    super()
    const filePattern = new FilePattern(pattern, "FileGroupMatcher", opts?.syntax)
    const anyName = filePattern.syntax.anyName
    const anyFolders = filePattern.syntax.anyFolders
    if (!filePattern.hasGlob) {
      throw new Error(
        `FileGroupMatcher pattern '${pattern}' has no '${anyName}' or '${anyFolders}'; use FileMatcher for one match for each file`,
      )
    }
    if (filePattern.hasVarAtOrAfterGlob) {
      throw new Error(
        `FileGroupMatcher pattern '${pattern}': a var must come in a part before the first '${anyName}' or '${anyFolders}'; read the other names from the path of each file`,
      )
    }
    this.filePattern = filePattern
    this.pattern = filePattern.pattern
    this.root = filePattern.root
    this.varNames = filePattern.varNames
    this.fileStates = new FileMatchStates(filePattern, stampMode(opts))
  }

  /**
   * Reads the folders of the pattern, and sends one `found` for each group that got files,
   * after the whole scan. The groups come in the order of their first file.
   */
  async scan(signal: AbortSignal): Promise<void> {
    const filePaths = await this.filePattern.collectFiles(signal)
    if (signal.aborted) return
    const changedGroups = new Set<FileGroup>()
    for (const filePath of filePaths) {
      const change = this.fileStates.foundOnDisk(filePath)
      if (change === null) continue
      const group = this.applyChange(change)
      changedGroups.add(group)
    }
    for (const group of changedGroups) {
      this.sendGroup(group)
    }
  }

  /** Each event that adds a file to a group, or removes one, sends the new list of that group. */
  override receiveArtifactEvent(event: ArtifactEvent): void {
    const change = this.fileStates.receive(event)
    if (change === null) return
    const group = this.applyChange(change)
    this.sendGroup(group)
  }

  /** Adds the file to its group, or removes it. Returns the group. */
  private applyChange(change: FileMatchChange): FileGroup {
    const file = change.file
    const key = this.groupKeyOf(file.vars)
    let group = this.groupsByKey.get(key)
    if (group === undefined) {
      group = { key, vars: file.vars, files: [] }
      this.groupsByKey.set(key, group)
    }
    const index = sortedIndexOf(group.files, file.artifact.path)
    if (change.kind === "found") {
      group.files.splice(index, 0, file.artifact)
    } else {
      group.files.splice(index, 1)
    }
    return group
  }

  /** Sends `found` with a copy of the list, or `gone` and forgets the group when its list is empty. */
  private sendGroup(group: FileGroup): void {
    if (group.files.length === 0) {
      this.groupsByKey.delete(group.key)
      this.send({ kind: "gone", vars: group.vars })
      return
    }
    const files = group.files.slice()
    this.send({ kind: "found", matched: { vars: group.vars, data: files } })
  }

  private groupKeyOf(vars: Vars): string {
    const values: string[] = []
    for (const name of this.varNames) {
      values.push(vars[name]!)
    }
    return JSON.stringify(values)
  }
}

/** The index of the first file whose path is not less than `filePath`. The list is sorted by path. */
function sortedIndexOf(files: readonly FileArtifact[], filePath: string): number {
  let low = 0
  let high = files.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (files[middle]!.path < filePath) {
      low = middle + 1
    } else {
      high = middle
    }
  }
  return low
}
