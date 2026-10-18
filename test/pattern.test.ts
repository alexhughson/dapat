import { describe, expect, test } from "bun:test"
import { KeyPattern } from "../src/pattern"

describe("KeyPattern", () => {
  test("binds named segments and a suffix", () => {
    const pattern = new KeyPattern("input/<book>/<section>.txt")
    const vars = pattern.match("input/moby/ch1.txt")
    expect(vars).toEqual({ book: "moby", section: "ch1" })
    expect(pattern.render({ book: "moby", section: "ch1" })).toBe("input/moby/ch1.txt")
  })

  test("rejects a key that does not match", () => {
    const pattern = new KeyPattern("input/<book>/<section>.txt")
    expect(pattern.match("input/moby/ch1.md")).toBeNull()
    expect(pattern.match("other/moby/ch1.txt")).toBeNull()
  })

  test("ignores a leading slash in the template and the key", () => {
    const pattern = new KeyPattern("/proj/input/<book>.txt")
    expect(pattern.match("/proj/input/moby.txt")).toEqual({ book: "moby" })
    expect(pattern.match("proj/input/moby.txt")).toEqual({ book: "moby" })
  })

  test("a glob does not bind a name and marks the pattern as a glob", () => {
    const pattern = new KeyPattern("input/<book>/pages/*.txt")
    expect(pattern.hasGlob).toBe(true)
    expect(pattern.varNames).toEqual(["book"])
    expect(pattern.match("input/moby/pages/1.txt")).toEqual({ book: "moby" })
    expect(pattern.match("input/moby/pages/1.md")).toBeNull()
  })

  test("a pattern with only names is not a glob", () => {
    const pattern = new KeyPattern("input/<book>/<section>.txt")
    expect(pattern.hasGlob).toBe(false)
    expect(pattern.varNames).toEqual(["book", "section"])
  })

  test("** matches any number of segments", () => {
    const pattern = new KeyPattern("notes/**/<name>.md")
    expect(pattern.hasGlob).toBe(true)
    expect(pattern.match("notes/a.md")).toEqual({ name: "a" })
    expect(pattern.match("notes/x/y/a.md")).toEqual({ name: "a" })
    expect(pattern.match("other/a.md")).toBeNull()
  })

  test("a name used twice must bind the same value", () => {
    const pattern = new KeyPattern("<lang>/<slug>.<lang>.md")
    expect(pattern.match("en/intro.en.md")).toEqual({ lang: "en", slug: "intro" })
    expect(pattern.match("en/intro.fr.md")).toBeNull()
  })

  test("render throws on a missing var or a glob", () => {
    const named = new KeyPattern("input/<book>/<section>.txt")
    expect(() => named.render({ book: "moby" })).toThrow(
      "pattern 'input/<book>/<section>.txt' missing vars to render",
    )
    const globbed = new KeyPattern("input/<book>/*.txt")
    expect(() => globbed.render({ book: "moby" })).toThrow("cannot render a glob")
  })

  test("static prefix stops at the first capture", () => {
    const pattern = new KeyPattern("input/<book>/<section>.txt")
    expect(pattern.staticPrefix()).toBe("input/")
    expect(new KeyPattern("<book>.txt").staticPrefix()).toBe("")
  })

  test("bound prefix includes named segments and stops at a glob", () => {
    const pattern = new KeyPattern("pages/<doc>/*.txt")
    expect(pattern.boundPrefix({ doc: "report" })).toBe("pages/report/")
  })

  test("bound prefix stops at an unbound name", () => {
    const pattern = new KeyPattern("pages/<doc>/<page>.txt")
    expect(pattern.boundPrefix({})).toBe("pages/")
  })
})
