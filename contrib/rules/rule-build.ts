import type { Artifact } from "../../src/artifact"
import type { ArtifactEvent, Build } from "../../src/build"
import type { Result } from "../../src/result"
import { Task, type Ref } from "../../src/task"
import { joinTaskVars, lookupValue } from "./join"
import type {
  Feed,
  InputGen,
  OutputGen,
  Rule,
  RuleContext,
  Value,
} from "./types"
import {
  hasAllVars,
  sameVarNames,
  VarsMap,
  varsKey,
  type Vars,
} from "./vars"

type InputSlot = {
  name: string
  gen: InputGen
  table: VarsMap<Value>
  dirty: Set<string>
  started: boolean
  /** True while a listen callback for this slot is running. */
  inCallback: boolean
}

type CompiledRule = {
  name: string
  optional: ReadonlySet<string>
  inputs: InputSlot[]
  outputs: { name: string; gen: OutputGen }[]
  id: (vars: Vars) => string
  run: (ctx: RuleContext<any, any, any>) => Promise<void>
  live: Set<string>
}

export class RuleBuild {
  private readonly build: Build
  private readonly rules: CompiledRule[] = []
  private loading = false

  constructor(build: Build) {
    this.build = build
  }

  rule<
    I extends Record<string, InputGen<Value>>,
    const Opt extends keyof I = never,
    O extends Record<string, OutputGen> = Record<string, OutputGen>,
  >(spec: Rule<I, Opt, O>): void {
    checkRuleShape(spec)

    const optional = new Set<string>()
    if (spec.optional) {
      for (const name of spec.optional) {
        optional.add(String(name))
      }
    }

    const inputs: InputSlot[] = []
    for (const name of Object.keys(spec.inputs)) {
      const gen = spec.inputs[name]!
      const slot: InputSlot = {
        name,
        gen,
        table: new VarsMap(),
        dirty: new Set(),
        started: false,
        inCallback: false,
      }
      inputs.push(slot)
    }

    const outputs: { name: string; gen: OutputGen }[] = []
    for (const name of Object.keys(spec.outputs)) {
      outputs.push({ name, gen: spec.outputs[name]! })
    }

    const idFn =
      spec.id ??
      ((vars: Vars) => {
        const key = varsKey(vars)
        if (key.length === 0) return spec.name
        return `${spec.name}:${key}`
      })

    this.rules.push({
      name: spec.name,
      optional,
      inputs,
      outputs,
      id: idFn,
      run: spec.run as (ctx: RuleContext<any, any, any>) => Promise<void>,
      live: new Set(),
    })
  }

  async load(): Promise<void> {
    this.loading = true
    try {
      for (const rule of this.rules) {
        for (const slot of rule.inputs) {
          if (slot.started) continue
          slot.started = true
          const feed = this.feedFor(slot)
          await slot.gen.start(feed)
        }
      }
    } finally {
      this.loading = false
    }
    this.syncAll()
    this.clearAllDirty()
  }

  async run(): Promise<Result> {
    await this.load()
    return this.build.run()
  }

  private feedFor(slot: InputSlot): Feed<Value> {
    return {
      set: (vars, value) => {
        this.assertFeedAllowed(slot, "set")
        if (!sameVarNames(vars, slot.gen.varNames)) {
          throw new Error(
            `feed.set vars ${JSON.stringify(vars)} do not match varNames [${slot.gen.varNames.join(", ")}]`,
          )
        }
        slot.table.set(vars, value)
        slot.dirty.add(varsKey(vars))
        this.syncIfIdle(slot)
      },
      delete: (vars) => {
        this.assertFeedAllowed(slot, "delete")
        if (!sameVarNames(vars, slot.gen.varNames)) {
          throw new Error(
            `feed.delete vars ${JSON.stringify(vars)} do not match varNames [${slot.gen.varNames.join(", ")}]`,
          )
        }
        const key = varsKey(vars)
        const existed = slot.table.delete(vars)
        if (!existed) return
        slot.dirty.add(key)
        this.syncIfIdle(slot)
      },
      listen: (prefix, fn) => {
        this.build.listen(prefix, async (event: ArtifactEvent) => {
          slot.inCallback = true
          try {
            await fn(event)
            if (!this.loading) {
              this.syncRulesUsing(slot)
              slot.dirty.clear()
            }
          } finally {
            slot.inCallback = false
          }
        })
      },
    }
  }

  private assertFeedAllowed(slot: InputSlot, op: "set" | "delete"): void {
    if (this.loading) return
    if (slot.inCallback) return
    throw new Error(
      `feed.${op} after start must run inside a listen callback for this input`,
    )
  }

  private syncIfIdle(slot: InputSlot): void {
    if (this.loading) return
    if (slot.inCallback) return
    this.syncRulesUsing(slot)
    slot.dirty.clear()
  }

  private syncRulesUsing(slot: InputSlot): void {
    for (const rule of this.rules) {
      let uses = false
      for (const input of rule.inputs) {
        if (input === slot) {
          uses = true
          break
        }
      }
      if (uses) this.syncRule(rule)
    }
  }

  private syncAll(): void {
    for (const rule of this.rules) {
      this.syncRule(rule)
    }
  }

  private clearAllDirty(): void {
    for (const rule of this.rules) {
      for (const slot of rule.inputs) {
        slot.dirty.clear()
      }
    }
  }

