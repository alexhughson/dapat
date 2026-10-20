/**
 * One matcher feeds two build.each calls. tasks() of the first build.each sends a newer
 * found for the same vars. The second build.each hears the two finds in the wrong order,
 * so it ends with the older data, while the first ends with the newer data.
 * Run: bun fuzz/repros/shared-matcher-reorder.ts
 */
import { Build, Matcher, Task } from "../../src/index"
import { Mem } from "../../test/mem"

class Posts extends Matcher<Mem> {
  readonly varNames = ["slug"]
  async scan(): Promise<void> {}
  emit(slug: string, data: Mem): void {
    this.send({ kind: "found", matched: { vars: { slug }, data } })
  }
}

const posts = new Posts()
const oldPost = new Mem("mem:old", "1")
const newPost = new Mem("mem:new", "2")
const build = new Build()
let resent = false

build.each({
  matchersByName: { post: posts },
  *tasks(vars, matched) {
    // The first time, a newer version of the post arrives while build.each 1 handles the old one.
    if (!resent) {
      resent = true
      posts.emit("a", newPost)
    }
    yield new Task({ id: `one:${vars.slug}`, inputs: [matched.post.data], run: async () => {} })
  },
})
build.each({
  matchersByName: { post: posts },
  *tasks(vars, matched) {
    yield new Task({ id: `two:${vars.slug}`, inputs: [matched.post.data], run: async () => {} })
  },
})

posts.emit("a", oldPost) // the matcher's last word is newPost

const slots = (build as any).slots as Map<string, { task: Task }>
const one = slots.get("one:a")!.task.inputs[0]!.id
const two = slots.get("two:a")!.task.inputs[0]!.id
console.log(`build.each 1 holds ${one}`)
console.log(`build.each 2 holds ${two}`)
console.log(one === two ? "OK: both hold the same data" : "BUG: build.each 2 holds older data than build.each 1")
process.exit(one === two ? 0 : 1)
