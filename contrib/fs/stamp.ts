import { stat } from "node:fs/promises"

export async function pathOrderStamp(p: string): Promise<bigint | null> {
  try {
    const info = await stat(p, { bigint: true })
    return info.mtimeNs
  } catch {
    return null
  }
}
