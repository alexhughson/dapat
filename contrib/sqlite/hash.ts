export function sha256Hex(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(bytes)
  return hasher.digest("hex")
}

export function hashRow(row: Record<string, unknown>): string {
  const hasher = new Bun.CryptoHasher("sha256")
  const keys = Object.keys(row).filter((k) => k !== "rowid")
  keys.sort()
  for (const key of keys) {
    hasher.update(key)
    hasher.update("=")
    hasher.update(encodeValue(row[key]))
    hasher.update("\n")
  }
  return hasher.digest("hex")
}

function encodeValue(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return value
  if (typeof value === "number") return String(value)
  if (typeof value === "bigint") return value.toString()
  if (typeof value === "boolean") return value ? "1" : "0"
  if (value instanceof Uint8Array) return sha256Hex(value)
  return JSON.stringify(value)
}
