import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
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
    "file:/tmp/a": "abc",
    "file:/tmp/missing": null,
  },
  outputStamps: {
    "file:/tmp/b": "def",
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

  test("JsonStore keeps every record when parallel tasks finish at the same time", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dapat-json-"))
    temps.push(dir)
    const store = new JsonStore(path.join(dir, "state.json"))
    const count = 8

    const runOnce = async () => {
      const build = new Build({ store })
      for (let i = 0; i < count; i++) {
        const out = new FileArtifact(path.join(dir, `out-${i}.txt`))
        build.add(
          new Task({
            id: `write-${i}`,
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
    let runs = 0
    const build = new Build({ store: new JsonStore(statePath) })
    build.add(
      new Task({
        id: "write",
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
    const db = new Database(path.join(dir, "state.sqlite"))
    const store = new SqliteStore(db)
    // The payload that dapat wrote before one stamp per artifact.
    const oldPayload = {
      inputStamps: {},
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
      inputStamps: {},
      outputStamps: { [out.id]: await out.stamp() },
    })
    const second = await runOnce()
    expect(second.skipped.length).toBe(1)
    expect(runs).toBe(1)
    db.close()
  })
})
