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
