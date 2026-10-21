import path from "node:path"
import type { ArtifactTemplate } from "../../src/artifact-template"
import type { Vars } from "../../src/matched-artifact"
import { KeyPattern } from "../../src/pattern"
import { FileArtifact } from "./file"
import { FilesystemPrefix } from "./folder"
import type { FileStampOptions } from "./stamp"

/**
 * A file path with vars, such as `site/<lang>/<slug>.html`. `expand` gives the FileArtifact for one set of vars.
 * A relative pattern resolves against the working directory when you create the template, as for FileMatcher.
 */
export class FileTemplate implements ArtifactTemplate<FileArtifact> {
  readonly pattern: string
  readonly varNames: readonly string[]
  private readonly keyPattern: KeyPattern
  private readonly root: string

  constructor(
    pattern: string,
    private readonly opts?: FileStampOptions,
  ) {
    this.keyPattern = templatePattern(pattern, "FileTemplate")
    this.pattern = pattern
    this.varNames = this.keyPattern.varNames
    this.root = path.isAbsolute(pattern) ? "/" : process.cwd()
  }

  expand(vars: Vars): FileArtifact {
    return new FileArtifact(path.join(this.root, this.keyPattern.render(vars)), this.opts)
  }
}

/** A folder path with vars, such as `out/<book>/pages/`. `expand` gives the FilesystemPrefix for one set of vars. */
export class FolderTemplate implements ArtifactTemplate<FilesystemPrefix> {
  readonly pattern: string
  readonly varNames: readonly string[]
  private readonly keyPattern: KeyPattern
  private readonly root: string

  constructor(
    pattern: string,
    private readonly opts?: FileStampOptions,
  ) {
    this.keyPattern = templatePattern(pattern, "FolderTemplate")
    this.pattern = pattern
    this.varNames = this.keyPattern.varNames
    this.root = path.isAbsolute(pattern) ? "/" : process.cwd()
  }

  expand(vars: Vars): FilesystemPrefix {
    return new FilesystemPrefix(path.join(this.root, this.keyPattern.render(vars)), this.opts)
  }
}

function templatePattern(pattern: string, className: string): KeyPattern {
  const keyPattern = new KeyPattern(pattern)
  if (keyPattern.hasGlob) {
    throw new Error(`${className} pattern '${pattern}': '*' and '**' are not allowed; a template names one path`)
  }
  return keyPattern
}
