import { describe, expect, test } from "bun:test"
import { FixedRowArtifact, StubRowGenerator, type Feed } from "../../contrib/generator"

describe("StubRowGenerator", () => {
  test("start calls feed.set once per hard-coded row", async () => {
    const gen = new StubRowGenerator([
      { vars: { locale: "fr" }, row: { greeting: "bonjour" } },
      { vars: { locale: "de" }, row: { greeting: "hallo" } },
    ])

    const fed: { vars: Record<string, string>; artifact: FixedRowArtifact }[] = []
    const feed: Feed<FixedRowArtifact> = {
      set(vars, artifact) {
        fed.push({ vars, artifact })
      },
      delete() {},
      listen() {},
    }

    await gen.start(feed)

    expect(gen.varNames).toEqual(["locale"])
    expect(fed).toHaveLength(2)
    expect(await fed[0]!.artifact.read()).toEqual({ greeting: "bonjour" })
    expect(fed[0]!.vars).toEqual({ locale: "fr" })
    expect(fed[1]!.artifact.id).toBe("row:locale=de")
  })
})
