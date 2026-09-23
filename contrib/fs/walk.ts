import { readdir } from "node:fs/promises"
import path from "node:path"

/** Absolute paths of files under `root`. Missing root returns []. */
export async function walkFiles(root: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const files: string[] = []
  const stack: { dir: string; items: typeof entries }[] = [
    { dir: root, items: entries },
  ]
  while (stack.length > 0) {
    const frame = stack.pop()
    if (!frame) break
    for (const entry of frame.items) {
      const full = path.join(frame.dir, entry.name)
      if (entry.isDirectory()) {
        const child = await readdir(full, { withFileTypes: true })
        stack.push({ dir: full, items: child })
      } else if (entry.isFile()) {
        files.push(full)
      }
    }
  }
  return files
}
