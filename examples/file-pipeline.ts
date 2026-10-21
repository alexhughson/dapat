// Makes site/<lang>/<slug>.html from each content/<lang>/<slug>.md and the template templates/<lang>.html.
// Then makes one sitemap for each lang, sitemaps/<lang>.txt, from the list of HTML files under site/<lang>/.
// Run it from any folder. It writes sample files first when content/ is missing.
// Run it two times: the second run skips each task.
import { existsSync } from "node:fs"
import path from "node:path"
import { Build, Task } from "dapat"
import { FileArtifact, FileGroupMatcher, FileMatcher, FilesystemPrefix, JsonStore } from "dapat/contrib"

if (!existsSync("content")) {
  await Bun.write("content/en/hello.md", "Hello")
  await Bun.write("content/en/about.md", "About us")
  await Bun.write("content/fr/hello.md", "Bonjour")
  await Bun.write("templates/en.html", "<html lang=en><body>{{body}}</body></html>")
  await Bun.write("templates/fr.html", "<html lang=fr><body>{{body}}</body></html>")
}

const store = new JsonStore(".dapat/state.json")
const build = new Build({ store })

build.each({
  matchersByName: {
    page: new FileMatcher("content/<lang>/<slug>.md"),
    template: new FileMatcher("templates/<lang>.html"),
  },
  *tasks(vars, matched) {
    const page = matched.page.data
    const template = matched.template.data
    const html = new FileArtifact(`site/${vars.lang}/${vars.slug}.html`)
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

// One match for each lang, with the list of its HTML files, at any depth under site/<lang>/.
// The sitemap goes next to site/, not in it: in site/<lang>/, it would change the stamp of its own input.
build.each({
  matchersByName: { html: new FileGroupMatcher("site/<lang>/**/*.html") },
  *tasks(vars, matched) {
    const pages = matched.html.data
    // The folder input makes the sitemap wait for each task that writes into site/<lang>/.
    const siteFolder = new FilesystemPrefix(`site/${vars.lang}/`)
    const sitemap = new FileArtifact(`sitemaps/${vars.lang}.txt`)
    const inputs = [...pages, siteFolder]
    yield new Task({
      id: `sitemap:${vars.lang}`,
      inputs,
      outputs: [sitemap],
      run: async () => {
        const lines: string[] = []
        for (const page of pages) {
          lines.push(path.relative(siteFolder.path, page.path))
        }
        await Bun.write(sitemap.path, `${lines.join("\n")}\n`)
      },
    })
  },
})

const result = await build.run()
const executedIds: string[] = []
for (const task of result.executed) {
  executedIds.push(task.id)
}
const skippedIds: string[] = []
for (const task of result.skipped) {
  skippedIds.push(task.id)
}
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
