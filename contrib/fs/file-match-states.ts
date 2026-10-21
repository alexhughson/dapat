import type { ArtifactEvent } from "../../src/build"
import type { Vars } from "../../src/matched-artifact"
import { FileArtifact } from "./file"
import type { FilePattern } from "./file-pattern"
import type { FileStampMode } from "./stamp"

/** What a matcher knows about one file that fits its pattern. */
export type KnownFile = {
  vars: Vars
  filePath: string
  // The artifact that the matcher sends for the file. Made one time for each record.
  artifact: FileArtifact
  // True when the scan found the file, or a task produced it, and no task deleted it after that.
  onDisk: boolean
  // The ids of the tasks that declare the file as an output now.
  promisedBy: Set<string>
  // True when the file has a match, as far as the listeners of the matcher know.
  matched: boolean
}

/** A file that got a match ("found"), or that lost its match ("gone"). */
export type FileMatchChange = { kind: "found" | "gone"; file: KnownFile }

/**
 * The rules that tell if a file has a match, for FileMatcher and FileGroupMatcher.
 * A file has a match while the file is on disk, as far as the matcher knows, or while a task
 * declares it as an output. It keeps a record only for a file that has a match now.
 */
export class FileMatchStates {
  // Each file that has a match now, by absolute path.
  private readonly knownFiles = new Map<string, KnownFile>()

  constructor(
    private readonly filePattern: FilePattern,
    // The stamp mode of each `FileArtifact` that the matcher sends.
    private readonly stampMode: FileStampMode,
  ) {}

  /** Records that the scan found the file. Returns the change of its match, or null for no change. */
  foundOnDisk(filePath: string): FileMatchChange | null {
    const known = this.knownFileFor(filePath)
    if (known === null) return null
    known.onDisk = true
    return this.changeOf(known)
  }

  /**
   * `promised` and `produced` of a `FileArtifact` that fits the pattern make a match.
   * `deleted` and `withdrawn` remove it, unless the file is still on disk or a task still declares it.
   * Returns the change of the match, or null for no change.
   */
  receive(event: ArtifactEvent): FileMatchChange | null {
    if (event.kind === "promised" || event.kind === "withdrawn") {
      if (!(event.output instanceof FileArtifact)) return null
      const known = this.knownFileFor(event.output.path)
      if (known === null) return null
      if (event.kind === "promised") {
        known.promisedBy.add(event.taskId)
      } else {
        known.promisedBy.delete(event.taskId)
      }
      return this.changeOf(known)
    }
    if (!(event.artifact instanceof FileArtifact)) return null
    const known = this.knownFileFor(event.artifact.path)
    if (known === null) return null
    if (event.kind === "produced") {
      known.onDisk = true
    } else {
      known.onDisk = false
    }
    return this.changeOf(known)
  }

  /** The record of the file at the absolute `filePath`, made when it is new. null when the file does not fit. */
  private knownFileFor(filePath: string): KnownFile | null {
    const existing = this.knownFiles.get(filePath)
    if (existing !== undefined) return existing
    const vars = this.filePattern.match(filePath)
    if (vars === null) return null
    const artifact = new FileArtifact(filePath, { stamp: this.stampMode })
    const known: KnownFile = { vars, filePath, artifact, onDisk: false, promisedBy: new Set(), matched: false }
    this.knownFiles.set(filePath, known)
    return known
  }

  /** "found" when the file has a match now and did not before, "gone" for the reverse, else null. */
  private changeOf(known: KnownFile): FileMatchChange | null {
    const hasMatch = known.onDisk || known.promisedBy.size > 0
    if (hasMatch && !known.matched) {
      known.matched = true
      return { kind: "found", file: known }
    }
    if (hasMatch) return null
    // A file with no match needs no record. A later event makes a new one.
    this.knownFiles.delete(known.filePath)
    if (!known.matched) return null
    known.matched = false
    return { kind: "gone", file: known }
  }
}
