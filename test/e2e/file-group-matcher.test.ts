import { afterEach, describe, expect, test } from "bun:test"
import * as fsPromises from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Build, Task, type MatchedArtifactEvent } from "../../src/index"
import { FileArtifact, FileGroupMatcher, FilesystemPrefix } from "../../contrib/fs"
import { JsonStore } from "../../contrib/store"

const temps: string[] = []
const repoFolder = path.resolve(import.meta.dir, "..", "..")

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await fsPromises.rm(dir, { recursive: true, force: true })
  }
})

async function tempDir(): Promise<string> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "dapat-file-group-"))
  temps.push(dir)
  return dir
}

async function writeText(filePath: string, text: string): Promise<void> {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true })
  await fsPromises.writeFile(filePath, text)
}

/** A line for each event of the matcher, such as `found lang=en [a.html blog/b.html]` or `gone lang=en`. */
function recordEvents(matcher: FileGroupMatcher, root: string): string[] {
  const lines: string[] = []
  matcher.subscribe((event: MatchedArtifactEvent<readonly FileArtifact[]>) => {
    if (event.kind === "found") {
      const relativePaths: string[] = []
      for (const file of event.matched.data) {
        relativePaths.push(path.relative(root, file.path))
      }
      lines.push(`found ${varsText(event.matched.vars)} [${relativePaths.join(" ")}]`)
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

describe("FileGroupMatcher pattern", () => {
  test("reads its var names from the parts before the first glob", () => {
    expect(new FileGroupMatcher("site/<lang>/**/*.html").varNames).toEqual(["lang"])
    expect(new FileGroupMatcher("notes/*.md").varNames).toEqual([])
  })

  test("throws for a var in or after the first glob part", () => {
    const message = "a var must come in a part before the first '*' or '**'"
    expect(() => new FileGroupMatcher("site/**/<slug>.html")).toThrow(message)
    expect(() => new FileGroupMatcher("site/*/<slug>.html")).toThrow(message)
    expect(() => new FileGroupMatcher("site/<lang>-*.html")).toThrow(message)
  })

  test("throws for a pattern with no glob, a '**' at the end, and a '**' inside a name", () => {
    expect(() => new FileGroupMatcher("site/<lang>/index.html")).toThrow("use FileMatcher")
    expect(() => new FileGroupMatcher("site/<lang>/**")).toThrow("the last part must name files")
    expect(() => new FileGroupMatcher("site/a**b/*.html")).toThrow("'**' must be a whole part")
    expect(() => new FileGroupMatcher("site/../*.html")).toThrow("a '..' part is not allowed")
  })
})

describe("FileGroupMatcher scan", () => {
  test("sends one list for each lang, sorted by path, after the whole scan", async () => {
    const root = await tempDir()
    await writeText(path.join(root, "site", "en", "blog", "deep", "c.html"), "")
    await writeText(path.join(root, "site", "en", "blog", "b.html"), "")
    await writeText(path.join(root, "site", "en", "a.html"), "")
    await writeText(path.join(root, "site", "fr", "index.html"), "")
    // These do not fit: the wrong extension, and a file that is not in a lang folder.
    await writeText(path.join(root, "site", "en", "notes.txt"), "")
    await writeText(path.join(root, "site", "de", "readme.txt"), "")
    await writeText(path.join(root, "site", "top.html"), "")
    const matcher = new FileGroupMatcher(path.join(root, "site/<lang>/**/*.html"))
    const events = recordEvents(matcher, root)
    await matcher.scan(new AbortController().signal)
    expect(events).toEqual([
      "found lang=en [site/en/a.html site/en/blog/b.html site/en/blog/deep/c.html]",
      "found lang=fr [site/fr/index.html]",
    ])
  })

  test("'*' takes one name in one folder, and a pattern with no var has one list", async () => {
    const root = await tempDir()
    await writeText(path.join(root, "notes", "a", "x.md"), "")
    await writeText(path.join(root, "notes", "b", "y.md"), "")
    await writeText(path.join(root, "notes", "a", "deep", "z.md"), "")
    await writeText(path.join(root, "notes", "top.md"), "")
    const matcher = new FileGroupMatcher(path.join(root, "notes/*/*.md"))
    const events = recordEvents(matcher, root)
    await matcher.scan(new AbortController().signal)
    expect(events).toEqual(["found  [notes/a/x.md notes/b/y.md]"])
  })

  test("a missing folder sends nothing, and a link loop under '**' adds each file one time", async () => {
    const root = await tempDir()
    await writeText(path.join(root, "site", "en", "a.html"), "")
    await fsPromises.symlink(path.join(root, "site", "en"), path.join(root, "site", "en", "loop"))
    const matcher = new FileGroupMatcher(path.join(root, "site/<lang>/**/*.html"))
    const events = recordEvents(matcher, root)
    await matcher.scan(new AbortController().signal)
    expect(events).toEqual(["found lang=en [site/en/a.html]"])
    const missing = new FileGroupMatcher(path.join(root, "nothing/<lang>/**/*.html"))
    const missingEvents = recordEvents(missing, root)
    await missing.scan(new AbortController().signal)
    expect(missingEvents).toEqual([])
  })
})

describe("FileGroupMatcher artifact events", () => {
  test("a file that gets or loses its match sends the new list, and an empty list sends gone", async () => {
    const root = await tempDir()
    await writeText(path.join(root, "site", "en", "old.html"), "")
    const matcher = new FileGroupMatcher(path.join(root, "site/<lang>/**/*.html"))
    const events = recordEvents(matcher, root)
    await matcher.scan(new AbortController().signal)
    const old = new FileArtifact(path.join(root, "site", "en", "old.html"))
    const fresh = new FileArtifact(path.join(root, "site", "en", "blog", "new.html"))
    const french = new FileArtifact(path.join(root, "site", "fr", "index.html"))
    const text = new FileArtifact(path.join(root, "site", "en", "notes.txt"))

    matcher.receiveArtifactEvent({ kind: "promised", output: text, taskId: "write" })
    matcher.receiveArtifactEvent({ kind: "promised", output: fresh, taskId: "write" })
    // The file has a match already, so its produced event sends nothing.
    matcher.receiveArtifactEvent({ kind: "produced", artifact: fresh, taskId: "write" })
    matcher.receiveArtifactEvent({ kind: "promised", output: french, taskId: "write" })
    matcher.receiveArtifactEvent({ kind: "deleted", artifact: old, taskId: "clean" })
    // fresh.html is on disk, so the match stays when the task leaves the build.
    matcher.receiveArtifactEvent({ kind: "withdrawn", output: fresh, taskId: "write" })
    matcher.receiveArtifactEvent({ kind: "deleted", artifact: fresh, taskId: "clean" })

    expect(events).toEqual([
      "found lang=en [site/en/old.html]",
      "found lang=en [site/en/blog/new.html site/en/old.html]",
      "found lang=fr [site/fr/index.html]",
      "found lang=en [site/en/blog/new.html]",
      "gone lang=en",
    ])
    // The maps are private. Bracket access reads them here only to show that an empty group keeps no record.
    expect(matcher["groupsByKey"].size).toBe(1)
    expect(matcher["fileStates"]["knownFiles"].size).toBe(1)
  })
})

describe("FileGroupMatcher in a build", () => {
  /** Adds the sitemap rule: one sitemap for each lang, from the list of its HTML files. */
  function addSitemapRule(build: Build, root: string, sitemapRuns: string[]): void {
    build.each({
      matchersByName: { html: new FileGroupMatcher(path.join(root, "site/<lang>/**/*.html")) },
      *tasks(vars, matched) {
        const pages = matched.html.data
        const siteFolder = new FilesystemPrefix(path.join(root, "site", vars.lang!))
        const sitemap = new FileArtifact(path.join(root, "sitemaps", `${vars.lang}.txt`))
        const inputs = [...pages, siteFolder]
        yield new Task({
          id: `sitemap:${vars.lang}`,
          inputs,
          outputs: [sitemap],
          run: async () => {
            sitemapRuns.push(vars.lang!)
            const lines: string[] = []
            for (const page of pages) {
              lines.push(path.relative(siteFolder.path, page.path))
            }
            await Bun.write(sitemap.path, `${lines.join("\n")}\n`)
          },
        })
      },
    })
  }

  async function readSitemap(root: string, lang: string): Promise<string> {
    return Bun.file(path.join(root, "sitemaps", `${lang}.txt`)).text()
  }

  test("the scan gives one sitemap for each lang, the second build skips, and a deleted file changes the list", async () => {
    const root = await tempDir()
    await writeText(path.join(root, "site", "en", "a.html"), "")
    await writeText(path.join(root, "site", "en", "blog", "b.html"), "")
    await writeText(path.join(root, "site", "fr", "index.html"), "")
    const store = new JsonStore(path.join(root, "state.json"))
    const sitemapRuns: string[] = []

    async function buildOnce() {
      const build = new Build({ store })
      addSitemapRule(build, root, sitemapRuns)
      return build.run()
    }

    const first = await buildOnce()
    expect(first.success).toBe(true)
    expect(taskIds(first.executed)).toEqual(["sitemap:en", "sitemap:fr"])
    expect(await readSitemap(root, "en")).toBe("a.html\nblog/b.html\n")
    expect(await readSitemap(root, "fr")).toBe("index.html\n")

    const second = await buildOnce()
    expect(second.executed).toEqual([])
    expect(taskIds(second.skipped)).toEqual(["sitemap:en", "sitemap:fr"])

    // You delete a page between two builds. The next scan does not find it.
    await fsPromises.rm(path.join(root, "site", "en", "blog", "b.html"))
    const third = await buildOnce()
    expect(taskIds(third.executed)).toEqual(["sitemap:en"])
    expect(taskIds(third.skipped)).toEqual(["sitemap:fr"])
    expect(await readSitemap(root, "en")).toBe("a.html\n")
    // The two tasks of the first build run at the same time, in either order.
    expect(sitemapRuns.length).toBe(3)
    expect(sitemapRuns[2]).toBe("en")
  })

  test("a task that writes a new HTML file adds it to the list, and the build replaces the sitemap task", async () => {
    const root = await tempDir()
    await writeText(path.join(root, "site", "en", "a.html"), "")
    const build = new Build()
    // The task does not know its file names before it runs, so its output is a folder.
    build.add(
      new Task({
        id: "blog",
        outputs: [new FilesystemPrefix(path.join(root, "site", "en", "blog"))],
        run: async (ctx) => {
          const post = new FileArtifact(path.join(root, "site", "en", "blog", "new.html"))
          await writeText(post.path, "")
          ctx.produced(post)
        },
      }),
    )
    const sitemapRuns: string[] = []
    addSitemapRule(build, root, sitemapRuns)
    const result = await build.run()
    expect(result.success).toBe(true)
    expect(taskIds(result.executed)).toEqual(["blog", "sitemap:en"])
    // The first sitemap task waited for "blog", because its folder input covers the output of "blog".
    // The new list replaced it before it ran.
    expect(taskIds(result.cancelled)).toEqual(["sitemap:en"])
    expect(sitemapRuns).toEqual(["en"])
    expect(await readSitemap(root, "en")).toBe("a.html\nblog/new.html\n")
  })

  test("a list that becomes empty sends gone, and the build removes its sitemap task", async () => {
    const root = await tempDir()
    await writeText(path.join(root, "site", "en", "old.html"), "")
    await writeText(path.join(root, "site", "fr", "index.html"), "")
    const build = new Build()
    // A test task that deletes the one English page, and reports it with ctx.deleted.
    build.add(
      new Task({
        id: "clean",
        outputs: [new FilesystemPrefix(path.join(root, "site", "en"))],
        run: async (ctx) => {
          const old = new FileArtifact(path.join(root, "site", "en", "old.html"))
          await fsPromises.rm(old.path)
          ctx.deleted(old)
        },
      }),
    )
    const sitemapRuns: string[] = []
    addSitemapRule(build, root, sitemapRuns)
    const result = await build.run()
    expect(result.success).toBe(true)
    expect(taskIds(result.executed)).toEqual(["clean", "sitemap:fr"])
    expect(taskIds(result.cancelled)).toEqual(["sitemap:en"])
    expect(sitemapRuns).toEqual(["fr"])
  })

  test("a reader waits when one report replaces the group task and the next report removes it", async () => {
    const root = await tempDir()
    await writeText(path.join(root, "seed.txt"), "new")
    await writeText(path.join(root, "gen", "a.txt"), "old")
    await writeText(path.join(root, "gen", "b.txt"), "old")
    // The output of an earlier build.
    await writeText(path.join(root, "out", "all.txt"), "old|old")
    const fileA = new FileArtifact(path.join(root, "gen", "a.txt"))
    const fileB = new FileArtifact(path.join(root, "gen", "b.txt"))
    const all = new FileArtifact(path.join(root, "out", "all.txt"))
    const final = new FileArtifact(path.join(root, "final.txt"))
    const build = new Build()
    build.add(
      new Task({
        id: "rewrite",
        inputs: [new FileArtifact(path.join(root, "seed.txt"))],
        outputs: [new FilesystemPrefix(path.join(root, "gen"))],
        run: async (ctx) => {
          const text = await Bun.file(path.join(root, "seed.txt")).text()
          // "read" waits for "join" first.
          await new Promise<void>((resolve) => setTimeout(resolve, 5))
          await fsPromises.rm(fileB.path)
          await fsPromises.rm(fileA.path)
          // In one synchronous step: the group is now [a.txt], so the build replaces "join".
          // Then the group is empty, so the build removes the new "join".
          ctx.deleted(fileB)
          ctx.deleted(fileA)
          await new Promise<void>((resolve) => setTimeout(resolve, 10))
          // The group is [a.txt] again: the build adds "join" again.
          await writeText(fileA.path, text)
          ctx.produced(fileA)
        },
      }),
    )
    build.each({
      matchersByName: { files: new FileGroupMatcher(path.join(root, "gen/*.txt")) },
      *tasks(_vars, matched) {
        const files = matched.files.data
        yield new Task({
          id: "join",
          inputs: [...files],
          outputs: [all],
          run: async () => {
            const texts: string[] = []
            for (const file of files) {
              texts.push(await Bun.file(file.path).text())
            }
            await writeText(all.path, texts.join("|"))
          },
        })
      },
    })
    build.add(
      new Task({
        id: "read",
        inputs: [all],
        outputs: [final],
        run: async () => {
          const text = await Bun.file(all.path).text()
          await writeText(final.path, text)
        },
      }),
    )
    const result = await build.run()
    expect(result.success).toBe(true)
    expect(await Bun.file(all.path).text()).toBe("new")
    expect(await Bun.file(final.path).text()).toBe("new")
  })
})

describe("examples", () => {
  async function runExample(name: string, folder: string): Promise<string> {
    const child = Bun.spawn(["bun", "run", path.join(repoFolder, "examples", name)], { cwd: folder, stdout: "pipe", stderr: "pipe" })
    const output = await new Response(child.stdout).text()
    const errors = await new Response(child.stderr).text()
    const exitCode = await child.exited
    expect(errors).toBe("")
    expect(exitCode).toBe(0)
    return output
  }

  test("book-chapters: each summary task appears while its split task runs, and the second run skips", async () => {
    const folder = await tempDir()
    const first = await runExample("book-chapters.ts", folder)
    const lines = first.split("\n")
    const wroteSecond = lines.indexOf("split:sea wrote chapter 2")
    expect(wroteSecond).toBeGreaterThan(0)
    expect(lines[wroteSecond - 1]).toBe("new task summary:sea/1")
    expect(lines[wroteSecond + 1]).toBe("new task summary:sea/2")
    expect(await Bun.file(path.join(folder, "summaries", "sea", "2.txt")).text()).toBe("The storm: 7 words\n")
    const second = await runExample("book-chapters.ts", folder)
    expect(second).toContain("executed: []")
  })

  test("file-pipeline: one sitemap for each lang, and the second run skips", async () => {
    const folder = await tempDir()
    await runExample("file-pipeline.ts", folder)
    expect(await Bun.file(path.join(folder, "sitemaps", "en.txt")).text()).toBe("about.html\nhello.html\n")
    const second = await runExample("file-pipeline.ts", folder)
    expect(second).toContain("executed: []")
  })
})

describe("FileGroupMatcher syntax option", () => {
  test("the default syntax is unchanged", () => {
    expect(new FileGroupMatcher("site/<lang>/**/*.html", { syntax: {} }).varNames).toEqual(["lang"])
    expect(() => new FileGroupMatcher("site/<lang>/index.html", { syntax: {} })).toThrow(
      "has no '*' or '**'; use FileMatcher",
    )
  })

  test("custom glob characters find the files under a root folder whose real name holds '<x>' and '*'", async () => {
    const root = await tempDir()
    const strangeFolder = path.join(root, "a<x>*b")
    await writeText(path.join(strangeFolder, "en", "a.html"), "")
    await writeText(path.join(strangeFolder, "en", "blog", "b.html"), "")
    await writeText(path.join(strangeFolder, "fr", "index.html"), "")
    await writeText(path.join(strangeFolder, "fr", "notes.txt"), "")
    const syntax = { varStart: "{", varEnd: "}", anyName: "%", anyFolders: "...." }
    const matcher = new FileGroupMatcher(path.join(strangeFolder, "{lang}/..../%.html"), { syntax })
    expect(matcher.varNames).toEqual(["lang"])
    const events = recordEvents(matcher, root)
    await matcher.scan(new AbortController().signal)
    expect(events).toEqual([
      "found lang=en [a<x>*b/en/a.html a<x>*b/en/blog/b.html]",
      "found lang=fr [a<x>*b/fr/index.html]",
    ])
  })

  test("with a custom anyName, '*' and '**' are literal names", async () => {
    const root = await tempDir()
    await writeText(path.join(root, "**", "*.md"), "")
    await writeText(path.join(root, "**", "other.md"), "")
    const syntax = { anyName: "?", anyFolders: "??" }
    const literalMatcher = new FileGroupMatcher(path.join(root, "**/?.md"), { syntax })
    const literalEvents = recordEvents(literalMatcher, root)
    await literalMatcher.scan(new AbortController().signal)
    expect(literalEvents).toEqual(["found  [**/*.md **/other.md]"])
    const starMatcher = new FileGroupMatcher(path.join(root, "??/*.md"), { syntax })
    const starEvents = recordEvents(starMatcher, root)
    await starMatcher.scan(new AbortController().signal)
    expect(starEvents).toEqual(["found  [**/*.md]"])
  })

  test("an anyFolders that does not hold anyName must still be a whole part", () => {
    const syntax = { anyName: "%", anyFolders: "@@" }
    expect(new FileGroupMatcher("site/<lang>/@@/%.html", { syntax }).varNames).toEqual(["lang"])
    expect(() => new FileGroupMatcher("site/a@@b/%.html", { syntax })).toThrow("'@@' must be a whole part, as in 'a/@@/b'")
    expect(() => new FileGroupMatcher("site/<lang>/@@", { syntax })).toThrow("not '@@'; use '@@/%' for every file")
  })

  test("a var marker that the anyName glob takes first is stray, and the pattern throws", () => {
    const syntax = { anyName: "%a", anyFolders: "%a%a", varStart: "a{", varEnd: "}" }
    expect(new FileGroupMatcher("/d/a{q}/%a.md", { syntax }).varNames).toEqual(["q"])
    // '%a' starts before 'a{', so the part is the glob '%a' and the literal '{x}.md'. The '}' is stray.
    expect(() => new FileGroupMatcher("/d/a{q}/%a{x}.md", { syntax })).toThrow("each 'a{' and '}' must enclose a var name")
  })

  test("with a change to anyFolders alone, a '**' part is two '*' globs in one folder name", async () => {
    const root = await tempDir()
    await writeText(path.join(root, "site", "en", "blog", "x.md"), "")
    await writeText(path.join(root, "site", "en", "x.md"), "")
    await writeText(path.join(root, "site", "en", "a", "b", "x.md"), "")
    const syntax = { anyFolders: "%%" }
    const matcher = new FileGroupMatcher(path.join(root, "site/<lang>/**/x.md"), { syntax })
    const events = recordEvents(matcher, root)
    await matcher.scan(new AbortController().signal)
    expect(events).toEqual(["found lang=en [site/en/blog/x.md]"])
  })

  test("the errors name the custom glob characters", () => {
    const syntax = { anyName: "%", anyFolders: "%%" }
    expect(() => new FileGroupMatcher("site/*.html", { syntax })).toThrow("has no '%' or '%%'; use FileMatcher")
    expect(() => new FileGroupMatcher("site/%/<slug>.html", { syntax })).toThrow(
      "a var must come in a part before the first '%' or '%%'",
    )
  })

  test("throws for a syntax that has no single parse", () => {
    expect(() => new FileGroupMatcher("a/*.md", { syntax: { anyFolders: "" } })).toThrow("FileGroupMatcher syntax: anyFolders is empty")
    expect(() => new FileGroupMatcher("a/*.md", { syntax: { anyName: "**" } })).toThrow("anyName and anyFolders are both '**'")
    expect(() => new FileGroupMatcher("a/*.md", { syntax: { anyName: "x/" } })).toThrow("anyName 'x/' holds '/'")
  })
})
