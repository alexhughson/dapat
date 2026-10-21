// The blog example with output templates and the one-task form of build.each.
import path from "node:path"
import { Build } from "dapat"
import { FileGroupMatcher, FileMatcher, FileTemplate, JsonStore } from "dapat/contrib"

process.chdir(import.meta.dir)
const build = new Build({ store: new JsonStore(".dapat/state.json") })

// One html page for each page file, joined to the template of its lang.
build.each({
  name: "page",
  matchersByName: {
    page: new FileMatcher("content/<lang>/<section>/<slug>.md"),
    template: new FileMatcher("templates/<lang>.html"),
  },
  outputsByName: { html: new FileTemplate("site/<lang>/<section>/<slug>.html") },
  async run({ matched, outputs }) {
    const text = await Bun.file(matched.page.data.path).text()
    const layout = await Bun.file(matched.template.data.path).text()
    await Bun.write(outputs.html.path, layout.replace("{{body}}", text))
  },
})

// One sitemap for each lang. It lists content/<lang>/, not site/<lang>/:
// dapat does not delete the html of a deleted page, so site/ can hold pages that are gone.
build.each({
  name: "sitemap",
  matchersByName: { pages: new FileGroupMatcher("content/<lang>/**/*.md") },
  outputsByName: { sitemap: new FileTemplate("site/<lang>/sitemap.txt") },
  async run({ vars, matched, outputs }) {
    const urls: string[] = []
    for (const file of matched.pages.data) {
      const page = path.relative(`content/${vars.lang}`, file.path).replace(/\.md$/, ".html")
      urls.push(`https://example.com/${vars.lang}/${page}`)
    }
    await Bun.write(outputs.sitemap.path, urls.join("\n") + "\n")
  },
})

const result = await build.run()
console.log("executed:", result.executed.map((task) => task.id))
console.log("skipped:", result.skipped.map((task) => task.id))
for (const [task, error] of result.failed) {
  console.error(`${task.id} failed: ${error.message}`)
}
if (!result.success) process.exit(1)
