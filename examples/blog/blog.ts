// A blog site with two languages. dapat makes these files under the folder `root`:
//   site/<lang>/<section>/<slug>.html  from content/<lang>/<section>/<slug>.md and templates/<lang>.html
//   site/<lang>/sitemap.xml            from the list of files under content/<lang>/
// Run it with `bun run examples/blog/blog.ts`. It builds into examples/blog/.
// Run it two times: the second run skips each task.
import path from "node:path"
import { Build, Task } from "dapat"
import { FileArtifact, FileMatcher, FilesystemPrefix, JsonStore } from "dapat/contrib"

const SITE_URL = "https://example.com"

/** A build of the blog in `root`. Its store is `<root>/.dapat/state.json`. */
export function blogBuild(root: string): Build {
  const store = new JsonStore(path.join(root, ".dapat/state.json"))
  const build = new Build({ store })

  // One task for each page and the template of its lang.
  build.each({
    matchersByName: {
      page: new FileMatcher(path.join(root, "content/<lang>/<section>/<slug>.md")),
      template: new FileMatcher(path.join(root, "templates/<lang>.html")),
    },
    *tasks(vars, matched) {
      const page = matched.page.data
      const template = matched.template.data
      const pageName = `${vars.lang}/${vars.section}/${vars.slug}`
      const html = new FileArtifact(path.join(root, "site", `${pageName}.html`))
      yield new Task({
        id: `page:${pageName}`,
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

  // One sitemap for each lang that has a template.
  // The sitemap reads the content folder, not the site folder. dapat does not delete the html
  // of a deleted page, so the site folder can hold pages that the sitemap must not list.
  build.each({
    matchersByName: {
      template: new FileMatcher(path.join(root, "templates/<lang>.html")),
    },
    *tasks(vars) {
      const content = new FilesystemPrefix(path.join(root, "content", vars.lang))
      const sitemap = new FileArtifact(path.join(root, "site", vars.lang, "sitemap.xml"))
      yield new Task({
        id: `sitemap:${vars.lang}`,
        inputs: [content],
        outputs: [sitemap],
        run: async () => {
          const files = await content.list()
          const urls: string[] = []
          for (const file of files) {
            const url = pageUrl(vars.lang, path.relative(content.path, file))
            if (url !== null) {
              urls.push(url)
            }
          }
          urls.sort()
          await Bun.write(sitemap.path, sitemapXml(urls))
        },
      })
    },
  })

  return build
}

/**
 * The url of the page made from `content/<lang>/<relativePath>`, or null when the file
 * does not fit `<section>/<slug>.md`, the part of the page pattern under the lang folder.
 */
function pageUrl(lang: string, relativePath: string): string | null {
  const parts = relativePath.split(path.sep)
  if (parts.length !== 2) {
    return null
  }
  const section = parts[0]!
  const fileName = parts[1]!
  // <slug> takes one or more characters, so ".md" alone is not a page.
  if (!fileName.endsWith(".md") || fileName === ".md") {
    return null
  }
  const slug = fileName.slice(0, -".md".length)
  return `${SITE_URL}/${lang}/${section}/${slug}.html`
}

function sitemapXml(urls: readonly string[]): string {
  const lines: string[] = []
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`)
  lines.push(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`)
  for (const url of urls) {
    lines.push(`  <url><loc>${url}</loc></url>`)
  }
  lines.push(`</urlset>`)
  return lines.join("\n") + "\n"
}

if (import.meta.main) {
  const build = blogBuild(import.meta.dir)
  const result = await build.run()
  const executedIds: string[] = []
  for (const task of result.executed) {
    executedIds.push(task.id)
  }
  const skippedIds: string[] = []
  for (const task of result.skipped) {
    skippedIds.push(task.id)
  }
  executedIds.sort()
  skippedIds.sort()
  console.log("executed:", executedIds)
  console.log("skipped:", skippedIds)
  if (!result.success) {
    for (const [task, error] of result.failed) {
      console.error(`${task.id}: ${error.message}`)
    }
    for (const error of result.errors) {
      console.error(error.message)
    }
    process.exit(1)
  }
}
