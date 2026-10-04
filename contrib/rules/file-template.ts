import path from "node:path"
import {
  collectMeta,
  matchSegments,
  parseSegment,
  renderMix,
  splitTemplate,
  type Segment,
} from "./template"
import { hasAllVars, type Vars } from "./vars"

/** Absolute path template. Shared by file inputs and file outputs. */
export class FileTemplate {
  readonly template: string
  readonly root: string
  readonly varNames: readonly string[]
  readonly hasGlob: boolean
  readonly endsWithSlash: boolean
  private readonly segments: Segment[]
  private readonly absolute: boolean

  constructor(template: string, opts: { root?: string } = {}) {
    this.template = template
    this.root = path.resolve(opts.root ?? process.cwd())
    this.endsWithSlash = template.endsWith("/")
    this.absolute = template.startsWith("/")
    this.segments = splitTemplate(template).map(parseSegment)
    const meta = collectMeta(this.segments)
    this.varNames = meta.varNames
    this.hasGlob = meta.hasGlob
  }

  get staticPrefix(): string {
    const segs = this.fullSegments()
    const lit: string[] = []
    for (const segment of segs) {
      if (segment.kind !== "lit") break
      lit.push(segment.value)
    }
    return `${path.sep}${lit.join(path.sep)}${path.sep}`
  }

  match(absPath: string): Vars | null {
    const pathSegs = splitAbs(absPath)
    return matchSegments(this.fullSegments(), pathSegs)
  }

  render(vars: Vars): string {
    if (!hasAllVars(this.varNames, vars)) {
      throw new Error(`template '${this.template}' missing vars to render`)
    }
    const segs = this.fullSegments()
    const out: string[] = []
    for (const segment of segs) {
      if (segment.kind === "lit") {
        out.push(segment.value)
        continue
      }
      if (segment.kind === "star" || segment.kind === "rest") {
        throw new Error(`template '${this.template}' cannot render a glob`)
      }
      out.push(renderMix(segment.parts, vars, this.template))
    }
    const rendered = `${path.sep}${out.join(path.sep)}`
    if (this.endsWithSlash && !rendered.endsWith(path.sep)) {
      return `${rendered}${path.sep}`
    }
    return rendered
  }

  private fullSegments(): Segment[] {
    if (this.absolute) return this.segments
    const rootSegs = splitAbs(this.root)
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
