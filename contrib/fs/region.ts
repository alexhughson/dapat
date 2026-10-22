import type { Artifact } from "../../src/artifact"
import { Prefix } from "../../src/prefix"
import { FileArtifact } from "./file"
import type { FilePattern } from "./file-pattern"
import { FilesystemPrefix } from "./folder"
import { dirId } from "./id"

/**
 * Every file that a pattern can name, as a prefix. A FileMatcher gives it as the files that it sees, and a
 * FileTemplate as the files that its tasks write. The gate task of a build.each reads and writes these.
 * Its id is the folder of the literal start of the pattern, so the default prefix rules of the build find it.
 */
export class FilePatternRegion extends Prefix {
  readonly id: string

  constructor(readonly filePattern: FilePattern) {
    super()
    this.id = dirId(filePattern.literalFolder())
  }

  covers(artifact: Artifact): boolean {
    if (!(artifact instanceof FileArtifact)) return false
    return this.filePattern.match(artifact.path) !== null
  }

  overlaps(other: Prefix): boolean {
    if (other instanceof FilePatternRegion) {
      const otherFolder = other.filePattern.literalFolder()
      const ownFolder = this.filePattern.literalFolder()
      return this.filePattern.canHaveFileBelow(otherFolder) && other.filePattern.canHaveFileBelow(ownFolder)
    }
    if (other instanceof FilesystemPrefix) {
      return this.filePattern.canHaveFileBelow(other.path)
    }
    return super.overlaps(other)
  }
}
