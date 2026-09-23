import { Prefix } from "../../src/prefix"

export class S3Prefix extends Prefix {
  readonly id: string

  constructor(
    readonly bucket: string,
    readonly keyPrefix: string,
  ) {
    super()
    const key = keyPrefix.endsWith("/") || keyPrefix === "" ? keyPrefix : `${keyPrefix}/`
    this.id = `s3://${bucket}/${key}`
  }
}

export function s3Prefix(bucket: string, keyPrefix: string): S3Prefix {
  return new S3Prefix(bucket, keyPrefix)
}
