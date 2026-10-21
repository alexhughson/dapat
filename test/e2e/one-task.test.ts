import { afterEach, describe, expect, test } from "bun:test"
import * as fsPromises from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Build, Task, type Context, type Result } from "../../src/index"
import { FileArtifact, FileGroupMatcher, FileMatcher, FileTemplate, FolderTemplate } from "../../contrib/fs"
import { JsonStore } from "../../contrib/store"

const temps: string[] = []

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await fsPromises.rm(dir, { recursive: true, force: true })
  }
})

async function tempDir(): Promise<string> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "dapat-one-task-"))
  temps.push(dir)
  return dir
}

async function writeText(filePath: string, text: string): Promise<void> {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true })
  await fsPromises.writeFile(filePath, text)
}

function taskIds(tasks: readonly Task[]): string[] {
  const ids: string[] = []
  for (const task of tasks) {
    ids.push(task.id)
  }
  ids.sort()
  return ids
}

/** The path of each input of the task, relative to root, as `<path>` or `<path>/` for a prefix. */
function inputPaths(result: Result, taskId: string, root: string): string[] {
  for (const task of result.outcomes.keys()) {
    if (task.id !== taskId) continue
    const paths: string[] = []
    for (const input of task.inputs) {
      paths.push(path.relative(root, (input as FileArtifact).path))
    }
    return paths
  }
  throw new Error(`no task ${taskId}`)
}

