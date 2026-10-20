import { describe, expect, test } from "bun:test"
import { Build, IdPrefix, MemoryStore, SEND_LIMIT, Task, isPrefix } from "../src/index"
import type { Artifact, ArtifactEvent, Ref, TaskState } from "../src/index"
import { Mem, MemPrefix } from "./mem"

/** "<kind> <id>": the artifact id of a produced or deleted event, or the declared output id. */
function describeEvent(event: ArtifactEvent): string {
  if (event.kind === "produced" || event.kind === "deleted") {
    return `${event.kind} ${event.artifact.id}`
  }
  return `${event.kind} ${event.output.id}`
}

describe("Build", () => {
  test("runs producer before consumer regardless of add order", async () => {
    const data = new Mem("mem:data")
    const resultArt = new Mem("mem:result")
    const executed: string[] = []

    const build = new Build()
    build.add(
      new Task({
        id: "consumer",
        inputs: [data],
        outputs: [resultArt],
        run: async () => {
          executed.push("consumer")
          resultArt.write("ok")
        },
      }),
    )
    build.add(
      new Task({
        id: "producer",
        outputs: [data],
        run: async () => {
          executed.push("producer")
          data.write("v")
        },
      }),
    )

    const result = await build.run()
    expect(result.success).toBe(true)
    expect(executed).toEqual(["producer", "consumer"])
  })

  test("prefix output makes a child consumer wait", async () => {
    const foo = new Mem("mem:out/foo")
    const used = new Mem("mem:used")
    const executed: string[] = []

    const build = new Build()
    build.add(
      new Task({
        id: "use-foo",
        inputs: [foo],
        outputs: [used],
        run: async () => {
          executed.push("use-foo")
          used.write("y")
        },
      }),
    )
    build.add(
      new Task({
        id: "write-unknown",
        outputs: [new IdPrefix("mem:out/")],
        run: async (ctx) => {
          executed.push("write-unknown")
          foo.write("x")
          ctx.produced(foo)
        },
      }),
    )

    const result = await build.run()
    expect(result.success).toBe(true)
    expect(executed).toEqual(["write-unknown", "use-foo"])
  })

  test("a folder input waits for the writers of the files in it", async () => {
    const foo = new Mem("mem:out/foo")
    const dir = new MemPrefix("mem:out/", [foo])
    const zip = new Mem("mem:zip")
    const executed: string[] = []

    const build = new Build()
    build.add(
      new Task({
        id: "zip",
        inputs: [dir],
        outputs: [zip],
        run: async () => {
          executed.push("zip")
          zip.write("z")
        },
      }),
    )
    build.add(
      new Task({
        id: "write",
        outputs: [foo],
        run: async () => {
          executed.push("write")
          foo.write("x")
        },
      }),
    )

    const result = await build.run()
    expect(result.success).toBe(true)
    expect(executed).toEqual(["write", "zip"])
  })

  test("a subscriber adds a task for a produced child", async () => {
    const foo = new Mem("mem:logs/1.json")
    const report = new Mem("mem:reports/1.json")
    const executed: string[] = []

    const build = new Build()
    build.subscribe((event) => {
      if (event.kind !== "produced") return
      if (!event.artifact.id.startsWith("mem:logs/")) return
      build.add(
        new Task({
          id: `report:${event.artifact.id}`,
          inputs: [event.artifact],
          outputs: [report],
          run: async () => {
            executed.push("report")
            report.write("r")
          },
        }),
      )
    })
    build.add(
      new Task({
        id: "write-log",
        outputs: [new IdPrefix("mem:logs/")],
        run: async (ctx) => {
          executed.push("write-log")
          foo.write("log")
          ctx.produced(foo)
        },
      }),
    )

    const result = await build.run()
    expect(result.success).toBe(true)
    expect(executed).toEqual(["write-log", "report"])
  })

  test("a subscriber gets each produced artifact in order and at once", async () => {
    const first = new Mem("mem:out/1")
    const second = new Mem("mem:out/2")
    const declared = new Mem("mem:declared")
    const report = new Mem("mem:report")
    const log: string[] = []

    const build = new Build()
    build.subscribe((event) => {
      log.push(`${describeEvent(event)} by ${event.taskId}`)
      if (event.kind === "produced" && event.artifact === first) {
        build.add(
          new Task({
            id: "report",
            inputs: [first],
            outputs: [report],
            run: async () => {
              report.write("r")
            },
          }),
        )
      }
    })
    build.add(
      new Task({
        id: "write",
        outputs: [new IdPrefix("mem:out/"), declared],
        run: async (ctx) => {
          first.write("1")
          ctx.produced(first)
          log.push("produced returned")
          // The listener added "report" before ctx.produced returned,
          // so a second task with the same output is a duplicate.
          const duplicate = new Task({ id: "other", outputs: [report], run: async () => {} })
          expect(() => ctx.add(duplicate)).toThrow(/duplicate output 'mem:report'/)
          second.write("2")
          ctx.produced(second)
          declared.write("d")
        },
      }),
    )

    const result = await build.run()
    expect(result.success).toBe(true)
    expect(log).toEqual([
      "promised mem:out/ by write",
      "promised mem:declared by write",
      "produced mem:out/1 by write",
      "promised mem:report by report",
      "produced returned",
      "produced mem:out/2 by write",
      "produced mem:declared by write",
      "produced mem:report by report",
    ])
  })

  test("a subscriber error in ctx.produced rejects run(), and ctx.produced does not throw", async () => {
    const foo = new Mem("mem:out/foo")
    let returned = false
    const build = new Build()
    build.subscribe((event) => {
      if (event.kind === "produced") {
        throw new Error(`listener broke on ${event.artifact.id}`)
      }
    })
    build.add(
      new Task({
        id: "write",
        outputs: [new IdPrefix("mem:out/")],
        run: async (ctx) => {
          foo.write("x")
          ctx.produced(foo)
          returned = true
        },
      }),
    )

    await expect(build.run()).rejects.toThrow("listener broke on mem:out/foo")
    expect(returned).toBe(true)
  })

  test("a subscriber error on a declared output rejects run() and keeps no store record", async () => {
    const out = new Mem("mem:out")
    const store = new MemoryStore()
    const build = new Build({ store })
    build.subscribe((event) => {
      if (event.kind === "produced") throw new Error("listener broke")
    })
    build.add(
      new Task({
        id: "write",
        outputs: [out],
        run: async () => {
          out.write("x")
        },
      }),
    )

    await expect(build.run()).rejects.toThrow("listener broke")
    expect(await store.get("write")).toBeNull()
  })

  for (const how of ["remove", "replace"]) {
    test(`a subscriber error on a withdrawn event from build.${how} rejects run()`, async () => {
      const out = new Mem("mem:out")
      const other = new Mem("mem:other")
      const withdrawn: string[] = []
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let waiting!: () => void
      const reached = new Promise<void>((resolve) => {
        waiting = resolve
      })

      const build = new Build()
      build.subscribe((event) => {
        if (event.kind !== "withdrawn") return
        withdrawn.push(event.output.id)
        throw new Error("listener broke")
      })
      build.add(
        new Task({
          id: "write",
          outputs: [out],
          run: async () => {
            out.write("x")
          },
        }),
      )
      // Starts only after "write" completes, and holds the run open.
      build.add(
        new Task({
          id: "hold",
          inputs: [out],
          run: async () => {
            waiting()
            await gate
          },
        }),
      )

      const running = build.run()
      await reached
      if (how === "remove") {
        build.remove("write")
      } else {
        build.add(
          new Task({
            id: "write",
            outputs: [other],
            run: async () => {
              other.write("y")
            },
          }),
        )
      }
      release()

      await expect(running).rejects.toThrow("listener broke")
      expect(withdrawn).toEqual(["mem:out"])
    })
  }



  test("produced throws when no output covers the child", async () => {
    const foo = new Mem("mem:other/foo")
    const build = new Build()
    build.add(
      new Task({
        id: "write",
        outputs: [new IdPrefix("mem:out/")],
        run: async (ctx) => {
          foo.write("x")
          ctx.produced(foo)
        },
      }),
    )

    const result = await build.run()
    expect(result.success).toBe(false)
    expect(result.failed.size).toBe(1)
  })

  test("replacing a pending task cancels the old declaration", async () => {
    const out = new Mem("mem:out")
    const executed: string[] = []

    const build = new Build()
    build.add(
      new Task({
        id: "t",
        outputs: [out],
        run: async () => {
          executed.push("old")
          out.write("old")
        },
      }),
    )
    build.add(
      new Task({
        id: "t",
        outputs: [out],
        run: async () => {
          executed.push("new")
          out.write("new")
        },
      }),
    )

    const result = await build.run()
    expect(result.success).toBe(true)
    expect(executed).toEqual(["new"])
    expect(result.cancelled.length).toBe(1)
  })

  test("exact-artifact cycle deadlocks if both wait at start", async () => {
    const a = new Mem("mem:a")
    const b = new Mem("mem:b")
    const build = new Build()
    build.add(
      new Task({
        id: "A",
        inputs: [b],
        outputs: [a],
        run: async () => {},
      }),
    )
    build.add(
      new Task({
        id: "B",
        inputs: [a],
        outputs: [b],
        run: async () => {},
      }),
    )
    const result = await build.run()
    expect(result.success).toBe(false)
    for (const error of result.failed.values()) {
      expect(error.message).toMatch(/deadlock/)
    }
  })

  test("throws on two exact producers of one id", () => {
    const out = new Mem("mem:out")
    const build = new Build()
    build.add(
      new Task({
        id: "one",
        outputs: [out],
        run: async () => {},
      }),
    )
    expect(() => {
      build.add(
        new Task({
          id: "two",
          outputs: [out],
          run: async () => {},
        }),
      )
    }).toThrow(/duplicate output/)
  })

  test("failed producer fails the consumer", async () => {
    const data = new Mem("mem:data")
    const out = new Mem("mem:out")
    const executed: string[] = []

    const build = new Build()
    build.add(
      new Task({
        id: "producer",
        outputs: [data],
        run: async () => {
          executed.push("producer")
          throw new Error("boom")
        },
      }),
    )
    build.add(
      new Task({
        id: "consumer",
        inputs: [data],
        outputs: [out],
        run: async () => {
          executed.push("consumer")
        },
      }),
    )

    const result = await build.run()
    expect(result.success).toBe(false)
    expect(executed).toEqual(["producer"])
    expect(result.failed.size).toBe(2)
  })

  test("prefix deadlock fails instead of hanging", async () => {
    const x = new Mem("mem:x")
    const build = new Build()
    build.add(
      new Task({
        id: "A",
        inputs: [x],
        outputs: [new IdPrefix("mem:out/")],
        run: async () => {},
      }),
    )
    build.add(
      new Task({
        id: "B",
        inputs: [new IdPrefix("mem:out/")],
        outputs: [x],
        run: async () => {
          x.write("x")
        },
      }),
    )

    const result = await build.run()
    expect(result.success).toBe(false)
    expect(result.failed.size).toBeGreaterThan(0)
    for (const error of result.failed.values()) {
      expect(error.message).toMatch(/deadlock/)
    }
  })

  test("ctx.remove with a throwing withdrawn subscriber removes the task and drops the later events", async () => {
    const a = new Mem("mem:p/a")
    const b = new Mem("mem:p/b")
    const withdrawn: string[] = []
    const build = new Build()
    build.subscribe((event) => {
      if (event.kind !== "withdrawn") return
      withdrawn.push(`${event.output.id} by ${event.taskId}`)
      throw new Error(`withdraw broke on ${event.output.id}`)
    })
    build.add(
      new Task({
        id: "write",
        outputs: [a, b],
        run: async () => {
          a.write("a")
          b.write("b")
        },
      }),
    )
    let removeReturned = false
    build.add(
      new Task({
        id: "remover",
        inputs: [a, b],
        run: async (ctx) => {
          ctx.remove("write")
          removeReturned = true
        },
      }),
    )

    // The first error clears the queue, so "withdrawn mem:p/b" is never sent.
    await expect(build.run()).rejects.toThrow("withdraw broke on mem:p/a")
    expect(removeReturned).toBe(true)
    expect(withdrawn).toEqual(["mem:p/a by write"])

    // The task is gone: a second remove sends nothing, and its output id is free.
    build.remove("write")
    expect(withdrawn.length).toBe(1)
    build.add(new Task({ id: "again", outputs: [a], run: async () => {} }))
  })

  test("ctx.add that replaces a completed task with a throwing subscriber rejects run(), and the replacement does not run", async () => {
    const old = new Mem("mem:old")
    const next = new Mem("mem:next")
    const executed: string[] = []
    const build = new Build()
    build.subscribe((event) => {
      if (event.kind === "withdrawn") throw new Error("withdraw broke")
    })
    build.add(
      new Task({
        id: "t",
        outputs: [old],
        run: async () => {
          executed.push("old t")
          old.write("o")
        },
      }),
    )
    build.add(
      new Task({
        id: "replacer",
        inputs: [old],
        run: async (ctx) => {
          executed.push("replacer")
          ctx.add(
            new Task({
              id: "t",
              outputs: [next],
              run: async () => {
                executed.push("new t")
                next.write("n")
              },
            }),
          )
        },
      }),
    )

    await expect(build.run()).rejects.toThrow("withdraw broke")
    expect(executed).toEqual(["old t", "replacer"])
  })

  test("build.add and build.remove inside a task reject run() on a subscriber error, as ctx.add and ctx.remove do", async () => {
    const one = new Mem("mem:one")
    const two = new Mem("mem:two")
    const build = new Build()
    build.subscribe((event) => {
      if (event.kind === "withdrawn") throw new Error(`withdraw broke on ${event.output.id}`)
    })
    build.add(new Task({ id: "one", outputs: [one], run: async () => {} }))
    build.add(new Task({ id: "two", outputs: [two], run: async () => {} }))
    build.add(
      new Task({
        id: "outside",
        inputs: [one, two],
        run: async () => {
          build.remove("one")
          build.add(new Task({ id: "two", run: async () => {} }))
        },
      }),
    )

    // Only the first error is kept. The build sends no events after it.
    await expect(build.run()).rejects.toThrow("withdraw broke on mem:one")
  })

  test("a subscriber error on the withdrawn events of a running task that build.add replaces rejects run()", async () => {
    const out = new Mem("mem:out/a")
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const reached = new Promise<void>((resolve) => {
      started = resolve
    })
    const build = new Build()
    build.subscribe((event) => {
      if (event.kind === "withdrawn") throw new Error("withdraw broke")
    })
    build.add(
      new Task({
        id: "t",
        outputs: [new IdPrefix("mem:out/")],
        run: async (ctx) => {
          ctx.produced(out)
          started()
          await gate
        },
      }),
    )

    const running = build.run()
    await reached
    build.add(new Task({ id: "t", run: async () => {} }))
    release()
    await expect(running).rejects.toThrow("withdraw broke")
  })

  test("a subscriber error outside run() makes each later run() reject at once", async () => {
    const a = new Mem("mem:a")
    const b = new Mem("mem:b")
    const withdrawn: string[] = []
    const build = new Build()
    build.subscribe((event) => {
      if (event.kind !== "withdrawn") return
      withdrawn.push(event.output.id)
      throw new Error(`withdraw broke on ${event.output.id}`)
    })
    build.add(new Task({ id: "write", outputs: [a, b], run: async () => {} }))
    const first = await build.run()
    expect(first.success).toBe(true)

    // build.remove does not throw. The first error clears the queue, so mem:b gets no event.
    build.remove("write")
    expect(withdrawn).toEqual(["mem:a"])
    await expect(build.run()).rejects.toThrow("withdraw broke on mem:a")
    await expect(build.run()).rejects.toThrow("withdraw broke on mem:a")
  })





  test("a subscriber added during a send gets the next event only", async () => {
    const a = new Mem("mem:p/a")
    const b = new Mem("mem:p/b")
    const late: string[] = []
    const build = new Build()
    let subscribed = false
    build.subscribe(() => {
      if (subscribed) return
      subscribed = true
      build.subscribe((event) => {
        late.push(describeEvent(event))
      })
    })
    build.add(
      new Task({
        id: "write",
        outputs: [new IdPrefix("mem:p/")],
        run: async (ctx) => {
          ctx.produced(a)
          ctx.produced(b)
        },
      }),
    )

    const result = await build.run()
    expect(result.success).toBe(true)
    // The first event is "promised mem:p/" at the start of run().
    expect(late).toEqual(["produced mem:p/a", "produced mem:p/b"])
  })

  test("a subscriber error in one task's ctx.produced rejects run() and aborts the other running task", async () => {
    const bad = new Mem("mem:bad/1")
    let finished = false
    let started!: () => void
    const reached = new Promise<void>((resolve) => {
      started = resolve
    })
    const build = new Build()
    build.subscribe((event) => {
      if (event.kind !== "produced") return
      if (event.artifact === bad) throw new Error("listener broke on bad")
    })
    build.add(
      new Task({
        id: "bad",
        outputs: [new IdPrefix("mem:bad/")],
        run: async (ctx) => {
          await reached
          ctx.produced(bad)
        },
      }),
    )
    // Waits for its signal to abort, and then works a little longer.
    build.add(
      new Task({
        id: "other",
        run: async (ctx) => {
          await new Promise<void>((resolve) => {
            ctx.signal.addEventListener("abort", () => resolve())
            started()
          })
          await new Promise<void>((resolve) => setTimeout(resolve, 10))
          finished = true
        },
      }),
    )

    // run() rejects only after the aborted task returned.
    await expect(build.run()).rejects.toThrow("listener broke on bad")
    expect(finished).toBe(true)
  })

  test("a subscriber that returns a promise rejects run(), and the promise's rejection is dropped", async () => {
    const out = new Mem("mem:out")
    const build = new Build()
    build.subscribe((event) => {
      if (event.kind === "produced") return Promise.reject(new Error("async subscriber broke"))
    })
    build.add(
      new Task({
        id: "write",
        outputs: [out],
        run: async () => {},
      }),
    )

    const message = "subscriber returned a promise; subscribers must be synchronous"
    await expect(build.run()).rejects.toThrow(message)
    // The rejection came after the first error, so the build keeps the first one.
    await new Promise<void>((resolve) => setTimeout(resolve, 1))
    await expect(build.run()).rejects.toThrow(message)
  })


  test("a replacement with the same outputs sends no promised or withdrawn events", async () => {
    const a = new Mem("mem:a")
    const events: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const reached = new Promise<void>((resolve) => {
      started = resolve
    })
    const build = new Build()
    build.subscribe((event) => {
      events.push(describeEvent(event))
    })
    build.add(
      new Task({
        id: "t",
        outputs: [a],
        run: async (ctx) => {
          ctx.produced(a)
          started()
          await gate
        },
      }),
    )

    const running = build.run()
    await reached
    build.add(new Task({ id: "t", outputs: [a], run: async () => {} }))
    // Let the replacement finish before the old run returns.
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
    release()
    const result = await running

    expect(result.success).toBe(true)
    expect(result.cancelled.length).toBe(1)
    expect(events).toEqual(["promised mem:a", "produced mem:a", "produced mem:a"])
    build.remove("t")
    expect(events).toEqual(["promised mem:a", "produced mem:a", "produced mem:a", "withdrawn mem:a"])
  })

  test("a task's own error after a subscriber error does not replace it", async () => {
    const out = new Mem("mem:out/a")
    const build = new Build()
    build.subscribe((event) => {
      if (event.kind === "produced") throw new Error("listener broke")
    })
    build.add(
      new Task({
        id: "t",
        outputs: [new IdPrefix("mem:out/")],
        run: async (ctx) => {
          ctx.produced(out)
          throw new Error("task gave up")
        },
      }),
    )

    await expect(build.run()).rejects.toThrow("listener broke")
  })

  test("a subscriber that removes the writer on its declared output stops its record", async () => {
    const out = new Mem("mem:out")
    const store = new MemoryStore()
    const build = new Build({ store })
    build.subscribe((event) => {
      if (event.kind === "produced" && event.taskId === "t") build.remove("t")
    })
    build.add(
      new Task({
        id: "t",
        outputs: [out],
        run: async () => {
          out.write("v")
        },
      }),
    )

    const result = await build.run()
    // Let the store delete that remove started finish.
    await new Promise<void>((resolve) => setTimeout(resolve, 1))
    expect(result.executed).toEqual([])
    expect(result.cancelled.map((task) => task.id)).toEqual(["t"])
    expect(await store.get("t")).toBeNull()
  })

  test("removing a prefix writer withdraws the prefix, not each artifact under it", async () => {
    const a = new Mem("mem:p/a")
    const events: string[] = []
    const build = new Build()
    build.subscribe((event) => {
      events.push(describeEvent(event))
    })
    build.add(
      new Task({
        id: "t",
        outputs: [new IdPrefix("mem:p/")],
        run: async (ctx) => {
          ctx.produced(a)
          ctx.produced(a)
        },
      }),
    )

    await build.run()
    build.remove("t")
    expect(events).toEqual([
      "promised mem:p/",
      "produced mem:p/a",
      "produced mem:p/a",
      "withdrawn mem:p/",
    ])
  })

  test("a replacement owns the outputs it declares, even if it is removed before it runs", async () => {
    const a = new Mem("mem:a")
    const events: string[] = []
    const build = new Build()
    build.subscribe((event) => {
      events.push(describeEvent(event))
    })
    build.add(new Task({ id: "t", outputs: [a], run: async () => {} }))
    await build.run()

    build.add(new Task({ id: "t", outputs: [a], run: async () => {} }))
    expect(events).toEqual(["promised mem:a", "produced mem:a"])
    build.remove("t")
    expect(events).toEqual(["promised mem:a", "produced mem:a", "withdrawn mem:a"])
  })


  test("replacing a running task withdraws the outputs the new task does not declare, at once", async () => {
    const a = new Mem("mem:a")
    const events: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const reached = new Promise<void>((resolve) => {
      started = resolve
    })
    const build = new Build()
    build.subscribe((event) => {
      events.push(describeEvent(event))
    })
    build.add(
      new Task({
        id: "t",
        outputs: [a],
        run: async (ctx) => {
          ctx.produced(a)
          started()
          await gate
        },
      }),
    )

    const running = build.run()
    await reached
    build.add(new Task({ id: "t", run: async () => {} }))
    expect(events).toEqual(["promised mem:a", "produced mem:a", "withdrawn mem:a"])
    release()
    const result = await running
    expect(result.success).toBe(true)
    expect(events).toEqual(["promised mem:a", "produced mem:a", "withdrawn mem:a"])
  })

  test("a subscriber that removes the writer on its first declared output stops the later ones", async () => {
    const a = new Mem("mem:a")
    const b = new Mem("mem:b")
    const events: string[] = []
    const build = new Build()
    build.subscribe((event) => {
      events.push(describeEvent(event))
      if (event.kind === "produced" && event.artifact === a) build.remove("t")
    })
    build.add(new Task({ id: "t", outputs: [a, b], run: async () => {} }))

    const result = await build.run()
    expect(events).toEqual([
      "promised mem:a",
      "promised mem:b",
      "produced mem:a",
      "withdrawn mem:a",
      "withdrawn mem:b",
    ])
    expect(result.cancelled.map((task) => task.id)).toEqual(["t"])
    expect(result.success).toBe(true)
  })

  for (const honoursSignal of [true, false]) {
    const name = honoursSignal ? "ignores the abort error" : "keeps any other error"
    test(`a removed running task ${name}`, async () => {
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let started!: () => void
      const reached = new Promise<void>((resolve) => {
        started = resolve
      })
      const build = new Build()
      build.add(
        new Task({
          id: "t",
          run: async (ctx) => {
            started()
            await gate
            if (honoursSignal) {
              ctx.signal.throwIfAborted()
            }
            throw new Error("real bug")
          },
        }),
      )

      const running = build.run()
      await reached
      build.remove("t")
      release()
      const result = await running

      expect(result.cancelled.map((task) => task.id)).toEqual(["t"])
      expect(result.failed.size).toBe(0)
      if (honoursSignal) {
        expect(result.errors).toEqual([])
        expect(result.success).toBe(true)
      } else {
        expect(result.errors.map((error) => error.message)).toEqual(["real bug"])
        expect(result.success).toBe(false)
      }
    })
  }

  test("run() waits for a store delete, and a delete that rejects goes to result.errors", async () => {
    class SlowBrokenDeleteStore extends MemoryStore {
      override async delete(id: string): Promise<void> {
        await new Promise<void>((resolve) => setTimeout(resolve, 20))
        throw new Error(`delete broke on ${id}`)
      }
    }
    const build = new Build({ store: new SlowBrokenDeleteStore() })
    build.add(new Task({ id: "victim", inputs: [new Mem("mem:never")], outputs: [new Mem("mem:v")], run: async () => {} }))
    build.add(
      new Task({
        id: "remover",
        run: async (ctx) => {
          ctx.remove("victim")
        },
      }),
    )

    const result = await build.run()
    expect(result.success).toBe(false)
    expect(result.errors.map((error) => error.message)).toEqual(["delete broke on victim"])
  })

  test("a store delete that throws at once does not stop build.remove", async () => {
    class ThrowingDeleteStore extends MemoryStore {
      override delete(): Promise<void> {
        throw new Error("delete broke at once")
      }
    }
    const events: string[] = []
    const build = new Build({ store: new ThrowingDeleteStore() })
    build.subscribe((event) => {
      events.push(describeEvent(event))
    })
    build.add(new Task({ id: "t", outputs: [new Mem("mem:a")], run: async () => {} }))
    await build.run()

    build.remove("t")
    expect(events).toEqual(["promised mem:a", "produced mem:a", "withdrawn mem:a"])
    const second = await build.run()
    expect(second.errors.map((error) => error.message)).toEqual(["delete broke at once"])
  })

  test("a fatal error during the stamp reads of a task stops its store record", async () => {
    /** An artifact whose stamp takes time to read, after the task wrote it. */
    class SlowStamp extends Mem {
      override async stamp(): Promise<string | null> {
        if (this.value === null) return null
        await new Promise<void>((resolve) => setTimeout(resolve, 30))
        return this.value
      }
    }
    const store = new MemoryStore()
    const slow = new SlowStamp("mem:slow")
    const build = new Build({ store })
    build.subscribe((event) => {
      if (event.kind === "produced" && event.taskId === "b") throw new Error("late fatal")
    })
    build.add(
      new Task({
        id: "a",
        outputs: [slow],
        run: async () => {
          slow.write("a")
        },
      }),
    )
    // Its produced event comes while "a" reads its stamps.
    build.add(
      new Task({
        id: "b",
        outputs: [new Mem("mem:b")],
        run: async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 10))
        },
      }),
    )

    await expect(build.run()).rejects.toThrow("late fatal")
    expect(await store.get("a")).toBeNull()
  })

  test("task can add another task during run", async () => {
    const done = new Mem("mem:done")
    const childOut = new Mem("mem:child")
    const executed: string[] = []

    const build = new Build()
    build.add(
      new Task({
        id: "parent",
        outputs: [done],
        run: async (ctx) => {
          executed.push("parent")
          done.write("p")
          ctx.add(
            new Task({
              id: "child",
              inputs: [done],
              outputs: [childOut],
              run: async () => {
                executed.push("child")
                childOut.write("c")
              },
            }),
          )
        },
      }),
    )

    const result = await build.run()
    expect(result.success).toBe(true)
    expect(executed).toEqual(["parent", "child"])
  })
})

