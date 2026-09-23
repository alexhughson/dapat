import { mkdir } from "node:fs/promises"
import path from "node:path"
import type { Prefix } from "../../src/prefix"
import { FileArtifact } from "../fs/file"
import { fileId, resolveFilePath } from "../fs/id"
import { PathPrefix } from "../fs/prefix"
import { walkFiles } from "../fs/walk"
import type { InputPattern, Item, OutputPattern } from "./item"
import {
  boundPrefixSegments,
  collectMeta,
  matchSegments,
  parseSegment,
  renderMix,
  splitTemplate,
  type Segment,
} from "./key"
import { hasAllVars, type Vars } from "./vars"

export type FilePatternOpts = {
  optional?: boolean
  list?: boolean
}

export class FilePattern implements InputPattern, OutputPattern {
  readonly template: string
  readonly optional: boolean
  readonly list: boolean
  readonly varNames: readonly string[]
  private readonly segments: Segment[]
  private readonly absolute: boolean
  private readonly hasGlob: boolean

  constructor(template: string, opts: FilePatternOpts = {}) {
    this.template = template
    this.optional = opts.optional === true
    this.absolute = template.startsWith("/")
    this.segments = splitTemplate(template).map(parseSegment)
    const meta = collectMeta(this.segments)
    this.varNames = meta.varNames
    this.hasGlob = meta.hasGlob
    this.list = opts.list === true || this.hasGlob
  }

  staticPrefix(root: string): string {
    const segs = this.fullSegments(root)
    const lit: string[] = []
    for (const segment of segs) {
      if (segment.kind !== "lit") break
      lit.push(segment.value)
    }
    return `${path.sep}${lit.join(path.sep)}${path.sep}`
  }

  match(absPath: string, root: string): Vars | null {
    const pathSegs = splitAbs(absPath)
    const pat = this.fullSegments(root)
    return matchSegments(pat, pathSegs)
  }

  render(vars: Vars, root: string): string {
    if (!hasAllVars(this.varNames, vars)) {
      throw new Error(`pattern '${this.template}' missing vars to render`)
    }
    const segs = this.fullSegments(root)
    const out: string[] = []
    for (const segment of segs) {
      if (segment.kind === "lit") {
        out.push(segment.value)
        continue
      }
      if (segment.kind === "star" || segment.kind === "rest") {
        throw new Error(`pattern '${this.template}' cannot render a glob`)
      }
      out.push(renderMix(segment.parts, vars))
    }
    return `${path.sep}${out.join(path.sep)}`
  }

  listenPrefix(root: string): Prefix {
    return new PathPrefix(this.staticPrefix(root))
  }

  boundPrefix(vars: Vars, root: string): Prefix {
    const lit = boundPrefixSegments(this.fullSegments(root), vars)
    return new PathPrefix(`${path.sep}${lit.join(path.sep)}${path.sep}`)
  }

  matchId(id: string, root: string): Vars | null {
    if (!id.startsWith("file:")) return null
    return this.match(id.slice("file:".length), root)
  }

  renderId(vars: Vars, root: string): string {
    return fileId(this.render(vars, root))
  }

  artifact(id: string, _root: string): FileArtifact {
    if (!id.startsWith("file:")) {
      throw new Error(`id '${id}' is not a file artifact`)
    }
    return new FileArtifact(id.slice("file:".length))
  }

  async scan(root: string): Promise<string[]> {
    const files = await walkFiles(this.staticPrefix(root))
    const ids: string[] = []
    for (const filePath of files) {
      ids.push(fileId(resolveFilePath(filePath)))
    }
    return ids
  }

  async prepareOutput(artifact: Item): Promise<void> {
    if (!(artifact instanceof FileArtifact)) {
      throw new Error("FilePattern.prepareOutput expected a FileArtifact")
    }
    await mkdir(path.dirname(artifact.path), { recursive: true })
  }

  async preparePrefix(prefix: Prefix): Promise<void> {
    if (!(prefix instanceof PathPrefix)) {
      throw new Error("FilePattern.preparePrefix expected a PathPrefix")
    }
    await mkdir(prefix.path, { recursive: true })
  }

  sortKey(artifact: Item): string {
    if (artifact instanceof FileArtifact) return artifact.path
    return artifact.id
  }

  private fullSegments(root: string): Segment[] {
    if (this.absolute) return this.segments
    const rootSegs = splitAbs(path.resolve(root))
    const prefix: Segment[] = []
    for (const value of rootSegs) {
      prefix.push({ kind: "lit", value })
    }
    return prefix.concat(this.segments)
  }
}

function splitAbs(absPath: string): string[] {
  const parts = path.resolve(absPath).split(path.sep)
  const out: string[] = []
  for (const part of parts) {
    if (part.length > 0) out.push(part)
  }
  return out
}
