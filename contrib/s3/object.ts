import { Artifact } from "../../src/artifact"
import type { S3Client } from "./client"

export class S3ObjectArtifact extends Artifact<Uint8Array> {
  readonly id: string

  constructor(
    readonly client: S3Client,
    readonly bucket: string,
    readonly key: string,
  ) {
    super()
    this.id = `s3://${bucket}/${key}`
  }

  async orderStamp(): Promise<bigint | null> {
    const head = await this.client.head(this.bucket, this.key)
    if (!head) return null
    return BigInt(head.lastModified.getTime())
  }

  async contentStamp(): Promise<string | null> {
    const head = await this.client.head(this.bucket, this.key)
    if (!head) return null
    return head.etag
  }

  async read(): Promise<Uint8Array> {
    return this.client.get(this.bucket, this.key)
  }
}

export function s3Object(client: S3Client, bucket: string, key: string): S3ObjectArtifact {
  return new S3ObjectArtifact(client, bucket, key)
}
