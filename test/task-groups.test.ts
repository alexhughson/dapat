import { describe, expect, test } from "bun:test"
import { Build, IdPrefix, Matcher, MemoryStore, Task, TaskGroup } from "../src/index"
import type { ArtifactEvent } from "../src/index"
import { Mem } from "./mem"

/** A real build that stands for build.each: it gives tasks to a group that it picks. */
class GroupBuild extends Build {
  give(group: TaskGroup, tasks: Task[]): void {
    this.setTasks(group, tasks)
  }
}

/**
 * A real matcher over in-memory posts, like the Posts matcher in DOCS.md.
 * It matches the ids `posts/<slug>.md`. deletePost sends `gone`, as a file watcher would.
 */
class MemPostsMatcher extends Matcher<Mem> {
  readonly varNames = ["slug"]

  constructor(private readonly posts: Mem[]) {
    super()
  }

  async scan(_signal: AbortSignal): Promise<void> {
    for (const post of this.posts) {
      const slug = post.id.slice("posts/".length, -".md".length)
      this.send({ kind: "found", matched: { vars: { slug }, data: post } })
    }
  }

  deletePost(slug: string): void {
    const kept: Mem[] = []
    for (const post of this.posts) {
      if (post.id !== `posts/${slug}.md`) kept.push(post)
    }
    this.posts.length = 0
    for (const post of kept) {
      this.posts.push(post)
    }
    this.send({ kind: "gone", vars: { slug } })
  }
}

function line(event: ArtifactEvent): string {
  if (event.kind === "produced" || event.kind === "deleted") {
    return `${event.kind} ${event.artifact.id} by ${event.taskId}`
  }
  return `${event.kind} ${event.output.id} by ${event.taskId}`
}

function writer(id: string, outputs: Mem[]): Task {
  return new Task({
    id,
    outputs,
    run: async () => {
      for (const output of outputs) {
        output.write(id)
      }
    },
  })
}

function ids(tasks: readonly Task[]): string[] {
  return tasks.map((task) => task.id)
}

