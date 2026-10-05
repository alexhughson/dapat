import { compatible, mergeVars, type Vars } from "../filebuild/vars"

/** Inner join on shared var names (same rule as `FileBuild.join`). */
export function innerJoinVarLists(left: Vars[], right: Vars[]): Vars[] {
  const out: Vars[] = []
  for (const l of left) {
    for (const r of right) {
      if (!compatible(l, r)) continue
      out.push(mergeVars(l, r))
    }
  }
  return out
}

/** Fold many var lists with inner join; starts from one empty tuple. */
export function joinVarLists(lists: readonly Vars[][]): Vars[] {
  let tuples: Vars[] = [{}]
  for (const list of lists) {
    tuples = innerJoinVarLists(tuples, list)
  }
  return tuples
}
