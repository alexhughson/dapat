import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  FileOutput,
  MemoryS3,
  RuleBuild,
  S3ObjectArtifact,
  S3Pattern,
  S3PrefixOutput,
} from "../contrib"
import { Build, MemoryStore } from "../src/index"

const encode = (text: string) => new TextEncoder().encode(text)
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

const root = await mkdtemp(path.join(tmpdir(), "dapat-ex-pages-"))
const s3 = new MemoryS3()

try {
  await s3.put("docs", "inbox/report.txt", encode("p1\np2\np3"))
  await s3.put("docs", "inbox/notes.txt", encode("only"))

  const build = new Build({ store: new MemoryStore() })
  const rules = new RuleBuild(build)

  rules.rule({
    name: "paginate",
    inputs: {
      src: new S3Pattern("s3://docs/inbox/<doc>.txt", { client: s3 }),
    },
    outputs: {
      pages: new S3PrefixOutput("s3://docs/pages/<doc>/"),
    },
    run: async (ctx) => {
      const text = decode(await ctx.inputs.src.read())
      const lines = text.split("\n")
      for (let i = 0; i < lines.length; i++) {
        const key = `${ctx.outputs.pages.keyPrefix}${i + 1}.txt`
        await s3.put("docs", key, encode(lines[i]!))
        ctx.produced(new S3ObjectArtifact(s3, "docs", key))
      }
    },
  })

  rules.rule({
    name: "shot",
    inputs: {
      page: new S3Pattern("s3://docs/pages/<doc>/<page>.txt", { client: s3 }),
    },
    outputs: { shot: new FileOutput("shots/<doc>/<page>.png", { root }) },
    run: async (ctx) => {
      const body = decode(await ctx.inputs.page.read())
      await Bun.write(ctx.outputs.shot.path, `shot:${body}`)
    },
  })

  const result = await rules.run()
  if (!result.success) {
    throw new Error("build failed")
  }

  const report1 = await Bun.file(path.join(root, "shots/report/1.png")).text()
  const report2 = await Bun.file(path.join(root, "shots/report/2.png")).text()
  const report3 = await Bun.file(path.join(root, "shots/report/3.png")).text()
  const notes1 = await Bun.file(path.join(root, "shots/notes/1.png")).text()
  if (report1 !== "shot:p1" || report2 !== "shot:p2" || report3 !== "shot:p3") {
    throw new Error("report did not yield 3 shots")
  }
  if (notes1 !== "shot:only") {
    throw new Error("notes did not yield 1 shot")
  }

  console.log("s3://docs/inbox/report.txt → 3 pages → 3 shots")
  console.log(`  shots/report/1.png = ${report1}`)
  console.log(`  shots/report/2.png = ${report2}`)
  console.log(`  shots/report/3.png = ${report3}`)
  console.log("s3://docs/inbox/notes.txt → 1 page → 1 shot")
  console.log(`  shots/notes/1.png = ${notes1}`)
} finally {
  await rm(root, { recursive: true, force: true })
}