describe("task groups", () => {
  test("setTasks adds, replaces, and removes by difference", async () => {
    const a = new Mem("mem:a")
    const b = new Mem("mem:b")
    const c = new Mem("mem:c")
    const d = new Mem("mem:d")
    const store = new MemoryStore()
    const log: string[] = []
    const build = new GroupBuild({ store })
    const x = new TaskGroup("x")
    build.subscribe((event) => {
      if (event.kind === "produced") return
      log.push(line(event))
    })
    build.give(x, [writer("t1", [a]), writer("t2", [b])])
    const first = await build.run()
    expect(ids(first.executed).sort()).toEqual(["t1", "t2"])
    expect(log).toEqual(["promised mem:a by t1", "promised mem:b by t2"])
    expect(await store.get("t1")).not.toBeNull()
    log.length = 0

    // t1 goes, t2 is replaced, and t3 is new.
    build.give(x, [writer("t2", [b, c]), writer("t3", [d])])
    expect(log).toEqual(["withdrawn mem:a by t1", "promised mem:c by t2", "promised mem:d by t3"])
    expect(await store.get("t1")).toBeNull()

    const second = await build.run()
    expect(second.success).toBe(true)
    // Completion order is not fixed, so the ids are sorted.
    expect(ids(second.executed).sort()).toEqual(["t1", "t2", "t2", "t3"])
    expect(second.cancelled).toEqual([])
  })

  test("a task id that another group has throws, and the build stays as it was", async () => {
    const a = new Mem("mem:a")
    const b = new Mem("mem:b")
    const mx = new Mem("mem:x")
    const log: string[] = []
    const build = new GroupBuild()
    const x = new TaskGroup("x")
    const y = new TaskGroup("y")
    build.subscribe((event) => {
      log.push(line(event))
    })
    build.give(x, [writer("t", [a])])
    await build.run()
    log.length = 0

    expect(() => build.give(y, [writer("u", [mx]), writer("t", [b])])).toThrow(
      "task 't' is in two groups: 'x' and 'y'",
    )
    expect(log).toEqual([])
    // "u" did not enter the build, so its output id is still free.
    build.add(writer("v", [mx]))
    const result = await build.run()
    expect(ids(result.executed)).toEqual(["t", "v"])
    expect(log).toEqual(["promised mem:x by v", "produced mem:x by v"])
  })

  test("a task of build.add and a task of another group with the same id clash", () => {
    const build = new GroupBuild()
    const x = new TaskGroup("x")
    build.add(writer("t", []))
    expect(() => build.give(x, [writer("t", [])])).toThrow(
      "task 't' is in two groups: 'build.add t' and 'x'",
    )
    build.give(x, [writer("s", [])])
    expect(() => build.add(writer("s", []))).toThrow(
      "task 's' is in two groups: 'x' and 'build.add s'",
    )
  })

  test("two groups with the same label are still two groups", () => {
    const build = new GroupBuild()
    const first = new TaskGroup("same")
    const second = new TaskGroup("same")
    build.give(first, [writer("t", [])])
    // Disjoint ids: no clash, and the second group does not replace the first.
    build.give(second, [writer("u", [])])
    build.give(second, [])
    expect(() => build.add(writer("t", []))).toThrow("task 't' is in two groups: 'same' and 'build.add t'")
    // One id in both groups: the error names both labels.
    expect(() => build.give(second, [writer("t", [])])).toThrow("task 't' is in two groups: 'same' and 'same'")
  })

  test("one call that gives one id twice throws, and the build stays as it was", async () => {
    const a = new Mem("mem:a")
    const b = new Mem("mem:b")
    const build = new GroupBuild()
    const x = new TaskGroup("x")
    build.give(x, [writer("old", [a])])
    expect(() => build.give(x, [writer("t", []), writer("t", [b])])).toThrow(
      "group 'x' gives task 't' twice",
    )
    const result = await build.run()
    expect(ids(result.executed)).toEqual(["old"])
  })

  test("two tasks of one call that declare one output throw", () => {
    const a = new Mem("mem:a")
    const build = new GroupBuild()
    const x = new TaskGroup("x")
    expect(() => build.give(x, [writer("t", [a]), writer("u", [a])])).toThrow(
      "duplicate output 'mem:a': claimed by 't' and 'u'",
    )
    build.add(writer("v", [a]))
    expect(() => build.give(x, [writer("t", [a])])).toThrow(
      "duplicate output 'mem:a': claimed by 'v' and 't'",
    )
  })

  test("setTasks with no tasks removes every task of the group and stops the running one", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const reached = new Promise<void>((resolve) => {
      started = resolve
    })
    let aborted = false
    const log: string[] = []
    const build = new GroupBuild()
    const x = new TaskGroup("x")
    build.subscribe((event) => {
      log.push(line(event))
    })
    const slow = new Task({
      id: "slow",
      outputs: [new IdPrefix("mem:s/")],
      run: async (ctx) => {
        ctx.signal.addEventListener("abort", () => {
          aborted = true
        })
        started()
        await gate
      },
    })
    // "waiting" reads an output of "slow", so it is still waiting when the group drops it.
    const waiting = new Task({ id: "waiting", inputs: [new Mem("mem:s/1")], run: async () => {} })
    build.give(x, [slow, waiting])

    const running = build.run()
    await reached
    build.give(x, [])
    expect(aborted).toBe(true)
    release()
    const result = await running

    expect(result.success).toBe(true)
    expect(ids(result.cancelled)).toEqual(["slow", "waiting"])
    expect(result.executed).toEqual([])
    expect(log).toEqual(["promised mem:s/ by slow", "withdrawn mem:s/ by slow"])
    // The group has no tasks now, so build.add can now use one of its ids.
    build.add(writer("slow", []))
  })

  test("remove(id) takes the id out of its group, and a later call for the group can give it again", async () => {
    const a = new Mem("mem:a")
    const b = new Mem("mem:b")
    const log: string[] = []
    const build = new GroupBuild()
    const x = new TaskGroup("x")
    build.subscribe((event) => {
      if (event.kind === "produced") return
      log.push(line(event))
    })
    build.give(x, [writer("t1", [a]), writer("t2", [b])])
    await build.run()
    log.length = 0

    build.remove("t1")
    expect(log).toEqual(["withdrawn mem:a by t1"])
    const afterRemove = await build.run()
    expect(ids(afterRemove.executed)).toEqual(["t1", "t2"])

    // The group no longer has t1, so this call removes nothing.
    build.give(x, [writer("t2", [b])])
    expect(log).toEqual(["withdrawn mem:a by t1"])
    // The group gets t1 again: it is a new task.
    build.give(x, [writer("t1", [a]), writer("t2", [b])])
    expect(log).toEqual(["withdrawn mem:a by t1", "promised mem:a by t1"])
  })

  test("an output that moves from one task to another in one call is withdrawn before it is promised", async () => {
    const o = new Mem("mem:o")
    const log: string[] = []
    const build = new GroupBuild()
    const x = new TaskGroup("x")
    build.subscribe((event) => {
      if (event.kind === "produced") return
      log.push(line(event))
    })
    build.give(x, [writer("from", [o])])
    const first = await build.run()
    expect(ids(first.executed)).toEqual(["from"])
    log.length = 0

    // "to" comes first in the list, and still its promised event comes last.
    build.give(x, [writer("to", [o]), writer("from", [])])
    expect(log).toEqual(["withdrawn mem:o by from", "promised mem:o by to"])
    // The output is gone, so "to" cannot skip.
    o.value = null
    const second = await build.run()
    expect(ids(second.executed).sort()).toEqual(["from", "from", "to"])
  })

  test("two kept tasks that swap outputs get every withdrawn event first", async () => {
    const a = new Mem("mem:a")
    const b = new Mem("mem:b")
    const log: string[] = []
    const build = new GroupBuild()
    const x = new TaskGroup("x")
    build.subscribe((event) => {
      if (event.kind === "produced") return
      log.push(line(event))
    })
    build.give(x, [writer("A", [a]), writer("B", [b])])
    await build.run()
    log.length = 0

    build.give(x, [writer("A", [b]), writer("B", [a])])
    expect(log).toEqual([
      "withdrawn mem:a by A",
      "withdrawn mem:b by B",
      "promised mem:b by A",
      "promised mem:a by B",
    ])
  })

  test("a group can hand an output to a new task, and a reader waits for the new task", async () => {
    const o = new Mem("mem:o")
    let seen = ""
    const build = new GroupBuild()
    const x = new TaskGroup("x")
    build.give(x, [writer("a", [o])])
    build.give(x, [
      new Task({
        id: "b",
        outputs: [o],
        run: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10))
          o.write("from b")
        },
      }),
    ])
    build.add(
      new Task({
        id: "reader",
        inputs: [o],
        run: async () => {
          seen = await o.read()
        },
      }),
    )

    const result = await build.run()
    expect(result.success).toBe(true)
    expect(seen).toBe("from b")
    expect(ids(result.cancelled)).toEqual(["a"])
  })

  test("setTasks from a subscriber during ctx.produced adds tasks that run", async () => {
    const page = new Mem("mem:p/1")
    const shotA = new Mem("mem:shot/a")
    const shotB = new Mem("mem:shot/b")
    const build = new GroupBuild()
    const x = new TaskGroup("x")
    // This subscriber stands for a build.each that makes tasks for each page.
    build.subscribe((event) => {
      if (event.kind !== "produced") return
      if (event.artifact.id !== "mem:p/1") return
      build.give(x, [writer("shot-a", [shotA]), writer("shot-b", [shotB])])
    })
    build.add(
      new Task({
        id: "split",
        outputs: [new IdPrefix("mem:p/")],
        run: async (ctx) => {
          ctx.produced(page)
        },
      }),
    )

    const result = await build.run()
    expect(result.success).toBe(true)
    expect(ids(result.executed).sort()).toEqual(["shot-a", "shot-b", "split"])
  })

  test("the example in DOCS.md: a gone post removes only the task of its group", async () => {
    const postA = new Mem("posts/a.md", "A")
    const postB = new Mem("posts/b.md", "B")
    const posts = new MemPostsMatcher([postA, postB])
    const log: string[] = []
    const build = new Build()
    build.subscribe((event) => {
      if (event.kind !== "withdrawn") return
      log.push(line(event))
    })
    // Two groups from build.add: "build.add lint" and "build.add test".
    build.add(writer("lint", []))
    build.add(writer("test", []))
    // One group for each post: "build.each 1 slug=a" and "build.each 1 slug=b".
    build.each({
      matchersByName: { post: posts },
      *tasks(vars, matched) {
        const page = new Mem(`site/${vars.slug}.html`)
        yield new Task({
          id: `page:${vars.slug}`,
          inputs: [matched.post.data],
          outputs: [page],
          run: async () => {
            page.write(await matched.post.data.read())
          },
        })
      },
    })
    const first = await build.run()
    expect(ids(first.executed).sort()).toEqual(["lint", "page:a", "page:b", "test"])

    // posts/b.md is deleted. The group "build.each 1 slug=b" gets an empty task list.
    posts.deletePost("b")
    expect(log).toEqual(["withdrawn site/b.html by page:b"])

    // page:a is still in its group.
    expect(() => build.add(writer("page:a", []))).toThrow(
      "task 'page:a' is in two groups: 'build.each 1 slug=a' and 'build.add page:a'",
    )
    // page:b is not in the build now, so build.add can use its id.
    build.add(writer("page:b", []))
    // lint and test are still in their groups, so build.add replaces them.
    build.add(writer("lint", []))
    build.add(writer("test", []))
    const second = await build.run()
    expect(second.success).toBe(true)
    // A result holds the tasks of every run so far: the three new tasks ran, and page:a did not run again.
    expect(ids(second.executed).sort()).toEqual(["lint", "lint", "page:a", "page:b", "page:b", "test", "test"])
  })
})
