/** A small seeded PRNG (mulberry32), so each case replays from its seed. */
export class Rng {
  private state: number

  constructor(seed: number) {
    this.state = seed >>> 0
  }

  /** A float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0
    let t = this.state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** An integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n)
  }

  /** An integer in [lo, hi]. */
  range(lo: number, hi: number): number {
    return lo + this.int(hi - lo + 1)
  }

  chance(p: number): boolean {
    return this.next() < p
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("rng.pick from an empty list")
    return items[this.int(items.length)]!
  }

  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(i + 1)
      const tmp = items[i]!
      items[i] = items[j]!
      items[j] = tmp
    }
    return items
  }

  /** A child seed, so that sub-steps do not shift each other's numbers. */
  fork(): Rng {
    return new Rng(this.int(0x7fffffff) ^ 0x5bd1e995)
  }
}

/** A stable 32-bit hash of a string (FNV-1a). */
export function hashString(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}
