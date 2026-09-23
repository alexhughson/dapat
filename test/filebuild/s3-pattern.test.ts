import { describe, expect, test } from "bun:test"
import { S3Pattern } from "../../contrib/filebuild/s3-pattern"
import { MemoryS3 } from "../../contrib/s3/memory"

const client = new MemoryS3()

describe("S3Pattern", () => {
  test("binds named key segments from an s3 URI", () => {
    const pattern = new S3Pattern("s3://books/input/<book>/<section>.txt", {
      client,
    })
    expect(pattern.bucket).toBe("books")
    expect(pattern.match("input/moby/ch1.txt")).toEqual({
      book: "moby",
      section: "ch1",
    })
    expect(pattern.render({ book: "moby", section: "ch1" })).toBe(
      "input/moby/ch1.txt",
    )
    expect(pattern.matchId("s3://books/input/moby/ch1.txt", "")).toEqual({
      book: "moby",
      section: "ch1",
    })
    expect(pattern.renderId({ book: "moby", section: "ch1" }, "")).toBe(
      "s3://books/input/moby/ch1.txt",
    )
  })

  test("accepts a relative key plus bucket", () => {
    const pattern = new S3Pattern("input/<book>/<section>.txt", {
      client,
      bucket: "books",
    })
    expect(pattern.match("input/moby/ch1.txt")).toEqual({
      book: "moby",
      section: "ch1",
    })
  })

  test("rejects a key that does not match", () => {
    const pattern = new S3Pattern("s3://books/input/<book>/<section>.txt", {
      client,
    })
    expect(pattern.match("input/moby/ch1.md")).toBeNull()
    expect(pattern.match("other/moby/ch1.txt")).toBeNull()
    expect(pattern.matchId("s3://other/input/moby/ch1.txt", "")).toBeNull()
  })

  test("a glob does not bind a permute name and marks the pattern as a list", () => {
    const pattern = new S3Pattern("s3://books/input/<book>/pages/*.txt", {
      client,
    })
    expect(pattern.list).toBe(true)
    expect(pattern.varNames).toEqual(["book"])
    expect(pattern.match("input/moby/pages/1.txt")).toEqual({ book: "moby" })
    expect(pattern.match("input/moby/pages/1.md")).toBeNull()
  })

  test("static key prefix stops at the first capture", () => {
    const pattern = new S3Pattern("s3://books/input/<book>/<section>.txt", {
      client,
    })
    expect(pattern.keyPrefix()).toBe("input/")
    expect(pattern.listenPrefix("").id).toBe("s3://books/input/")
  })

  test("bound prefix includes named segments and stops at a glob", () => {
    const pattern = new S3Pattern("s3://docs/pages/<doc>/*.txt", { client })
    expect(pattern.boundPrefix({ doc: "report" }, "").id).toBe(
      "s3://docs/pages/report/",
    )
  })
})
