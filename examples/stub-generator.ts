import type { Vars } from "../contrib/filebuild/vars"
import {
  FixedRowArtifact,
  StubRowGenerator,
  type Feed,
} from "../contrib/generator"

const feed: Feed<FixedRowArtifact> & {
  readonly rows: { vars: Vars; artifact: FixedRowArtifact }[]
} = {
  rows: [],
  set(vars, artifact) {
    this.rows.push({ vars, artifact })
  },
  delete(_vars) {
    // stub example does not remove rows
  },
  listen(_prefix, _fn) {
    // row-only generator; walk-driven inputs use listen in FilePattern.start (future)
  },
}

const gen = new StubRowGenerator([
  { vars: { locale: "fr" }, row: { greeting: "bonjour" } },
  { vars: { locale: "es" }, row: { greeting: "hola" } },
])

await gen.start(feed)

for (const { vars, artifact } of feed.rows) {
  const row = await artifact.read()
  console.log(`${vars.locale} -> ${row.greeting} (id=${artifact.id})`)
}
