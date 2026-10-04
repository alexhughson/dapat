import { Artifact } from "../src/artifact"
import {
  FieldGen,
  capture,
  type FieldRecord,
  type FieldSpec,
} from "../contrib"

export class GitCommitArtifact extends Artifact<string> {
  readonly id: string

  constructor(
    readonly repo: string,
    readonly sha: string,
  ) {
    super()
    this.id = `git:${repo}@${sha}`
  }

  async orderStamp(): Promise<bigint | null> {
    return null
  }

  async contentStamp(): Promise<string | null> {
    return this.sha
  }

  async read(): Promise<string> {
    return this.sha
  }
}

type CommitField = "commit" | "branch"

export class GitCommits<S extends FieldSpec<CommitField>> extends FieldGen<
  CommitField,
  "commit",
  GitCommitArtifact,
  S
> {
  constructor(
    readonly repo: string,
    spec: S,
  ) {
    super(spec, ["commit"])
  }

  protected async records(): Promise<
    FieldRecord<CommitField, GitCommitArtifact>[]
  > {
    const branches: string[] = []
    const only = this.literal("branch")
    if (only !== undefined) {
      branches.push(only)
    } else {
      const refs = await gitText(this.repo, [
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/heads",
      ])
      for (const line of refs.split("\n")) {
        if (line.length > 0) branches.push(line)
      }
    }

    const records: FieldRecord<CommitField, GitCommitArtifact>[] = []
    for (const branch of branches) {
      const shas = await gitText(this.repo, ["rev-list", branch])
      for (const sha of shas.split("\n")) {
        if (sha.length === 0) continue
        const artifact = new GitCommitArtifact(this.repo, sha)
        records.push({ fields: { commit: sha, branch }, artifact })
      }
    }
    return records
  }
}

export class GitBranchArtifact extends Artifact<string> {
  readonly id: string

  constructor(
    readonly repo: string,
    readonly branch: string,
    readonly tip: string,
  ) {
    super()
    this.id = `git-branch:${repo}@${branch}`
  }

  async orderStamp(): Promise<bigint | null> {
    return null
  }

  async contentStamp(): Promise<string | null> {
    return this.tip
  }

  async read(): Promise<string> {
    return this.tip
  }
}

type BranchField = "branch"

export class GitBranches<S extends FieldSpec<BranchField>> extends FieldGen<
  BranchField,
  "branch",
  GitBranchArtifact,
  S
> {
  constructor(
    readonly repo: string,
    spec: S,
  ) {
    super(spec, ["branch"])
  }

  protected async records(): Promise<
    FieldRecord<BranchField, GitBranchArtifact>[]
  > {
    const refs = await gitText(this.repo, [
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads",
    ])
    const records: FieldRecord<BranchField, GitBranchArtifact>[] = []
    for (const line of refs.split("\n")) {
      if (line.length === 0) continue
      const tip = await gitText(this.repo, ["rev-parse", line])
      records.push({
        fields: { branch: line },
        artifact: new GitBranchArtifact(this.repo, line, tip.trim()),
      })
    }
    return records
  }
}

async function gitText(repo: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", repo, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const text = await new Response(proc.stdout).text()
  const code = await proc.exited
  if (code !== 0) {
    const err = await new Response(proc.stderr).text()
    throw new Error(`git ${args.join(" ")} failed: ${err}`)
  }
  return text
}

export { capture }

if (import.meta.main) {
  const repo = process.argv[2] ?? process.cwd()
  const commits = new GitCommits(repo, { commit: capture("sha") })
  const branches = new GitBranches(repo, { branch: capture("branch") })
  console.log(`GitCommits varNames = ${commits.varNames.join(",")}`)
  console.log(`GitBranches varNames = ${branches.varNames.join(",")}`)
  console.log(`GitCommits many = ${commits.many}`)
  console.log(
    `GitCommits(branch only) many = ${new GitCommits(repo, { branch: capture("branch") }).many}`,
  )
}
