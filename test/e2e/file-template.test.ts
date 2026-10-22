import { afterEach, describe, expect, test } from "bun:test"
import * as fsPromises from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Build, Matcher, Task } from "../../src/index"
import { FileArtifact, FileMatcher, FileTemplate, FilesystemPrefix, FolderTemplate } from "../../contrib/fs"
import { JsonStore } from "../../contrib/store"

const temps: string[] = []
const startFolder = process.cwd()

afterEach(async () => {
  process.chdir(startFolder)
  for (const dir of temps.splice(0)) {
    await fsPromises.rm(dir, { recursive: true, force: true })
  }
})

async function tempDir(): Promise<string> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "dapat-file-template-"))
  temps.push(dir)
  return dir
}

async function writeText(filePath: string, text: string): Promise<void> {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true })
  await fsPromises.writeFile(filePath, text)
}

/** Sends one match for each slug, as a matcher that does not read paths can: its values are not path parts. */
class SlugMatcher extends Matcher<FileArtifact> {
  readonly varNames = ["slug"]

  constructor(
    private readonly root: string,
    private readonly slugs: readonly string[],
  ) {
    super()
  }

  async scan(_signal: AbortSignal): Promise<void> {
    for (const slug of this.slugs) {
      this.send({ kind: "found", matched: { vars: { slug }, data: new FileArtifact(path.join(this.root, "in.md")) } })
    }
  }
}

function taskIds(tasks: readonly Task[]): string[] {
  const ids: string[] = []
  for (const task of tasks) {
    ids.push(task.id)
  }
  ids.sort()
  return ids
}

describe("FileTemplate and FolderTemplate pattern", () => {
  test("reads its var names and fills them in", () => {
    const template = new FileTemplate("/site/<lang>/<section>/<slug>.html")
    expect(template.varNames).toEqual(["lang", "section", "slug"])
    const html = template.expand({ lang: "en", section: "docs", slug: "install" })
    expect(html).toBeInstanceOf(FileArtifact)
    expect(html.path).toBe("/site/en/docs/install.html")
    const folder = new FolderTemplate("/out/<book>/pages/").expand({ book: "owl" })
    expect(folder).toBeInstanceOf(FilesystemPrefix)
    expect(folder.path).toBe("/out/owl/pages/")
  })

  test("a relative pattern resolves against the working directory when you create the template", async () => {
    const root = await tempDir()
    process.chdir(root)
    const template = new FileTemplate("./site/<slug>.html")
    process.chdir(startFolder)
    expect(template.pattern).toBe("site/<slug>.html")
    const html = template.expand({ slug: "hi" })
    expect(await fsPromises.realpath(path.dirname(path.dirname(html.path)))).toBe(await fsPromises.realpath(root))
    expect(path.basename(html.path)).toBe("hi.html")
  })

  test("throws for a '*' or '**', because an output names one path", () => {
    const message = "'*' and '**' are not allowed; an output names one path"
    expect(() => new FileTemplate("site/*.html")).toThrow(message)
    expect(() => new FileTemplate("site/<lang>/**/index.html")).toThrow(message)
    expect(() => new FolderTemplate("out/<book>/**")).toThrow(message)
    expect(() => new FolderTemplate("out/<book>/pages*/")).toThrow(message)
  })

  test("throws for each other error of FileMatcher", () => {
    expect(() => new FileTemplate("")).toThrow("FileTemplate: the pattern is empty")
    expect(() => new FileTemplate("../site/<slug>.html")).toThrow("a '..' part is not allowed")
    expect(() => new FileTemplate("site/<slug.html")).toThrow("must enclose a var name")
    expect(() => new FolderTemplate("out/<a><b>/")).toThrow("have nothing between them")
  })

  test("throws for a var value that is not one path part", () => {
    const template = new FileTemplate("/site/<slug>.html")
    const message = "a var value must be one path part, not empty, '.', '..', or a value with '/'"
    expect(() => template.expand({ slug: "../../../etc/passwd" })).toThrow(
      `FileTemplate pattern '/site/<slug>.html': the var <slug> is '../../../etc/passwd'; ${message}`,
    )
    expect(() => template.expand({ slug: "a/b" })).toThrow(message)
    expect(() => template.expand({ slug: "" })).toThrow(message)
    expect(() => template.expand({ slug: "." })).toThrow(message)
    expect(() => new FolderTemplate("/out/<book>/").expand({ book: ".." })).toThrow(message)
    expect(template.expand({ slug: "..hidden" }).path).toBe("/site/..hidden.html")
  })

  test("the syntax option sets other markers: '<', '>', and '*' are then literals", () => {
    const syntax = { varStart: "{", varEnd: "}", anyName: "%", anyFolders: "%%" }
    const template = new FileTemplate("/site/<raw>*/{slug}.html", { syntax })
    expect(template.varNames).toEqual(["slug"])
    expect(template.expand({ slug: "hi" }).path).toBe("/site/<raw>*/hi.html")
    const folder = new FolderTemplate("/out/{book}/", { syntax })
    expect(folder.expand({ book: "owl" }).path).toBe("/out/owl/")
    expect(() => new FileTemplate("/site/%.html", { syntax })).toThrow("'%' and '%%' are not allowed")
    expect(() => new FolderTemplate("/out/{book}/%%", { syntax })).toThrow("'%' and '%%' are not allowed")
    expect(() => new FileTemplate("/site/{slug.html", { syntax })).toThrow("each '{' and '}' must enclose a var name")
  })
})

