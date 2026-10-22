import type { ArtifactTemplate } from "../../src/artifact-template"
import type { Vars } from "../../src/matched-artifact"
import { FileArtifact } from "./file"
import { FilePattern, type FilePatternOptions } from "./file-pattern"
import { FilesystemPrefix } from "./folder"

/**
 * A file path with vars, such as `site/<lang>/<slug>.html`, for `outputsByName` of `build.each`.
 * `expand` gives the FileArtifact for one set of vars. The pattern has the syntax of FileMatcher, also the
 * `syntax` option, but no `*` or `**`: an output names one file.
 * A relative pattern resolves against the working directory when you create the template, as for FileMatcher.
 */
export class FileTemplate implements ArtifactTemplate<FileArtifact> {
  /** The pattern after normalization, for example `site/<lang>/<slug>.html`. */
  readonly pattern: string
  readonly varNames: readonly string[]
  private readonly filePattern: FilePattern

  constructor(
    pattern: string,
    private readonly opts?: FilePatternOptions,
  ) {
    this.filePattern = new FilePattern(pattern, "FileTemplate", opts?.syntax, false)
    this.pattern = this.filePattern.pattern
    this.varNames = this.filePattern.varNames
  }

  expand(vars: Vars): FileArtifact {
    return new FileArtifact(this.filePattern.render(vars), { stamp: this.opts?.stamp })
  }
}

/**
 * A folder path with vars, such as `out/<book>/pages/`, for `outputsByName` of `build.each`.
 * `expand` gives the FilesystemPrefix for one set of vars. The pattern rules are those of FileTemplate.
 */
export class FolderTemplate implements ArtifactTemplate<FilesystemPrefix> {
  /** The pattern after normalization, for example `out/<book>/pages/`. */
  readonly pattern: string
  readonly varNames: readonly string[]
  private readonly filePattern: FilePattern

  constructor(
    pattern: string,
    private readonly opts?: FilePatternOptions,
  ) {
    this.filePattern = new FilePattern(pattern, "FolderTemplate", opts?.syntax, false)
    this.pattern = this.filePattern.pattern
    this.varNames = this.filePattern.varNames
  }

  expand(vars: Vars): FilesystemPrefix {
    return new FilesystemPrefix(this.filePattern.render(vars), { stamp: this.opts?.stamp })
  }
}
