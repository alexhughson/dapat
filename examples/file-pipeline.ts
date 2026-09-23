import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { FileBuild, FilePattern } from "../contrib/filebuild"
import { Build, MemoryStore } from "../src/index"

const root = await mkdtemp(path.join(tmpdir(), "dapat-ex-pipeline-"))

try {
  await mkdir(path.join(root, "src"), { recursive: true })
  await writeFile(path.join(root, "src/hello.txt"), "hello")

  const build = new Build({ store: new MemoryStore() })
  const files = new FileBuild(build, { root })
  files.rule({
    name: "upper",
    inputs: { src: new FilePattern("src/<name>.txt") },
    outputs: { mid: new FilePattern("mid/<name>.txt") },
    run: async (ctx) => {
      const text = new TextDecoder().decode(await ctx.file("src").read())
      await writeFile(ctx.outputFile("mid").path, text.toUpperCase())
    },
  })
  files.rule({
    name: "wrap",
    inputs: { mid: new FilePattern("mid/<name>.txt") },
    outputs: { out: new FilePattern("out/<name>.txt") },
    run: async (ctx) => {
      const text = new TextDecoder().decode(await ctx.file("mid").read())
      await writeFile(ctx.outputFile("out").path, `[${text}]`)
    },
  })

  const result = await files.run()
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