describe("outputsByName in a build", () => {
  test("tasks gets the filled outputs; a changed output file makes the task run again", async () => {
    const root = await tempDir()
    await writeText(path.join(root, "content", "en", "docs", "install.md"), "Install")
    await writeText(path.join(root, "content", "en", "blog", "hello.md"), "Hello")
    await writeText(path.join(root, "templates", "en.html"), "<main>{{body}}</main>")
    const store = new JsonStore(path.join(root, "state.json"))

    async function buildOnce() {
      const build = new Build({ store })
      build.each({
        matchersByName: {
          page: new FileMatcher(path.join(root, "content/<lang>/<section>/<slug>.md")),
          template: new FileMatcher(path.join(root, "templates/<lang>.html")),
        },
        outputsByName: { html: new FileTemplate(path.join(root, "site/<lang>/<section>/<slug>.html")) },
        *tasks(vars, matched, outputs) {
          const html: FileArtifact = outputs.html
          // @ts-expect-error: no template is named htm.
          void outputs.htm
          yield new Task({
            id: `page:${vars.lang}/${vars.section}/${vars.slug}`,
            inputs: [matched.page.data, matched.template.data],
            outputs: [html],
            run: async () => {
              const text = await Bun.file(matched.page.data.path).text()
              const layout = await Bun.file(matched.template.data.path).text()
              await Bun.write(html.path, layout.replace("{{body}}", text))
            },
          })
        },
      })
      return build.run()
    }

    const first = await buildOnce()
    expect(first.success).toBe(true)
    expect(taskIds(first.executed)).toEqual(["page:en/blog/hello", "page:en/docs/install"])
    const installPath = path.join(root, "site", "en", "docs", "install.html")
    expect(await Bun.file(installPath).text()).toBe("<main>Install</main>")

    const second = await buildOnce()
    expect(second.executed).toEqual([])
    expect(taskIds(second.skipped)).toEqual(["page:en/blog/hello", "page:en/docs/install"])

    await writeText(installPath, "edited by hand")
    const third = await buildOnce()
    expect(taskIds(third.executed)).toEqual(["page:en/docs/install"])
    expect(third.outcomes.get(third.executed[0]!)).toEqual({
      type: "executed",
      reason: { kind: "output-changed", id: `file:${installPath}` },
    })
    expect(await Bun.file(installPath).text()).toBe("<main>Install</main>")
  })

  test("a set with no value for a var of a template gets no tasks", async () => {
    const root = await tempDir()
    await writeText(path.join(root, "content", "a.md"), "A")
    await writeText(path.join(root, "content", "b.md"), "B")
    await writeText(path.join(root, "words", "a", "fr.txt"), "un")
    const calls: string[] = []
    const build = new Build()
    build.each({
      matchersByName: {
        page: new FileMatcher(path.join(root, "content/<slug>.md")),
        words: new FileMatcher(path.join(root, "words/<slug>/<lang>.txt")),
      },
      required: ["page"],
      outputsByName: { html: new FileTemplate(path.join(root, "site/<lang>/<slug>.html")) },
      *tasks(vars, matched, outputs) {
        calls.push(`${vars.slug} ${vars.lang}`)
        yield new Task({ id: `page:${vars.slug}`, inputs: [matched.page.data], outputs: [outputs.html], run: async () => {} })
      },
    })
    const result = await build.run()
    expect(result.success).toBe(true)
    // b has no words file, so its set has no lang, and the build does not call tasks for it.
    expect(calls).toEqual(["a fr"])
    expect(taskIds(result.executed)).toEqual(["page:a"])
  })

  test("a var value that is not one path part makes the build fail", async () => {
    const root = await tempDir()
    await writeText(path.join(root, "in.md"), "")
    const build = new Build()
    build.each({
      matchersByName: { page: new SlugMatcher(root, ["../../escape"]) },
      outputsByName: { html: new FileTemplate(path.join(root, "site/<slug>.html")) },
      *tasks(vars, matched, outputs) {
        yield new Task({ id: `page:${vars.slug}`, inputs: [matched.page.data], outputs: [outputs.html], run: async () => {} })
      },
    })
    await expect(build.run()).rejects.toThrow("the var <slug> is '../../escape'")
    expect(await Bun.file(path.join(root, "..", "escape.html")).exists()).toBe(false)
  })

  test("a template var that no matcher has throws at build.each", () => {
    const build = new Build()
    expect(() =>
      build.each({
        matchersByName: { page: new FileMatcher("content/<slug>.md") },
        outputsByName: { html: new FileTemplate("site/<lang>/<slug>.html") },
        *tasks() {},
      }),
    ).toThrow("build.each 1: the output template 'html' uses the var 'lang', which no matcher has")
  })

  test("FolderTemplate gives each set a FilesystemPrefix; a removed file in it makes the task run again", async () => {
    const root = await tempDir()
    await writeText(path.join(root, "books", "owl", "text.txt"), "one\ntwo")
    const store = new JsonStore(path.join(root, "state.json"))

    async function buildOnce() {
      const build = new Build({ store })
      build.each({
        matchersByName: { text: new FileMatcher(path.join(root, "books/<book>/text.txt")) },
        outputsByName: { pages: new FolderTemplate(path.join(root, "out/<book>/pages/")) },
        *tasks(vars, matched, outputs) {
          const pages: FilesystemPrefix = outputs.pages
          yield new Task({
            id: `chunk:${vars.book}`,
            inputs: [matched.text.data],
            outputs: [pages],
            run: async () => {
              const lines = (await Bun.file(matched.text.data.path).text()).split("\n")
              for (let index = 0; index < lines.length; index++) {
                await Bun.write(path.join(pages.path, `${index}.txt`), lines[index]!)
              }
            },
          })
        },
      })
      return build.run()
    }

    const first = await buildOnce()
    expect(first.success).toBe(true)
    expect(taskIds(first.executed)).toEqual(["chunk:owl"])
    expect(await Bun.file(path.join(root, "out", "owl", "pages", "1.txt")).text()).toBe("two")

    const second = await buildOnce()
    expect(taskIds(second.skipped)).toEqual(["chunk:owl"])

    await fsPromises.rm(path.join(root, "out", "owl", "pages", "0.txt"))
    const third = await buildOnce()
    expect(taskIds(third.executed)).toEqual(["chunk:owl"])
    expect(await Bun.file(path.join(root, "out", "owl", "pages", "0.txt")).text()).toBe("one")
  })
})
