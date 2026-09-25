import { mkdir } from "node:fs/promises"
import path from "node:path"
import { FileArtifact } from "../fs/file"
import { PathPrefix } from "../fs/prefix"
import { FileTemplate } from "./file-template"
import type { OutputGen } from "./types"
import type { Vars } from "./vars"

export class FileOutput implements OutputGen<FileArtifact> {
  readonly template: string
  readonly varNames: readonly string[]
  private readonly key: FileTemplate

  constructor(template: string, opts: { root?: string } = {}) {
    this.key = new FileTemplate(template, opts)
    if (this.key.hasGlob) {
      throw new Error(`FileOutput '${template}' must not contain a glob`)
    }
    if (this.key.endsWithSlash) {
      throw new Error(`FileOutput '${template}' must not end with '/'`)
    }
    this.template = template
    this.varNames = this.key.varNames
  }

  render(vars: Vars): string {
    return this.key.render(vars)
  }

  ref(vars: Vars): FileArtifact {
    return new FileArtifact(this.render(vars))
  }

  async prepare(artifact: FileArtifact): Promise<void> {
    await mkdir(path.dirname(artifact.path), { recursive: true })
  }
}

export class DirOutput implements OutputGen<PathPrefix> {
  readonly template: string
  readonly varNames: readonly string[]
  private readonly key: FileTemplate

  constructor(template: string, opts: { root?: string } = {}) {
    this.key = new FileTemplate(template, opts)
    if (!this.key.endsWithSlash) {
      throw new Error(`DirOutput '${template}' must end with '/'`)
    }
    if (this.key.hasGlob) {
      throw new Error(`DirOutput '${template}' must not contain a glob`)
    }
    this.template = template
    this.varNames = this.key.varNames
  }

  render(vars: Vars): string {
    return this.key.render(vars)
  }

  ref(vars: Vars): PathPrefix {
    return new PathPrefix(this.render(vars))
  }

  async prepare(prefix: PathPrefix): Promise<void> {
    await mkdir(prefix.path, { recursive: true })
  }
}
