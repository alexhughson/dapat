import type { Artifact } from "../../src/artifact"
import { InputGen, type Feed } from "./types"
import { VarsMap, type Vars } from "./vars"

export class Capture {
  constructor(readonly name: string) {}
}

export function capture(name: string): Capture {
  return new Capture(name)
}

export type FieldSpec<F extends string> = Partial<Record<F, string | Capture>>

export type FieldRecord<F extends string, A extends Artifact> = {
  fields: Record<F, string>
  artifact: A
}

export type FieldValue<Id extends string, A extends Artifact, S> =
  [Exclude<Id, keyof S>] extends [never] ? A : A[]

export abstract class FieldGen<
  F extends string,
  Id extends F,
  A extends Artifact,
  S extends FieldSpec<F>,
> extends InputGen<FieldValue<Id, A, S>> {
  readonly spec: S
  readonly identity: readonly Id[]
  readonly varNames: readonly string[]
  readonly many: boolean

  constructor(spec: S, identity: readonly Id[]) {
    super()
    for (const key of Object.keys(spec) as F[]) {
      if (spec[key] === undefined) {
        throw new Error(
          `FieldGen spec field '${String(key)}' must not be undefined; omit the field instead`,
        )
      }
    }
    this.spec = spec
    this.identity = identity
    this.varNames = captureNames(spec)
    this.many = hasMissingIdentity(identity, spec)
  }

  protected abstract records(): Promise<FieldRecord<F, A>[]>

  protected literal(field: F): string | undefined {
    const value = this.spec[field]
    if (typeof value === "string") return value
    return undefined
  }

  async start(feed: Feed<FieldValue<Id, A, S>>): Promise<void> {
    const records = await this.records()
    const groups = new VarsMap<A[]>()

    for (const record of records) {
      const bound = bindRecord(record.fields, this.spec)
      if (bound === null) continue
      const existing = groups.get(bound) ?? []
      existing.push(record.artifact)
      groups.set(bound, existing)
    }

    for (const [vars, artifacts] of groups.entries()) {
      if (this.many) {
        const unique = dedupById(artifacts)
        unique.sort((a, b) => {
          if (a.id < b.id) return -1
          if (a.id > b.id) return 1
          return 0
        })
        feed.set(vars, unique as FieldValue<Id, A, S>)
      } else {
        const first = artifacts[0]!
        for (let i = 1; i < artifacts.length; i++) {
          if (artifacts[i]!.id !== first.id) {
            throw new Error(
              `FieldGen: two records with vars ${JSON.stringify(vars)} have different artifact ids '${first.id}' and '${artifacts[i]!.id}'`,
            )
          }
        }
        feed.set(vars, first as FieldValue<Id, A, S>)
      }
    }
  }
}

function captureNames<F extends string>(spec: FieldSpec<F>): string[] {
  const names: string[] = []
  for (const key of Object.keys(spec) as F[]) {
    const value = spec[key]
    if (value instanceof Capture) {
      if (!names.includes(value.name)) names.push(value.name)
    }
  }
  return names
}

function hasMissingIdentity<F extends string, Id extends F>(
  identity: readonly Id[],
  spec: FieldSpec<F>,
): boolean {
  for (const field of identity) {
    if (spec[field] === undefined) return true
  }
  return false
}

function bindRecord<F extends string>(
  fields: Record<F, string>,
  spec: FieldSpec<F>,
): Vars | null {
  const vars: Record<string, string> = {}
  for (const key of Object.keys(spec) as F[]) {
    const rule = spec[key]
    const fieldValue = fields[key]
    if (typeof rule === "string") {
      if (fieldValue !== rule) return null
      continue
    }
    if (rule instanceof Capture) {
      const existing = vars[rule.name]
      if (existing !== undefined && existing !== fieldValue) return null
      vars[rule.name] = fieldValue
    }
  }
  return vars
}

function dedupById<A extends Artifact>(artifacts: A[]): A[] {
  const seen = new Set<string>()
  const out: A[] = []
  for (const artifact of artifacts) {
    if (seen.has(artifact.id)) continue
    seen.add(artifact.id)
    out.push(artifact)
  }
  return out
}