describe("the skip rule", () => {
  /** A task "compile" that reads `src` and writes `out`. It counts its runs in `runs.count`. */
  function compile(inputs: Mem[], out: Mem, runs: { count: number }): Task {
    return new Task({
      id: "compile",
      inputs,
      outputs: [out],
      run: async () => {
        runs.count += 1
        out.write("obj")
      },
    })
  }

  /** Runs `task` in a new build with `store`, and returns the ids that ran and skipped. */
  async function runOnce(task: Task, store?: MemoryStore): Promise<{ executed: string[]; skipped: string[] }> {
    const build = new Build({ store })
    build.add(task)
    const result = await build.run()
    expect(result.success).toBe(true)
    const executed: string[] = []
    for (const done of result.executed) {
      executed.push(done.id)
    }
    const skipped: string[] = []
    for (const done of result.skipped) {
      skipped.push(done.id)
    }
    return { executed, skipped }
  }

  test("no store: the task runs each time", async () => {
    const src = new Mem("mem:src", "a")
    const out = new Mem("mem:out")
    const runs = { count: 0 }

    await runOnce(compile([src], out, runs))
    const second = await runOnce(compile([src], out, runs))
    expect(second.executed).toEqual(["compile"])
    expect(runs.count).toBe(2)
  })

  test("no record: the task runs and writes a record of its stamps", async () => {
    const src = new Mem("mem:src", "a")
    const out = new Mem("mem:out", "old")
    const store = new MemoryStore()
    const runs = { count: 0 }

    const first = await runOnce(compile([src], out, runs), store)
    expect(first.executed).toEqual(["compile"])
    expect(await store.get("compile")).toEqual({
      inputStamps: { "artifact mem:src": "a" },
      outputStamps: { "artifact mem:out": "obj" },
    })
  })

  test("same stamps: the task skips", async () => {
    const src = new Mem("mem:src", "a")
    const out = new Mem("mem:out")
    const store = new MemoryStore()
    const runs = { count: 0 }

    await runOnce(compile([src], out, runs), store)
    const second = await runOnce(compile([src], out, runs), store)
    expect(second.skipped).toEqual(["compile"])
    expect(runs.count).toBe(1)
  })

  test("an input changed: the task runs", async () => {
    const src = new Mem("mem:src", "a")
    const out = new Mem("mem:out")
    const store = new MemoryStore()
    const runs = { count: 0 }

    await runOnce(compile([src], out, runs), store)
    src.write("b")
    const second = await runOnce(compile([src], out, runs), store)
    expect(second.executed).toEqual(["compile"])
    expect(runs.count).toBe(2)
  })

  test("an output changed: the task runs", async () => {
    const src = new Mem("mem:src", "a")
    const out = new Mem("mem:out")
    const store = new MemoryStore()
    const runs = { count: 0 }

    await runOnce(compile([src], out, runs), store)
    out.write("edited by hand")
    const second = await runOnce(compile([src], out, runs), store)
    expect(second.executed).toEqual(["compile"])
    expect(out.value).toBe("obj")
  })

  test("an output is missing: the task runs", async () => {
    const src = new Mem("mem:src", "a")
    const out = new Mem("mem:out")
    const store = new MemoryStore()
    const runs = { count: 0 }

    await runOnce(compile([src], out, runs), store)
    out.value = null
    const second = await runOnce(compile([src], out, runs), store)
    expect(second.executed).toEqual(["compile"])
    expect(runs.count).toBe(2)
  })

  test("the input ids changed: the task runs", async () => {
    const src = new Mem("mem:src", "a")
    const extra = new Mem("mem:extra", "e")
    const out = new Mem("mem:out")
    const store = new MemoryStore()
    const runs = { count: 0 }

    await runOnce(compile([src], out, runs), store)
    const second = await runOnce(compile([src, extra], out, runs), store)
    expect(second.executed).toEqual(["compile"])
    const third = await runOnce(compile([src], out, runs), store)
    expect(third.executed).toEqual(["compile"])
    expect(runs.count).toBe(3)
  })

  test("a missing input that is still missing: the task skips", async () => {
    const optional = new Mem("mem:optional")
    const out = new Mem("mem:out")
    const store = new MemoryStore()
    const runs = { count: 0 }

    await runOnce(compile([optional], out, runs), store)
    expect(await store.get("compile")).toEqual({
      inputStamps: { "artifact mem:optional": null },
      outputStamps: { "artifact mem:out": "obj" },
    })
    const second = await runOnce(compile([optional], out, runs), store)
    expect(second.skipped).toEqual(["compile"])
  })

  test("a record in the old shape counts as no record: the task runs and writes a new record", async () => {
    const src = new Mem("mem:src", "a")
    const out = new Mem("mem:out", "obj")
    const store = new MemoryStore()
    // The shape that dapat wrote before one stamp per artifact.
    const oldRecord = {
      inputStamps: { "mem:src": { order: 1n, content: "a" } },
      outputStamps: { "mem:out": { order: 2n, content: "obj" } },
    }
    await store.set("compile", oldRecord as unknown as TaskState)
    const runs = { count: 0 }

    const first = await runOnce(compile([src], out, runs), store)
    expect(first.executed).toEqual(["compile"])
    expect(await store.get("compile")).toEqual({
      inputStamps: { "artifact mem:src": "a" },
      outputStamps: { "artifact mem:out": "obj" },
    })
    const second = await runOnce(compile([src], out, runs), store)
    expect(second.skipped).toEqual(["compile"])
  })

  test("a task with only prefix outputs runs on each build", async () => {
    const store = new MemoryStore()
    let runs = 0
    const split = () =>
      new Task({
        id: "split",
        outputs: [new IdPrefix("mem:pages/")],
        run: async (ctx) => {
          runs += 1
          ctx.produced(new Mem("mem:pages/1", "p1"))
        },
      })

    await runOnce(split(), store)
    const second = await runOnce(split(), store)
    expect(second.executed).toEqual(["split"])
    expect(runs).toBe(2)
  })

  test("a task with no inputs and no outputs runs on each build", async () => {
    const store = new MemoryStore()
    let runs = 0
    const deploy = () =>
      new Task({
        id: "deploy",
        run: async () => {
          runs += 1
        },
      })

    await runOnce(deploy(), store)
    const second = await runOnce(deploy(), store)
    expect(second.executed).toEqual(["deploy"])
    expect(runs).toBe(2)
  })

  test("a task with a plain prefix input and no artifact output runs on each build", async () => {
    const store = new MemoryStore()
    let runs = 0
    const index = () =>
      new Task({
        id: "index",
        inputs: [new IdPrefix("mem:pages/")],
        run: async () => {
          runs += 1
        },
      })

    await runOnce(index(), store)
    const second = await runOnce(index(), store)
    expect(second.executed).toEqual(["index"])
    expect(runs).toBe(2)
  })

  test("an input that changes during the run makes the next build run", async () => {
    const src = new Mem("mem:src", "a")
    const out = new Mem("mem:out")
    const store = new MemoryStore()
    let runs = 0
    const make = () =>
      new Task({
        id: "compile",
        inputs: [src],
        outputs: [out],
        run: async () => {
          runs += 1
          out.write(`compiled ${src.value}`)
          // Someone edits the input after the task read it.
          if (runs === 1) src.write("b")
        },
      })

    await runOnce(make(), store)
    expect(out.value).toBe("compiled a")
    const record = await store.get("compile")
    expect(record?.inputStamps["artifact mem:src"]).toBe("a")

    const second = await runOnce(make(), store)
    expect(second.executed).toEqual(["compile"])
    expect(out.value).toBe("compiled b")
    const third = await runOnce(make(), store)
    expect(third.skipped).toEqual(["compile"])
  })

  test("a stamp() that throws fails the task, and the tasks that read its outputs", async () => {
    class Broken extends Mem {
      override async stamp(): Promise<string | null> {
        throw new Error(`cannot stamp ${this.id}`)
      }
    }
    const broken = new Broken("mem:broken", "x")
    const mid = new Mem("mem:mid")
    const out = new Mem("mem:out")
    let runs = 0
    const build = new Build({ store: new MemoryStore() })
    build.add(
      new Task({
        id: "first",
        inputs: [broken],
        outputs: [mid],
        run: async () => {
          runs += 1
        },
      }),
    )
    build.add(
      new Task({
        id: "second",
        inputs: [mid],
        outputs: [out],
        run: async () => {
          runs += 1
        },
      }),
    )

    const result = await build.run()
    expect(result.success).toBe(false)
    expect(runs).toBe(0)
    const messages: string[] = []
    for (const [task, error] of result.failed) {
      messages.push(`${task.id}: ${error.message}`)
    }
    messages.sort()
    expect(messages).toEqual([
      "first: cannot stamp mem:broken",
      "second: dependency of 'second' failed",
    ])
  })

  test("without a store, the build reads no stamps", async () => {
    let reads = 0
    class Counted extends Mem {
      override async stamp(): Promise<string | null> {
        reads += 1
        return this.value
      }
    }
    const src = new Counted("mem:src", "a")
    const out = new Counted("mem:out")
    const runs = { count: 0 }

    await runOnce(compile([src], out, runs))
    await runOnce(compile([src], out, runs))
    expect(runs.count).toBe(2)
    expect(reads).toBe(0)
  })

  test("an artifact id \"__proto__\" keeps its stamp in the record", async () => {
    const src = new Mem("__proto__", "a")
    const out = new Mem("mem:out")
    const store = new MemoryStore()
    const runs = { count: 0 }

    await runOnce(compile([src], out, runs), store)
    const record = await store.get("compile")
    expect(Object.keys(record?.inputStamps ?? {})).toEqual(["artifact __proto__"])
    const second = await runOnce(compile([src], out, runs), store)
    expect(second.skipped).toEqual(["compile"])
    src.write("b")
    const third = await runOnce(compile([src], out, runs), store)
    expect(third.executed).toEqual(["compile"])
  })

  test("a prefix and an artifact with the same id keep separate stamps in the record", async () => {
    const page = new Mem("mem:pages/a", "A")
    const prefix = new MemPrefix("mem:pages/", [page])
    const listing = new Mem("mem:pages/", "a")
    const out = new Mem("mem:out")
    const store = new MemoryStore()
    const runs = { count: 0 }
    const read = () =>
      new Task({
        id: "read",
        inputs: [prefix, listing],
        outputs: [out],
        run: async () => {
          runs.count += 1
          out.write("x")
        },
      })

    await runOnce(read(), store)
    const record = await store.get("read")
    const keys = Object.keys(record!.inputStamps)
    keys.sort()
    expect(keys).toEqual([`artifact ${listing.id}`, `prefix ${prefix.id}`])
    const second = await runOnce(read(), store)
    expect(second.skipped).toEqual(["read"])
  })

  test("a record keyed by bare ids, as PR 7 wrote it, makes the task run once and then skip", async () => {
    const src = new Mem("mem:src", "a")
    const out = new Mem("mem:out", "obj")
    const store = new MemoryStore()
    const runs = { count: 0 }
    const bareRecord: TaskState = {
      inputStamps: { "mem:src": "a" },
      outputStamps: { "mem:out": "obj" },
    }
    await store.set("compile", bareRecord)

    const first = await runOnce(compile([src], out, runs), store)
    expect(first.executed).toEqual(["compile"])
    expect(await store.get("compile")).toEqual({
      inputStamps: { "artifact mem:src": "a" },
      outputStamps: { "artifact mem:out": "obj" },
    })
    const second = await runOnce(compile([src], out, runs), store)
    expect(second.skipped).toEqual(["compile"])
    expect(runs.count).toBe(1)
  })

  test("a record whose stamp maps are arrays counts as no record", async () => {
    // The input id "0" matches the array index, so only the shape check stops a skip.
    const src = new Mem("0", "a")
    const out = new Mem("mem:out", "obj")
    const store = new MemoryStore()
    const badRecord = { inputStamps: ["a"], outputStamps: { "mem:out": "obj" } }
    await store.set("compile", badRecord as unknown as TaskState)
    const runs = { count: 0 }

    const first = await runOnce(compile([src], out, runs), store)
    expect(first.executed).toEqual(["compile"])
  })
})

