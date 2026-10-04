/**
 * Type-level contract for RuleBuild. Checked by `bunx tsc -p .`.
 * Runtime body only proves the module graph loads; negatives live in
 * never-called functions so bun test does not execute them.
 */
import { describe, expect, test } from "bun:test"
import { Artifact } from "../../src"
import {
  FieldGen,
  FileArtifact,
  FileGlob,
  FileOutput,
  FilePattern,
  RuleBuild,
  capture,
  type FieldRecord,
  type FieldSpec,
  type FieldValue,
  type InputValue,
  type OutputRef,
  type RuleContext,
} from "../../contrib"

type RowField = "id" | "group"

class DummyArtifact extends Artifact<string> {
  readonly id = "dummy:1"
  async orderStamp() {
    return null
  }
  async contentStamp() {
    return "x"
  }
  async read() {
    return "x"
  }
}

class RowsSingle<S extends FieldSpec<RowField>> extends FieldGen<
  RowField,
  "id",
  DummyArtifact,
  S
> {
  constructor(spec: S) {
    super(spec, ["id"])
  }

  protected async records(): Promise<FieldRecord<RowField, DummyArtifact>[]> {
    return []
  }
}

type DraftInputs = {
  brief: FilePattern
  guide: FilePattern
  process: FilePattern
}
type DraftOutputs = {
  draft: FileOutput
}
type DraftCtx = RuleContext<DraftInputs, never, DraftOutputs>

type ReviseInputs = {
  draft: FilePattern
  feedback: FilePattern
  attachments: FileGlob
}
type ReviseOutputs = {
  final: FileOutput
}
type ReviseCtx = RuleContext<
  ReviseInputs,
  "feedback" | "attachments",
  ReviseOutputs
>

// Positives: DOCS 11.1 / 11.2 table
type _DraftBrief = DraftCtx["inputs"]["brief"]
type _checkDraftBrief = _DraftBrief extends FileArtifact ? true : false
const _draftBriefOk: _checkDraftBrief = true

type _ReviseFeedback = ReviseCtx["inputs"]["feedback"]
type _checkFeedback = _ReviseFeedback extends FileArtifact | undefined
  ? true
  : false
const _feedbackOk: _checkFeedback = true

type _ReviseAttachments = ReviseCtx["inputs"]["attachments"]
type _checkAttachments = _ReviseAttachments extends
  | FileArtifact[]
  | undefined
  ? true
  : false
const _attachmentsOk: _checkAttachments = true

type _ReviseFinal = ReviseCtx["outputs"]["final"]
type _checkFinal = _ReviseFinal extends FileArtifact ? true : false
const _finalOk: _checkFinal = true

type _PatternValue = InputValue<FilePattern>
type _checkPattern = _PatternValue extends FileArtifact ? true : false
const _patternValueOk: _checkPattern = true

type _GlobValue = InputValue<FileGlob>
type _checkGlob = _GlobValue extends FileArtifact[] ? true : false
const _globValueOk: _checkGlob = true

type _FileOutRef = OutputRef<FileOutput>
type _checkFileOut = _FileOutRef extends FileArtifact ? true : false
const _fileOutOk: _checkFileOut = true

// FieldGen: identity present → A; identity left out → A[]
type SingleSpec = { id: ReturnType<typeof capture>; group: string }
type ListSpec = { group: ReturnType<typeof capture> }

type _SingleVal = FieldValue<"id", DummyArtifact, SingleSpec>
type _checkSingle = _SingleVal extends DummyArtifact ? true : false
const _singleOk: _checkSingle = true

type _ListVal = FieldValue<"id", DummyArtifact, ListSpec>
type _checkList = _ListVal extends DummyArtifact[] ? true : false
const _listOk: _checkList = true

type _GenSingle = RowsSingle<SingleSpec>
type _GenList = RowsSingle<ListSpec>
type _checkGenSingle = InputValue<_GenSingle> extends DummyArtifact ? true : false
type _checkGenList = InputValue<_GenList> extends DummyArtifact[] ? true : false
const _genSingleOk: _checkGenSingle = true
const _genListOk: _checkGenList = true

function typeNegatives(
  rules: RuleBuild,
  pattern: FilePattern,
  glob: FileGlob,
  fileOut: FileOutput,
  ctx: ReviseCtx,
): void {
  rules.rule({
    name: "bad-pattern-out",
    inputs: { src: pattern },
    // @ts-expect-error FilePattern is not an output generator
    outputs: { out: pattern },
    run: async () => {},
  })

  rules.rule({
    name: "bad-fileout-in",
    // @ts-expect-error FileOutput is not an input generator
    inputs: { src: fileOut },
    outputs: { out: fileOut },
    run: async () => {},
  })

  rules.rule({
    name: "bad-glob-out",
    inputs: { src: pattern },
    // @ts-expect-error FileGlob is not an output generator
    outputs: { out: glob },
    run: async () => {},
  })

  rules.rule({
    name: "bad-optional-name",
    inputs: { src: pattern },
    // @ts-expect-error optional name must be a key of inputs
    optional: ["nope"],
    outputs: { out: fileOut },
    run: async () => {},
  })

  // @ts-expect-error optional feedback is FileArtifact | undefined
  const _forced: FileArtifact = ctx.inputs.feedback
  void _forced
}

describe("RuleBuild type contract", () => {
  test("positive assignability constants hold", () => {
    expect(_draftBriefOk).toBe(true)
    expect(_feedbackOk).toBe(true)
    expect(_attachmentsOk).toBe(true)
    expect(_finalOk).toBe(true)
    expect(_patternValueOk).toBe(true)
    expect(_globValueOk).toBe(true)
    expect(_fileOutOk).toBe(true)
    expect(_singleOk).toBe(true)
    expect(_listOk).toBe(true)
    expect(_genSingleOk).toBe(true)
    expect(_genListOk).toBe(true)
  })

  test("typeNegatives is retained for tsc", () => {
    expect(typeof typeNegatives).toBe("function")
  })
})
