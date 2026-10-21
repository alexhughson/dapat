import { afterEach, describe, expect, test } from "bun:test"
import * as fsPromises from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Build, Task, TaskGroup, type MatchedArtifactEvent } from "../../src/index"
import { FileArtifact, FileMatcher } from "../../contrib/fs"
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
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "dapat-file-matcher-"))
  temps.push(dir)
  return dir
}

async function writeText(filePath: string, text: string): Promise<void> {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true })
  await fsPromises.writeFile(filePath, text)
}

/** A line for each event of the matcher, such as `found lang=en <path>` or `gone lang=en`. */
function recordEvents(matcher: FileMatcher, root: string): string[] {
  const lines: string[] = []
  matcher.subscribe((event: MatchedArtifactEvent<FileArtifact>) => {
    if (event.kind === "found") {
      const relativePath = path.relative(root, event.matched.data.path)
      lines.push(`found ${varsText(event.matched.vars)} ${relativePath}`)
      return
    }
    lines.push(`gone ${varsText(event.vars)}`)
  })
  return lines
}

function varsText(vars: Readonly<Record<string, string>>): string {
  const parts: string[] = []
  for (const [name, value] of Object.entries(vars)) {
    parts.push(`${name}=${value}`)
  }
  return parts.join(" ")
}

function taskIds(tasks: readonly Task[]): string[] {
  const ids: string[] = []
  for (const task of tasks) {
    ids.push(task.id)
  }
  ids.sort()
  return ids
}

describe("FileMatcher pattern", () => {
  test("reads its var names from the pattern", () => {
    expect(new FileMatcher("templates/<lang>.html").varNames).toEqual(["lang"])
    expect(new FileMatcher("content/<lang>/<section>/<slug>.md").varNames).toEqual(["lang", "section", "slug"])
    expect(new FileMatcher("site/index.html").varNames).toEqual([])
  })

  test("throws for a pattern with * or **", () => {
    expect(() => new FileMatcher("content/*.md")).toThrow("'*' and '**' are not allowed")
    expect(() => new FileMatcher("content/**/<slug>.md")).toThrow("'*' and '**' are not allowed")
    expect(() => new FileMatcher("content/<lang>/*")).toThrow("'*' and '**' are not allowed")
  })

  test("throws for two vars with nothing between them, and for an empty pattern", () => {
    expect(() => new FileMatcher("content/<a><b>.md")).toThrow("have nothing between them")
    expect(() => new FileMatcher("")).toThrow("the pattern is empty")
    expect(() => new FileMatcher(".")).toThrow("names no file")
  })

  test("throws for a '<' or '>' that does not enclose a valid var name", () => {
    const message = "must enclose a var name"
    expect(() => new FileMatcher("content/<lang-x>.md")).toThrow(message)
    expect(() => new FileMatcher("content/<1>.md")).toThrow(message)
    expect(() => new FileMatcher("content/<>.md")).toThrow(message)
    expect(() => new FileMatcher("content/a>b.md")).toThrow(message)
    expect(() => new FileMatcher("content/<slug.md")).toThrow(message)
  })

  test("throws for a '..' part, also one that removes a var", () => {
    const message = "a '..' part is not allowed"
    expect(() => new FileMatcher("a/<x>/../b.md")).toThrow(message)
    expect(() => new FileMatcher("../shared/<slug>.md")).toThrow(message)
    expect(() => new FileMatcher("/abs/../<slug>.md")).toThrow(message)
  })

  test("an absolute pattern has the root '/'", async () => {
    const root = await tempDir()
    await writeText(path.join(root, "posts", "a.md"), "")
    const matcher = new FileMatcher(`${root}/./posts/<slug>.md`)
    expect(matcher.root).toBe("/")
    expect(matcher.pattern).toBe(`${root}/posts/<slug>.md`)
    const events = recordEvents(matcher, root)
    await matcher.scan(new AbortController().signal)
    expect(events).toEqual(["found slug=a posts/a.md"])
  })

  test("a var never takes '..': a file outside the root of a relative pattern does not fit", async () => {
    const parent = await tempDir()
    const project = path.join(parent, "project")
    await writeText(path.join(parent, "notes.txt"), "")
    await writeText(path.join(project, "docs", "intro.txt"), "")
    process.chdir(project)
    const matcher = new FileMatcher("<dir>/<name>.txt")
    process.chdir(startFolder)
    const events = recordEvents(matcher, project)
    await matcher.scan(new AbortController().signal)
    const outside = new FileArtifact(path.join(parent, "notes.txt"))
    const twoUp = new FileArtifact(path.join(parent, "..", "x.txt"))
    matcher.receiveArtifactEvent({ kind: "promised", output: outside, taskId: "write" })
    matcher.receiveArtifactEvent({ kind: "produced", artifact: twoUp, taskId: "write" })
    expect(events).toEqual(["found dir=docs name=intro docs/intro.txt"])
  })

  test("a relative pattern resolves against the working directory when you create the matcher", async () => {
    const root = await tempDir()
    await writeText(path.join(root, "templates", "en.html"), "en")
    process.chdir(root)
    const matcher = new FileMatcher("./templates/<lang>.html")
    process.chdir(startFolder)
    const realRoot = await fsPromises.realpath(root)
    expect(await fsPromises.realpath(matcher.root)).toBe(realRoot)
    expect(matcher.pattern).toBe("templates/<lang>.html")
    const events = recordEvents(matcher, matcher.root)
    await matcher.scan(new AbortController().signal)
    expect(events).toEqual(["found lang=en templates/en.html"])
  })
})

