import {
  compatible,
  mergeVars,
  projectVars,
  varsKey,
  type Vars,
} from "./vars"
import type { Value } from "./types"
import type { VarsMap } from "./vars"

export type TableEntry = {
  vars: Vars
  value: Value
}

/** Distinct projected var rows from a table, for joining. */
export function bindingRows(
  entries: Iterable<[Vars, Value]>,
  varNames: readonly string[],
): Vars[] {
  const out: Vars[] = []
  const seen = new Set<string>()
  for (const [vars] of entries) {
    const projected = projectVars(vars, varNames)
    const key = varsKey(projected)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(projected)
  }
  return out
}

export function innerJoin(left: Vars[], right: Vars[]): Vars[] {
  const out: Vars[] = []
  for (const l of left) {
    for (const r of right) {
      if (!compatible(l, r)) continue
      out.push(mergeVars(l, r))
    }
  }
  return out
}

export function leftJoin(left: Vars[], right: Vars[]): Vars[] {
  const out: Vars[] = []
  for (const l of left) {
    let matched = false
    for (const r of right) {
      if (!compatible(l, r)) continue
      out.push(mergeVars(l, r))
      matched = true
    }
    if (!matched) out.push(l)
  }
  return out
}

/**
 * Inner-join required tables, then left-join optional tables.
 * Input order is normalized by sorting names so the result set
 * does not depend on object-key order.
 */
export function joinTaskVars(
  required: { name: string; varNames: readonly string[]; table: VarsMap<Value> }[],
  optional: { name: string; varNames: readonly string[]; table: VarsMap<Value> }[],
): Vars[] {
  const requiredSorted = [...required]
  requiredSorted.sort((a, b) => {
    if (a.name < b.name) return -1
    if (a.name > b.name) return 1
    return 0
  })
  const optionalSorted = [...optional]
  optionalSorted.sort((a, b) => {
    if (a.name < b.name) return -1
    if (a.name > b.name) return 1
    return 0
  })

  let tuples: Vars[] = [{}]
  for (const slot of requiredSorted) {
    const rows = bindingRows(slot.table.entries(), slot.varNames)
    tuples = innerJoin(tuples, rows)
  }
  for (const slot of optionalSorted) {
    const rows = bindingRows(slot.table.entries(), slot.varNames)
    tuples = leftJoin(tuples, rows)
  }
  return tuples
}

export function lookupValue(
  table: VarsMap<Value>,
  varNames: readonly string[],
  taskVars: Vars,
): Value | undefined {
  const projected = projectVars(taskVars, varNames)
  return table.get(projected)
}
