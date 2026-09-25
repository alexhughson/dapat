import type { S3Client } from "../s3/client"
import { S3ObjectArtifact } from "../s3/object"
import { S3Prefix } from "../s3/prefix"
import { S3KeyTemplate } from "./s3-input"
import type { OutputGen } from "./types"
import type { Vars } from "./vars"

export class S3Output implements OutputGen<S3ObjectArtifact> {
  readonly template: string
  readonly bucket: string
  readonly client: S3Client
  readonly varNames: readonly string[]
  private readonly key: S3KeyTemplate

  constructor(template: string, opts: { client: S3Client }) {
    this.key = new S3KeyTemplate(template)
    if (this.key.hasGlob) {
      throw new Error(`S3Output '${template}' must not contain a glob`)
    }
    if (this.key.endsWithSlash) {
      throw new Error(`S3Output '${template}' must not end with '/'`)
    }
    this.template = template
    this.bucket = this.key.bucket
    this.client = opts.client
    this.varNames = this.key.varNames
  }

  render(vars: Vars): string {
    return this.key.render(vars)
  }

  ref(vars: Vars): S3ObjectArtifact {
    return new S3ObjectArtifact(this.client, this.bucket, this.render(vars))
  }

  async prepare(_ref: S3ObjectArtifact): Promise<void> {}
}

export class S3PrefixOutput implements OutputGen<S3Prefix> {
  readonly template: string
  readonly bucket: string
  readonly varNames: readonly string[]
  private readonly key: S3KeyTemplate

  constructor(template: string) {
    this.key = new S3KeyTemplate(template)
    if (!this.key.endsWithSlash) {
      throw new Error(`S3PrefixOutput '${template}' must end with '/'`)
    }
    if (this.key.hasGlob) {
      throw new Error(`S3PrefixOutput '${template}' must not contain a glob`)
    }
    this.template = template
    this.bucket = this.key.bucket
    this.varNames = this.key.varNames
  }

  render(vars: Vars): string {
    return this.key.render(vars)
  }

  ref(vars: Vars): S3Prefix {
    return new S3Prefix(this.bucket, this.render(vars))
  }

  async prepare(_ref: S3Prefix): Promise<void> {}
}