describe("FileMatcher scan", () => {
  test("finds each file that fits the pattern, in name order", async () => {
    const root = await tempDir()
    await writeText(path.join(root, "content", "fr", "blog", "hello.md"), "")
    await writeText(path.join(root, "content", "en", "blog", "hello.md"), "")
    await writeText(path.join(root, "content", "en", "docs", "start.md"), "")
    // These do not fit: the wrong extension, the wrong depth, and a folder with the name of a file.
    await writeText(path.join(root, "content", "en", "blog", "notes.txt"), "")
    await writeText(path.join(root, "content", "en", "top.md"), "")
    await writeText(path.join(root, "content", "en", "deep", "a", "b.md"), "")
    await fsPromises.mkdir(path.join(root, "content", "en", "docs", "folder.md"), { recursive: true })

    const matcher = new FileMatcher(path.join(root, "content/<lang>/<section>/<slug>.md"))
    const events = recordEvents(matcher, root)
    await matcher.scan(new AbortController().signal)
    expect(events).toEqual([
      "found lang=en section=blog slug=hello content/en/blog/hello.md",
      "found lang=en section=docs slug=start content/en/docs/start.md",
      "found lang=fr section=blog slug=hello content/fr/blog/hello.md",
    ])
  })

  test("a missing folder has no files", async () => {
    const root = await tempDir()
    const matcher = new FileMatcher(path.join(root, "nothing/<slug>.md"))
    const events = recordEvents(matcher, root)
    await matcher.scan(new AbortController().signal)
    expect(events).toEqual([])
  })

  test("a pattern with no var finds its one file", async () => {
    const root = await tempDir()
    await writeText(path.join(root, "site", "index.html"), "")
    const matcher = new FileMatcher(path.join(root, "site/index.html"))
    const events = recordEvents(matcher, root)
    await matcher.scan(new AbortController().signal)
    expect(events).toEqual(["found  site/index.html"])
  })

  test("a symlink to a file counts as that file, and a broken symlink adds nothing", async () => {
    const root = await tempDir()
    await writeText(path.join(root, "real.md"), "")
    await fsPromises.mkdir(path.join(root, "posts"))
    await fsPromises.symlink(path.join(root, "real.md"), path.join(root, "posts", "linked.md"))
    await fsPromises.symlink(path.join(root, "missing.md"), path.join(root, "posts", "broken.md"))
    const matcher = new FileMatcher(path.join(root, "posts/<slug>.md"))
    const events = recordEvents(matcher, root)
    await matcher.scan(new AbortController().signal)
    expect(events).toEqual(["found slug=linked posts/linked.md"])
  })

  test("a link loop adds nothing, also at a part with no var", async () => {
    const root = await tempDir()
    await writeText(path.join(root, "y", "sub", "ok.txt"), "")
    await fsPromises.mkdir(path.join(root, "x"))
    await fsPromises.symlink(path.join(root, "x", "sub"), path.join(root, "x", "sub"))
    await fsPromises.symlink(path.join(root, "selfloop"), path.join(root, "selfloop"))
    const afterVar = new FileMatcher(path.join(root, "<d>/sub/<f>.txt"))
    const afterVarEvents = recordEvents(afterVar, root)
    await afterVar.scan(new AbortController().signal)
    expect(afterVarEvents).toEqual(["found d=y f=ok y/sub/ok.txt"])
    const beforeVar = new FileMatcher(path.join(root, "selfloop/<f>.txt"))
    const beforeVarEvents = recordEvents(beforeVar, root)
    await beforeVar.scan(new AbortController().signal)
    expect(beforeVarEvents).toEqual([])
  })
})

