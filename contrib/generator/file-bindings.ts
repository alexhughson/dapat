import { FilePattern } from "../filebuild/pattern"
import { projectVars, varsKey, type Vars } from "../filebuild/vars"

/**
 * Vars for each file that matches `pattern` under `root`.
 * Same projection `FileBuild` uses when it ingests scan results.
 */
export async function filePatternVarRows(
  pattern: FilePattern,
  root: string,
): Promise<Vars[]> {
  const ids = await pattern.scan(root)
  const out: Vars[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    const binding = pattern.matchId(id, root)
    if (!binding) continue
    const projected = projectVars(binding, pattern.varNames)
    const key = varsKey(projected)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(projected)
  }
  return out
}
