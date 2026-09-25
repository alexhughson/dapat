import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { FileOutput, FilePattern, RuleBuild } from "../contrib"
import { Build, MemoryStore } from "../src/index"

const root = await mkdtemp(path.join(tmpdir(), "dapat-ex-pipeline-"))

try {
  await mkdir(path.join(root, "src"), { recursive: true })
  await writeFile(path.join(root, "src/hello.txt"), "hello")

  const build = new Build({ store: new MemoryStore() })
  const rules = new RuleBuild(build)
  rules.rule({
    name: "upper",
    inputs: { src: new FilePattern("src/<name>.txt", { root }) },
    outputs: { mid: new FileOutput("mid/<name>.txt", { root }) },
    run: async (ctx) => {
      const text = new TextDecoder().decode(await ctx.inputs.src.read())
      await Bun.write(ctx.outputs.mid.path, text.toUpperCase())
    },
  })
  rules.rule({
    name: "wrap",
    inputs: { mid: new FilePattern("mid/<name>.txt", { root }) },
    outputs: { out: new FileOutput("out/<name>.txt", { root }) },
    run: async (ctx) => {
      const text = new TextDecoder().decode(await ctx.inputs.mid.read())
      await Bun.write(ctx.outputs.out.path, `[${text}]`)
    },
  })

  const result = await rules.run()
  if (!result.success) {
    throw new Error("build failed")
  }

  const out = await Bun.file(path.join(root, "out/hello.txt")).text()
  if (out !== "[HELLO]") {
    throw new Error(`expected [HELLO], got ${out}`)
  }
  console.log(`out/hello.txt = ${out}`)
} finally {
  await rm(root, { recursive: true, force: true })
}