describe("FileMatcher artifact events", () => {
  test("a match lasts while the file is on disk or a task declares it", async () => {
    const root = await tempDir()
    await writeText(path.join(root, "posts", "old.md"), "")
    const matcher = new FileMatcher(path.join(root, "posts/<slug>.md"))
    const events = recordEvents(matcher, root)
    await matcher.scan(new AbortController().signal)
    const fresh = new FileArtifact(path.join(root, "posts", "new.md"))
    const old = new FileArtifact(path.join(root, "posts", "old.md"))
    const other = new FileArtifact(path.join(root, "notes", "new.md"))

    matcher.receiveArtifactEvent({ kind: "promised", output: other, taskId: "write" })
    matcher.receiveArtifactEvent({ kind: "promised", output: fresh, taskId: "write" })
    // The second report of the same file sends nothing.
    matcher.receiveArtifactEvent({ kind: "produced", artifact: fresh, taskId: "write" })
    // The file is on disk, so the match stays when the task leaves the build.
    matcher.receiveArtifactEvent({ kind: "withdrawn", output: fresh, taskId: "write" })
    matcher.receiveArtifactEvent({ kind: "deleted", artifact: fresh, taskId: "clean" })
    // The scan found old.md. A task that declares it and then leaves does not remove it.
    matcher.receiveArtifactEvent({ kind: "promised", output: old, taskId: "rewrite" })
    matcher.receiveArtifactEvent({ kind: "withdrawn", output: old, taskId: "rewrite" })

    expect(events).toEqual([
      "found slug=old posts/old.md",
      "found slug=new posts/new.md",
      "gone slug=new",
    ])
  })

  test("a file with no match keeps no record", async () => {
    const root = await tempDir()
    const matcher = new FileMatcher(path.join(root, "posts/<slug>.md"))
    const events = recordEvents(matcher, root)
    await matcher.scan(new AbortController().signal)
    for (let index = 0; index < 1000; index++) {
      const post = new FileArtifact(path.join(root, "posts", `p${index}.md`))
      matcher.receiveArtifactEvent({ kind: "deleted", artifact: post, taskId: "clean" })
      matcher.receiveArtifactEvent({ kind: "withdrawn", output: post, taskId: "write" })
    }
    const kept = new FileArtifact(path.join(root, "posts", "kept.md"))
    matcher.receiveArtifactEvent({ kind: "promised", output: kept, taskId: "write" })
    expect(events).toEqual(["found slug=kept posts/kept.md"])
    // The record map is private. Bracket access reads it here only to show that it does not grow.
    expect(matcher["fileStates"]["knownFiles"].size).toBe(1)
    matcher.receiveArtifactEvent({ kind: "withdrawn", output: kept, taskId: "write" })
    expect(matcher["fileStates"]["knownFiles"].size).toBe(0)
  })

  test("an output that moves from one task to another gives gone and then found", async () => {
    const root = await tempDir()
    const matcher = new FileMatcher(path.join(root, "posts/<slug>.md"))
    const events = recordEvents(matcher, root)
    await matcher.scan(new AbortController().signal)
    const post = new FileArtifact(path.join(root, "posts", "a.md"))
    matcher.receiveArtifactEvent({ kind: "promised", output: post, taskId: "first" })
    // The build sends every withdrawn event of a change before its promised events.
    matcher.receiveArtifactEvent({ kind: "withdrawn", output: post, taskId: "first" })
    matcher.receiveArtifactEvent({ kind: "promised", output: post, taskId: "second" })
    expect(events).toEqual(["found slug=a posts/a.md", "gone slug=a", "found slug=a posts/a.md"])
  })

  test("a file that only a task declares is gone when the task withdraws it", async () => {
    const root = await tempDir()
    const matcher = new FileMatcher(path.join(root, "posts/<slug>.md"))
    const events = recordEvents(matcher, root)
    await matcher.scan(new AbortController().signal)
    const post = new FileArtifact(path.join(root, "posts", "a.md"))

    matcher.receiveArtifactEvent({ kind: "promised", output: post, taskId: "write" })
    matcher.receiveArtifactEvent({ kind: "withdrawn", output: post, taskId: "write" })
    // A task that deletes a file that a task still declares keeps the match: the task will write it.
    matcher.receiveArtifactEvent({ kind: "promised", output: post, taskId: "write" })
    matcher.receiveArtifactEvent({ kind: "deleted", artifact: post, taskId: "write" })

    expect(events).toEqual(["found slug=a posts/a.md", "gone slug=a", "found slug=a posts/a.md"])
  })
})

