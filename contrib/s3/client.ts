export interface S3Head {
  lastModified: Date
  etag: string
}

/** One object that `list` returns. */
export interface S3ListEntry {
  key: string
  etag: string
}

/**
 * I/O port for S3 objects. Pass AWS SDK v3, a custom signer, or MemoryS3.
 *
 *   const client: S3Client = {
 *     async head(bucket, key) { ... },
 *     async get(bucket, key) { ... },
 *     async put(bucket, key, body) { ... },
 *     async list(bucket, prefix) { ... },
 *   }
 */
export interface S3Client {
  head(bucket: string, key: string): Promise<S3Head | null>
  get(bucket: string, key: string): Promise<Uint8Array>
  put(bucket: string, key: string, body: Uint8Array): Promise<S3Head>
  /** Every object under the prefix, from every page of results. */
  list(bucket: string, prefix: string): Promise<S3ListEntry[]>
}
