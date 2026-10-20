/**
 * A var named "__proto__" is lost in the vars that tasks() gets and in the group label.
 * TaskMaterializer.hear copies the vars into a plain object with `vars[varName] = ...`
 * (src/task-materializer.ts lines 86-88); for "__proto__" that sets the prototype instead.
 * The match itself is stored and joined (varsKeyOf uses Object.hasOwn), so the task exists, but
 * tasks() cannot read the var, and two matches that differ only in it give the same task id.
 * Run: bun fuzz/repros/proto-var-name.ts
 */
import { Build, Matcher, Task } from "../../src/index"
import { Mem } from "../../test/mem"

class Things extends Matcher<Mem> {
  readonly varNames = ["__proto__", "slug"]
  async scan(): Promise<void> {
    for (const owner of ["ann", "bob"]) {
      // A computed key makes an own property named "__proto__".
      const vars = { ["__proto__"]: owner, slug: "x" }
      this.send({ kind: "found", matched: { vars, data: new Mem(`mem:${owner}`, "1") } })
    }
  }
}

const build = new Build()
const seen: string[] = []
build.each({
  matchersByName: { thing: new Things() },
  *tasks(vars) {
    seen.push(JSON.stringify(Object.entries(vars)))
    yield new Task({ id: `t:${Object.hasOwn(vars, "__proto__") ? vars["__proto__"] : "?"}/${vars.slug}`, run: async () => {} })
  },
})
let code = 0
try {
  const result = await build.run()
  console.log(`ran ${result.executed.map((t) => t.id).join(", ")}`)
} catch (error) {
  console.log(`run() rejected: ${String(error)}`)
  code = 1
}
console.log(`tasks() got vars: ${seen.join(" ; ")}`)
if (seen.some((v) => !v.includes("__proto__"))) {
  console.log("BUG: tasks() did not get the var __proto__")
  code = 1
}
process.exit(code)
