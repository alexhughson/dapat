import type { Prefix } from "../../src/prefix"
import type { S3Client } from "../s3/client"
import { S3ObjectArtifact } from "../s3/object"
import { S3Prefix } from "../s3/prefix"
import type { Item, ItemPattern } from "./item"
import { KeyPattern } from "./key"
import type { Vars } from "./vars"

export type S3PatternOpts = {
  client: S3Client
  bucket?: string
  optional?: boolean
  list?: boolean
}

export class S3Pattern implements ItemPattern {
  readonly template: string
  readonly bucket: string
  readonly client: S3Client
  readonly optional: boolean
  readonly list: boolean
  readonly varNames: readonly string[]
  private readonly keys: KeyPattern

  constructor(template: string, opts: S3PatternOpts) {
    const parsed = parseS3Template(template, opts.bucket)
    this.template = template
    this.bucket = parsed.bucket
    this.client = opts.client
    this.optional = opts.optional === true
    this.keys = new KeyPattern(parsed.key)
    this.varNames = this.keys.varNames
    this.list = opts.list === true || this.keys.hasGlob
  }

  keyPrefix(): string {
    return this.keys.staticPrefix()
  }

  match(key: string): Vars | null {
    return this.keys.match(key)
  }

  render(vars: Vars): string {
    return this.keys.render(vars)
  }

  listenPrefix(_root: string): Prefix {
    return new S3Prefix(this.bucket, this.keys.staticPrefix())
  }

  boundPrefix(vars: Vars, _root: string): Prefix {
    return new S3Prefix(this.bucket, this.keys.boundPrefix(vars))
  }

  matchId(id: string, _root: string): Vars | null {
    const parsed = parseS3Id(id)
    if (!parsed) return null
    if (parsed.bucket !== this.bucket) return null
    return this.keys.match(parsed.key)
  }

  renderId(vars: Vars, _root: string): string {
    return `s3://${this.bucket}/${this.keys.render(vars)}`
  }

  artifact(id: string, _root: string): S3ObjectArtifact {
    const parsed = parseS3Id(id)
    if (!parsed || parsed.bucket !== this.bucket) {
      throw new Error(`id '${id}' is not in s3://${this.bucket}/`)
    }
    return new S3ObjectArtifact(this.client, parsed.bucket, parsed.key)
  }

  async scan(_root: string): Promise<string[]> {
    const keys = await this.client.list(this.bucket, this.keys.staticPrefix())
    const ids: string[] = []
    for (const key of keys) {
      ids.push(`s3://${this.bucket}/${key}`)
    }
    return ids
  }

  async prepareOutput(_artifact: Item): Promise<void> {}

  sortKey(artifact: Item): string {
    return artifact.id
  }
}

function parseS3Template(
  template: string,
  bucket: string | undefined,
): { bucket: string; key: string } {
  const uri = parseS3Id(template)
  if (uri) {
    if (bucket !== undefined && bucket !== uri.bucket) {
      throw new Error(
        `S3Pattern bucket '${bucket}' does not match template '${template}'`,
      )
    }
    return uri
  }
  if (bucket === undefined || bucket.length === 0) {
    throw new Error(
      `S3Pattern '${template}' needs s3://bucket/... or { bucket }`,
    )
  }
  return { bucket, key: stripSlashes(template) }
}

function parseS3Id(id: string): { bucket: string; key: string } | null {
  if (!id.startsWith("s3://")) return null
  const rest = id.slice("s3://".length)
  const slash = rest.indexOf("/")
  if (slash < 0) {
    if (rest.length === 0) return null
    return { bucket: rest, key: "" }
  }
  const bucket = rest.slice(0, slash)
  if (bucket.length === 0) return null
  return { bucket, key: stripSlashes(rest.slice(slash + 1)) }
}

function stripSlashes(value: string): string {
  let start = 0
  while (start < value.length && value[start] === "/") start += 1
  return value.slice(start)
}
