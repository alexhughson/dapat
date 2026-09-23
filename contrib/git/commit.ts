import { Artifact } from "../../src/artifact"
import { gitCommitId, resolveRepoPath } from "./id"
import { git } from "./run"

export class GitCommitArtifact extends Artifact<Uint8Array> {
  readonly repo: string
  readonly sha: string
  readonly id: string

  constructor(repo: string, sha: string) {
    super()
    this.repo = resolveRepoPath(repo)
    this.sha = sha
    this.id = gitCommitId(this.repo, this.sha)
  }

  async orderStamp(): Promise<bigint | null> {
    return null
  }

  async contentStamp(): Promise<string | null> {
    return this.sha
  }

  async read(): Promise<Uint8Array> {
    const text = await git(["cat-file", "commit", this.sha], { cwd: this.repo })
    return new TextEncoder().encode(text)
  }
}

export function gitCommit(repo: string, sha: string): GitCommitArtifact {
  return new GitCommitArtifact(repo, sha)
}
