/**
 * Type-level attacks. Checked by `bunx tsc -p .`.
 * Bodies are never called at runtime.
 */
import { describe, expect, test } from "bun:test"
import {
  FieldGen,
  FileOutput,
  FilePattern,
  RuleBuild,
  capture,
  type FieldRecord,
  type FieldSpec,
  type FieldValue,
  type InputValue,
  type RuleContext,
} from "../../contrib"
import { Artifact } from "../../src"

type Row = "id" | "tag"

class RowArt extends Artifact<string> {
  readonly id = "row:1"
  async orderStamp() {
    return null
  }
  async contentStamp() {
    return "c"
  }
  async read() {
    return "c"
  }
}

class Rows<S extends FieldSpec<Row>> extends FieldGen<Row, "id", RowArt, S> {
  constructor(spec: S) {
    super(spec, ["id"])
  }
  protected async records(): Promise<FieldRecord<Row, RowArt>[]> {
    return []
  }
}

describe("adv types", () => {
  test("module loads", () => {
    expect(RuleBuild).toBeDefined()
  })
})

function typeAttacks(
  rules: RuleBuild,
  pattern: FilePattern,
  fileOut: FileOutput,
): void {
  rules.rule({
    name: "bad-in",
    // @ts-expect-error FileOutput is not an input generator
    inputs: { src: fileOut },
    outputs: { out: fileOut },
    run: async () => {},
  })

  rules.rule({
    name: "bad-out",
    inputs: { src: pattern },
    // @ts-expect-error FilePattern is not an output generator
    outputs: { out: pattern },
    run: async () => {},
  })

  rules.rule({
    name: "bad-opt",
    inputs: { src: pattern },
    // @ts-expect-error optional name is not a key of inputs
    optional: ["nope"],
    outputs: { out: fileOut },
    run: async () => {},
  })

  // FieldGen list vs single through InputValue / RuleContext
  type ListSpec = { tag: ReturnType<typeof capture> }
  type ListInputs = { rows: Rows<ListSpec> }
  type ListCtx = RuleContext<ListInputs, never, { out: FileOutput }>
  type _list = ListCtx["inputs"]["rows"]
  type _listOk = _list extends RowArt[] ? true : false
  const listOk: _listOk = true
  void listOk

  type SingleSpec = { id: ReturnType<typeof capture> }
  type SingleInputs = { row: Rows<SingleSpec> }
  type SingleCtx = RuleContext<SingleInputs, never, { out: FileOutput }>
  type _single = SingleCtx["inputs"]["row"]
  type _singleOk = _single extends RowArt ? true : false
  const singleOk: _singleOk = true
  void singleOk

  type _ivList = InputValue<Rows<ListSpec>>
  type _ivListOk = _ivList extends RowArt[] ? true : false
  const ivListOk: _ivListOk = true
  void ivListOk

  type _fvList = FieldValue<"id", RowArt, ListSpec>
  type _fvListOk = _fvList extends RowArt[] ? true : false
  const fvListOk: _fvListOk = true
  void fvListOk
}

void typeAttacks
