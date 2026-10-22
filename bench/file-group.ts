/**
 * Times FileGroupMatcher. Run it with `bun bench/file-group.ts`.
 *
 * 1. The scan of 10,000 HTML files in 100 folders, with FileGroupMatcher `site/<lang>/**\/*.html`,
 *    against FileMatcher `site/<lang>/<folder>/<name>.html` on the same files.
 * 2. 2,000 HTML files that tasks write in one run, with the sitemap rule:
 *    a. 2,000 tasks that each declare one file. The scan step gets all of them, so one sitemap task is made.
 *    b. One task that writes the 2,000 files into a folder output and reports each one with ctx.produced.
 *       Each report is one step, so the build replaces the sitemap task 2,000 times.
 */
import * as fsPromises from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Build, Task } from "../src/index"
import { FileArtifact, FileGroupMatcher, FileMatcher, FilesystemPrefix } from "../contrib/fs"

const SCAN_FOLDERS = 100
const FILES_IN_FOLDER = 100
const WRITTEN_FILES = 2000

function addSitemapRule(build: Build, root: string): void {
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
          await Bun.write(sitemap.path, `${pages.length}\n`)
        },
      })
    },
  })
}

async function benchScan(): Promise<void> {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "dapat-bench-group-"))
  for (let folder = 0; folder < SCAN_FOLDERS; folder++) {
    const folderPath = path.join(root, "site", "en", `f${folder}`)
    await fsPromises.mkdir(folderPath, { recursive: true })
    for (let file = 0; file < FILES_IN_FOLDER; file++) {
      await fsPromises.writeFile(path.join(folderPath, `p${file}.html`), "")
    }
  }
  const groupMatcher = new FileGroupMatcher(path.join(root, "site/<lang>/**/*.html"))
  let groupFiles = 0
  groupMatcher.subscribe((event) => {
    if (event.kind === "found") groupFiles = event.matched.data.length
  })
  const groupStart = performance.now()
  await groupMatcher.scan(new AbortController().signal)
  const groupTime = performance.now() - groupStart

  const fileMatcher = new FileMatcher(path.join(root, "site/<lang>/<folder>/<name>.html"))
  let fileMatches = 0
  fileMatcher.subscribe(() => {
    fileMatches += 1
  })
  const fileStart = performance.now()
  await fileMatcher.scan(new AbortController().signal)
  const fileTime = performance.now() - fileStart
  console.log(`scan of ${groupFiles} files: FileGroupMatcher ${groupTime.toFixed(0)} ms, FileMatcher (${fileMatches} matches) ${fileTime.toFixed(0)} ms`)
  await fsPromises.rm(root, { recursive: true, force: true })
}

async function benchDeclaredWriters(): Promise<void> {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "dapat-bench-group-"))
  const build = new Build()
  for (let index = 0; index < WRITTEN_FILES; index++) {
    const page = new FileArtifact(path.join(root, "site", "en", `p${index}.html`))
    build.add(
      new Task({
        id: `page:${index}`,
        outputs: [page],
        run: async () => {
          await Bun.write(page.path, "")
        },
      }),
    )
  }
  addSitemapRule(build, root)
  const start = performance.now()
  const result = await build.run()
  const time = performance.now() - start
  console.log(
    `${WRITTEN_FILES} tasks that each declare one file: ${time.toFixed(0)} ms, ${result.executed.length} executed, ${result.cancelled.length} cancelled`,
  )
  await fsPromises.rm(root, { recursive: true, force: true })
}

async function benchReportedFiles(): Promise<void> {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "dapat-bench-group-"))
  const build = new Build()
  build.add(
    new Task({
      id: "write-all",
      outputs: [new FilesystemPrefix(path.join(root, "site", "en"))],
      run: async (ctx) => {
        await fsPromises.mkdir(path.join(root, "site", "en"), { recursive: true })
        for (let index = 0; index < WRITTEN_FILES; index++) {
          const page = new FileArtifact(path.join(root, "site", "en", `p${index}.html`))
          await Bun.write(page.path, "")
          ctx.produced(page)
        }
      },
    }),
  )
  addSitemapRule(build, root)
  const start = performance.now()
  const result = await build.run()
  const time = performance.now() - start
  console.log(
    `one task that reports ${WRITTEN_FILES} files: ${time.toFixed(0)} ms, ${result.executed.length} executed, ${result.cancelled.length} cancelled`,
  )
  await fsPromises.rm(root, { recursive: true, force: true })
}

await benchScan()
await benchDeclaredWriters()
await benchReportedFiles()
