// Makes site/<lang>/<slug>.html from each content/<lang>/<slug>.md and the template templates/<lang>.html.
// Then makes one sitemap for each lang, sitemaps/<lang>.txt, from the list of source files in content/<lang>/.
// Run it from any folder. It writes sample files first when content/ is missing.
// Run it two times: the second run skips each task.
import { existsSync } from "node:fs"
import path from "node:path"
import { Build, Task } from "dapat"
import { FileArtifact, FileGroupMatcher, FileMatcher, JsonStore } from "dapat/contrib"

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

// One match for each lang, with the list of its source files. The list comes from content/, not from site/:
// dapat leaves the HTML of a deleted source on disk, so a list of site/ would keep the deleted page.
// The sitemap goes next to site/, not in it.
build.each({
  matchersByName: { source: new FileGroupMatcher("content/<lang>/*.md") },
  *tasks(vars, matched) {
    const sources = matched.source.data
    const sitemap = new FileArtifact(`sitemaps/${vars.lang}.txt`)
    yield new Task({
      id: `sitemap:${vars.lang}`,
      inputs: sources,
      outputs: [sitemap],
      run: async () => {
        const lines: string[] = []
        for (const source of sources) {
          const slug = path.basename(source.path, ".md")
          lines.push(`${slug}.html`)
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