describe("promised and withdrawn events", () => {
  test("run() sends promised for each task added before it, before any task starts", async () => {
    const a = new Mem("mem:a")
    const log: string[] = []
    const build = new Build()
    build.add(
      new Task({
        id: "t",
        outputs: [a, new IdPrefix("mem:p/")],
        run: async () => {
          log.push("t runs")
        },
      }),
    )
    // A subscriber that subscribes after add still hears the promised events.
    build.subscribe((event) => {
      log.push(`${describeEvent(event)} by ${event.taskId}`)
    })
    expect(log).toEqual([])

    const first = await build.run()
    expect(first.success).toBe(true)
    expect(log).toEqual([
      "promised mem:a by t",
      "promised mem:p/ by t",
      "t runs",
      "produced mem:a by t",
    ])

    // A second run() does not send them again.
    await build.run()
    expect(log.length).toBe(4)
  })

  test("a task added during or after a run sends promised at add time", async () => {
    const c = new Mem("mem:c")
    const d = new Mem("mem:d")
    const log: string[] = []
    const build = new Build()
    build.subscribe((event) => {
      log.push(`${describeEvent(event)} by ${event.taskId}`)
    })
    build.add(
      new Task({
        id: "parent",
        run: async (ctx) => {
          ctx.add(new Task({ id: "child", outputs: [c], run: async () => {} }))
          log.push("ctx.add returned")
        },
      }),
    )

    await build.run()
    expect(log).toEqual(["promised mem:c by child", "ctx.add returned", "produced mem:c by child"])

    build.add(new Task({ id: "later", outputs: [d], run: async () => {} }))
    expect(log.slice(3)).toEqual(["promised mem:d by later"])
  })

  test("remove sends withdrawn for each exact and prefix output", async () => {
    const a = new Mem("mem:a")
    const child = new Mem("mem:p/1")
    const log: string[] = []
    const build = new Build()
    build.subscribe((event) => {
      log.push(`${describeEvent(event)} by ${event.taskId}`)
    })
    build.add(
      new Task({
        id: "t",
        outputs: [a, new IdPrefix("mem:p/")],
        run: async (ctx) => {
          ctx.produced(child)
        },
      }),
    )
    await build.run()
    log.length = 0

    build.remove("t")
    expect(log).toEqual(["withdrawn mem:a by t", "withdrawn mem:p/ by t"])
  })

  test("a task removed before run() sends no events; a task removed during the first sends gets promised, then withdrawn", async () => {
    const a = new Mem("mem:a")
    const b = new Mem("mem:b")
    const log: string[] = []
    const build = new Build()
    build.add(new Task({ id: "gone", outputs: [a], run: async () => {} }))
    build.remove("gone")
    build.add(new Task({ id: "first", outputs: [b], run: async () => {} }))
    build.add(new Task({ id: "doomed", outputs: [a], run: async () => {} }))
    build.subscribe((event) => {
      log.push(`${describeEvent(event)} by ${event.taskId}`)
      // Removes "doomed" during the sends at the start of run(), before its turn.
      if (event.kind === "promised" && event.taskId === "first") build.remove("doomed")
    })

    const result = await build.run()
    expect(result.success).toBe(true)
    expect(result.cancelled.map((task) => task.id)).toEqual(["gone", "doomed"])
    // The promised event of "doomed" was already in the queue, and its withdrawn event comes after it.
    expect(log).toEqual([
      "promised mem:b by first",
      "promised mem:a by doomed",
      "withdrawn mem:a by doomed",
      "produced mem:b by first",
    ])
  })

  test("replacement sends withdrawn and promised only for the outputs that changed", async () => {
    const a = new Mem("mem:a")
    const b = new Mem("mem:b")
    const c = new Mem("mem:c")
    const log: string[] = []
    const build = new Build()
    build.subscribe((event) => {
      log.push(`${describeEvent(event)} by ${event.taskId}`)
    })
    build.add(new Task({ id: "t", outputs: [a, b, new IdPrefix("mem:p/")], run: async () => {} }))
    await build.run()
    log.length = 0

    build.add(new Task({ id: "t", outputs: [b, c, new IdPrefix("mem:p/")], run: async () => {} }))
    expect(log).toEqual(["withdrawn mem:a by t", "promised mem:c by t"])
  })

  test("a replacement before run() sends only the promised events of the new task", async () => {
    const a = new Mem("mem:a")
    const b = new Mem("mem:b")
    const log: string[] = []
    const build = new Build()
    build.subscribe((event) => {
      if (event.kind === "produced") return
      log.push(`${describeEvent(event)} by ${event.taskId}`)
    })
    build.add(new Task({ id: "t", outputs: [a], run: async () => {} }))
    build.add(new Task({ id: "t", outputs: [b], run: async () => {} }))
    expect(log).toEqual([])

    await build.run()
    expect(log).toEqual(["promised mem:b by t"])
  })

  test("a subscriber error on promised at the start of run() rejects run(), and no task runs", async () => {
    const a = new Mem("mem:a")
    const b = new Mem("mem:b")
    const heard: string[] = []
    let ran = false
    const build = new Build()
    build.subscribe((event) => {
      if (event.kind !== "promised") return
      throw new Error(`promise broke on ${event.output.id}`)
    })
    build.subscribe((event) => {
      heard.push(describeEvent(event))
    })
    build.add(
      new Task({
        id: "t",
        outputs: [a, b],
        run: async () => {
          ran = true
        },
      }),
    )

    await expect(build.run()).rejects.toThrow("promise broke on mem:a")
    expect(ran).toBe(false)
    // The throw stops that event for later subscribers, and the queue is cleared.
    expect(heard).toEqual([])
  })

  test("a subscriber error on promised from ctx.add rejects run(), and the new task does not run", async () => {
    const c = new Mem("mem:c")
    let addReturned = false
    let childRan = false
    const build = new Build()
    build.subscribe((event) => {
      if (event.kind === "promised" && event.taskId === "child") throw new Error("promise broke")
    })
    build.add(
      new Task({
        id: "parent",
        run: async (ctx) => {
          const child = new Task({
            id: "child",
            outputs: [c],
            run: async () => {
              childRan = true
            },
          })
          ctx.add(child)
          addReturned = true
        },
      }),
    )

    await expect(build.run()).rejects.toThrow("promise broke")
    expect(addReturned).toBe(true)
    expect(childRan).toBe(false)
  })


  test("for each output, promised comes before produced, and nothing comes after withdrawn", async () => {
    const one = new Mem("mem:p/1")
    const two = new Mem("mem:p/2")
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const log: string[] = []
    const problems: string[] = []
    // The outputs of each task id that are promised and not withdrawn.
    const live = new Map<string, Ref[]>()

    const build = new Build()
    // The first subscriber sees the events in the order that the build sends them.
    build.subscribe((event) => {
      const line = `${describeEvent(event)} by ${event.taskId}`
      log.push(line)
      const outputs = live.get(event.taskId) ?? []
      if (event.kind === "promised") {
        if (findOutput(outputs, event.output.id) !== null) problems.push(`again: ${line}`)
        outputs.push(event.output)
        live.set(event.taskId, outputs)
        return
      }
      if (event.kind === "withdrawn") {
        const found = findOutput(outputs, event.output.id)
        if (found === null) {
          problems.push(`not promised: ${line}`)
          return
        }
        outputs.splice(outputs.indexOf(found), 1)
        return
      }
      if (!coveredBy(outputs, event.artifact)) problems.push(`not promised: ${line}`)
    })
    build.subscribe((event) => {
      if (event.kind === "promised" && event.taskId === "split") build.remove("doomed")
      if (event.kind !== "produced" || event.taskId !== "split") return
      const n = event.artifact.id.slice("mem:p/".length)
      build.add(
        new Task({
          id: `use:${n}`,
          inputs: [event.artifact],
          outputs: [new Mem(`mem:out/${n}`)],
          run: async () => {
            await gate
          },
        }),
      )
    })
    build.add(
      new Task({
        id: "split",
        outputs: [new IdPrefix("mem:p/")],
        run: async (ctx) => {
          ctx.produced(one)
          await new Promise<void>((resolve) => setTimeout(resolve, 1))
          ctx.produced(two)
        },
      }),
    )
    build.add(new Task({ id: "doomed", outputs: [new Mem("mem:doomed")], run: async () => {} }))
    build.add(
      new Task({
        id: "editor",
        inputs: [new IdPrefix("mem:p/")],
        run: async (ctx) => {
          ctx.remove("use:2")
          ctx.add(
            new Task({
              id: "use:1",
              inputs: [one],
              outputs: [new Mem("mem:out/1b")],
              run: async () => {
                await gate
              },
            }),
          )
          release()
        },
      }),
    )

    const result = await build.run()
    expect(result.success).toBe(true)
    expect(problems).toEqual([])
    expect(log).toEqual([
      "promised mem:p/ by split",
      // The second subscriber removed "doomed" during the first event. Its promised event was already queued.
      "promised mem:doomed by doomed",
      "withdrawn mem:doomed by doomed",
      "produced mem:p/1 by split",
      "promised mem:out/1 by use:1",
      "produced mem:p/2 by split",
      "promised mem:out/2 by use:2",
      "withdrawn mem:out/2 by use:2",
      "withdrawn mem:out/1 by use:1",
      "promised mem:out/1b by use:1",
      "produced mem:out/1b by use:1",
    ])
  })

  describe("the event queue", () => {
    test("two subscribers get every event in one order, and a stale event is followed by its correction", async () => {
      const x = new Mem("mem:x")
      const y = new Mem("mem:y")
      const logs: string[][] = [[], []]
      // For each output id, the task that promised it, as each subscriber sees it.
      const promisers = [new Map<string, string>(), new Map<string, string>()]
      let replaced = false
      const build = new Build()
      for (let i = 0; i < 2; i++) {
        const log = logs[i]!
        const promiser = promisers[i]!
        build.subscribe((event) => {
          log.push(`${describeEvent(event)} by ${event.taskId}`)
          if (event.kind === "promised") promiser.set(event.output.id, event.taskId)
          if (event.kind === "withdrawn") promiser.delete(event.output.id)
          // Subscriber 1 replaces t during the first "promised mem:x by t".
          if (i !== 0 || replaced) return
          if (event.kind !== "promised" || event.output.id !== "mem:x") return
          replaced = true
          build.add(new Task({ id: "t", outputs: [y], run: async () => {} }))
        })
      }
      build.add(new Task({ id: "t", outputs: [x], run: async () => {} }))

      const result = await build.run()
      expect(result.success).toBe(true)
      const expected = [
        "promised mem:x by t",
        "withdrawn mem:x by t",
        "promised mem:y by t",
        "produced mem:y by t",
      ]
      expect(logs[0]).toEqual(expected)
      expect(logs[1]).toEqual(expected)
      // Subscriber 2 got "promised mem:x" after t no longer declared it, and then its withdrawn event.
      // Each subscriber applied the events in order and ends with the true state.
      const truth = new Map<string, string>([["mem:y", "t"]])
      expect(promisers[0]).toEqual(truth)
      expect(promisers[1]).toEqual(truth)
    })

    test("a subscriber that changes tasks during a send gets the new events after the current event reached every subscriber", async () => {
      const a = new Mem("mem:a")
      const log: string[] = []
      const build = new Build()
      build.subscribe((event) => {
        log.push(`1: ${describeEvent(event)}`)
        if (event.kind === "produced") build.remove("t")
      })
      build.subscribe((event) => {
        log.push(`2: ${describeEvent(event)}`)
      })
      build.add(new Task({ id: "t", outputs: [a], run: async () => {} }))

      const result = await build.run()
      expect(result.cancelled.map((task) => task.id)).toEqual(["t"])
      expect(log).toEqual([
        "1: promised mem:a",
        "2: promised mem:a",
        "1: produced mem:a",
        "2: produced mem:a",
        "1: withdrawn mem:a",
        "2: withdrawn mem:a",
      ])
    })

    test("a subscriber error during a top-level build.add after a run rejects the next run(), which runs nothing", async () => {
      const a = new Mem("mem:a")
      let ran = false
      const build = new Build()
      const first = await build.run()
      expect(first.success).toBe(true)
      build.subscribe((event) => {
        if (event.kind === "promised") throw new Error("promise broke")
      })

      build.add(
        new Task({
          id: "t",
          outputs: [a],
          run: async () => {
            ran = true
          },
        }),
      )
      await expect(build.run()).rejects.toThrow("promise broke")
      // Gives a task that started at add time the chance to run.
      await new Promise<void>((resolve) => setTimeout(resolve, 1))
      expect(ran).toBe(false)
    })

    test("a subscriber that undoes every change stops at the send limit", async () => {
      const x = new Mem("mem:x")
      const make = () => new Task({ id: "t", outputs: [x], run: () => new Promise<void>(() => {}) })
      const build = new Build()
      build.subscribe((event) => {
        if (event.kind === "promised") build.remove("t")
        if (event.kind === "withdrawn") build.add(make())
      })
      build.add(make())

      // The first event started the drain. The subscriber caused each later one.
      await expect(build.run()).rejects.toThrow(
        `send limit: subscribers caused ${SEND_LIMIT} events in one drain, and more wait; ` +
          "the last sent was 'promised mem:x by t'",
      )
    })

    test("the send-limit error cuts each long id", async () => {
      const longId = `mem:${"x".repeat(20_000)}`
      const make = () => new Task({ id: "t", outputs: [new Mem(longId)], run: async () => {} })
      const build = new Build({ sendLimit: 5 })
      build.subscribe((event) => {
        if (event.kind === "promised") build.remove("t")
        if (event.kind === "withdrawn") build.add(make())
      })
      build.add(make())

      const error = await build.run().then(
        () => null,
        (reason: Error) => reason,
      )

      expect(error).not.toBeNull()
      expect(error!.message).toContain(`'withdrawn ${longId.slice(0, 200)}… by t'`)
      expect(error!.message.length).toBeLessThan(400)
    })

    test("the sendLimit option sets the limit", async () => {
      let sent = 0
      const build = new Build({ sendLimit: 5 })
      build.subscribe((event) => {
        sent += 1
        if (event.kind === "promised") build.remove("t")
        if (event.kind === "withdrawn") build.add(new Task({ id: "t", outputs: [new Mem("mem:x")], run: async () => {} }))
      })
      build.add(new Task({ id: "t", outputs: [new Mem("mem:x")], run: async () => {} }))

      await expect(build.run()).rejects.toThrow(
        "send limit: subscribers caused 5 events in one drain, and more wait; the last sent was 'withdrawn mem:x by t'",
      )
      expect(sent).toBe(6)
    })

    test("the send limit does not count the events of the call that started the drain", async () => {
      const build = new Build({ sendLimit: 3 })
      for (let i = 0; i < 10; i++) {
        build.add(new Task({ id: `t${i}`, outputs: [new Mem(`mem:${i}`)], run: async () => {} }))
      }
      const first = await build.run()
      expect(first.executed.length).toBe(10)

      class Owner extends Build {
        give(tasks: Task[]): void {
          this.setTasks("owner", tasks)
        }
      }
      const owner = new Owner({ sendLimit: 3 })
      await owner.run()
      const tasks: Task[] = []
      for (let i = 0; i < 10; i++) {
        tasks.push(new Task({ id: `t${i}`, outputs: [new Mem(`mem:${i}`)], run: async () => {} }))
      }
      owner.give(tasks)
      const second = await owner.run()
      expect(second.executed.length).toBe(10)
    })

    test("the constructor rejects a send limit that is not a positive integer", () => {
      expect(() => new Build({ sendLimit: 0 })).toThrow("sendLimit must be a positive integer, not 0")
      expect(() => new Build({ sendLimit: -1 })).toThrow("sendLimit must be a positive integer, not -1")
      expect(() => new Build({ sendLimit: Number.NaN })).toThrow("sendLimit must be a positive integer, not NaN")
      expect(() => new Build({ sendLimit: 1.5 })).toThrow("sendLimit must be a positive integer, not 1.5")
      // A string from untyped code shows its quotes.
      const fromConfig = JSON.parse('{"sendLimit": "10"}') as { sendLimit: number }
      expect(() => new Build(fromConfig)).toThrow('sendLimit must be a positive integer, not "10"')
    })

    test("the events of an abort listener that changes tasks come after the events of the change that aborted it", async () => {
      const a = new Mem("mem:a")
      const b = new Mem("mem:b")
      const c = new Mem("mem:c")
      const log: string[] = []
      const promiser = new Map<string, string>()
      let started!: () => void
      const reached = new Promise<void>((resolve) => {
        started = resolve
      })
      const build = new Build()
      build.subscribe((event) => {
        log.push(`${describeEvent(event)} by ${event.taskId}`)
        if (event.kind === "promised") promiser.set(event.output.id, event.taskId)
        if (event.kind === "withdrawn") promiser.delete(event.output.id)
      })
      build.add(
        new Task({
          id: "t",
          outputs: [a],
          run: async (ctx) => {
            // Clean-up code that declares t again, with another output.
            ctx.signal.addEventListener("abort", () => {
              ctx.add(new Task({ id: "t", outputs: [c], run: () => new Promise<void>(() => {}) }))
            })
            started()
            await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve()))
          },
        }),
      )

      const running = build.run()
      await reached
      build.add(new Task({ id: "t", outputs: [b], run: async () => {} }))
      expect(log).toEqual([
        "promised mem:a by t",
        "withdrawn mem:a by t",
        "promised mem:b by t",
        "withdrawn mem:b by t",
        "promised mem:c by t",
      ])
      expect(promiser).toEqual(new Map([["mem:c", "t"]]))
      build.remove("t")
      await running
    })
  })

  describe("a task added after run() started", () => {
    test("waits for a producer that the same synchronous code adds later", async () => {
      const dep = new Mem("mem:dep")
      const log: string[] = []
      const build = new Build()
      await build.run()

      build.add(
        new Task({
          id: "consumer",
          inputs: [dep],
          run: async () => {
            log.push(`consumer reads ${dep.value}`)
          },
        }),
      )
      build.add(
        new Task({
          id: "producer",
          outputs: [dep],
          run: async () => {
            await new Promise<void>((resolve) => setTimeout(resolve, 10))
            dep.write("v")
            log.push("producer wrote")
          },
        }),
      )
      const result = await build.run()
      expect(result.success).toBe(true)
      expect(log).toEqual(["producer wrote", "consumer reads v"])
    })

    test("waits for a producer that a subscriber adds in the same cascade", async () => {
      const dep = new Mem("mem:dep")
      const log: string[] = []
      const build = new Build()
      // Adds the producer when it hears about the consumer.
      build.subscribe((event) => {
        if (event.kind !== "promised" || event.taskId !== "consumer") return
        build.add(
          new Task({
            id: "producer",
            outputs: [dep],
            run: async () => {
              await new Promise<void>((resolve) => setTimeout(resolve, 10))
              dep.write("v")
              log.push("producer wrote")
            },
          }),
        )
      })
      await build.run()

      build.add(
        new Task({
          id: "consumer",
          inputs: [dep],
          outputs: [new Mem("mem:out")],
          run: async () => {
            log.push(`consumer reads ${dep.value}`)
          },
        }),
      )
      const result = await build.run()
      expect(result.success).toBe(true)
      expect(log).toEqual(["producer wrote", "consumer reads v"])
    })
  })

  test("an artifact and a prefix with the same id are different outputs", async () => {
    const log: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const build = new Build()
    build.subscribe((event) => {
      if (event.kind === "produced" || event.kind === "deleted") return
      const kind = isPrefix(event.output) ? "prefix" : "artifact"
      log.push(`${event.kind} ${kind} ${event.output.id}`)
    })
    const running = build.run()
    build.add(new Task({ id: "t", outputs: [new Mem("mem:out/")], run: () => gate }))
    build.add(new Task({ id: "t", outputs: [new IdPrefix("mem:out/")], run: async () => {} }))
    release()
    await running
    // A prefix that a task declares two times gets one event.
    build.add(
      new Task({
        id: "twice",
        outputs: [new IdPrefix("mem:two/"), new IdPrefix("mem:two/")],
        run: async () => {},
      }),
    )

    expect(log).toEqual([
      "promised artifact mem:out/",
      "withdrawn artifact mem:out/",
      "promised prefix mem:out/",
      "promised prefix mem:two/",
    ])
  })
})