describe("FileMatcher in a build", () => {
  test("vars with different names do not join: each page gets each banner of its lang", async () => {
    const root = await tempDir()
    await writeText(path.join(root, "content", "en", "hello.md"), "")
    await writeText(path.join(root, "content", "en", "install.md"), "")
    await writeText(path.join(root, "banners", "en", "blue.png"), "")
    await writeText(path.join(root, "banners", "en", "red.png"), "")
    const build = new Build()
    build.each({
      matchersByName: {
        page: new FileMatcher(path.join(root, "content/<lang>/<page>.md")),
        banner: new FileMatcher(path.join(root, "banners/<lang>/<banner>.png")),
      },
      *tasks(vars) {
        const name = `${vars.lang}/${vars.page}/${vars.banner}`
        yield new Task({ id: `card:${name}`, outputs: [new FileArtifact(path.join(root, "cards", `${name}.png`))], run: async () => {} })
      },
    })
    const result = await build.run()
    const executed = taskIds(result.executed)
    expect(executed).toEqual(["card:en/hello/blue", "card:en/hello/red", "card:en/install/blue", "card:en/install/red"])
  })

  test("pages joined to a template, and the second build skips", async () => {
    const root = await tempDir()
    await writeText(path.join(root, "content", "en", "hello.md"), "Hello")
    await writeText(path.join(root, "content", "en", "about.md"), "About")
    await writeText(path.join(root, "content", "de", "hello.md"), "Hallo")
    await writeText(path.join(root, "templates", "en.html"), "<main>{{body}}</main>")
    const store = new JsonStore(path.join(root, "state.json"))

    async function buildOnce() {
      const build = new Build({ store })
      build.each({
        matchersByName: {
          page: new FileMatcher(path.join(root, "content/<lang>/<slug>.md")),
          template: new FileMatcher(path.join(root, "templates/<lang>.html")),
        },
        *tasks(vars, matched) {
          const page = matched.page.data
          const template = matched.template.data
          const html = new FileArtifact(path.join(root, "site", vars.lang!, `${vars.slug}.html`))
          yield new Task({
            id: `page:${vars.lang}/${vars.slug}`,
            inputs: [page, template],
            outputs: [html],
            run: async () => {
              const text = await Bun.file(page.path).text()
              const layout = await Bun.file(template.path).text()
              await Bun.write(html.path, layout.replace("{{body}}", text))
            },
          })
        },
      })
      return build.run()
    }

    const first = await buildOnce()
    expect(first.success).toBe(true)
    expect(taskIds(first.executed)).toEqual(["page:en/about", "page:en/hello"])
    expect(await Bun.file(path.join(root, "site", "en", "hello.html")).text()).toBe("<main>Hello</main>")

    const second = await buildOnce()
    expect(second.executed).toEqual([])
    expect(taskIds(second.skipped)).toEqual(["page:en/about", "page:en/hello"])
  })

  test("an output that a task declares feeds a second build.each in the same run", async () => {
    const root = await tempDir()
    await writeText(path.join(root, "content", "a.md"), "a")
    await writeText(path.join(root, "content", "b.md"), "b")
    const store = new JsonStore(path.join(root, "state.json"))

    async function buildOnce() {
      const build = new Build({ store })
      build.each({
        matchersByName: { source: new FileMatcher(path.join(root, "content/<slug>.md")) },
        *tasks(vars, matched) {
          const source = matched.source.data
          const upper = new FileArtifact(path.join(root, "upper", `${vars.slug}.txt`))
          yield new Task({
            id: `upper:${vars.slug}`,
            inputs: [source],
            outputs: [upper],
            run: async () => {
              const text = await Bun.file(source.path).text()
              await Bun.write(upper.path, text.toUpperCase())
            },
          })
        },
      })
      build.each({
        matchersByName: { upper: new FileMatcher(path.join(root, "upper/<slug>.txt")) },
        *tasks(vars, matched) {
          const upper = matched.upper.data
          const html = new FileArtifact(path.join(root, "site", `${vars.slug}.html`))
          yield new Task({
            id: `html:${vars.slug}`,
            inputs: [upper],
            outputs: [html],
            run: async () => {
              const text = await Bun.file(upper.path).text()
              await Bun.write(html.path, `<p>${text}</p>`)
            },
          })
        },
      })
      return build.run()
    }

    // The folder upper/ does not exist yet, so only the promised events find its files.
    const first = await buildOnce()
    expect(first.success).toBe(true)
    expect(taskIds(first.executed)).toEqual(["html:a", "html:b", "upper:a", "upper:b"])
    expect(await Bun.file(path.join(root, "site", "b.html")).text()).toBe("<p>B</p>")

    const second = await buildOnce()
    expect(second.executed).toEqual([])
    expect(taskIds(second.skipped)).toEqual(["html:a", "html:b", "upper:a", "upper:b"])

    // A source file that is gone has no task. Its old output is still on disk, so the scan of upper/ finds it.
    await fsPromises.rm(path.join(root, "content", "b.md"))
    const third = await buildOnce()
    expect(third.success).toBe(true)
    expect(taskIds(third.skipped)).toEqual(["html:a", "html:b", "upper:a"])
  })

  test("an output that moves to another task in one step keeps the task of its match", async () => {
    const root = await tempDir()
    await writeText(path.join(root, "seed.txt"), "seed")
    const gate = new FileArtifact(path.join(root, "gate.txt"))
    const draft = new FileArtifact(path.join(root, "drafts", "x.md"))
    const writers = new TaskGroup("writers")
    const build = new MovingBuild()
    function writer(id: string): Task {
      return new Task({
        id,
        inputs: [gate],
        outputs: [draft],
        run: async () => {
          await Bun.write(draft.path, id)
        },
      })
    }
    build.setTasks(writers, [writer("first-writer")])
    // "mover" runs first. In one step, it gives the output of "first-writer" to "second-writer".
    build.add(
      new Task({
        id: "mover",
        inputs: [new FileArtifact(path.join(root, "seed.txt"))],
        outputs: [gate],
        run: async () => {
          await Bun.write(gate.path, "open")
          build.setTasks(writers, [writer("second-writer")])
        },
      }),
    )
    const publishedTexts: string[] = []
    build.each({
      matchersByName: { draft: new FileMatcher(path.join(root, "drafts/<slug>.md")) },
      *tasks(vars, matched) {
        const draftFile = matched.draft.data
        yield new Task({
          id: `publish:${vars.slug}`,
          inputs: [draftFile],
          run: async () => {
            publishedTexts.push(await Bun.file(draftFile.path).text())
          },
        })
      },
    })
    const result = await build.run()
    expect(result.success).toBe(true)
    expect(taskIds(result.executed)).toEqual(["mover", "publish:x", "second-writer"])
    expect(publishedTexts).toEqual(["second-writer"])
    // build.each replaces publish:x in the same step: the old task object ends as cancelled "replaced".
    expect(taskIds(result.cancelled)).toEqual(["first-writer", "publish:x"])
  })

  test("a task that leaves the build during the run removes the tasks of its declared file", async () => {
    const root = await tempDir()
    await writeText(path.join(root, "seed.txt"), "seed")
    const gate = new FileArtifact(path.join(root, "gate.txt"))
    const draft = new FileArtifact(path.join(root, "drafts", "x.md"))
    const build = new Build()
    // "writer" waits for "remover", and "remover" takes it out of the build.
    build.add(
      new Task({
        id: "remover",
        inputs: [new FileArtifact(path.join(root, "seed.txt"))],
        outputs: [gate],
        run: async (ctx) => {
          await Bun.write(gate.path, "open")
          ctx.remove("writer")
        },
      }),
    )
    build.add(
      new Task({
        id: "writer",
        inputs: [gate],
        outputs: [draft],
        run: async () => {
          await Bun.write(draft.path, "draft")
        },
      }),
    )
    let publishRuns = 0
    build.each({
      matchersByName: { draft: new FileMatcher(path.join(root, "drafts/<slug>.md")) },
      *tasks(vars, matched) {
        yield new Task({
          id: `publish:${vars.slug}`,
          inputs: [matched.draft.data],
          run: async () => {
            publishRuns += 1
          },
        })
      },
    })
    const result = await build.run()
    expect(result.success).toBe(true)
    expect(taskIds(result.executed)).toEqual(["remover"])
    expect(taskIds(result.cancelled)).toEqual(["publish:x", "writer"])
    expect(publishRuns).toBe(0)
  })
})

