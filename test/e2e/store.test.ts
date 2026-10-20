import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Build, Task } from "../../src/index"
import { MemoryStore } from "../../src/store"
import { FileArtifact } from "../../contrib/fs"
import { JsonStore, SqliteStore } from "../../contrib/store"
import type { Store, TaskState } from "../../src/store"

const temps: string[] = []

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

const sample: TaskState = {
  inputStamps: {
    "artifact file:/tmp/a": "abc",
    "artifact file:/tmp/missing": null,
    "prefix file:/tmp/pages/": "123",
  },
  outputStamps: {
    "artifact file:/tmp/b": "def",
  },
}

async function roundTrip(store: Store): Promise<void> {
  await store.set("copy", sample)
  const got = await store.get("copy")
  expect(got).toEqual(sample)
  await store.delete("copy")
  expect(await store.get("copy")).toBeNull()
}

describe("stores", () => {
  test("MemoryStore keeps stamps", async () => {
    await roundTrip(new MemoryStore())
  })

  test("JsonStore writes stamps to disk", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dapat-json-"))
    temps.push(dir)
    const filePath = path.join(dir, "state.json")
    const first = new JsonStore(filePath)
    await first.set("copy", sample)

    const second = new JsonStore(filePath)
    const got = await second.get("copy")
    expect(got).toEqual(sample)
  })

  test("SqliteStore writes stamps to disk", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dapat-sqlstore-"))
    temps.push(dir)
    const dbPath = path.join(dir, "state.sqlite")
    const first = new SqliteStore(dbPath)
    await first.set("copy", sample)
    first.close()

    const second = new SqliteStore(dbPath)
    const got = await second.get("copy")
    expect(got).toEqual(sample)
    second.close()
  })

  test("SqliteStore creates the folders of its path", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dapat-sqlstore-"))
    temps.push(dir)
    const dbPath = path.join(dir, "nested", "deeper", "state.db")
    const first = new SqliteStore(dbPath)
    await first.set("copy", sample)
    first.close()

    const second = new SqliteStore(dbPath)
    const got = await second.get("copy")
    expect(got).toEqual(sample)
    second.close()
  })

  test("JsonStore keeps every record when parallel tasks finish at the same time", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dapat-json-"))
    temps.push(dir)
    const store = new JsonStore(path.join(dir, "state.json"))
    const count = 8
    // A task with no input always runs, so each task reads a seed file.
    const seed = new FileArtifact(path.join(dir, "seed.txt"))
    await writeFile(seed.path, "seed")

    const runOnce = async () => {
      const build = new Build({ store })
      for (let i = 0; i < count; i++) {
        const out = new FileArtifact(path.join(dir, `out-${i}.txt`))
        build.add(
          new Task({
            id: `write-${i}`,
            inputs: [seed],
            outputs: [out],
            run: async () => {
              await writeFile(out.path, String(i))
            },
          }),
        )
      }
      return build.run()
    }

    const first = await runOnce()
    expect(first.failed.size).toBe(0)
    expect(first.executed.length).toBe(count)
    const second = await runOnce()
    expect(second.failed.size).toBe(0)
    expect(second.skipped.length).toBe(count)
  })

  test("a corrupt JsonStore file fails the task", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dapat-json-"))
    temps.push(dir)
    const statePath = path.join(dir, "state.json")
    await writeFile(statePath, '{"tasks":{')
    const out = new FileArtifact(path.join(dir, "out.txt"))
    // With no input the task runs without a look at the store, so it reads a seed file.
    const seed = new FileArtifact(path.join(dir, "seed.txt"))
    await writeFile(seed.path, "seed")
    let runs = 0
    const build = new Build({ store: new JsonStore(statePath) })
    build.add(
      new Task({
        id: "write",
        inputs: [seed],
        outputs: [out],
        run: async () => {
          runs += 1
          await writeFile(out.path, "x")
        },
      }),
    )

    const result = await build.run()
    expect(result.success).toBe(false)
    expect(runs).toBe(0)
    const failedIds: string[] = []
    for (const task of result.failed.keys()) {
      failedIds.push(task.id)
    }
    expect(failedIds).toEqual(["write"])
  })

  test("a SqliteStore record in the old shape makes the task run and write a new record", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dapat-sqlstore-"))
    temps.push(dir)
    const out = new FileArtifact(path.join(dir, "out.txt"))
    await writeFile(out.path, "x")
    const seed = new FileArtifact(path.join(dir, "seed.txt"))
    await writeFile(seed.path, "seed")
    const db = new Database(path.join(dir, "state.sqlite"))
    const store = new SqliteStore(db)
    // The payload that dapat wrote before one stamp per artifact.
    const oldPayload = {
      inputStamps: { [seed.id]: { order: "1", content: await seed.stamp() } },
      outputStamps: { [out.id]: { order: "1", content: await out.stamp() } },
    }
    db.query(`INSERT INTO dapat_task_state (task_id, payload) VALUES (?, ?)`).run(
      "write",
      JSON.stringify(oldPayload),
    )
    let runs = 0

    const runOnce = async () => {
      const build = new Build({ store })
      build.add(
        new Task({
          id: "write",
          inputs: [seed],
          outputs: [out],
          run: async () => {
            runs += 1
            await writeFile(out.path, "x")
          },
        }),
      )
      return build.run()
    }

    const first = await runOnce()
    expect(first.executed.length).toBe(1)
    expect(await store.get("write")).toEqual({
      inputStamps: { [`artifact ${seed.id}`]: await seed.stamp() },
      outputStamps: { [`artifact ${out.id}`]: await out.stamp() },
    })
    const second = await runOnce()
    expect(second.skipped.length).toBe(1)
    expect(runs).toBe(1)
    db.close()
  })

  test("a SqliteStore opened again from its file lets a task skip, and an input change makes it run", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dapat-sqlstore-"))
    temps.push(dir)
    const storePath = path.join(dir, "state.sqlite")
    const src = new FileArtifact(path.join(dir, "src.txt"))
    const out = new FileArtifact(path.join(dir, "out.txt"))
    await writeFile(src.path, "hello")
    let runs = 0

    const runOnce = async () => {
      const store = new SqliteStore(storePath)
      const build = new Build({ store })
      build.add(
        new Task({
          id: "upper",
          inputs: [src],
          outputs: [out],
          run: async () => {
            runs += 1
            const text = new TextDecoder().decode(await src.read())
            await writeFile(out.path, text.toUpperCase())
          },
        }),
      )
      const result = await build.run()
      store.close()
      return result
    }

    const first = await runOnce()
    expect(first.executed.length).toBe(1)
    expect(await Bun.file(out.path).text()).toBe("HELLO")

    const second = await runOnce()
    expect(second.skipped.length).toBe(1)
    expect(runs).toBe(1)

    await writeFile(src.path, "hi")
    const third = await runOnce()
    expect(third.executed.length).toBe(1)
    expect(runs).toBe(2)
    expect(await Bun.file(out.path).text()).toBe("HI")
  })

  test("JsonStore get reads whole files while set writes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dapat-json-"))
    temps.push(dir)
    const store = new JsonStore(path.join(dir, "state.json"))
    await store.set("first", sample)
    const rounds = 300
    let parseErrors = 0

    const writer = async () => {
      for (let i = 0; i < rounds; i++) {
        const state: TaskState = {
          inputStamps: { [`file:/tmp/${i}`]: "a".repeat(64) },
          outputStamps: {},
        }
        await store.set(`task-${i}`, state)
      }
    }
    const reader = async () => {
      for (let i = 0; i < rounds; i++) {
        try {
          await store.get("first")
        } catch {
          parseErrors += 1
        }
      }
    }

    await Promise.all([writer(), reader()])
    expect(parseErrors).toBe(0)
    expect(await store.get("first")).toEqual(sample)
  })

  test("JsonStore keeps ids that match inherited keys", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dapat-json-"))
    temps.push(dir)
    const statePath = path.join(dir, "state.json")
    const store = new JsonStore(statePath)

    expect(await store.get("constructor")).toBeNull()
    await store.set("__proto__", sample)
    const reopened = new JsonStore(statePath)
    expect(await reopened.get("__proto__")).toEqual(sample)
    expect(await reopened.get("constructor")).toBeNull()
  })

  test("a failed JsonStore write does not stop the writes queued after it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dapat-json-"))
    temps.push(dir)
    const store = new JsonStore(path.join(dir, "state.json"))
    // JSON.stringify throws on a bigint, so this write fails.
    const bad = { inputStamps: { "file:/tmp/a": 1n }, outputStamps: {} }
    const failing = store.set("bad", bad as unknown as TaskState)
    const following = store.set("good", sample)

    await expect(failing).rejects.toThrow()
    await following
    expect(await store.get("good")).toEqual(sample)
    expect(await store.get("bad")).toBeNull()
    // The failed write leaves no temp file.
    expect(await readdir(dir)).toEqual(["state.json"])
  })
})
