import { describe, expect, test } from "bun:test"
import path from "node:path"
import { FileGlob, FilePattern } from "../../contrib"

const root = "/proj"

describe("FilePattern and FileGlob", () => {
  test("binds named segments and a suffix", () => {
    const pattern = new FilePattern("input/<book>/<section>.txt", { root })
    const vars = pattern.match("/proj/input/moby/ch1.txt")
    expect(vars).toEqual({ book: "moby", section: "ch1" })
  })

  test("rejects a path that does not match", () => {
    const pattern = new FilePattern("input/<book>/<section>.txt", { root })
    expect(pattern.match("/proj/input/moby/ch1.md")).toBeNull()
    expect(pattern.match("/proj/other/moby/ch1.txt")).toBeNull()
  })

  test("a glob does not bind a permute name", () => {
    const pattern = new FileGlob("input/<book>/pages/*.txt", { root })
    expect(pattern.varNames).toEqual(["book"])
    expect(pattern.match("/proj/input/moby/pages/1.txt")).toEqual({
      book: "moby",
    })
    expect(pattern.match("/proj/input/moby/pages/1.md")).toBeNull()
  })

  test("static prefix stops at the first capture", () => {
    const pattern = new FilePattern("input/<book>/<section>.txt", { root })
    expect(pattern.staticPrefix).toBe(`${path.sep}proj${path.sep}input${path.sep}`)
  })
})
