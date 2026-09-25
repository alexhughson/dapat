import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DirOutput, FileGlob, FileOutput, FilePattern } from "../../contrib"
import { FileTemplate } from "../../contrib/rules/file-template"
import { KeyTemplate } from "../../contrib/rules/template"

const temps: string[] = []

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dapat-adv-tpl-"))
  temps.push(dir)
  return dir
}

describe("adv templates", () => {
  test("var value '..' must not escape: render throws", async () => {
    const root = await tempDir()
    const out = new FileOutput("safe/<name>/x.txt", { root })
    expect(() => out.render({ name: ".." })).toThrow(/unsafe value/)
    expect(() => out.render({ name: "." })).toThrow(/unsafe value/)
    expect(() => out.render({ name: "" })).toThrow(/unsafe value/)
    expect(() => out.render({ name: "a/b" })).toThrow(/unsafe value/)
  })

  test("S3 key template render throws on unsafe var values", () => {
    const key = new KeyTemplate("docs/<name>.txt")
    expect(() => key.render({ name: ".." })).toThrow(/unsafe value/)
    expect(() => key.render({ name: "a/b" })).toThrow(/var 'name'/)
  })

  test("absolute template ignores root option", () => {
    const abs = `/tmp/dapat-adv-abs/<name>.txt`
    const key = new FileTemplate(abs, { root: "/var/somewhere" })
    const rendered = key.render({ name: "a" })
    expect(rendered).toBe(`/tmp/dapat-adv-abs/a.txt`)
  })

  test("root with trailing slash still resolves", () => {
    const root = `/tmp/dapat-adv-root/`
    const key = new FileTemplate("src/<name>.txt", { root })
    const rendered = key.render({ name: "a" })
    expect(rendered).toBe(path.resolve("/tmp/dapat-adv-root", "src", "a.txt"))
  })

  test("template with no literal start: staticPrefix is root only", async () => {
    const root = await tempDir()
    const pattern = new FilePattern("<name>.txt", { root })
    expect(pattern.staticPrefix).toBe(`${path.resolve(root)}${path.sep}`)
  })

  test("FileGlob with ** at start walks from root", async () => {
    const root = await tempDir()
    const { mkdir, writeFile } = await import("node:fs/promises")
    await mkdir(path.join(root, "deep", "nest"), { recursive: true })
    await writeFile(path.join(root, "deep", "nest", "x.txt"), "x")
    const glob = new FileGlob("**/x.txt", { root })
    expect(glob.staticPrefix).toBe(`${path.resolve(root)}${path.sep}`)
    expect(glob.match(path.join(root, "deep", "nest", "x.txt"))).toEqual({})
  })

  test("DirOutput requires trailing slash; FileOutput rejects it", () => {
    expect(() => new DirOutput("pages/<doc>")).toThrow()
    expect(() => new FileOutput("pages/<doc>/")).toThrow()
  })
})
