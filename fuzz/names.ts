import type { Rng } from "./rng"

/** The kinds of odd var values that the cases draw from. Each value is a legal file name piece on Linux. */
export const VALUE_KINDS = [
  "plain",
  "nfc",
  "nfd",
  "space",
  "uriSpecial",
  "dots",
  "long",
  "globLike",
  "emoji",
  "protoLike",
  "dash",
] as const
export type ValueKind = (typeof VALUE_KINDS)[number]

const PLAIN = ["a", "b", "c", "en", "fr", "de", "x1", "hello", "about", "z"]

/** A var value of the given kind. It never holds "/" or NUL, and it is never "." or "..". */
export function valueOfKind(rng: Rng, kind: ValueKind): string {
  switch (kind) {
    case "plain":
      return rng.pick(PLAIN)
    case "nfc":
      return rng.pick(["café", "été", "naïve"])
    case "nfd":
      return rng.pick(["café", "été", "naïve"])
    case "space":
      return rng.pick(["a b", " lead", "trail ", "two  spaces"])
    case "uriSpecial":
      return rng.pick(["50%", "%2F", "a#b", "q?x=1", "a&b", "1+1", "%", "%25", "a%20b"])
    case "dots":
      return rng.pick(["a.b", ".hidden", "..x", "x..", "...", "v1.2.3"])
    case "long": {
      // 200 bytes leaves room for a short extension within the 255-byte name limit.
      const unit = rng.pick(["a", "é", "z"])
      const bytesPerUnit = unit === "é" ? 2 : 1
      return unit.repeat(Math.floor(200 / bytesPerUnit))
    }
    case "globLike":
      return rng.pick(["*", "**", "?", "[ab]", "{a,b}", "<x>", "<lang>", "a*b"])
    case "emoji":
      return rng.pick(["\u{1F600}", "\u{1F1EB}\u{1F1F7}", "中文"])
    case "protoLike":
      return rng.pick(["__proto__", "constructor", "toString", "hasOwnProperty"])
    case "dash":
      return rng.pick(["-", "--x", "a-b", "a-b-c"])
  }
}

/** A small pool of values for one case: mostly plain, so that joins happen, plus some odd ones. */
export function valuePool(rng: Rng, size: number, oddRate: number): { values: string[]; kinds: ValueKind[] } {
  const values: string[] = []
  const kinds: ValueKind[] = []
  let attempts = 0
  while (values.length < size && attempts < size * 20) {
    attempts += 1
    const kind: ValueKind = rng.chance(oddRate) ? rng.pick(VALUE_KINDS) : "plain"
    const value = valueOfKind(rng, kind)
    if (values.includes(value)) continue
    values.push(value)
    kinds.push(kind)
  }
  return { values, kinds }
}
