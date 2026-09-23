import { describe, expect, test } from "bun:test"
import { FilePattern } from "../../contrib/filebuild/pattern"

const root = "/proj"

describe("FilePattern", () => {
  test("binds named segments and a suffix", () => {
    const pattern = new FilePattern("input/<book>/<section>.txt")
    const vars = pattern.match("/proj/input/moby/ch1.txt", root)
    expect(vars).toEqual({ book: "moby", section: "ch1" })
    expect(pattern.render({ book: "moby", section: "ch1" }, root)).toBe(
      "/proj/input/moby/ch1.txt",
    )
  })

  test("rejects a path that does not match", () => {
    const pattern = new FilePattern("input/<book>/<section>.txt")
    expect(pattern.match("/proj/input/moby/ch1.md", root)).toBeNull()
    expect(pattern.match("/proj/other/moby/ch1.txt", root)).toBeNull()
  })

  test("a glob does not bind a permute name and marks the pattern as a list", () => {
    const pattern = new FilePattern("input/<book>/pages/*.txt")
    expect(pattern.list).toBe(true)
    expect(pattern.varNames).toEqual(["book"])
    expect(pattern.match("/proj/input/moby/pages/1.txt", root)).toEqual({
      book: "moby",
    })
    expect(pattern.match("/proj/input/moby/pages/1.md", root)).toBeNull()
  })

  test("static prefix stops at the first capture", () => {
    const pattern = new FilePattern("input/<book>/<section>.txt")
    expect(pattern.staticPrefix(root)).toBe("/proj/input/")
  })

  test("bound prefix includes named segments and stops at a glob", () => {
    const pattern = new FilePattern("pages/<doc>/*.txt")
    expect(pattern.boundPrefix({ doc: "report" }, root).id).toBe(
      "file:/proj/pages/report/",
    )
  })
})
