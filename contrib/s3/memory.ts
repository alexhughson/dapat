import type { S3Client, S3Head } from "./client"
import { sha256Hex } from "./hash"

type Stored = {
  body: Uint8Array
  lastModified: Date
  etag: string
}

/** In-memory object store. Same contract as an S3 endpoint. */
export class MemoryS3 implements S3Client {
  private readonly objects = new Map<string, Stored>()
  private nextTime = Date.now()

  async head(bucket: string, key: string): Promise<S3Head | null> {
    const stored = this.objects.get(loc(bucket, key))
    if (!stored) return null
    return { lastModified: stored.lastModified, etag: stored.etag }
  }

  async get(bucket: string, key: string): Promise<Uint8Array> {
    const stored = this.objects.get(loc(bucket, key))
    if (!stored) {
      throw new Error(`missing s3://${bucket}/${key}`)
    }
    return stored.body
  }

  async put(bucket: string, key: string, body: Uint8Array): Promise<S3Head> {
    const etag = sha256Hex(body)
    const lastModified = this.stamp()
    this.objects.set(loc(bucket, key), { body, lastModified, etag })
    return { lastModified, etag }
  }

  private stamp(): Date {
    const now = Date.now()
    if (now <= this.nextTime) {
      this.nextTime += 1
    } else {
      this.nextTime = now
    }
    return new Date(this.nextTime)
  }

  async list(bucket: string, prefix: string): Promise<string[]> {
    const keys: string[] = []
    const start = `${bucket}\0`
    for (const key of this.objects.keys()) {
      if (!key.startsWith(start)) continue
      const objectKey = key.slice(start.length)
      if (prefix.length > 0 && !objectKey.startsWith(prefix)) continue
      keys.push(objectKey)
    }
    keys.sort()
    return keys
  }
}

function loc(bucket: string, key: string): string {
  return `${bucket}\0${key}`
}