describe("deleted events", () => {
  test("ctx.deleted sends a deleted event to each subscriber before it returns", async () => {
    const child = new Mem("mem:d/1")
    const kept = new Mem("mem:kept")
    const events: ArtifactEvent[] = []
    const log: string[] = []

    const build = new Build()
    build.subscribe((event) => {
      events.push(event)
      log.push(`${describeEvent(event)} by ${event.taskId}`)
    })
    build.add(
      new Task({
        id: "prune",
        outputs: [new IdPrefix("mem:d/"), kept],
        run: async (ctx) => {
          ctx.deleted(child)
          log.push("deleted returned")
          kept.write("k")
        },
      }),
    )

    const result = await build.run()
    expect(result.success).toBe(true)
    expect(log).toEqual([
      "promised mem:d/ by prune",
      "promised mem:kept by prune",
      "deleted mem:d/1 by prune",
      "deleted returned",
      "produced mem:kept by prune",
    ])
    expect(events[2]).toEqual({ kind: "deleted", artifact: child, taskId: "prune" })
  })

  test("ctx.deleted throws when no output covers the artifact", async () => {
    const other = new Mem("mem:other")
    const log: string[] = []
    const build = new Build()
    build.subscribe((event) => {
      log.push(describeEvent(event))
    })
    build.add(
      new Task({
        id: "prune",
        outputs: [new IdPrefix("mem:d/")],
        run: async (ctx) => {
          ctx.deleted(other)
        },
      }),
    )

    const result = await build.run()
    expect(result.success).toBe(false)
    const messages: string[] = []
    for (const error of result.failed.values()) {
      messages.push(error.message)
    }
    expect(messages).toEqual(["task 'prune' deleted 'mem:other', which no output covers"])
    expect(log).toEqual(["promised mem:d/"])
  })

  test("a subscriber error on deleted rejects run(), and ctx.deleted does not throw", async () => {
    const child = new Mem("mem:d/1")
    const store = new MemoryStore()
    let returned = false
    const build = new Build({ store })
    build.subscribe((event) => {
      if (event.kind === "deleted") {
        throw new Error(`listener broke on ${event.artifact.id}`)
      }
    })
    build.add(
      new Task({
        id: "prune",
        outputs: [new IdPrefix("mem:d/")],
        run: async (ctx) => {
          ctx.deleted(child)
          returned = true
        },
      }),
    )

    await expect(build.run()).rejects.toThrow("listener broke on mem:d/1")
    expect(returned).toBe(true)
    expect(await store.get("prune")).toBeNull()
  })

  test("the last report for an id wins, and a deleted declared output gets no produced event after the task returns", async () => {
    const gone = new Mem("mem:gone", "old")
    const back = new Mem("mem:back", "old")
    const regone = new Mem("mem:regone", "old")
    const src = new Mem("mem:src", "a")
    const log: string[] = []

    const build = new Build()
    build.subscribe((event) => {
      log.push(describeEvent(event))
    })
    build.add(
      new Task({
        id: "t",
        inputs: [src],
        outputs: [gone, back, regone],
        run: async (ctx) => {
          gone.value = null
          ctx.deleted(gone)
          back.value = null
          ctx.deleted(back)
          back.write("new")
          ctx.produced(back)
          regone.write("new")
          ctx.produced(regone)
          regone.value = null
          ctx.deleted(regone)
        },
      }),
    )

    const result = await build.run()
    expect(result.success).toBe(true)
    expect(log).toEqual([
      "promised mem:gone",
      "promised mem:back",
      "promised mem:regone",
      "deleted mem:gone",
      "deleted mem:back",
      "produced mem:back",
      "produced mem:regone",
      "deleted mem:regone",
    ])
  })

  test("a stopped task's ctx.deleted does nothing", async () => {
    const child = new Mem("mem:d/1")
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const reached = new Promise<void>((resolve) => {
      started = resolve
    })
    const log: string[] = []
    let threw = false

    const build = new Build()
    build.subscribe((event) => {
      log.push(describeEvent(event))
    })
    build.add(
      new Task({
        id: "prune",
        outputs: [new IdPrefix("mem:d/")],
        run: async (ctx) => {
          started()
          await gate
          try {
            ctx.deleted(child)
          } catch {
            threw = true
          }
        },
      }),
    )

    const running = build.run()
    await reached
    build.remove("prune")
    release()
    const result = await running

    expect(result.success).toBe(true)
    expect(result.cancelled.map((task) => task.id)).toEqual(["prune"])
    expect(threw).toBe(false)
    expect(log).toEqual(["promised mem:d/", "withdrawn mem:d/"])
  })

  test("a task that deletes a declared output runs again on the next build; a deletion under a prefix output does not stop a skip", async () => {
    const src = new Mem("mem:src", "a")
    const out = new Mem("mem:out", "old")
    const child = new Mem("mem:d/1", "old")
    const store = new MemoryStore()
    const runs: string[] = []

    const makeTasks = () => [
      new Task({
        id: "clean-out",
        inputs: [src],
        outputs: [out],
        run: async (ctx) => {
          runs.push("clean-out")
          out.value = null
          ctx.deleted(out)
        },
      }),
      new Task({
        id: "clean-dir",
        inputs: [src],
        // IdPrefix has a null stamp and always runs. This prefix can stamp what is under it.
        outputs: [new MemPrefix("mem:d/", [child])],
        run: async (ctx) => {
          runs.push("clean-dir")
          child.value = null
          ctx.deleted(child)
        },
      }),
    ]

    const first = new Build({ store })
    for (const task of makeTasks()) first.add(task)
    const r1 = await first.run()
    expect(r1.success).toBe(true)
    expect(runs.toSorted()).toEqual(["clean-dir", "clean-out"])
    // The record keeps null for the deleted output.
    expect(await store.get("clean-out")).toEqual({
      inputStamps: { "artifact mem:src": "a" },
      outputStamps: { "artifact mem:out": null },
    })

    const second = new Build({ store })
    for (const task of makeTasks()) second.add(task)
    const r2 = await second.run()
    expect(r2.success).toBe(true)
    expect(r2.executed.map((task) => task.id)).toEqual(["clean-out"])
    expect(r2.skipped.map((task) => task.id)).toEqual(["clean-dir"])
    expect(runs.toSorted()).toEqual(["clean-dir", "clean-out", "clean-out"])
  })

  test("for each output, promised comes before deleted, and nothing comes after withdrawn", async () => {
    const child = new Mem("mem:p/1")
    const declared = new Mem("mem:x", "old")
    const src = new Mem("mem:src", "a")
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const reached = new Promise<void>((resolve) => {
      started = resolve
    })
    const log: string[] = []
    const problems: string[] = []
    // The outputs of each task id that are promised and not withdrawn.
    const live = new Map<string, Ref[]>()

    const build = new Build()
    build.subscribe((event) => {
      const line = `${describeEvent(event)} by ${event.taskId}`
      log.push(line)
      const outputs = live.get(event.taskId) ?? []
      if (event.kind === "promised") {
        outputs.push(event.output)
        live.set(event.taskId, outputs)
        return
      }
      if (event.kind === "withdrawn") {
        const found = findOutput(outputs, event.output.id)
        if (found === null) {
          problems.push(`not promised: ${line}`)
          return
        }
        outputs.splice(outputs.indexOf(found), 1)
        return
      }
      if (!coveredBy(outputs, event.artifact)) problems.push(`not promised: ${line}`)
    })
    build.add(
      new Task({
        id: "split",
        inputs: [src],
        outputs: [new IdPrefix("mem:p/"), declared],
        run: async (ctx) => {
          ctx.deleted(child)
          declared.value = null
          ctx.deleted(declared)
        },
      }),
    )
    build.add(
      new Task({
        id: "slow",
        outputs: [new IdPrefix("mem:s/")],
        run: async (ctx) => {
          started()
          await gate
          ctx.deleted(new Mem("mem:s/1"))
        },
      }),
    )

    const running = build.run()
    await reached
    build.remove("slow")
    release()
    const result = await running
    build.remove("split")

    expect(result.success).toBe(true)
    expect(problems).toEqual([])
    const bySplit = log.filter((line) => line.endsWith(" by split"))
    expect(bySplit).toEqual([
      "promised mem:p/ by split",
      "promised mem:x by split",
      "deleted mem:p/1 by split",
      "deleted mem:x by split",
      "withdrawn mem:p/ by split",
      "withdrawn mem:x by split",
    ])
    const bySlow = log.filter((line) => line.endsWith(" by slow"))
    expect(bySlow).toEqual(["promised mem:s/ by slow", "withdrawn mem:s/ by slow"])
  })
})

function findOutput(outputs: readonly Ref[], id: string): Ref | null {
  for (const output of outputs) {
    if (output.id === id) return output
  }
  return null
}

function coveredBy(outputs: readonly Ref[], artifact: Artifact): boolean {
  for (const output of outputs) {
    if (output.id === artifact.id) return true
    if (isPrefix(output) && output.covers(artifact)) return true
  }
  return false
}
