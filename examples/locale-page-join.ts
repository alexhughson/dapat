import path from "node:path"
import { FilePattern } from "../contrib/filebuild/pattern"
import {
  CollectingFeed,
  filePatternVarRows,
  innerJoinVarLists,
  ValuesGenerator,
} from "../contrib/generator"

const root = path.join(import.meta.dir, "fixtures/locale-pages")

const localeFeed = new CollectingFeed()
await new ValuesGenerator("locale", ["fr", "de"]).start(localeFeed)
const localeRows = localeFeed.rows.map((row) => row.vars)

const pagePattern = new FilePattern("pages/<locale>/<page>.md")
const pageRows = await filePatternVarRows(pagePattern, root)

const tasks = innerJoinVarLists(localeRows, pageRows)
tasks.sort((a, b) => `${a.locale}/${a.page}`.localeCompare(`${b.locale}/${b.page}`))

for (const vars of tasks) {
  console.log(`${vars.locale}/${vars.page}`)
}
