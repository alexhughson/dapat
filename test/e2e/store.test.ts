import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { MemoryStore } from "../../src/store"
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
    "file:/tmp/a": { order: 10n, content: "abc" },
  },
  outputStamps: {
    "file:/tmp/b": { order: 20n, content: "def" },
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

  test("JsonStore writes bigint stamps to disk", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dapat-json-"))
    temps.push(dir)
    const filePath = path.join(dir, "state.json")
    const first = new JsonStore(filePath)
    await first.set("copy", sample)

    const second = new JsonStore(filePath)
    const got = await second.get("copy")
    expect(got).toEqual(sample)
    expect(typeof got?.inputStamps["file:/tmp/a"]?.order).toBe("bigint")
  })

  test("SqliteStore writes bigint stamps to disk", async () => {
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
})
