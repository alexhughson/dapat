import { Prefix } from "../../src/prefix"
import type { S3Client } from "./client"
import { sha256Hex } from "./hash"

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
   * The SHA-256 of the sorted lines `<key>=<etag>` for every key under the prefix.
   * It lists the keys, then calls `head` for each key. An empty prefix has the stamp of an empty list.
   */
  async stamp(): Promise<string | null> {
    const keys = await this.client.list(this.bucket, this.listPrefix)
    const lines: string[] = []
    for (const key of keys) {
      const head = await this.client.head(this.bucket, key)
      // A key that went away after the list is not under the prefix now.
      if (head === null) continue
      lines.push(`${key}=${head.etag}`)
    }
    lines.sort()
    return sha256Hex(new TextEncoder().encode(lines.join("\n")))
  }
}

export function s3Prefix(client: S3Client, bucket: string, keyPrefix: string): S3Prefix {
  return new S3Prefix(client, bucket, keyPrefix)
}
