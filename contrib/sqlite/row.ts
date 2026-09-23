import type { Database } from "bun:sqlite"
import { Artifact } from "../../src/artifact"
import { hashRow } from "./hash"
import { rowId, sqliteIdent } from "./ident"

export type SqliteRowValue = Record<string, unknown>

export class SqliteRowArtifact extends Artifact<SqliteRowValue> {
  readonly id: string
  readonly table: string
  readonly pkColumn: string
  readonly pk: string
  readonly orderColumn: string | undefined
  private readonly db: Database

  constructor(opts: {
    db: Database
    table: string
    pkColumn: string
    pk: string | number
    orderColumn?: string
  }) {
    super()
    this.db = opts.db
    this.table = sqliteIdent(opts.table)
    this.pkColumn = sqliteIdent(opts.pkColumn)
    this.pk = String(opts.pk)
    this.orderColumn = opts.orderColumn ? sqliteIdent(opts.orderColumn) : undefined
    this.id = rowId(this.table, this.pkColumn, this.pk)
  }

  async orderStamp(): Promise<bigint | null> {
    const row = this.load()
    if (!row) return null
    if (this.orderColumn) {
      const raw = row[this.orderColumn]
      if (typeof raw === "number") return BigInt(raw)
      if (typeof raw === "bigint") return raw
      if (typeof raw === "string" && raw.length > 0) return BigInt(raw)
      return null
    }
    const rowid = row.rowid
    if (typeof rowid === "number") return BigInt(rowid)
    if (typeof rowid === "bigint") return rowid
    return null
  }

  async contentStamp(): Promise<string | null> {
    const row = this.load()
    if (!row) return null
    return hashRow(row)
  }

  async read(): Promise<SqliteRowValue> {
    const row = this.load()
    if (!row) {
      throw new Error(`missing sqlite row ${this.id}`)
    }
    const copy: SqliteRowValue = {}
    for (const key of Object.keys(row)) {
      if (key === "rowid") continue
      copy[key] = row[key]
    }
    return copy
  }

  private load(): Record<string, unknown> | null {
    const sql = `SELECT rowid, * FROM ${this.table} WHERE ${this.pkColumn} = ?`
    const row = this.db.query(sql).get(this.pk) as Record<string, unknown> | null
    return row ?? null
  }
}

export function sqliteRow(opts: {
  db: Database
  table: string
  pkColumn: string
  pk: string | number
  orderColumn?: string
}): SqliteRowArtifact {
  return new SqliteRowArtifact(opts)
}
