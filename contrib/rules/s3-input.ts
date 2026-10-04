import type { S3Client } from "../s3/client"
import { S3ObjectArtifact } from "../s3/object"
import { S3Prefix } from "../s3/prefix"
import { KeyTemplate } from "./template"
import { InputGen, type Feed } from "./types"
import { VarsMap, type Vars } from "./vars"

export type S3TemplateOpts = { client: S3Client }

function parseS3Uri(template: string): { bucket: string; key: string } {
  if (!template.startsWith("s3://")) {
    throw new Error(`S3 template '${template}' must start with s3://<bucket>/`)
  }
  const rest = template.slice("s3://".length)
  const slash = rest.indexOf("/")
  if (slash <= 0) {
    throw new Error(`S3 template '${template}' must start with s3://<bucket>/`)
  }
  const bucket = rest.slice(0, slash)
  const key = rest.slice(slash + 1)
  return { bucket, key }
}

export class S3KeyTemplate {
  readonly template: string
  readonly bucket: string
  readonly keyTemplate: string
  readonly endsWithSlash: boolean
  readonly varNames: readonly string[]
  readonly hasGlob: boolean
  private readonly keys: KeyTemplate

  constructor(template: string) {
    const parsed = parseS3Uri(template)
    this.template = template
    this.bucket = parsed.bucket
    this.keyTemplate = parsed.key
    this.endsWithSlash = template.endsWith("/")
    this.keys = new KeyTemplate(parsed.key)
    this.varNames = this.keys.varNames
    this.hasGlob = this.keys.hasGlob
  }

  get keyPrefix(): string {
    return this.keys.staticPrefix()
  }

  match(key: string): Vars | null {
    return this.keys.match(key)
  }

  render(vars: Vars): string {
    const rendered = this.keys.render(vars)
    if (this.endsWithSlash && rendered.length > 0 && !rendered.endsWith("/")) {
      return `${rendered}/`
    }
    return rendered
  }
}

export class S3Pattern extends InputGen<S3ObjectArtifact> {
  readonly template: string
  readonly bucket: string
  readonly client: S3Client
  readonly varNames: readonly string[]
  readonly keyPrefix: string
  private readonly key: S3KeyTemplate

  constructor(template: string, opts: S3TemplateOpts) {
    super()
    this.key = new S3KeyTemplate(template)
    if (this.key.hasGlob) {
      throw new Error(`S3Pattern '${template}' contains a glob; use S3Glob`)
    }
    if (this.key.endsWithSlash) {
      throw new Error(`S3Pattern '${template}' must not end with '/'`)
    }
    this.template = template
    this.bucket = this.key.bucket
    this.client = opts.client
    this.varNames = this.key.varNames
    this.keyPrefix = this.key.keyPrefix
  }

  match(key: string): Vars | null {
    return this.key.match(key)
  }

  async start(feed: Feed<S3ObjectArtifact>): Promise<void> {
    const keys = await this.client.list(this.bucket, this.keyPrefix)
    for (const objectKey of keys) {
      const vars = this.match(objectKey)
      if (vars === null) continue
      feed.set(vars, new S3ObjectArtifact(this.client, this.bucket, objectKey))
    }
    feed.listen(new S3Prefix(this.bucket, this.keyPrefix), (event) => {
      const parsed = parseS3Id(event.id)
      if (!parsed || parsed.bucket !== this.bucket) return
      const vars = this.match(parsed.key)
      if (vars === null) return
      if (event.type === "produced") {
        feed.set(
          vars,
          new S3ObjectArtifact(this.client, this.bucket, parsed.key),
        )
      } else {
        feed.delete(vars)
      }
    })
  }
}

export class S3Glob extends InputGen<S3ObjectArtifact[]> {
  readonly template: string
  readonly bucket: string
  readonly client: S3Client
  readonly varNames: readonly string[]
  readonly keyPrefix: string
  private readonly key: S3KeyTemplate

  constructor(template: string, opts: S3TemplateOpts) {
    super()
    this.key = new S3KeyTemplate(template)
    if (!this.key.hasGlob) {
      throw new Error(`S3Glob '${template}' has no glob; use S3Pattern`)
    }
    this.template = template
    this.bucket = this.key.bucket
    this.client = opts.client
    this.varNames = this.key.varNames
    this.keyPrefix = this.key.keyPrefix
  }

  match(key: string): Vars | null {
    return this.key.match(key)
  }

  async start(feed: Feed<S3ObjectArtifact[]>): Promise<void> {
    const groups = new VarsMap<Set<string>>()

    const update = (objectKey: string, present: boolean): void => {
      const vars = this.match(objectKey)
      if (vars === null) return
      const keys = groups.get(vars) ?? new Set<string>()
      if (present) {
        keys.add(objectKey)
      } else {
        keys.delete(objectKey)
      }
      if (keys.size === 0) {
        groups.delete(vars)
        feed.delete(vars)
        return
      }
      groups.set(vars, keys)
      const sorted = [...keys]
      sorted.sort()
      const objects: S3ObjectArtifact[] = []
      for (const k of sorted) {
        objects.push(new S3ObjectArtifact(this.client, this.bucket, k))
      }
      feed.set(vars, objects)
    }

    const listed = await this.client.list(this.bucket, this.keyPrefix)
    for (const objectKey of listed) {
      update(objectKey, true)
    }
    feed.listen(new S3Prefix(this.bucket, this.keyPrefix), (event) => {
      const parsed = parseS3Id(event.id)
      if (!parsed || parsed.bucket !== this.bucket) return
      update(parsed.key, event.type === "produced")
    })
  }
}

function parseS3Id(id: string): { bucket: string; key: string } | null {
  if (!id.startsWith("s3://")) return null
  const rest = id.slice("s3://".length)
  const slash = rest.indexOf("/")
  if (slash < 0) return null
  const bucket = rest.slice(0, slash)
  if (bucket.length === 0) return null
  return { bucket, key: rest.slice(slash + 1) }
}
