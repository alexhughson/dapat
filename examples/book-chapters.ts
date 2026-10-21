// Splits each books/<book>.md into chapters/<book>/<n>.md, and makes summaries/<book>/<n>.txt from each chapter.
// A chapter starts at a line that starts with "# ". The split task does not know the chapters before it runs,
// so its output is the folder chapters/<book>/, and it reports each chapter with ctx.produced.
// The summary task of a chapter then exists before ctx.produced returns, while the split task still runs.
// Run it from any folder. It writes sample books first when books/ is missing.
// Run it two times: the second run skips each task.
import { existsSync } from "node:fs"
import { Build, Task } from "dapat"
import { FileArtifact, FileMatcher, FilesystemPrefix, JsonStore } from "dapat/contrib"

if (!existsSync("books")) {
  await Bun.write("books/sea.md", "# The ship\nThe ship leaves the port.\n# The storm\nThe wind is strong.\n")
  await Bun.write("books/hill.md", "# The climb\nWe go up the hill.\n")
}

const store = new JsonStore(".dapat/state.json")
const build = new Build({ store })

// Prints a line when a task that declares a file appears. The output shows that each summary task
// appears right after its split task writes the chapter.
build.subscribe((event) => {
  if (event.kind !== "promised") return
  if (!(event.output instanceof FileArtifact)) return
  console.log(`new task ${event.taskId}`)
})

// Rule 3: one split task for each book.
build.each({
  matchersByName: { book: new FileMatcher("books/<book>.md") },
  *tasks(vars, matched) {
    const book = matched.book.data
    const chapterFolder = new FilesystemPrefix(`chapters/${vars.book}/`)
    yield new Task({
      id: `split:${vars.book}`,
      inputs: [book],
      outputs: [chapterFolder],
      run: async (ctx) => {
        const text = await Bun.file(book.path).text()
        const chapters: string[] = []
        for (const line of text.split("\n")) {
          if (line.startsWith("# ")) {
            chapters.push("")
          }
          if (chapters.length === 0) continue
          chapters[chapters.length - 1] += `${line}\n`
        }
        for (let index = 0; index < chapters.length; index++) {
          const chapter = new FileArtifact(`chapters/${vars.book}/${index + 1}.md`)
          await Bun.write(chapter.path, chapters[index]!)
          console.log(`split:${vars.book} wrote chapter ${index + 1}`)
          ctx.produced(chapter)
        }
      },
    })
  },
})

// Rule 4: one summary task for each chapter. The chapters of the split tasks feed this rule in the same run.
build.each({
  matchersByName: { chapter: new FileMatcher("chapters/<book>/<n>.md") },
  *tasks(vars, matched) {
    const chapter = matched.chapter.data
    const summary = new FileArtifact(`summaries/${vars.book}/${vars.n}.txt`)
    yield new Task({
      id: `summary:${vars.book}/${vars.n}`,
      inputs: [chapter],
      outputs: [summary],
      run: async () => {
        const text = await Bun.file(chapter.path).text()
        const lines = text.split("\n")
        const title = lines[0]!.slice(2)
        let wordCount = 0
        for (const word of text.split(/\s+/)) {
          if (word.length > 0) wordCount += 1
        }
        await Bun.write(summary.path, `${title}: ${wordCount} words\n`)
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
