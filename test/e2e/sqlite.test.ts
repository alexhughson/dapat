import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Build, Task } from "../../src/index"
import { SqliteRowArtifact, SqliteTableArtifact, SqliteTablePrefix } from "../../contrib/sqlite"
import { SqliteStore } from "../../contrib/store"

const temps: string[] = []

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dapat-sqlite-"))
  temps.push(dir)
  return dir
}

function openNotes(dbPath: string): Database {
  const db = new Database(dbPath)
  db.run(`
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      body TEXT NOT NULL,
      rev INTEGER NOT NULL
    )
  `)
  return db
}

describe("sqlite row artifacts", () => {
  test("derives a row and skips on the next run", async () => {
    const root = await tempDir()
    const dbPath = path.join(root, "notes.sqlite")
    const storePath = path.join(root, "state.sqlite")

    const seed = openNotes(dbPath)
    seed.run(`INSERT INTO notes (id, body, rev) VALUES ('src', 'hello', 1)`)
    seed.close()

    let runs = 0
    const store = new SqliteStore(storePath)

    const runOnce = async () => {
      const db = openNotes(dbPath)
      const src = new SqliteRowArtifact({
        db,
        table: "notes",
        pkColumn: "id",
        pk: "src",
        orderColumn: "rev",
      })
      const out = new SqliteRowArtifact({
        db,
        table: "notes",
        pkColumn: "id",
        pk: "out",
        orderColumn: "rev",
      })
      const build = new Build({ store })
      build.add(
        new Task({
          id: "upper",
          inputs: [src],
          outputs: [out],
          run: async () => {
            runs += 1
            const row = await src.read()
            const body = String(row.body).toUpperCase()
            db.run(
              `INSERT INTO notes (id, body, rev) VALUES ('out', ?, 1)
               ON CONFLICT(id) DO UPDATE SET body = excluded.body, rev = notes.rev + 1`,
              [body],
            )
          },
        }),
      )
      const result = await build.run()
      db.close()
      return result
    }

    const first = await runOnce()
    expect(first.executed.length).toBe(1)
    expect(runs).toBe(1)

    const check = openNotes(dbPath)
    const outRow = check.query(`SELECT body FROM notes WHERE id = 'out'`).get() as {
      body: string
    }
    expect(outRow.body).toBe("HELLO")
    check.close()

    const second = await runOnce()
    expect(second.skipped.length).toBe(1)
    expect(runs).toBe(1)

    const bump = openNotes(dbPath)
    bump.run(`UPDATE notes SET body = 'hi', rev = 2 WHERE id = 'src'`)
    bump.close()

    const third = await runOnce()
    expect(third.executed.length).toBe(1)
    expect(runs).toBe(2)

    const again = openNotes(dbPath)
    const updated = again.query(`SELECT body FROM notes WHERE id = 'out'`).get() as {
      body: string
    }
    expect(updated.body).toBe("HI")
    again.close()
    store.close()
  })

  test("table listing waits for row writers", async () => {
    const root = await tempDir()
    const dbPath = path.join(root, "notes.sqlite")
    const db = openNotes(dbPath)
    db.run(`
      CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY,
        body TEXT NOT NULL,
        rev INTEGER NOT NULL
      )
    `)
    const store = new SqliteStore(path.join(root, "state.sqlite"))
    let writes = 0
    let summaries = 0

    const a = new SqliteRowArtifact({ db, table: "notes", pkColumn: "id", pk: "a", orderColumn: "rev" })
    const b = new SqliteRowArtifact({ db, table: "notes", pkColumn: "id", pk: "b", orderColumn: "rev" })
    const table = new SqliteTableArtifact({ db, table: "notes", pkColumn: "id", orderColumn: "rev" })
    const summary = new SqliteRowArtifact({
      db,
      table: "reports",
      pkColumn: "id",
      pk: "summary",
      orderColumn: "rev",
    })

    const build = new Build({ store })
    build.add(
      new Task({
        id: "write-a",
        outputs: [a],
        run: async () => {
          writes += 1
          db.run(`INSERT INTO notes (id, body, rev) VALUES ('a', 'A', 1)`)
        },
      }),
    )
    build.add(
      new Task({
        id: "write-b",
        outputs: [b],
        run: async () => {
          writes += 1
          db.run(`INSERT INTO notes (id, body, rev) VALUES ('b', 'B', 1)`)
        },
      }),
    )
    build.add(
      new Task({
        id: "summarize",
        inputs: [table],
        outputs: [summary],
        run: async () => {
          summaries += 1
          const ids = await table.read()
          ids.sort()
          db.run(`INSERT INTO reports (id, body, rev) VALUES ('summary', ?, 1)`, [
            ids.join(","),
          ])
        },
      }),
    )

    const result = await build.run()
    expect(result.success).toBe(true)
    expect(writes).toBe(2)
    expect(summaries).toBe(1)
    const row = await summary.read()
    expect(String(row.body)).toContain("a")
    expect(String(row.body)).toContain("b")

    db.close()
    store.close()
  })

  test("prefix output covers a later exact row consumer", async () => {
    const root = await tempDir()
    const dbPath = path.join(root, "notes.sqlite")
    const db = openNotes(dbPath)
    const executed: string[] = []

    const row = new SqliteRowArtifact({
      db,
      table: "notes",
      pkColumn: "id",
      pk: "n1",
      orderColumn: "rev",
    })

    const build = new Build()
    build.add(
      new Task({
        id: "consume",
        inputs: [row],
        outputs: [
          new SqliteRowArtifact({
            db,
            table: "notes",
            pkColumn: "id",
            pk: "copy",
            orderColumn: "rev",
          }),
        ],
        run: async () => {
          executed.push("consume")
          const src = await row.read()
          db.run(`INSERT INTO notes (id, body, rev) VALUES ('copy', ?, 1)`, [
            String(src.body),
          ])
        },
      }),
    )
    build.add(
      new Task({
        id: "produce",
        outputs: [new SqliteTablePrefix("notes")],
        run: async (ctx) => {
          executed.push("produce")
          db.run(`INSERT INTO notes (id, body, rev) VALUES ('n1', 'note', 1)`)
          ctx.produced(row)
        },
      }),
    )

    const result = await build.run()
    expect(result.success).toBe(true)
    expect(executed).toEqual(["produce", "consume"])
    db.close()
  })
})
