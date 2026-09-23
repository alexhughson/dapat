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

  test("listen inserts a task for a produced child", async () => {
    const foo = new Mem("mem:logs/1.json")
    const report = new Mem("mem:reports/1.json")
    const executed: string[] = []

    const build = new Build()
    build.listen(new IdPrefix("mem:logs/"), (event) => {
      if (event.type !== "produced") return
      build.add(
        new Task({
          id: `report:${event.id}`,
          inputs: [foo],
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