describe("build.each with name and run", () => {
  test("the blog page task: id from the vars, the matched files in, the template out; an edit to any input runs it again", async () => {
    const root = await tempDir()
    await writeText(path.join(root, "content", "en", "docs", "install.md"), "Install")
    await writeText(path.join(root, "content", "en", "blog", "hello.md"), "Hello $& there")
    await writeText(path.join(root, "content", "fr", "blog", "hello.md"), "Salut")
    await writeText(path.join(root, "templates", "en.html"), "<main>{{body}}</main>")
    await writeText(path.join(root, "templates", "fr.html"), "<main lang=fr>{{body}}</main>")
    const store = new JsonStore(path.join(root, "state.json"))

    async function buildOnce() {
      const build = new Build({ store })
      build.each({
        name: "page",
        matchersByName: {
          page: new FileMatcher(path.join(root, "content/<lang>/<section>/<slug>.md")),
          template: new FileMatcher(path.join(root, "templates/<lang>.html")),
        },
        outputsByName: { html: new FileTemplate(path.join(root, "site/<lang>/<section>/<slug>.html")) },
        async run({ matched, outputs }) {
          const html: FileArtifact = outputs.html
          const text = await Bun.file(matched.page.data.path).text()
          const layout = await Bun.file(matched.template.data.path).text()
          await Bun.write(html.path, layout.replace("{{body}}", () => text))
        },
      })
      return build.run()
    }

    const first = await buildOnce()
    expect(first.success).toBe(true)
    expect(taskIds(first.executed)).toEqual(["page:en/blog/hello", "page:en/docs/install", "page:fr/blog/hello"])
    expect(inputPaths(first, "page:en/docs/install", root)).toEqual(["content/en/docs/install.md", "templates/en.html"])
    for (const task of first.executed) {
      expect(task.outputs.length).toBe(1)
    }
    expect(await Bun.file(path.join(root, "site", "en", "blog", "hello.html")).text()).toBe("<main>Hello $& there</main>")

    const second = await buildOnce()
    expect(second.executed).toEqual([])
    expect(taskIds(second.skipped)).toEqual(["page:en/blog/hello", "page:en/docs/install", "page:fr/blog/hello"])

    await writeText(path.join(root, "content", "en", "docs", "install.md"), "Install now")
    const third = await buildOnce()
    expect(taskIds(third.executed)).toEqual(["page:en/docs/install"])

    await writeText(path.join(root, "templates", "fr.html"), "<body>{{body}}</body>")
    const fourth = await buildOnce()
    expect(taskIds(fourth.executed)).toEqual(["page:fr/blog/hello"])
    expect(await Bun.file(path.join(root, "site", "fr", "blog", "hello.html")).text()).toBe("<body>Salut</body>")

    await writeText(path.join(root, "site", "en", "blog", "hello.html"), "edited by hand")
    const fifth = await buildOnce()
    expect(taskIds(fifth.executed)).toEqual(["page:en/blog/hello"])
  })

  test("a group adds each of its files as an input", async () => {
    const root = await tempDir()
    await writeText(path.join(root, "content", "en", "a.md"), "")
    await writeText(path.join(root, "content", "en", "docs", "b.md"), "")
    await writeText(path.join(root, "content", "fr", "c.md"), "")
    const store = new JsonStore(path.join(root, "state.json"))

    async function buildOnce() {
      const build = new Build({ store })
      build.each({
        name: "sitemap",
        matchersByName: { pages: new FileGroupMatcher(path.join(root, "content/<lang>/**/*.md")) },
        outputsByName: { sitemap: new FileTemplate(path.join(root, "site/<lang>/sitemap.txt")) },
        async run({ matched, outputs }) {
          const lines: string[] = []
          for (const file of matched.pages.data) {
            lines.push(path.basename(file.path))
          }
          await Bun.write(outputs.sitemap.path, lines.join("\n"))
        },
      })
      return build.run()
    }

    const first = await buildOnce()
    expect(taskIds(first.executed)).toEqual(["sitemap:en", "sitemap:fr"])
    expect(inputPaths(first, "sitemap:en", root)).toEqual(["content/en/a.md", "content/en/docs/b.md"])
    expect(await Bun.file(path.join(root, "site", "en", "sitemap.txt")).text()).toBe("a.md\nb.md")

    await writeText(path.join(root, "content", "en", "docs", "b.md"), "changed")
    const second = await buildOnce()
    expect(taskIds(second.executed)).toEqual(["sitemap:en"])
    expect(taskIds(second.skipped)).toEqual(["sitemap:fr"])
  })

  test("a matcher that is not required and has no match adds no input and no id part", async () => {
    const root = await tempDir()
    await writeText(path.join(root, "content", "a.md"), "A")
    await writeText(path.join(root, "content", "b.md"), "B")
    await writeText(path.join(root, "words", "a", "fr.txt"), "un")
    const seen: string[] = []
    const build = new Build()
    build.each({
      name: "count",
      matchersByName: {
        page: new FileMatcher(path.join(root, "content/<slug>.md")),
        words: new FileMatcher(path.join(root, "words/<slug>/<lang>.txt")),
      },
      required: ["page"],
      async run({ vars, matched }) {
        seen.push(`${vars.slug} ${vars.lang} ${matched.words === undefined}`)
      },
    })
    const result = await build.run()
    expect(result.success).toBe(true)
    expect(taskIds(result.executed)).toEqual(["count:a/fr", "count:b"])
    expect(inputPaths(result, "count:a/fr", root)).toEqual(["content/a.md", "words/a/fr.txt"])
    expect(inputPaths(result, "count:b", root)).toEqual(["content/b.md"])
    seen.sort()
    expect(seen).toEqual(["a fr false", "b undefined true"])
  })

  test("a set with no value for a var of a template gets no task", async () => {
    const root = await tempDir()
    await writeText(path.join(root, "content", "a.md"), "A")
    await writeText(path.join(root, "content", "b.md"), "B")
    await writeText(path.join(root, "words", "a", "fr.txt"), "un")
    const build = new Build()
    build.each({
      name: "page",
      matchersByName: {
        page: new FileMatcher(path.join(root, "content/<slug>.md")),
        words: new FileMatcher(path.join(root, "words/<slug>/<lang>.txt")),
      },
      required: ["page"],
      outputsByName: { html: new FileTemplate(path.join(root, "site/<lang>/<slug>.html")) },
      async run({ outputs }) {
        await Bun.write(outputs.html.path, "")
      },
    })
    const result = await build.run()
    expect(result.success).toBe(true)
    expect(taskIds(result.executed)).toEqual(["page:a/fr"])
  })

  test("a var with no value in one set and a var with a value in another set can give one id: build.run rejects", async () => {
    const root = await tempDir()
    // The names in order: A and B are not required, P is. The vars in order: a, lang, b.
    await writeText(path.join(root, "a", "en", "x.txt"), "")
    await writeText(path.join(root, "p", "x.txt"), "")
    await writeText(path.join(root, "p", "en.txt"), "")
    await writeText(path.join(root, "b", "en", "x.txt"), "")
    const build = new Build()
    build.each({
      name: "page",
      matchersByName: {
        A: new FileMatcher(path.join(root, "a/<a>/<lang>.txt")),
        B: new FileMatcher(path.join(root, "b/<lang>/<b>.txt")),
        P: new FileMatcher(path.join(root, "p/<lang>.txt")),
      },
      required: ["P"],
      async run() {},
    })
    // { a: "en", lang: "x" } and { lang: "en", b: "x" } both give page:en/x.
    await expect(build.run()).rejects.toThrow("task 'page:en/x' is in two groups")
  })

  test("run gets ctx, and a pattern with no vars gives the id <name>", async () => {
    const root = await tempDir()
    await writeText(path.join(root, "book.txt"), "one\ntwo")
    const contexts: Context[] = []
    const build = new Build()
    const produced: string[] = []
    build.subscribe((event) => {
      if (event.kind === "produced") produced.push(path.relative(root, (event.artifact as FileArtifact).path))
    })
    build.each({
      name: "chunk",
      matchersByName: { book: new FileMatcher(path.join(root, "book.txt")) },
      outputsByName: { pages: new FolderTemplate(path.join(root, "pages/")) },
      async run({ matched, outputs, ctx }) {
        contexts.push(ctx)
        const lines = (await Bun.file(matched.book.data.path).text()).split("\n")
        for (let index = 0; index < lines.length; index++) {
          const page = new FileArtifact(path.join(outputs.pages.path, `${index}.txt`))
          await Bun.write(page.path, lines[index]!)
          ctx.produced(page)
        }
      },
    })
    const result = await build.run()
    expect(result.success).toBe(true)
    expect(taskIds(result.executed)).toEqual(["chunk"])
    expect(contexts.length).toBe(1)
    expect(contexts[0]!.signal).toBeInstanceOf(AbortSignal)
    expect(produced).toEqual(["pages/0.txt", "pages/1.txt"])
  })

  test("tasks and run: exactly one of them, and run needs a name", () => {
    const matcher = new FileMatcher("content/<slug>.md")
    const build = new Build()
    expect(() =>
      // @ts-expect-error: tasks and run together.
      build.each({
        name: "page",
        matchersByName: { page: matcher },
        *tasks() {},
        async run() {},
      }),
    ).toThrow("build.each 1 has both tasks and run; give tasks, or name and run")
    expect(() =>
      // @ts-expect-error: neither tasks nor run.
      build.each({ matchersByName: { page: new FileMatcher("content/<slug>.md") } }),
    ).toThrow("build.each 1 has no tasks and no run")
    expect(() =>
      // @ts-expect-error: run with no name.
      build.each({ matchersByName: { page: new FileMatcher("content/<slug>.md") }, async run() {} }),
    ).toThrow("build.each 1: run needs a name, the start of each task id")
    const emptyName = new Build()
    emptyName.each({ name: "", matchersByName: { page: new FileMatcher("content/<slug>.md") }, async run() {} })
  })
})
