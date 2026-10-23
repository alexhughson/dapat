// A matcher whose vars come from a function, not from a pattern. The function gets the path of each
// file under one folder, relative to it, and returns the vars of the file, or null for no match.
// The function can compute vars that a pattern cannot hold, such as `next` = `n` + 1.
import path from "node:path"
import { Matcher, type ArtifactEvent } from "dapat"
import { FileArtifact, FilesystemPrefix } from "dapat/contrib"

export type VarsFunction<V extends string> = (relativePath: string) => Record<V, string> | null

export class LambdaFileMatcher<V extends string> extends Matcher<FileArtifact> {
  readonly folder: FilesystemPrefix

  constructor(
    folder: string,
    readonly varNames: readonly V[],
    private readonly varsOf: VarsFunction<V>,
  ) {
    super()
    this.folder = new FilesystemPrefix(folder)
  }

  /** Every file that this matcher can see. The gate task of the gate-task prototype reads it. */
  region(): FilesystemPrefix {
    return this.folder
  }

  async scan(signal: AbortSignal): Promise<void> {
    const filePaths = await this.folder.list()
    if (signal.aborted) {
      return
    }
    for (const filePath of filePaths) {
      this.update(filePath, true)
    }
  }

  // Only produced and deleted change a match. So a file that a task declares gets its match when the
  // task writes it, not when the task is added, as FileMatcher does.
  override receiveArtifactEvent(event: ArtifactEvent): void {
    if (event.kind !== "produced" && event.kind !== "deleted") {
      return
    }
    if (!(event.artifact instanceof FileArtifact)) {
      return
    }
    this.update(event.artifact.path, event.kind === "produced")
  }

  private update(filePath: string, exists: boolean): void {
    const relativePath = path.relative(this.folder.path, filePath)
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      return
    }
    const vars = this.varsOf(relativePath)
    if (vars === null) {
      return
    }
    if (exists) {
      this.send({ kind: "found", matched: { vars, data: new FileArtifact(filePath) } })
    } else {
      this.send({ kind: "gone", vars })
    }
  }
}
