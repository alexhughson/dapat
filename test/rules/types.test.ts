import {
  DirOutput,
  FileGlob,
  FileOutput,
  FilePattern,
  RuleBuild,
  S3Glob,
  S3Output,
  S3Pattern,
  S3PrefixOutput,
  type S3Client,
} from "../../contrib"
import { Build } from "../../src"
import type { FileArtifact } from "../../contrib/fs/file"
import type { PathPrefix } from "../../contrib/fs/prefix"
import type { S3ObjectArtifact } from "../../contrib/s3/object"
import type { S3Prefix } from "../../contrib/s3/prefix"

function typeChecks(): void {
  const rules = new RuleBuild(new Build())
  const client = null as unknown as S3Client

  rules.rule({
    name: "ok",
    inputs: {
      src: new FilePattern("src/<n>.txt"),
      pages: new FileGlob("pages/<n>/**"),
      opt: new FilePattern("opt/<n>.txt"),
    },
    optional: ["opt"],
    outputs: {
      out: new FileOutput("out/<n>.txt"),
      dir: new DirOutput("dir/<n>/"),
    },
    run: async (ctx) => {
      const src: FileArtifact = ctx.inputs.src
      const pages: FileArtifact[] = ctx.inputs.pages
      const opt: FileArtifact | undefined = ctx.inputs.opt
      const out: FileArtifact = ctx.outputs.out
      const dir: PathPrefix = ctx.outputs.dir
      void src
      void pages
      void opt
      void out
      void dir
    },
  })

  rules.rule({
    name: "s3",
    inputs: {
      obj: new S3Pattern("s3://b/k/<n>.txt", { client }),
      objs: new S3Glob("s3://b/k/<n>/**", { client }),
    },
    outputs: {
      out: new S3Output("s3://b/o/<n>.txt", { client }),
      prefix: new S3PrefixOutput("s3://b/p/<n>/"),
    },
    run: async (ctx) => {
      const obj: S3ObjectArtifact = ctx.inputs.obj
      const objs: S3ObjectArtifact[] = ctx.inputs.objs
      const out: S3ObjectArtifact = ctx.outputs.out
      const prefix: S3Prefix = ctx.outputs.prefix
      void obj
      void objs
      void out
      void prefix
    },
  })

  rules.rule({
    name: "pattern-as-output",
    inputs: { src: new FilePattern("src/<n>.txt") },
    outputs: {
      // @ts-expect-error FilePattern is not an OutputGen
      out: new FilePattern("out/<n>.txt"),
    },
    run: async () => {},
  })

  rules.rule({
    name: "output-as-input",
    inputs: {
      // @ts-expect-error FileOutput is not an InputGen
      src: new FileOutput("src/<n>.txt"),
    },
    outputs: { out: new FileOutput("out/<n>.txt") },
    run: async () => {},
  })

  rules.rule({
    name: "bad-optional",
    inputs: { src: new FilePattern("src/<n>.txt") },
    // @ts-expect-error optional entry must be an input name
    optional: ["nope"],
    outputs: { out: new FileOutput("out/<n>.txt") },
    run: async () => {},
  })
}

void typeChecks
