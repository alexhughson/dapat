import path from "node:path"

export function resolveFilePath(p: string): string {
  return path.resolve(p)
}

export function resolveDirPath(p: string): string {
  const abs = path.resolve(p)
  if (abs.endsWith(path.sep)) return abs
  return `${abs}${path.sep}`
}

export function fileId(absFile: string): string {
  return `file:${absFile}`
}

export function dirId(absDir: string): string {
  return `file:${absDir}`
}
