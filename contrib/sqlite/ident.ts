export function sqliteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`invalid sqlite identifier: ${name}`)
  }
  return name
}

export function rowId(table: string, pkColumn: string, pk: string): string {
  return `sqlite:${table}/${pkColumn}/${pk}`
}

export function tableId(table: string): string {
  return `sqlite:${table}/`
}
