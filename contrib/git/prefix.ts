import { Prefix } from "../../src/prefix"
import { gitCommitPrefixId, resolveRepoPath } from "./id"

export class GitCommitPrefix extends Prefix {
  readonly repo: string
  readonly id: string

  constructor(repo: string) {
    super()
    this.repo = resolveRepoPath(repo)
    this.id = gitCommitPrefixId(this.repo)
  }
}

export function gitCommitPrefix(repo: string): GitCommitPrefix {
  return new GitCommitPrefix(repo)
}
