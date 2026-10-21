// Makes out/<book>/book.html for each books/<book>/text.txt and books/<book>/style.txt, with one image for each sentence.
// Run it from an empty folder. It copies the sample books from examples/book/books/ first when books/ is missing.
// Run it two times: the second run makes no image. Then edit a text or a style and run it again.
import * as fs from "node:fs"
import * as fsPromises from "node:fs/promises"
import path from "node:path"
import { Build } from "dapat"
import { JsonStore } from "dapat/contrib"
import * as fakeImage from "./fake-image"
import * as pipeline from "./pipeline"

if (!fs.existsSync("books")) {
  await fsPromises.cp(path.join(import.meta.dir, "books"), "books", { recursive: true })
}

let imageCalls = 0
async function countedDrawImage(request: pipeline.ImageRequest): Promise<Uint8Array> {
  imageCalls += 1
  return fakeImage.drawImage(request)
}

const build = new Build({ store: new JsonStore(".dapat/state.json") })
pipeline.addBookTasks(build, process.cwd(), countedDrawImage)

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
console.log("image calls:", imageCalls)
if (!result.success) {
  for (const [task, error] of result.failed) {
    console.error(`${task.id}: ${error.message}`)
  }
  for (const error of result.errors) {
    console.error(error.message)
  }
  process.exit(1)
}
