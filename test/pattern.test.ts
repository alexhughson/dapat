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

  test("** then a glob segment matches files at any depth", () => {
    const pattern = new KeyPattern("site/<lang>/**/*.html")
    expect(pattern.match("site/en/a/b/x.html")).toEqual({ lang: "en" })
    expect(pattern.match("site/en/x.html")).toEqual({ lang: "en" })
    expect(pattern.match("site/en/x.md")).toBeNull()
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

  test("a var used twice tries every split until both places agree", () => {
    expect(new KeyPattern("d/<a>-<a>.txt").match("d/a-b-a-b.txt")).toEqual({ a: "a-b" })
    expect(new KeyPattern("d/<a>-<b>/<a>.txt").match("d/x-y-z/x.txt")).toEqual({ a: "x", b: "y-z" })
  })

  test("a var and a glob match a name with a line break", () => {
    for (const name of ["a\nb", "a\rb", "a\u2028b", "a\u2029b"]) {
      const key = `notes/${name}.md`
      expect(new KeyPattern("notes/<slug>.md").match(key)).toEqual({ slug: name })
      expect(new KeyPattern("notes/*.md").match(key)).toEqual({})
    }
  })

  test("a var named like a member of Object.prototype matches, as an own property", () => {
    for (const name of ["constructor", "toString", "__proto__"]) {
      const pattern = new KeyPattern(`posts/<${name}>.md`)
      const vars = pattern.match("posts/hello.md")
      expect(vars).not.toBeNull()
      expect(Object.hasOwn(vars!, name)).toBe(true)
      expect(vars![name]).toBe("hello")
      expect(pattern.render(vars!)).toBe("posts/hello.md")
    }
  })

  test("two vars with nothing between them make the pattern throw", () => {
    expect(() => new KeyPattern("v/<lang><slug>.md")).toThrow(
      "pattern 'v/<lang><slug>.md': the vars <lang> and <slug> have nothing between them, so a key has no single split",
    )
    expect(() => new KeyPattern("emoji/<a><b>.txt")).toThrow("the vars <a> and <b> have nothing between them")
    expect(() => new KeyPattern("d/<x><x>.txt")).toThrow("pattern 'd/<x><x>.txt': the var <x> comes twice with nothing between")
  })

  test("a glob next to a var does not split a surrogate pair", () => {
    const vars = new KeyPattern("emoji/*<a>.txt").match("emoji/\u{1F600}.txt")
    expect(vars).toEqual({ a: "\u{1F600}" })
  })

  test("a key that does not match does not try every split of every segment", () => {
    // 20 segments `<v0>-<w0>/.../z`, and a key whose segments have 3 dashes each, ending in y.
    const templateSegments: string[] = []
    const keySegments: string[] = []
    for (let i = 0; i < 20; i++) {
      templateSegments.push(`<v${i}>-<w${i}>`)
      keySegments.push("x-x-x-x")
    }
    const pattern = new KeyPattern(`${templateSegments.join("/")}/z`)
    const start = performance.now()
    const missed = pattern.match(`${keySegments.join("/")}/y`)
    const elapsedMs = performance.now() - start
    expect(missed).toBeNull()
    expect(elapsedMs).toBeLessThan(100)
    expect(pattern.match(`${keySegments.join("/")}/z`)).toEqual(expect.objectContaining({ v0: "x-x-x", w0: "x", v19: "x-x-x" }))
  })

  test("a segment after ** still finds its split", () => {
    expect(new KeyPattern("**/<a>-<b>/z").match("p/q-r-s/z")).toEqual({ a: "q-r", b: "s" })
    expect(new KeyPattern("**/<a>-<b>.md").match("p/x/q-r.md")).toEqual({ a: "q", b: "r" })
  })

  test("a segment with a shared var tries each value of that var, and only one split of the rest", () => {
    const pattern = new KeyPattern("<lang>*<a>/<lang>.md")
    expect(pattern.match("en-x-y/en.md")).toEqual({ lang: "en", a: "y" })
    const longName = `en${"-x".repeat(1000)}`
    const start = performance.now()
    expect(pattern.match(`${longName}/fr.md`)).toBeNull()
    expect(performance.now() - start).toBeLessThan(100)
  })
})
