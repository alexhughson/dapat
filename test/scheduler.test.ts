import { describe, expect, test } from "bun:test"
import { Build, IdPrefix, Prefix, Task } from "../src/index"
import type { Artifact } from "../src/index"
import { IdTrie } from "../src/id-trie"
import { Mem } from "./mem"

/** A promise and the function that resolves it. */
function gate(): { opened: Promise<void>; open: () => void } {
  let open = () => {}
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { opened, open }
}

describe("IdTrie", () => {
  test("finds the same values as a scan, after random adds and deletes", () => {
    // Short ids over a small alphabet, so that many ids share a start and edges split and merge.
    let seed = 7
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    const randomId = () => {
      let id = ""
      for (let i = random(6); i > 0; i--) id += "ab/"[random(3)]
      return id
    }
    const trie = new IdTrie<number>()
    const entries: { key: string; value: number }[] = []
    for (let step = 0; step < 3000; step++) {
      if (entries.length > 0 && random(3) === 0) {
        const [entry] = entries.splice(random(entries.length), 1)
        trie.delete(entry!.key, entry!.value)
      } else {
        const entry = { key: randomId(), value: step }
        entries.push(entry)
        trie.add(entry.key, entry.value)
      }
      const query = randomId()
      const below: number[] = []
      trie.withPrefix(query, (value) => below.push(value))
      const above: number[] = []
      trie.startsOf(query, (value) => above.push(value))
      const sorted = (values: number[]) => [...values].sort((a, b) => a - b)
      expect(sorted(below)).toEqual(sorted(entries.filter((e) => e.key.startsWith(query)).map((e) => e.value)))
      expect(sorted(above)).toEqual(sorted(entries.filter((e) => query.startsWith(e.key)).map((e) => e.value)))
    }
  })
})

describe("Build scheduling", () => {
  test("a waiting task also waits for a producer that a running task adds", async () => {
    const log: string[] = []
    const first = new Mem("mem:out/first")
    const second = new Mem("mem:out/second")
    const build = new Build()
    build.add(
      new Task({
        id: "reader",
        inputs: [new IdPrefix("mem:out/")],
        run: async () => {
          log.push("reader")
        },
      }),
    )
    build.add(
      new Task({
        id: "first",
        outputs: [first],
        run: async (ctx) => {
          ctx.add(
            new Task({
              id: "second",
              outputs: [second],
              run: async () => {
                await new Promise<void>((resolve) => setTimeout(resolve, 10))
                log.push("second")
              },
            }),
          )
          log.push("first")
        },
      }),
    )
    const result = await build.run()
    expect(result.success).toBe(true)
    expect(log).toEqual(["first", "second", "reader"])
  })

  test("a waiting task starts when its producer is replaced by a task that does not write its input", async () => {
    const log: string[] = []
    const slow = gate()
    const raw = new Mem("mem:raw")
    const data = new Mem("mem:data")
    const build = new Build()
    build.add(
      new Task({
        id: "slow",
        outputs: [raw],
        run: async () => {
          await slow.opened
          log.push("slow")
        },
      }),
    )
    build.add(new Task({ id: "middle", inputs: [raw], outputs: [data], run: async () => {} }))
    build.add(
      new Task({
        id: "reader",
        inputs: [data],
        run: async () => {
          log.push("reader")
          slow.open()
        },
      }),
    )
    const running = build.run()
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
    // "reader" waits for "middle", which waits for "slow". The new "middle" writes nothing.
    build.add(new Task({ id: "middle", inputs: [raw], run: async () => {} }))
    const result = await running
    expect(result.success).toBe(true)
    expect(log).toEqual(["reader", "slow"])
  })

  test("a cycle next to a running task fails with deadlock when that task ends", async () => {
    const slow = gate()
    const a = new Mem("mem:a")
    const b = new Mem("mem:b")
    const build = new Build()
    build.add(new Task({ id: "A", inputs: [b], outputs: [a], run: async () => {} }))
    build.add(new Task({ id: "B", inputs: [a], outputs: [b], run: async () => {} }))
    build.add(
      new Task({
        id: "slow",
        run: async () => {
          await slow.opened
        },
      }),
    )
    const running = build.run()
    setTimeout(() => slow.open(), 5)
    const result = await running
    expect(result.executed.map((task) => task.id)).toEqual(["slow"])
    const messages = [...result.failed.values()].map((error) => error.message).sort()
    expect(messages).toEqual(["deadlock waiting for inputs of 'A'", "deadlock waiting for inputs of 'B'"])
  })

  test("an artifact input waits for a prefix output with its own covers()", async () => {
    /** Covers the ids that end with its id. */
    class SuffixPrefix extends Prefix {
      constructor(readonly id: string) {
        super()
      }
      override covers(artifact: Artifact): boolean {
        return artifact.id.endsWith(this.id)
      }
    }
    const log: string[] = []
    const build = new Build()
    build.add(
      new Task({
        id: "reader",
        inputs: [new Mem("mem:x/page.md")],
        run: async () => {
          log.push("reader")
        },
      }),
    )
    build.add(
      new Task({
        id: "writer",
        outputs: [new SuffixPrefix(".md")],
        run: async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 5))
          log.push("writer")
        },
      }),
    )
    const result = await build.run()
    expect(result.success).toBe(true)
    expect(log).toEqual(["writer", "reader"])
  })
})
