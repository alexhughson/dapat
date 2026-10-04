export type Vars = Readonly<Record<string, string>>

export function varsKey(vars: Vars): string {
  const keys = Object.keys(vars)
  keys.sort()
  const parts: string[] = []
  for (const key of keys) {
    parts.push(`${key}=${vars[key]}`)
  }
  return parts.join(",")
}

export function compatible(left: Vars, right: Vars): boolean {
  for (const key of Object.keys(left)) {
    const other = right[key]
    if (other !== undefined && other !== left[key]) return false
  }
  return true
}

export function mergeVars(left: Vars, right: Vars): Vars {
  const out: Record<string, string> = {}
  for (const key of Object.keys(left)) {
    out[key] = left[key]!
  }
  for (const key of Object.keys(right)) {
    out[key] = right[key]!
  }
  return out
}

export function hasAllVars(names: readonly string[], vars: Vars): boolean {
  for (const name of names) {
    if (vars[name] === undefined) return false
  }
  return true
}

export function projectVars(vars: Vars, names: readonly string[]): Vars {
  const out: Record<string, string> = {}
  for (const name of names) {
    const value = vars[name]
    if (value !== undefined) out[name] = value
  }
  return out
}

export function sameVarNames(vars: Vars, names: readonly string[]): boolean {
  const keys = Object.keys(vars)
  if (keys.length !== names.length) return false
  const nameSet = new Set(names)
  for (const key of keys) {
    if (!nameSet.has(key)) return false
  }
  return true
}

export class VarsMap<T> {
  private readonly map = new Map<string, { vars: Vars; value: T }>()

  get(vars: Vars): T | undefined {
    const entry = this.map.get(varsKey(vars))
    if (!entry) return undefined
    return entry.value
  }

  set(vars: Vars, value: T): void {
    this.map.set(varsKey(vars), { vars, value })
  }

  delete(vars: Vars): boolean {
    return this.map.delete(varsKey(vars))
  }

  get size(): number {
    return this.map.size
  }

  *entries(): IterableIterator<[Vars, T]> {
    for (const entry of this.map.values()) {
      yield [entry.vars, entry.value]
    }
  }
}
