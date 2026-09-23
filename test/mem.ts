import { Artifact } from "../src/artifact"

/** In-memory artifact. Also the dict-key case. */
export class Mem extends Artifact<string> {
  constructor(
    readonly id: string,
    public value: string | null = null,
    public order: bigint | null = null,
    public content: string | null = null,
  ) {
    super()
  }

  async orderStamp(): Promise<bigint | null> {
    if (this.value === null) return null
    return this.order
  }

  async contentStamp(): Promise<string | null> {
    if (this.value === null) return null
    return this.content
  }

  async read(): Promise<string> {
    if (this.value === null) {
      throw new Error(`missing ${this.id}`)
    }
    return this.value
  }

  write(value: string, order: bigint, content: string | null): void {
    this.value = value
    this.order = order
    this.content = content
  }
}

/** Listing whose `covers` includes every id under `region`. */
export class MemDir extends Artifact<string[]> {
  constructor(
    readonly region: string,
    public children: Mem[],
  ) {
    super()
  }

  get id(): string {
    return this.region
  }

  get coversOthers(): boolean {
    return true
  }

  covers(other: Artifact): boolean {
    if (other.id === this.id) return true
    return other.id.startsWith(this.region)
  }

  async orderStamp(): Promise<bigint | null> {
    let max: bigint | null = null
    for (const child of this.children) {
      const order = await child.orderStamp()
      if (order === null) continue
      if (max === null || order > max) max = order
    }
    return max
  }

  async contentStamp(): Promise<string | null> {
    const names: string[] = []
    for (const child of this.children) {
      if (child.value === null) continue
      names.push(child.id)
    }
    names.sort()
    if (names.length === 0) return null
    return names.join(",")
  }

  async read(): Promise<string[]> {
    const names: string[] = []
    for (const child of this.children) {
      if (child.value === null) continue
      names.push(child.id)
    }
    return names
  }
}