  private syncRule(rule: CompiledRule): void {
    const required: {
      name: string
      varNames: readonly string[]
      table: VarsMap<Value>
    }[] = []
    const optional: {
      name: string
      varNames: readonly string[]
      table: VarsMap<Value>
    }[] = []
    for (const slot of rule.inputs) {
      const desc = {
        name: slot.name,
        varNames: slot.gen.varNames,
        table: slot.table,
      }
      if (rule.optional.has(slot.name)) {
        optional.push(desc)
      } else {
        required.push(desc)
      }
    }

    const taskVarsList = joinTaskVars(required, optional)
    const wanted = new Map<string, { vars: Vars; task: Task; dirty: boolean }>()

    for (const vars of taskVarsList) {
      const built = this.instantiate(rule, vars)
      wanted.set(built.task.id, built)
    }

    for (const id of rule.live) {
      if (!wanted.has(id)) {
        this.build.remove(id)
        rule.live.delete(id)
      }
    }

    for (const [id, built] of wanted) {
      const isNew = !rule.live.has(id)
      if (!isNew && !built.dirty) continue
      this.build.add(built.task)
      rule.live.add(id)
    }
  }

  private instantiate(
    rule: CompiledRule,
    vars: Vars,
  ): { vars: Vars; task: Task; dirty: boolean } {
    const inputValues: Record<string, Value | undefined> = {}
    const inputArtifacts: Artifact[] = []
    let dirty = false

    for (const slot of rule.inputs) {
      const projected = projectKey(vars, slot.gen.varNames)
      if (slot.dirty.has(projected)) dirty = true

      const value = lookupValue(slot.table, slot.gen.varNames, vars)
      const isOptional = rule.optional.has(slot.name)
      if (value === undefined) {
        if (!isOptional) {
          throw new Error(
            `rule '${rule.name}': required input '${slot.name}' has no value for vars ${JSON.stringify(vars)}`,
          )
        }
        inputValues[slot.name] = undefined
        continue
      }
      inputValues[slot.name] = value
      for (const artifact of flattenValue(value)) {
        inputArtifacts.push(artifact)
      }
    }

    const outputRefs: Ref[] = []
    const outputValues: Record<string, Ref> = {}
    for (const out of rule.outputs) {
      if (!hasAllVars(out.gen.varNames, vars)) {
        throw new Error(
          `rule '${rule.name}': output '${out.name}' missing vars ${JSON.stringify(vars)}`,
        )
      }
      const ref = out.gen.ref(vars)
      outputValues[out.name] = ref
      outputRefs.push(ref)
    }

    const id = rule.id(vars)
    const task = new Task({
      id,
      inputs: inputArtifacts,
      outputs: outputRefs,
      run: async (ctx) => {
        for (const out of rule.outputs) {
          const ref = outputValues[out.name]!
          await out.gen.prepare(ref)
        }
        const ruleCtx: RuleContext<any, any, any> = {
          vars,
          inputs: inputValues,
          outputs: outputValues,
          signal: ctx.signal,
          produced: ctx.produced,
        }
        await rule.run(ruleCtx)
      },
    })

    return { vars, task, dirty }
  }
}

function projectKey(vars: Vars, names: readonly string[]): string {
  const out: Record<string, string> = {}
  for (const name of names) {
    const value = vars[name]
    if (value !== undefined) out[name] = value
  }
  return varsKey(out)
}

function flattenValue(value: Value): Artifact[] {
  if (Array.isArray(value)) {
    const out: Artifact[] = []
    for (const item of value) {
      out.push(item)
    }
    return out
  }
  return [value as Artifact]
}

function checkRuleShape(spec: {
  name: string
  inputs: Record<string, InputGen>
  optional?: readonly PropertyKey[]
  outputs: Record<string, OutputGen>
}): void {
  const inputNames = Object.keys(spec.inputs)
  const optionalNames: string[] = []
  if (spec.optional) {
    for (const name of spec.optional) {
      optionalNames.push(String(name))
    }
  }

  for (const name of optionalNames) {
    if (!inputNames.includes(name)) {
      throw new Error(
        `rule '${spec.name}': optional name '${name}' is not an input`,
      )
    }
  }

  const requiredNames: string[] = []
  for (const name of inputNames) {
    if (!optionalNames.includes(name)) requiredNames.push(name)
  }
  if (requiredNames.length === 0) {
    throw new Error(`rule '${spec.name}': needs at least one required input`)
  }

  const requiredVars = new Set<string>()
  for (const name of requiredNames) {
    const gen = spec.inputs[name]!
    for (const varName of gen.varNames) {
      requiredVars.add(varName)
    }
  }

  for (const name of optionalNames) {
    const gen = spec.inputs[name]!
    for (const varName of gen.varNames) {
      if (!requiredVars.has(varName)) {
        throw new Error(
          `rule '${spec.name}': optional input '${name}' uses var '${varName}' that no required input captures`,
        )
      }
    }
  }

  for (const name of Object.keys(spec.outputs)) {
    const gen = spec.outputs[name]!
    for (const varName of gen.varNames) {
      if (!requiredVars.has(varName)) {
        throw new Error(
          `rule '${spec.name}': output '${name}' uses var '${varName}' that no required input captures`,
        )
      }
    }
  }
}
