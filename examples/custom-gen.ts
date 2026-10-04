import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Artifact } from "../src/artifact"
import { Build, MemoryStore } from "../src/index"
import {
  FileOutput,
  FilePattern,
  InputGen,
  RuleBuild,
  type Feed,
} from "../contrib"

class ValueArtifact extends Artifact<string> {
  readonly id: string

  constructor(
    readonly name: string,
    readonly value: string,
  ) {
    super()
    this.id = `value:${name}=${value}`
  }

  async orderStamp(): Promise<bigint | null> {
    return null
  }

  async contentStamp(): Promise<string | null> {
    return this.value
  }

  async read(): Promise<string> {
    return this.value
  }
}

class Values extends InputGen<ValueArtifact> {
  readonly varNames: readonly string[]

  constructor(
    private readonly name: string,
    private readonly values: string[],
  ) {
    super()
    this.varNames = [name]
  }

  async start(feed: Feed<ValueArtifact>): Promise<void> {
    for (const value of this.values) {
      feed.set({ [this.name]: value }, new ValueArtifact(this.name, value))
    }
  }
}

const root = await mkdtemp(path.join(tmpdir(), "dapat-ex-custom-"))

try {
  await mkdir(path.join(root, "pages/fr"), { recursive: true })
  await mkdir(path.join(root, "pages/es"), { recursive: true })
  await writeFile(path.join(root, "pages/fr/home.md"), "bonjour")
  await writeFile(path.join(root, "pages/es/home.md"), "hola")

  const build = new Build({ store: new MemoryStore() })
  const rules = new RuleBuild(build)

  rules.rule({
    name: "translate",
    inputs: {
      locale: new Values("locale", ["fr", "de"]),
      page: new FilePattern("pages/<locale>/<page>.md", { root }),
    },
    outputs: { out: new FileOutput("site/<locale>/<page>.html", { root }) },
    run: async (ctx) => {
      const body = new TextDecoder().decode(await ctx.inputs.page.read())
      await Bun.write(
        ctx.outputs.out.path,
        `${ctx.inputs.locale.value}:${body}`,
      )
    },
  })

  const result = await rules.run()
  if (!result.success) {
    throw new Error("build failed")
  }

  const html = await Bun.file(path.join(root, "site/fr/home.html")).text()
  const esExists = await Bun.file(path.join(root, "site/es/home.html")).exists()
  console.log(`tasks executed = ${result.executed.map((t) => t.id).join(", ")}`)
  console.log(`site/fr/home.html = ${html}`)
  console.log(`site/es/home.html exists = ${esExists}`)
} finally {
  await rm(root, { recursive: true, force: true })
}
