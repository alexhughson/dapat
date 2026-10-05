import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, test } from "bun:test"
import { FilePattern } from "../../contrib/filebuild/pattern"
import {
  CollectingFeed,
  filePatternVarRows,
  innerJoinVarLists,
  joinVarLists,
  ValuesGenerator,
} from "../../contrib/generator"

async function writePage(root: string, locale: string, page: string, body: string) {
  const full = path.join(root, "pages", locale, `${page}.md`)
  await mkdir(path.dirname(full), { recursive: true })
  await writeFile(full, body)
}

describe("locale × page join (generator slice)", () => {
  test("innerJoinVarLists matches FileBuild join on shared locale", async () => {
    const rootTrimmed = await mkdtemp(path.join(tmpdir(), "dapat-locale-"))
    await writePage(rootTrimmed, "fr", "intro", "fr-intro")
    await writePage(rootTrimmed, "de", "intro", "de-intro")
    await writePage(rootTrimmed, "fr", "extra", "fr-only")

    const localeFeed = new CollectingFeed()
    await new ValuesGenerator("locale", ["fr", "de"]).start(localeFeed)
    const localeVars = localeFeed.rows.map((row) => row.vars)

    const pageVars = await filePatternVarRows(
      new FilePattern("pages/<locale>/<page>.md"),
      rootTrimmed,
    )

    const joined = innerJoinVarLists(localeVars, pageVars)
    const keys = joined.map((v) => `${v.locale}/${v.page}`).sort()

    expect(keys).toEqual(["de/intro", "fr/extra", "fr/intro"])
  })

  test("joinVarLists folds three slots", () => {
    const tuples = joinVarLists([
      [{ locale: "fr" }],
      [{ locale: "fr", page: "intro" }, { locale: "de", page: "intro" }],
    ])
    expect(tuples).toEqual([{ locale: "fr", page: "intro" }])
  })
})
