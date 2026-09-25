import type { Artifact } from "../../src/artifact"
import type { ArtifactEvent } from "../../src/build"
import type { Prefix } from "../../src/prefix"
import type { Ref } from "../../src/task"
import type { Vars } from "./vars"

export type { Vars }

export type Value = Artifact | readonly Artifact[]

export abstract class InputGen<V extends Value = Value> {
  abstract readonly varNames: readonly string[]
  abstract start(feed: Feed<V>): Promise<void>
}

export interface Feed<V extends Value> {
  set(vars: Vars, value: V): void
  delete(vars: Vars): void
  listen(
    prefix: Prefix,
    fn: (event: ArtifactEvent) => void | Promise<void>,
  ): void
}

export interface OutputGen<R extends Ref = Ref> {
  readonly varNames: readonly string[]
  ref(vars: Vars): R
  prepare(ref: R): Promise<void>
}

export type InputValue<G> = G extends InputGen<infer V> ? V : never
export type OutputRef<G> = G extends OutputGen<infer R> ? R : never

export interface RuleContext<
  I extends Record<string, InputGen<Value>>,
  Opt extends keyof I,
  O extends Record<string, OutputGen>,
> {
  readonly vars: Vars
  readonly inputs: {
    [K in keyof I]: K extends Opt ? InputValue<I[K]> | undefined : InputValue<I[K]>
  }
  readonly outputs: { [K in keyof O]: OutputRef<O[K]> }
  readonly signal: AbortSignal
  produced(artifact: Artifact): void
}

export interface Rule<
  I extends Record<string, InputGen<Value>>,
  Opt extends keyof I,
  O extends Record<string, OutputGen>,
> {
  name: string
  inputs: I
  optional?: readonly Opt[]
  outputs: O
  id?: (vars: Vars) => string
  run: (ctx: RuleContext<I, Opt, O>) => Promise<void>
}
