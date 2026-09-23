import type { Prefix } from "../../src/prefix"
import { GitCommitArtifact } from "../git/commit"
import {
  gitCommitId,
  parseGitCommitId,
  resolveRepoPath,
} from "../git/id"
import { GitCommitPrefix } from "../git/prefix"
import { git } from "../git/run"
import type { InputPattern, Item } from "./item"
import type { Vars } from "./vars"

export type GitCommitPatternOpts = {
  rev?: string
  optional?: boolean
  list?: boolean
}

export class GitCommitPattern implements InputPattern {
  readonly repo: string
  readonly rev: string
  readonly optional: boolean
  readonly list: boolean
  readonly varNames: readonly string[]

  constructor(repo: string, opts: GitCommitPatternOpts = {}) {
    this.repo = repo
    this.rev = opts.rev ?? "HEAD"
    this.optional = opts.optional === true
    this.list = opts.list === true
    if (this.list) {
      this.varNames = []
    } else {
      this.varNames = ["sha"]
    }
  }

  private absRepo(root: string): string {
    return resolveRepoPath(this.repo, root)
  }

  listenPrefix(root: string): Prefix {
    return new GitCommitPrefix(this.absRepo(root))
  }

  matchId(id: string, root: string): Vars | null {
    const parsed = parseGitCommitId(id)
    if (!parsed) return null
    if (parsed.repo !== this.absRepo(root)) return null
    return { sha: parsed.sha }
  }

  artifact(id: string, root: string): Item {
    const parsed = parseGitCommitId(id)
    if (!parsed || parsed.repo !== this.absRepo(root)) {
      throw new Error(`id '${id}' is not a commit in ${this.absRepo(root)}`)
    }
    return new GitCommitArtifact(parsed.repo, parsed.sha)
  }

  async scan(root: string): Promise<string[]> {
    const abs = this.absRepo(root)
    const stdout = await git(["rev-list", this.rev], { cwd: abs })
    const ids: string[] = []
    const lines = stdout.split("\n")
    for (const line of lines) {
      const sha = line.trim()
      if (sha.length === 0) continue
      ids.push(gitCommitId(abs, sha))
    }
    return ids
  }

  sortKey(artifact: Item): string {
    if (artifact instanceof GitCommitArtifact) return artifact.sha
    return artifact.id
  }
}