/** A build that sets the tasks of one group in one step, as build.each does. */
class MovingBuild extends Build {
  setTasks(group: TaskGroup, tasks: readonly Task[]): void {
    this.setTasksOfGroups([{ group, tasks }])
  }
}

describe("FileMatcher syntax option", () => {
  test("the default syntax is '<' '>' '*' '**'", () => {
    const matcher = new FileMatcher("content/<lang>/<slug>.md")
    expect(matcher.varNames).toEqual(["lang", "slug"])
    const sameMatcher = new FileMatcher("content/<lang>/<slug>.md", { syntax: {} })
    expect(sameMatcher.varNames).toEqual(["lang", "slug"])
    expect(() => new FileMatcher("content/<lang>/*.md", { syntax: {} })).toThrow("'*' and '**' are not allowed")
  })

  test("finds the files under a root folder whose real name holds '<x>' and '*'", async () => {
    const root = await tempDir()
    const strangeFolder = path.join(root, "a<x>*b")
    await writeText(path.join(strangeFolder, "en", "hello.md"), "")
    await writeText(path.join(strangeFolder, "fr", "salut.md"), "")
    await writeText(path.join(root, "aXb", "en", "other.md"), "")
    const syntax = { varStart: "{", varEnd: "}", anyName: "%", anyFolders: "%%" }
    const matcher = new FileMatcher(path.join(strangeFolder, "{lang}/{slug}.md"), { syntax })
    expect(matcher.varNames).toEqual(["lang", "slug"])
    const events = recordEvents(matcher, root)
    await matcher.scan(new AbortController().signal)
    expect(events).toEqual([
      "found lang=en slug=hello a<x>*b/en/hello.md",
      "found lang=fr slug=salut a<x>*b/fr/salut.md",
    ])
  })

  test("with a custom varStart and varEnd, '<' and '>' are literals in each part", async () => {
    const root = await tempDir()
    await writeText(path.join(root, "<old>", "a<1>.md"), "")
    await writeText(path.join(root, "<old>", "b.md"), "")
    const matcher = new FileMatcher(path.join(root, "<old>/{slug}<1>.md"), { syntax: { varStart: "{", varEnd: "}" } })
    expect(matcher.varNames).toEqual(["slug"])
    const events = recordEvents(matcher, root)
    await matcher.scan(new AbortController().signal)
    expect(events).toEqual(["found slug=a <old>/a<1>.md"])
  })

  test("with a custom anyName, '*' is a literal and the custom glob throws", async () => {
    const root = await tempDir()
    await writeText(path.join(root, "notes*", "a.md"), "")
    const syntax = { anyName: "%", anyFolders: "%%" }
    const matcher = new FileMatcher(path.join(root, "notes*/<slug>.md"), { syntax })
    const events = recordEvents(matcher, root)
    await matcher.scan(new AbortController().signal)
    expect(events).toEqual(["found slug=a notes*/a.md"])
    expect(() => new FileMatcher("notes/%.md", { syntax })).toThrow("'%' and '%%' are not allowed")
    expect(() => new FileMatcher("notes/%%/<slug>.md", { syntax })).toThrow("'%' and '%%' are not allowed")
  })

  test("a stray custom var marker throws, and the message names the custom markers", () => {
    const syntax = { varStart: "{", varEnd: "}" }
    expect(() => new FileMatcher("content/{slug.md", { syntax })).toThrow("each '{' and '}' must enclose a var name")
    expect(() => new FileMatcher("content/{a}{b}.md", { syntax })).toThrow("the vars {a} and {b} have nothing between them")
  })

  test("the parse of KeyPattern decides each var: '{{{x}}{.md' has the var x between two literal '{'", async () => {
    const root = await tempDir()
    await writeText(path.join(root, "{a{.md"), "")
    await writeText(path.join(root, "b.md"), "")
    const syntax = { varStart: "{{", varEnd: "}}" }
    const matcher = new FileMatcher(path.join(root, "{{{x}}{.md"), { syntax })
    expect(matcher.varNames).toEqual(["x"])
    const events = recordEvents(matcher, root)
    await matcher.scan(new AbortController().signal)
    expect(events).toEqual(["found x=a {a{.md"])
  })

  test("the glob message names a var with the custom markers", () => {
    const syntax = { varStart: "a{", varEnd: "}" }
    expect(() => new FileMatcher("content/*.md", { syntax })).toThrow("use a var such as a{name} for each part that changes")
  })

  test("a change to anyFolders alone keeps '*' as the glob, so '**' still throws", () => {
    const syntax = { anyFolders: "%%" }
    expect(() => new FileMatcher("content/**/<slug>.md", { syntax })).toThrow("'*' and '%%' are not allowed")
  })

  test("throws for a syntax that has no single parse", () => {
    expect(() => new FileMatcher("a/<x>.md", { syntax: { varStart: "" } })).toThrow("FileMatcher syntax: varStart is empty")
    expect(() => new FileMatcher("a/<x>.md", { syntax: { anyName: "" } })).toThrow("FileMatcher syntax: anyName is empty")
    expect(() => new FileMatcher("a/{x}.md", { syntax: { varStart: "{", varEnd: "{" } })).toThrow(
      "varStart and varEnd are both '{'",
    )
    expect(() => new FileMatcher("a/<x>.md", { syntax: { varEnd: "/" } })).toThrow("varEnd '/' holds '/'")
    expect(() => new FileMatcher("a/<x>.md", { syntax: { anyFolders: "a/b" } })).toThrow("anyFolders 'a/b' holds '/'")
    expect(() => new FileMatcher("a/<x>.md", { syntax: { anyName: "%", anyFolders: "%" } })).toThrow(
      "anyName and anyFolders are both '%'",
    )
    expect(() => new FileMatcher("a/<x>.md", { syntax: { anyName: "%%", anyFolders: "%" } })).toThrow(
      "anyName '%%' holds anyFolders '%'",
    )
    expect(() => new FileMatcher("a/<x>.md", { syntax: { varStart: "*" } })).toThrow("varStart and anyName are both '*'")
    expect(() => new FileMatcher("a/{{x}.md", { syntax: { varStart: "{{", varEnd: "}", anyName: "{" } })).toThrow(
      "varStart '{{' holds anyName '{'",
    )
    expect(() => new FileMatcher("a/<x>.md", { syntax: { anyFolders: "." } })).toThrow("anyFolders cannot be '.'")
    expect(() => new FileMatcher("a/<x>.md", { syntax: { anyName: ".." } })).toThrow("anyName cannot be '..'")
  })
})
