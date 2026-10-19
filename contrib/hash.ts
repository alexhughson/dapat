/** The SHA-256 hex of `bytes`. */
export function sha256Hex(bytes: Uint8Array | string): string {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(bytes)
  return hasher.digest("hex")
}

/**
 * The SHA-256 hex of the sorted lines, joined with "\n". A listing stamp uses it,
 * so the order of the listing has no effect. An empty list has a stamp too.
 */
export function hashLines(lines: readonly string[]): string {
  const sorted = [...lines]
  sorted.sort()
  return sha256Hex(sorted.join("\n"))
}
