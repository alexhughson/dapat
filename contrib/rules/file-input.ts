import { FileArtifact } from "../fs/file"
import { PathPrefix } from "../fs/prefix"
import { walkFiles } from "../fs/walk"
import { FileTemplate } from "./file-template"
import { InputGen, type Feed } from "./types"
import { VarsMap, type Vars } from "./vars"

export class FilePattern extends InputGen<FileArtifact> {
  readonly template: string
  readonly varNames: readonly string[]
  readonly staticPrefix: string
  private readonly key: FileTemplate

  constructor(template: string, opts: { root?: string } = {}) {
    super()
    this.key = new FileTemplate(template, opts)
    if (this.key.hasGlob) {
      throw new Error(
        `FilePattern '${template}' contains a glob; use FileGlob`,
      )
    }
    if (this.key.endsWithSlash) {
      throw new Error(`FilePattern '${template}' must not end with '/'`)
    }
    this.template = template
    this.varNames = this.key.varNames
    this.staticPrefix = this.key.staticPrefix
  }

  match(absPath: string): Vars | null {
    return this.key.match(absPath)
  }

  async start(feed: Feed<FileArtifact>): Promise<void> {
    const existing = await walkFiles(this.staticPrefix)
    for (const filePath of existing) {
      const vars = this.match(filePath)
      if (vars === null) continue
      feed.set(vars, new FileArtifact(filePath))
    }
    feed.listen(new PathPrefix(this.staticPrefix), (event) => {
      const filePath = event.id.slice("file:".length)
      const vars = this.match(filePath)
      if (vars === null) return
      if (event.type === "produced") {
        feed.set(vars, new FileArtifact(filePath))
      } else {
        feed.delete(vars)
      }
    })
  }
}

export class FileGlob extends InputGen<FileArtifact[]> {
  readonly template: string
  readonly varNames: readonly string[]
  readonly staticPrefix: string
  private readonly key: FileTemplate

  constructor(template: string, opts: { root?: string } = {}) {
    super()
    this.key = new FileTemplate(template, opts)
    if (!this.key.hasGlob) {
      throw new Error(
        `FileGlob '${template}' has no glob; use FilePattern`,
      )
    }
    this.template = template
    this.varNames = this.key.varNames
    this.staticPrefix = this.key.staticPrefix
  }

  match(absPath: string): Vars | null {
    return this.key.match(absPath)
  }

  async start(feed: Feed<FileArtifact[]>): Promise<void> {
    const groups = new VarsMap<Set<string>>()

    const update = (filePath: string, present: boolean): void => {
      const vars = this.match(filePath)
      if (vars === null) return
      const paths = groups.get(vars) ?? new Set<string>()
      if (present) {
        paths.add(filePath)
      } else {
        paths.delete(filePath)
      }
      if (paths.size === 0) {
        groups.delete(vars)
        feed.delete(vars)
        return
      }
      groups.set(vars, paths)
      const sorted = [...paths]
      sorted.sort()
      const files: FileArtifact[] = []
      for (const p of sorted) {
        files.push(new FileArtifact(p))
      }
      feed.set(vars, files)
    }

    const existing = await walkFiles(this.staticPrefix)
    for (const filePath of existing) {
      update(filePath, true)
    }
    feed.listen(new PathPrefix(this.staticPrefix), (event) => {
      const filePath = event.id.slice("file:".length)
      update(filePath, event.type === "produced")
    })
  }
}
