import { describe, expect, test } from "bun:test"
import { Build, IdPrefix, MemoryStore, Task } from "../src/index"
import { Mem, MemDir } from "./mem"

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
          resultArt.write("ok", 2n, "ok")
        },
      }),
    )
    build.add(
      new Task({
        id: "producer",
        outputs: [data],
        run: async () => {
          executed.push("producer")
          data.write("v", 1n, "v")
        },
      }),
    )

    const result = await build.run()
    expect(result.success).toBe(true)
    expect(executed).toEqual(["producer", "consumer"])
  })

  test("skips when content stamps match the store", async () => {
    const src = new Mem("mem:src", "a", 1n, "hash-a")
    const out = new Mem("mem:out")
    const store = new MemoryStore()
    let runs = 0

    const task = () =>
      new Task({
        id: "compile",
        inputs: [src],
        outputs: [out],
        run: async () => {
          runs += 1
          out.write("obj", 2n, "hash-out")
        },
      })

    const first = new Build({ store })
    first.add(task())
    const r1 = await first.run()
    expect(r1.executed.length).toBe(1)
    expect(runs).toBe(1)

    const second = new Build({ store })
    second.add(task())
    const r2 = await second.run()
    expect(r2.skipped.length).toBe(1)
    expect(runs).toBe(1)

    src.write("b", 3n, "hash-b")
    const third = new Build({ store })
    third.add(task())
    const r3 = await third.run()
    expect(r3.executed.length).toBe(1)
    expect(runs).toBe(2)
  })

  test("content change runs even when output order is newer", async () => {
    const src = new Mem("mem:src", "a", 1n, "hash-a")
    const out = new Mem("mem:out", "obj", 9n, "hash-out")
    const store = new MemoryStore()
    await store.set("compile", {
      inputStamps: { "mem:src": { order: 1n, content: "hash-a" } },
      outputStamps: { "mem:out": { order: 9n, content: "hash-out" } },
    })
    let runs = 0
    const build = new Build({ store })
    build.add(
      new Task({
        id: "compile",
        inputs: [src],
        outputs: [out],
        run: async () => {
          runs += 1
          out.write("obj2", 10n, "hash-out2")
        },
      }),
    )
    src.write("b", 1n, "hash-b")
    const result = await build.run()
    expect(result.executed.length).toBe(1)
    expect(runs).toBe(1)
  })

  test("skips on order stamps when outputs are newer", async () => {
    const src = new Mem("mem:src", "a", 1n, null)
    const out = new Mem("mem:out")
    let runs = 0

    const make = () =>
      new Task({
        id: "stamp",
        inputs: [src],
        outputs: [out],
        run: async () => {
          runs += 1
          out.write("obj", 5n, null)
        },
      })

    const first = new Build()
    first.add(make())
    await first.run()
    expect(runs).toBe(1)

    const second = new Build()
    second.add(make())
    const r2 = await second.run()
    expect(r2.skipped.length).toBe(1)
    expect(runs).toBe(1)

    src.order = 9n
    const third = new Build()
    third.add(make())
    const r3 = await third.run()
    expect(r3.executed.length).toBe(1)
    expect(runs).toBe(2)
  })

  test("runs when a declared output is missing", async () => {
    const src = new Mem("mem:src", "a", 1n, "a")
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
          out.write("obj", 2n, "old")
        },
      })

    const first = new Build({ store })
    first.add(make())
    await first.run()
    expect(runs).toBe(1)

    out.value = null
    const second = new Build({ store })
    second.add(make())
    await second.run()
    expect(runs).toBe(2)
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
          used.write("y", 2n, "y")
        },
      }),
    )
    build.add(
      new Task({
        id: "write-unknown",
        outputs: [new IdPrefix("mem:out/")],
        run: async (ctx) => {
          executed.push("write-unknown")
          foo.write("x", 1n, "x")
          ctx.produced(foo)
        },
      }),
    )

    const result = await build.run()
    expect(result.success).toBe(true)
    expect(executed).toEqual(["write-unknown", "use-foo"])
  })

  test("directory artifact waits for writers it covers", async () => {
    const foo = new Mem("mem:out/foo")
    const dir = new MemDir("mem:out/", [foo])
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
          zip.write("z", 2n, "z")
        },
      }),
    )
    build.add(
      new Task({
        id: "write",
        outputs: [foo],
        run: async () => {
          executed.push("write")
          foo.write("x", 1n, "x")
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
            report.write("r", 2n, "r")
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
          foo.write("log", 1n, "log")
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
      log.push(`${event.kind} ${event.artifact.id} by ${event.taskId}`)
      if (event.artifact === first) {
        build.add(
          new Task({
            id: "report",
            inputs: [first],
            outputs: [report],
            run: async () => {
              report.write("r", 3n, "r")
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
          first.write("1", 1n, "1")
          ctx.produced(first)
          log.push("produced returned")
          // The listener added "report" before ctx.produced returned,
          // so a second task with the same output is a duplicate.
          const duplicate = new Task({ id: "other", outputs: [report], run: async () => {} })
          expect(() => ctx.add(duplicate)).toThrow(/duplicate output 'mem:report'/)
          second.write("2", 1n, "2")
          ctx.produced(second)
          declared.write("d", 1n, "d")
        },
      }),
    )

    const result = await build.run()
    expect(result.success).toBe(true)
    expect(log).toEqual([
      "produced mem:out/1 by write",
      "produced returned",
      "produced mem:out/2 by write",
      "produced mem:declared by write",
      "produced mem:report by report",
    ])
  })

  test("a listener error in ctx.produced fails that task, even if the task catches it", async () => {
    const foo = new Mem("mem:out/foo")
    const caught = new Mem("mem:caught/foo")
    const later = new Mem("mem:later/foo")
    let caughtMessage = ""
    let laterMessage = ""
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
          foo.write("x", 1n, "x")
          ctx.produced(foo)
        },
      }),
    )
    build.add(
      new Task({
        id: "catches",
        outputs: [new IdPrefix("mem:caught/")],
        run: async (ctx) => {
          caught.write("x", 1n, "x")
          try {
            ctx.produced(caught)
          } catch (error) {
            caughtMessage = String(error)
          }
        },
      }),
    )
    // Calls ctx.produced from a timer callback, outside the promise chain of run.
    build.add(
      new Task({
        id: "callback",
        outputs: [new IdPrefix("mem:later/")],
        run: async (ctx) => {
          await new Promise<void>((resolve) => {
            setTimeout(() => {
              try {
                ctx.produced(later)
              } catch (error) {
                laterMessage = String(error)
              }
              resolve()
            }, 1)
          })
        },
      }),
    )

    const result = await build.run()
    expect(result.success).toBe(false)
    expect(result.errors).toEqual([])
    expect(result.executed).toEqual([])
    const failed: Record<string, string> = {}
    for (const [task, error] of result.failed) {
      failed[task.id] = error.message
    }
    expect(failed).toEqual({
      write: "listener broke on mem:out/foo",
      catches: "listener broke on mem:caught/foo",
      callback: "listener broke on mem:later/foo",
    })
    expect(caughtMessage).toBe("Error: listener broke on mem:caught/foo")
    expect(laterMessage).toBe("Error: listener broke on mem:later/foo")
  })

  test("a listener error on a declared output fails that task", async () => {
    const out = new Mem("mem:out")
    const store = new MemoryStore()
    const build = new Build({ store })
    build.subscribe(() => {
      throw new Error("listener broke")
    })
    build.add(
      new Task({
        id: "write",
        outputs: [out],
        run: async () => {
          out.write("x", 1n, "x")
        },
      }),
    )

    const result = await build.run()
    expect(result.success).toBe(false)
    expect(result.executed).toEqual([])
    expect(result.failed.size).toBe(1)
    for (const error of result.failed.values()) {
      expect(error.message).toBe("listener broke")
    }
    expect(await store.get("write")).toBeNull()
  })

  for (const how of ["remove", "replace"]) {
    test(`a listener error on a retraction from build.${how} goes to result.errors`, async () => {
      const out = new Mem("mem:out")
      const other = new Mem("mem:other")
      const retracted: string[] = []
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
        if (event.kind !== "retracted") return
        retracted.push(event.artifact.id)
        throw new Error("listener broke")
      })
      build.add(
        new Task({
          id: "write",
          outputs: [out],
          run: async () => {
            out.write("x", 1n, "x")
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
              other.write("y", 1n, "y")
            },
          }),
        )
      }
      release()
      const result = await running

      expect(retracted).toEqual(["mem:out"])
      expect(result.failed.size).toBe(0)
      expect(result.success).toBe(false)
      expect(result.errors.length).toBe(1)
      expect(result.errors[0]!.message).toBe("listener broke")
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
          foo.write("x", 1n, "x")
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
          out.write("old", 1n, "old")
        },
      }),
    )
    build.add(
      new Task({
        id: "t",
        outputs: [out],
        run: async () => {
          executed.push("new")
          out.write("new", 1n, "new")
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
          x.write("x", 1n, "x")
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

  test("ctx.remove with a throwing retract listener fails the caller and removes the task", async () => {
    const a = new Mem("mem:p/a")
    const b = new Mem("mem:p/b")
    const retracted: string[] = []
    const build = new Build()
    build.subscribe((event) => {
      if (event.kind !== "retracted") return
      retracted.push(`${event.artifact.id} by ${event.taskId}`)
      throw new Error(`retract broke on ${event.artifact.id}`)
    })
    build.add(
      new Task({
        id: "write",
        outputs: [new IdPrefix("mem:p/")],
        run: async (ctx) => {
          a.write("a", 1n, "a")
          ctx.produced(a)
          b.write("b", 1n, "b")
          ctx.produced(b)
        },
      }),
    )
    let removeMessage = ""
    build.add(
      new Task({
        id: "remover",
        inputs: [new IdPrefix("mem:p/")],
        run: async (ctx) => {
          try {
            ctx.remove("write")
          } catch (error) {
            removeMessage = String(error)
          }
        },
      }),
    )

    const result = await build.run()
    expect(retracted).toEqual(["mem:p/a by write", "mem:p/b by write"])
    expect(removeMessage).toBe("Error: retract broke on mem:p/a")
    expect(result.success).toBe(false)
    const failed: Record<string, string> = {}
    for (const [task, error] of result.failed) {
      failed[task.id] = error.message
    }
    // The first error fails the caller. The second error has no other owner.
    expect(failed).toEqual({ remover: "retract broke on mem:p/a" })
    expect(result.errors.map((error) => error.message)).toEqual(["retract broke on mem:p/b"])

    // The task is gone: a second remove sends nothing, and its output id is free.
    build.remove("write")
    expect(retracted.length).toBe(2)
    build.add(new Task({ id: "again", outputs: [a], run: async () => {} }))
  })

  test("ctx.add that replaces a completed task fails the caller and keeps the replacement", async () => {
    const old = new Mem("mem:old")
    const next = new Mem("mem:next")
    const executed: string[] = []
    const build = new Build()
    build.subscribe((event) => {
      if (event.kind === "retracted") throw new Error("retract broke")
    })
    build.add(
      new Task({
        id: "t",
        outputs: [old],
        run: async () => {
          executed.push("old t")
          old.write("o", 1n, "o")
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
                next.write("n", 1n, "n")
              },
            }),
          )
        },
      }),
    )

    const result = await build.run()
    expect(executed).toEqual(["old t", "replacer", "new t"])
    expect(result.success).toBe(false)
    expect(result.errors).toEqual([])
    const failedIds: string[] = []
    for (const [task, error] of result.failed) {
      failedIds.push(task.id)
      expect(error.message).toBe("retract broke")
    }
    expect(failedIds).toEqual(["replacer"])
  })

  test("build.add and build.remove inside a task without ctx put errors in result.errors", async () => {
    const one = new Mem("mem:one")
    const two = new Mem("mem:two")
    const build = new Build()
    build.subscribe((event) => {
      if (event.kind === "retracted") throw new Error(`retract broke on ${event.artifact.id}`)
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

    const result = await build.run()
    expect(result.failed.size).toBe(0)
    expect(result.success).toBe(false)
    const messages = result.errors.map((error) => error.message)
    expect(messages).toEqual(["retract broke on mem:one", "retract broke on mem:two"])
  })

  test("the retractions of a cancelled task go to result.errors", async () => {
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
      if (event.kind === "retracted") throw new Error("retract broke")
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
    const result = await running

    expect(result.cancelled.length).toBe(1)
    expect(result.failed.size).toBe(0)
    expect(result.success).toBe(false)
    expect(result.errors.map((error) => error.message)).toEqual(["retract broke"])
  })

  test("build.remove sends every retraction and reports each listener error", async () => {
    const a = new Mem("mem:p/a")
    const b = new Mem("mem:p/b")
    const retracted: string[] = []
    const build = new Build()
    build.subscribe((event) => {
      if (event.kind !== "retracted") return
      retracted.push(event.artifact.id)
      throw new Error(`retract broke on ${event.artifact.id}`)
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
    const first = await build.run()
    expect(first.success).toBe(true)

    build.remove("write")
    expect(retracted).toEqual(["mem:p/a", "mem:p/b"])
    // An error after run() returns appears in the next result.
    const second = await build.run()
    expect(second.success).toBe(false)
    const messages = second.errors.map((error) => error.message)
    expect(messages).toEqual(["retract broke on mem:p/a", "retract broke on mem:p/b"])
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
        late.push(event.artifact.id)
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
    expect(late).toEqual(["mem:p/b"])
  })

  test("a listener error goes to the task that caused it, not to another running task", async () => {
    const bad = new Mem("mem:bad/1")
    const good = new Mem("mem:good/1")
    const build = new Build()
    build.subscribe((event) => {
      if (event.artifact === bad) throw new Error("listener broke on bad")
    })
    const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1))
    build.add(
      new Task({
        id: "bad",
        outputs: [new IdPrefix("mem:bad/")],
        run: async (ctx) => {
          await tick()
          ctx.produced(bad)
        },
      }),
    )
    build.add(
      new Task({
        id: "good",
        outputs: [new IdPrefix("mem:good/")],
        run: async (ctx) => {
          ctx.produced(good)
          await tick()
          await tick()
          ctx.produced(good)
        },
      }),
    )

    const result = await build.run()
    expect(result.executed.map((task) => task.id)).toEqual(["good"])
    const failedIds: string[] = []
    for (const [task, error] of result.failed) {
      failedIds.push(task.id)
      expect(error.message).toBe("listener broke on bad")
    }
    expect(failedIds).toEqual(["bad"])
    expect(result.errors).toEqual([])
  })

  test("a subscriber that returns a promise fails the task that caused the send", async () => {
    const out = new Mem("mem:out")
    const build = new Build()
    build.subscribe(async () => {})
    build.add(
      new Task({
        id: "write",
        outputs: [out],
        run: async () => {},
      }),
    )

    const result = await build.run()
    expect(result.success).toBe(false)
    for (const error of result.failed.values()) {
      expect(error.message).toBe("subscriber returned a promise; subscribers must be synchronous")
    }
    expect(result.failed.size).toBe(1)
  })

  test("a replaced running task does not retract the artifact the replacement owns", async () => {
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
      events.push(`${event.kind} ${event.artifact.id}`)
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
    expect(events).toEqual(["produced mem:a", "produced mem:a"])
    build.remove("t")
    expect(events).toEqual(["produced mem:a", "produced mem:a", "retracted mem:a"])
  })

  test("a task that catches a listener error and throws its own fails with the listener error", async () => {
    const out = new Mem("mem:out/a")
    const build = new Build()
    build.subscribe(() => {
      throw new Error("listener broke")
    })
    build.add(
      new Task({
        id: "t",
        outputs: [new IdPrefix("mem:out/")],
        run: async (ctx) => {
          try {
            ctx.produced(out)
          } catch {
            throw new Error("task gave up")
          }
        },
      }),
    )

    const result = await build.run()
    expect(result.success).toBe(false)
    for (const error of result.failed.values()) {
      expect(error.message).toBe("listener broke")
    }
    expect(result.failed.size).toBe(1)
    expect(result.errors.map((error) => error.message)).toEqual(["task gave up"])
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
          out.write("v", 1n, "v")
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

  test("an artifact reported twice is retracted once", async () => {
    const a = new Mem("mem:p/a")
    const events: string[] = []
    const build = new Build()
    build.subscribe((event) => {
      events.push(`${event.kind} ${event.artifact.id}`)
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
    expect(events).toEqual(["produced mem:p/a", "produced mem:p/a", "retracted mem:p/a"])
  })

  test("a replacement owns the artifacts it declares, even if it is removed before it runs", async () => {
    const a = new Mem("mem:a")
    const events: string[] = []
    const build = new Build()
    build.subscribe((event) => {
      events.push(`${event.kind} ${event.artifact.id}`)
    })
    build.add(new Task({ id: "t", outputs: [a], run: async () => {} }))
    await build.run()

    build.add(new Task({ id: "t", outputs: [a], run: async () => {} }))
    expect(events).toEqual(["produced mem:a"])
    build.remove("t")
    expect(events).toEqual(["produced mem:a", "retracted mem:a"])
  })

  test("the rejection of an async subscriber goes to result.errors", async () => {
    const out = new Mem("mem:out")
    const build = new Build()
    build.subscribe(async () => {
      throw new Error("async subscriber broke")
    })
    build.add(new Task({ id: "t", outputs: [out], run: async () => {} }))

    const result = await build.run()
    expect(result.success).toBe(false)
    for (const error of result.failed.values()) {
      expect(error.message).toBe("subscriber returned a promise; subscribers must be synchronous")
    }
    expect(result.failed.size).toBe(1)
    expect(result.errors.map((error) => error.message)).toEqual(["async subscriber broke"])
  })

  test("replacing a running task retracts the artifacts the new task does not declare, at once", async () => {
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
      events.push(`${event.kind} ${event.artifact.id}`)
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
    expect(events).toEqual(["produced mem:a", "retracted mem:a"])
    release()
    const result = await running
    expect(result.success).toBe(true)
    expect(events).toEqual(["produced mem:a", "retracted mem:a"])
  })

  test("a subscriber that removes the writer on its first declared output stops the later ones", async () => {
    const a = new Mem("mem:a")
    const b = new Mem("mem:b")
    const events: string[] = []
    const build = new Build()
    build.subscribe((event) => {
      events.push(`${event.kind} ${event.artifact.id}`)
      if (event.kind === "produced" && event.artifact === a) build.remove("t")
    })
    build.add(new Task({ id: "t", outputs: [a, b], run: async () => {} }))

    const result = await build.run()
    expect(events).toEqual(["produced mem:a", "retracted mem:a"])
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
          done.write("p", 1n, "p")
          ctx.add(
            new Task({
              id: "child",
              inputs: [done],
              outputs: [childOut],
              run: async () => {
                executed.push("child")
                childOut.write("c", 2n, "c")
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
