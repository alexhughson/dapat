// A blog in two languages. Run it two times with `bun run examples/blog/blog.ts`:
// the second run skips each task. Edit a page or a template, and only the tasks that read it run.
import path from "node:path"
import { Build, Task } from "dapat"
import { FileArtifact, FileMatcher, FilesystemPrefix, JsonStore } from "dapat/contrib"

process.chdir(import.meta.dir)
const build = new Build({ store: new JsonStore(".dapat/state.json") })

// One html page for each page file, joined to the template of its lang.
build.each({
  matchersByName: {
    page: new FileMatcher("content/<lang>/<section>/<slug>.md"),
    template: new FileMatcher("templates/<lang>.html"),
  },
  *tasks(vars, matched) {
    const name = `${vars.lang}/${vars.section}/${vars.slug}`
    const html = new FileArtifact(`site/${name}.html`)
    yield new Task({
      id: `page:${name}`,
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

// One sitemap for each lang. It lists content/<lang>/, not site/<lang>/:
// dapat does not delete the html of a deleted page, so site/ can hold pages that are gone.
build.each({
  matchersByName: { template: new FileMatcher("templates/<lang>.html") },
  *tasks(vars) {
    const content = new FilesystemPrefix(`content/${vars.lang}/`)
    const sitemap = new FileArtifact(`site/${vars.lang}/sitemap.txt`)
    yield new Task({
      id: `sitemap:${vars.lang}`,
      inputs: [content],
      outputs: [sitemap],
      run: async () => {
        const urls: string[] = []
        for (const file of await content.list()) {
          const page = path.relative(content.path, file).replace(/\.md$/, ".html")
          urls.push(`https://example.com/${vars.lang}/${page}`)
        }
        urls.sort()
        await Bun.write(sitemap.path, urls.join("\n") + "\n")
      },
    })
  },
})

const result = await build.run()
console.log("executed:", result.executed.map((task) => task.id))
console.log("skipped:", result.skipped.map((task) => task.id))
for (const [task, error] of result.failed) {
  console.error(`${task.id} failed: ${error.message}`)
}
if (!result.success) process.exit(1)
