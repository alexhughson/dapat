import type { S3Client, S3Head, S3ListEntry } from "./client"
import { sha256Hex } from "../hash"

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

  async list(bucket: string, prefix: string): Promise<S3ListEntry[]> {
    const entries: S3ListEntry[] = []
    const start = `${bucket}\0`
    for (const [location, stored] of this.objects) {
      if (!location.startsWith(start)) continue
      const key = location.slice(start.length)
      if (prefix.length > 0 && !key.startsWith(prefix)) continue
      entries.push({ key, etag: stored.etag })
    }
    entries.sort((a, b) => {
      if (a.key < b.key) return -1
      if (a.key > b.key) return 1
      return 0
    })
    return entries
  }
}

function loc(bucket: string, key: string): string {
  return `${bucket}\0${key}`
}
