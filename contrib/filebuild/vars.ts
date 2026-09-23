export type Vars = Record<string, string>

export function compatible(left: Vars, right: Vars): boolean {
  for (const key of Object.keys(left)) {
    const other = right[key]
    if (other !== undefined && other !== left[key]) return false
  }
  return true
}

export function mergeVars(left: Vars, right: Vars): Vars {
  const out: Vars = {}
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

export function varsKey(vars: Vars): string {
  const keys = Object.keys(vars)
  keys.sort()
  const parts: string[] = []
  for (const key of keys) {
    parts.push(`${key}=${vars[key]}`)
  }
  return parts.join(",")
}

export function projectVars(vars: Vars, names: readonly string[]): Vars {
  const out: Vars = {}
  for (const name of names) {
    const value = vars[name]
    if (value !== undefined) out[name] = value
  }
  return out
}
