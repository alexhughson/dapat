import { describe, expect, test } from "bun:test"
import { Build, IdPrefix, MemoryStore, Task } from "../src/index"
import type { ArtifactEvent } from "../src/index"
import { Mem } from "./mem"

/** A real build that stands for a rule: it gives tasks under an owner name that it picks. */
class OwnerBuild extends Build {
  give(owner: string, tasks: Task[]): void {
    this.setTasks(owner, tasks)
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
        output.write(id, 1n, id)
      }
    },
  })
}

function ids(tasks: readonly Task[]): string[] {
  return tasks.map((task) => task.id)
}

describe("task owners", () => {
  test("setTasks adds, replaces, and removes by difference", async () => {
    const a = new Mem("mem:a")
    const b = new Mem("mem:b")
    const c = new Mem("mem:c")
    const d = new Mem("mem:d")
    const store = new MemoryStore()
    const log: string[] = []
    const build = new OwnerBuild({ store })
    build.subscribe((event) => {
      if (event.kind === "produced") return
      log.push(line(event))
    })
    build.give("1:x", [writer("t1", [a]), writer("t2", [b])])
    const first = await build.run()
    expect(ids(first.executed).sort()).toEqual(["t1", "t2"])
    expect(log).toEqual(["promised mem:a by t1", "promised mem:b by t2"])
    expect(await store.get("t1")).not.toBeNull()
    log.length = 0

    // t1 goes, t2 is replaced, and t3 is new.
    build.give("1:x", [writer("t2", [b, c]), writer("t3", [d])])
    expect(log).toEqual(["withdrawn mem:a by t1", "promised mem:c by t2", "promised mem:d by t3"])
    expect(await store.get("t1")).toBeNull()

    const second = await build.run()
    expect(second.success).toBe(true)
    // Completion order is not fixed, so the ids are sorted.
    expect(ids(second.executed).sort()).toEqual(["t1", "t2", "t2", "t3"])
    expect(second.cancelled).toEqual([])
  })

  test("a task id that another owner gives throws, and the build stays as it was", async () => {
    const a = new Mem("mem:a")
    const b = new Mem("mem:b")
    const x = new Mem("mem:x")
    const log: string[] = []
    const build = new OwnerBuild()
    build.subscribe((event) => {
      log.push(line(event))
    })
    build.give("1:x", [writer("t", [a])])
    await build.run()
    log.length = 0

    expect(() => build.give("2:y", [writer("u", [x]), writer("t", [b])])).toThrow(
      "task 't' has two owners: '1:x' and '2:y'",
    )
    expect(log).toEqual([])
    // "u" did not enter the build, so its output id is still free.
    build.add(writer("v", [x]))
    const result = await build.run()
    expect(ids(result.executed)).toEqual(["t", "v"])
    expect(log).toEqual(["promised mem:x by v", "produced mem:x by v"])
  })

  test("a plain task and an owner task with the same id clash", () => {
    const build = new OwnerBuild()
    build.add(writer("t", []))
    expect(() => build.give("1:x", [writer("t", [])])).toThrow(
      "task 't' has two owners: 'add:t' and '1:x'",
    )
    build.give("1:x", [writer("s", [])])
    expect(() => build.add(writer("s", []))).toThrow(
      "task 's' has two owners: '1:x' and 'add:s'",
    )
  })

  test("one call that gives one id twice throws, and the build stays as it was", async () => {
    const a = new Mem("mem:a")
    const b = new Mem("mem:b")
    const build = new OwnerBuild()
    build.give("1:x", [writer("old", [a])])
    expect(() => build.give("1:x", [writer("t", []), writer("t", [b])])).toThrow(
      "owner '1:x' gives task 't' twice",
    )
    const result = await build.run()
    expect(ids(result.executed)).toEqual(["old"])
  })

  test("two tasks of one call that declare one output throw", () => {
    const a = new Mem("mem:a")
    const build = new OwnerBuild()
    expect(() => build.give("1:x", [writer("t", [a]), writer("u", [a])])).toThrow(
      "duplicate output 'mem:a': claimed by 't' and 'u'",
    )
    build.add(writer("v", [a]))
    expect(() => build.give("1:x", [writer("t", [a])])).toThrow(
      "duplicate output 'mem:a': claimed by 'v' and 't'",
    )
  })

  test("setTasks with no tasks removes every task of the owner and stops the running one", async () => {
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
    const build = new OwnerBuild()
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
    // "waiting" reads an output of "slow", so it is still waiting when the owner drops it.
    const waiting = new Task({ id: "waiting", inputs: [new Mem("mem:s/1")], run: async () => {} })
    build.give("1:x", [slow, waiting])

    const running = build.run()
    await reached
    build.give("1:x", [])
    expect(aborted).toBe(true)
    release()
    const result = await running

    expect(result.success).toBe(true)
    expect(ids(result.cancelled)).toEqual(["slow", "waiting"])
    expect(result.executed).toEqual([])
    expect(log).toEqual(["promised mem:s/ by slow", "withdrawn mem:s/ by slow"])
    // The owner is gone, so a plain task can now use one of its ids.
    build.add(writer("slow", []))
  })

  test("remove(id) takes the id out of its owner, and a later call of the owner can give it again", async () => {
    const a = new Mem("mem:a")
    const b = new Mem("mem:b")
    const log: string[] = []
    const build = new OwnerBuild()
    build.subscribe((event) => {
      if (event.kind === "produced") return
      log.push(line(event))
    })
    build.give("1:x", [writer("t1", [a]), writer("t2", [b])])
    await build.run()
    log.length = 0

    build.remove("t1")
    expect(log).toEqual(["withdrawn mem:a by t1"])
    const afterRemove = await build.run()
    expect(ids(afterRemove.executed)).toEqual(["t1", "t2"])

    // The owner no longer has t1, so this call removes nothing.
    build.give("1:x", [writer("t2", [b])])
    expect(log).toEqual(["withdrawn mem:a by t1"])
    // The owner gives t1 again: it is a new task.
    build.give("1:x", [writer("t1", [a]), writer("t2", [b])])
    expect(log).toEqual(["withdrawn mem:a by t1", "promised mem:a by t1"])
  })

  test("setTasks from a subscriber during ctx.produced fails the task that produced", async () => {
    const page = new Mem("mem:p/1")
    const shotA = new Mem("mem:shot/a")
    const shotB = new Mem("mem:shot/b")
    let producedMessage = ""
    const build = new OwnerBuild()
    // This subscriber stands for a rule that makes tasks for each page.
    build.subscribe((event) => {
      if (event.kind !== "produced") return
      if (event.artifact.id !== "mem:p/1") return
      build.give("1:p/1", [writer("shot-a", [shotA]), writer("shot-b", [shotB])])
    })
    build.subscribe((event) => {
      if (event.kind !== "promised") return
      if (!event.output.id.startsWith("mem:shot/")) return
      throw new Error(`promise broke on ${event.output.id}`)
    })
    build.add(
      new Task({
        id: "split",
        outputs: [new IdPrefix("mem:p/")],
        run: async (ctx) => {
          try {
            ctx.produced(page)
          } catch (error) {
            producedMessage = String(error)
          }
        },
      }),
    )

    const result = await build.run()
    expect(producedMessage).toBe("Error: promise broke on mem:shot/a")
    const failed: Record<string, string> = {}
    for (const [task, error] of result.failed) {
      failed[task.id] = error.message
    }
    // The first error fails the task that caused the send. The second has no other owner.
    expect(failed).toEqual({ split: "promise broke on mem:shot/a" })
    expect(result.errors.map((error) => error.message)).toEqual(["promise broke on mem:shot/b"])
    // The tasks are in the build even though a subscriber threw.
    expect(ids(result.executed).sort()).toEqual(["shot-a", "shot-b"])
  })
})
