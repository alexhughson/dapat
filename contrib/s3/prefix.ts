import { Prefix } from "../../src/prefix"
import type { S3Client } from "./client"
import { hashLines } from "../hash"

export class S3Prefix extends Prefix {
  readonly id: string
  // The key prefix that `list` gets: `keyPrefix` with a trailing "/", or "" for the whole bucket.
  private readonly listPrefix: string

  constructor(
    readonly client: S3Client,
    readonly bucket: string,
    readonly keyPrefix: string,
  ) {
    super()
    const key = keyPrefix.endsWith("/") || keyPrefix === "" ? keyPrefix : `${keyPrefix}/`
    this.listPrefix = key
    this.id = `s3://${bucket}/${key}`
  }

  /**
   * The SHA-256 of the sorted lines `<key>=<etag>` for every key under the prefix,
   * from one `list` call. An empty prefix has the stamp of an empty list.
   */
  async stamp(): Promise<string | null> {
    const entries = await this.client.list(this.bucket, this.listPrefix)
    const lines: string[] = []
    for (const entry of entries) {
      lines.push(`${entry.key}=${entry.etag}`)
    }
    return hashLines(lines)
  }
}

export function s3Prefix(client: S3Client, bucket: string, keyPrefix: string): S3Prefix {
  return new S3Prefix(client, bucket, keyPrefix)
}
