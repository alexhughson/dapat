import { Artifact } from "../src/artifact"
import { Prefix } from "../src/prefix"

/** In-memory artifact. Also the dict-key case. */
export class Mem extends Artifact<string> {
  constructor(
    readonly id: string,
    public value: string | null = null,
  ) {
    super()
  }

  /** The value is the stamp. null when the value is missing. */
  async stamp(): Promise<string | null> {
    return this.value
  }

  async read(): Promise<string> {
    if (this.value === null) {
      throw new Error(`missing ${this.id}`)
    }
    return this.value
  }

  write(value: string): void {
    this.value = value
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

  /** The sorted ids of the children that have a value. null when no child has one. */
  async stamp(): Promise<string | null> {
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

/** Prefix over a list of in-memory children. Its stamp lists each child that has a value. */
export class MemPrefix extends Prefix {
  constructor(
    readonly id: string,
    public children: Mem[],
  ) {
    super()
  }

  /** The sorted lines `<id>=<value>`. An empty region is the empty string, not null. */
  async stamp(): Promise<string | null> {
    const lines: string[] = []
    for (const child of this.children) {
      if (child.value === null) continue
      lines.push(`${child.id}=${child.value}`)
    }
    lines.sort()
    return lines.join("\n")
  }
}
