import type { Database } from "bun:sqlite"
import { Artifact } from "../../src/artifact"
import { Prefix } from "../../src/prefix"
import { hashRow, sha256Hex } from "./hash"
import { sqliteIdent, tableId } from "./ident"
import { SqliteRowArtifact } from "./row"

export class SqliteTablePrefix extends Prefix {
  readonly id: string

  constructor(readonly table: string) {
    super()
    this.id = tableId(sqliteIdent(table))
  }
}

export class SqliteTableArtifact extends Artifact<string[]> {
  readonly id: string
  readonly table: string
  readonly pkColumn: string
  readonly orderColumn: string | undefined
  private readonly db: Database

  constructor(opts: {
    db: Database
    table: string
    pkColumn: string
    orderColumn?: string
  }) {
    super()
    this.db = opts.db
    this.table = sqliteIdent(opts.table)
    this.pkColumn = sqliteIdent(opts.pkColumn)
    this.orderColumn = opts.orderColumn ? sqliteIdent(opts.orderColumn) : undefined
    this.id = tableId(this.table)
  }

  get coversOthers(): boolean {
    return true
  }

  covers(other: Artifact): boolean {
    if (other.id === this.id) return true
    return other.id.startsWith(this.id)
  }

  async orderStamp(): Promise<bigint | null> {
    const pks = this.primaryKeys()
    if (pks === null) return null
    let max: bigint | null = null
    for (const pk of pks) {
      const row = this.row(pk)
      const order = await row.orderStamp()
      if (order === null) continue
      if (max === null || order > max) max = order
    }
    return max
  }

  async contentStamp(): Promise<string | null> {
    const pks = this.primaryKeys()
    if (pks === null) return null
    const lines: string[] = []
    for (const pk of pks) {
      const loaded = this.load(pk)
      if (!loaded) continue
      lines.push(`${pk}=${hashRow(loaded)}`)
    }
    lines.sort()
    return sha256Hex(new TextEncoder().encode(lines.join("\n")))
  }

  async read(): Promise<string[]> {
    const pks = this.primaryKeys()
    if (pks === null) {
      throw new Error(`missing sqlite table ${this.table}`)
    }
    return pks
  }

  private primaryKeys(): string[] | null {
    try {
      const sql = `SELECT ${this.pkColumn} FROM ${this.table}`
      const rows = this.db.query(sql).all() as Record<string, unknown>[]
      const pks: string[] = []
      for (const row of rows) {
        pks.push(String(row[this.pkColumn]))
      }
      return pks
    } catch {
      return null
    }
  }

  private load(pk: string): Record<string, unknown> | null {
    const sql = `SELECT rowid, * FROM ${this.table} WHERE ${this.pkColumn} = ?`
    return (this.db.query(sql).get(pk) as Record<string, unknown> | null) ?? null
  }

  private row(pk: string): SqliteRowArtifact {
    return new SqliteRowArtifact({
      db: this.db,
      table: this.table,
      pkColumn: this.pkColumn,
      pk,
      orderColumn: this.orderColumn,
    })
  }
}

export function sqliteTablePrefix(table: string): SqliteTablePrefix {
  return new SqliteTablePrefix(table)
}

export function sqliteTable(opts: {
  db: Database
  table: string
  pkColumn: string
  orderColumn?: string
}): SqliteTableArtifact {
  return new SqliteTableArtifact(opts)
}
