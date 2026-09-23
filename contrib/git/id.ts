import path from "node:path"

export function resolveRepoPath(repo: string, root?: string): string {
  let base = process.cwd()
  if (root !== undefined) {
    base = root
  }
  const abs = path.resolve(base, repo)
  if (abs.includes("#")) {
    throw new Error(`repo path '${abs}' contains '#'`)
  }
  return abs
}

export function gitCommitId(absRepo: string, sha: string): string {
  return `git:${absRepo}#${sha}`
}

export function gitCommitPrefixId(absRepo: string): string {
  return `git:${absRepo}#`
}

export function parseGitCommitId(
  id: string,
): { repo: string; sha: string } | null {
  if (!id.startsWith("git:")) return null
  const rest = id.slice("git:".length)
  const hash = rest.lastIndexOf("#")
  if (hash < 0) return null
  const repo = rest.slice(0, hash)
  const sha = rest.slice(hash + 1)
  if (repo.length === 0 || sha.length === 0) return null
  return { repo, sha }
}
