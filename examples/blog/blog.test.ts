import { afterEach, expect, test } from "bun:test"
import * as fsPromises from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Result } from "dapat"
import { blogBuild } from "./blog"

const temps: string[] = []

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await fsPromises.rm(dir, { recursive: true, force: true })
  }
})

/** A temp folder with a copy of the sample `content/` and `templates/` of the example. */
async function copyOfSample(): Promise<string> {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "dapat-blog-"))
  temps.push(root)
  await fsPromises.cp(path.join(import.meta.dir, "content"), path.join(root, "content"), { recursive: true })
  await fsPromises.cp(path.join(import.meta.dir, "templates"), path.join(root, "templates"), { recursive: true })
  return root
}

/** Runs a new build of the blog in `root`, as a new run of the program does. */
async function runBuild(root: string): Promise<{ executed: string[]; skipped: string[] }> {
  const result: Result = await blogBuild(root).run()
  expect(result.failed.size).toBe(0)
  expect(result.errors).toEqual([])
  expect(result.success).toBe(true)
  const executed: string[] = []
  for (const task of result.executed) {
    executed.push(task.id)
  }
  const skipped: string[] = []
  for (const task of result.skipped) {
    skipped.push(task.id)
  }
  executed.sort()
  skipped.sort()
  return { executed, skipped }
}

async function writeText(filePath: string, text: string): Promise<void> {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true })
  await fsPromises.writeFile(filePath, text)
}

async function readText(filePath: string): Promise<string> {
  return fsPromises.readFile(filePath, "utf8")
}

/** The relative path of each file under `root/site`, sorted. */
async function siteFiles(root: string): Promise<string[]> {
  const siteFolder = path.join(root, "site")
  const entries = await fsPromises.readdir(siteFolder, { recursive: true, withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    if (entry.isFile()) {
      files.push(path.relative(siteFolder, path.join(entry.parentPath, entry.name)))
    }
  }
  files.sort()
  return files
}

/** The `<loc>` values of a sitemap file, in file order. */
async function sitemapUrls(filePath: string): Promise<string[]> {
  const text = await readText(filePath)
  const urls: string[] = []
  for (const found of text.matchAll(/<loc>([^<]*)<\/loc>/g)) {
    urls.push(found[1]!)
  }
  return urls
}

const ALL_TASKS = [
  "page:en/blog/hello",
  "page:en/blog/second-post",
  "page:en/docs/install",
  "page:fr/blog/hello",
  "sitemap:en",
  "sitemap:fr",
]

test("the blog builds, skips, and runs only the tasks that each edit affects", async () => {
  const root = await copyOfSample()

  // First build: each page and each sitemap runs.
  const first = await runBuild(root)
  expect(first.executed).toEqual(ALL_TASKS)
  expect(first.skipped).toEqual([])
  expect(await siteFiles(root)).toEqual([
    "en/blog/hello.html",
    "en/blog/second-post.html",
    "en/docs/install.html",
    "en/sitemap.xml",
    "fr/blog/hello.html",
    "fr/sitemap.xml",
  ])
  expect(await readText(path.join(root, "site/fr/blog/hello.html"))).toBe(
    `<html lang="fr"><body>Bonjour, et bienvenue sur le blog.\n</body></html>\n`,
  )
  expect(await sitemapUrls(path.join(root, "site/en/sitemap.xml"))).toEqual([
    "https://example.com/en/blog/hello.html",
    "https://example.com/en/blog/second-post.html",
    "https://example.com/en/docs/install.html",
  ])
  expect(await sitemapUrls(path.join(root, "site/fr/sitemap.xml"))).toEqual(["https://example.com/fr/blog/hello.html"])

  // No change: each task skips.
  const second = await runBuild(root)
  expect(second.executed).toEqual([])
  expect(second.skipped).toEqual(ALL_TASKS)

  // A write of the same bytes changes only the modification time. The hash stamp does not change.
  await writeText(path.join(root, "content/en/blog/hello.md"), "Hello, and welcome to the blog.\n")
  const sameBytes = await runBuild(root)
  expect(sameBytes.executed).toEqual([])

  // An edit of one page runs that page. The en content folder changed, so the en sitemap runs too.
  await writeText(path.join(root, "content/en/blog/hello.md"), "Hello again.\n")
  const pageEdit = await runBuild(root)
  expect(pageEdit.executed).toEqual(["page:en/blog/hello", "sitemap:en"])
  expect(await readText(path.join(root, "site/en/blog/hello.html"))).toBe(
    `<html lang="en"><body>Hello again.\n</body></html>\n`,
  )

  // An edit of the en template runs each en page. No sitemap reads a template file, so both skip.
  await writeText(path.join(root, "templates/en.html"), `<html lang="en"><main>{{body}}</main></html>\n`)
  const templateEdit = await runBuild(root)
  expect(templateEdit.executed).toEqual(["page:en/blog/hello", "page:en/blog/second-post", "page:en/docs/install"])
  expect(await readText(path.join(root, "site/en/docs/install.html"))).toBe(
    `<html lang="en"><main>Run bun install.\n</main></html>\n`,
  )

  // A new fr page adds one task, and the fr sitemap lists the new page.
  await writeText(path.join(root, "content/fr/docs/install.md"), "Lancez bun install.\n")
  const pageAdd = await runBuild(root)
  expect(pageAdd.executed).toEqual(["page:fr/docs/install", "sitemap:fr"])
  expect(await readText(path.join(root, "site/fr/docs/install.html"))).toBe(
    `<html lang="fr"><body>Lancez bun install.\n</body></html>\n`,
  )
  expect(await sitemapUrls(path.join(root, "site/fr/sitemap.xml"))).toEqual([
    "https://example.com/fr/blog/hello.html",
    "https://example.com/fr/docs/install.html",
  ])

  // A deleted en page removes its task. dapat does not delete the old html, but the sitemap drops the page.
  await fsPromises.rm(path.join(root, "content/en/docs/install.md"))
  const pageDelete = await runBuild(root)
  expect(pageDelete.executed).toEqual(["sitemap:en"])
  expect(pageDelete.skipped).not.toContain("page:en/docs/install")
  expect(await Bun.file(path.join(root, "site/en/docs/install.html")).exists()).toBe(true)
  expect(await sitemapUrls(path.join(root, "site/en/sitemap.xml"))).toEqual([
    "https://example.com/en/blog/hello.html",
    "https://example.com/en/blog/second-post.html",
  ])

  // A new template adds a lang. Its sitemap runs and lists no page, because the lang has no content.
  await writeText(path.join(root, "templates/de.html"), `<html lang="de"><body>{{body}}</body></html>\n`)
  const langAdd = await runBuild(root)
  expect(langAdd.executed).toEqual(["sitemap:de"])
  expect(await sitemapUrls(path.join(root, "site/de/sitemap.xml"))).toEqual([])

  // After the edits, each task skips again.
  const last = await runBuild(root)
  expect(last.executed).toEqual([])
})
