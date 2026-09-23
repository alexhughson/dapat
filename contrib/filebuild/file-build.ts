import path from "node:path"
import type { Build } from "../../src/build"
import type { ArtifactEvent } from "../../src/build"
import type { Prefix } from "../../src/prefix"
import type { Result } from "../../src/result"
import { Task, type Ref } from "../../src/task"
import { FileArtifact } from "../fs/file"
import { S3ObjectArtifact } from "../s3/object"
import type { InputPattern, Item, ItemInput, OutputPattern } from "./item"
import {
  compatible,
  hasAllVars,
  mergeVars,
  projectVars,
  varsKey,
  type Vars,
} from "./vars"

export type { Item, ItemInput } from "./item"
export type FileInput = ItemInput

export interface FileContext {
  readonly vars: Vars
  readonly inputs: Record<string, ItemInput>
  readonly outputs: Record<string, Item>
  readonly signal: AbortSignal
  file(name: string): FileArtifact
  files(name: string): FileArtifact[]
  item(name: string): Item
  items(name: string): Item[]
  outputFile(name: string): FileArtifact
  outputObject(name: string): S3ObjectArtifact
  outputPrefix(name: string): Prefix
  produced(artifact: Item): void
}

export interface FileRule {
  name: string
  inputs: Record<string, InputPattern>
  outputs: Record<string, OutputPattern>
  id?: (vars: Vars) => string
  run: (ctx: FileContext) => Promise<void>
}

type Row = {
  binding: Vars
  item: Item
}

type Slot = {
  name: string
  pattern: InputPattern
  rows: Map<string, Row>
}

type CompiledRule = {
  spec: FileRule
  slots: Slot[]
  live: Map<string, string>
}

export class FileBuild {
  private readonly build: Build
  private readonly root: string
  private readonly rules: CompiledRule[] = []
  private readonly listened = new Set<string>()
  private readonly dirty = new Set<string>()
  private scanning = false

  constructor(build: Build, opts: { root?: string } = {}) {
    this.build = build
    this.root = path.resolve(opts.root ?? process.cwd())
  }

  rule(spec: FileRule): void {
    const slots: Slot[] = []
    for (const name of Object.keys(spec.inputs)) {
      const pattern = spec.inputs[name]
      if (!pattern) continue
      slots.push({ name, pattern, rows: new Map() })
      this.listenOn(pattern.listenPrefix(this.root))
    }
    for (const name of Object.keys(spec.outputs)) {
      const pattern = spec.outputs[name]
      if (!pattern) continue
      this.listenOn(pattern.listenPrefix(this.root))
    }
    this.rules.push({ spec, slots, live: new Map() })
  }

  async scan(): Promise<void> {
    this.scanning = true
    for (const rule of this.rules) {
      for (const slot of rule.slots) {
        const ids = await slot.pattern.scan(this.root)
        for (const id of ids) {
          this.ingestId(id)
        }
      }
    }
    this.scanning = false
    this.syncAll()
    this.dirty.clear()
  }

  async run(): Promise<Result> {
    await this.scan()
    return this.build.run()
  }

  private listenOn(prefix: Prefix): void {
    if (this.listened.has(prefix.id)) return
    this.listened.add(prefix.id)
    this.build.listen(prefix, (event) => {
      this.onEvent(event)
    })
  }

  private onEvent(event: ArtifactEvent): void {
    if (event.type === "retracted") {
      this.dropId(event.id)
    } else {
      this.ingestId(event.id)
    }
    if (!this.scanning) {
      this.syncAll()
      this.dirty.clear()
    }
  }

  private ingestId(id: string): void {
    for (const rule of this.rules) {
      for (const slot of rule.slots) {
        const binding = slot.pattern.matchId(id, this.root)
        if (!binding) continue
        const item = slot.pattern.artifact(id, this.root)
        slot.rows.set(item.id, { binding, item })
        this.dirty.add(item.id)
      }
    }
  }

  private dropId(id: string): void {
    for (const rule of this.rules) {
      for (const slot of rule.slots) {
        if (slot.rows.delete(id)) {
          this.dirty.add(id)
        }
      }
    }
  }

  private syncAll(): void {
    for (const rule of this.rules) {
      this.syncRule(rule)
    }
  }

  private syncRule(rule: CompiledRule): void {
    const wanted = new Map<string, Task>()
    const tuples = this.join(rule)
    for (const vars of tuples) {
      const built = this.instantiate(rule, vars)
      if (!built) continue
      wanted.set(built.id, built)
    }
    for (const id of rule.live.keys()) {
      if (!wanted.has(id)) {
        this.build.remove(id)
        rule.live.delete(id)
      }
    }
    for (const [id, task] of wanted) {
      const snap = taskSnapshot(task)
      const inputsTouched = this.taskTouchesDirty(task)
      if (rule.live.get(id) === snap && !inputsTouched) continue
      this.build.add(task)
      rule.live.set(id, snap)
    }
  }

  private taskTouchesDirty(task: Task): boolean {
    for (const ref of task.inputs) {
      if (this.dirty.has(ref.id)) return true
    }
    return false
  }

  private join(rule: CompiledRule): Vars[] {
    let tuples: Vars[] = [{}]
    for (const slot of rule.slots) {
      if (slot.pattern.optional) continue
      if (slot.pattern.list && slot.pattern.varNames.length === 0) continue
      tuples = innerJoin(tuples, this.bindings(slot))
    }
    for (const slot of rule.slots) {
      if (!slot.pattern.optional) continue
      if (slot.pattern.list && slot.pattern.varNames.length === 0) continue
      tuples = leftJoin(tuples, this.bindings(slot))
    }
    return tuples
  }

  private bindings(slot: Slot): Vars[] {
    const out: Vars[] = []
    const seen = new Set<string>()
    for (const row of slot.rows.values()) {
      const projected = projectVars(row.binding, slot.pattern.varNames)
      const key = varsKey(projected)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(projected)
    }
    return out
  }

  private instantiate(rule: CompiledRule, vars: Vars): Task | null {
    const inputs: Record<string, ItemInput> = {}
    const outputs: Record<string, Item> = {}
    const prefixes: Record<string, Prefix> = {}
    const inputItems: Item[] = []
    const outputRefs: Ref[] = []

    for (const slot of rule.slots) {
      const items = this.itemsFor(slot, vars)
      if (slot.pattern.list) {
        inputs[slot.name] = items
        for (const item of items) {
          inputItems.push(item)
        }
        continue
      }
      if (items.length === 0) {
        if (!slot.pattern.optional) return null
        inputs[slot.name] = undefined
        continue
      }
      if (items.length > 1) {
        throw new Error(
          `rule '${rule.spec.name}' input '${slot.name}' matched ${items.length} items for ${varsKey(vars)}`,
        )
      }
      inputs[slot.name] = items[0]
      inputItems.push(items[0]!)
    }

    for (const name of Object.keys(rule.spec.outputs)) {
      const pattern = rule.spec.outputs[name]
      if (!pattern) continue
      if (!hasAllVars(pattern.varNames, vars)) return null
      if (pattern.list) {
        const prefix = pattern.boundPrefix(vars, this.root)
        prefixes[name] = prefix
        outputRefs.push(prefix)
        continue
      }
      const outId = pattern.renderId(vars, this.root)
      const artifact = pattern.artifact(outId, this.root)
      outputs[name] = artifact
      outputRefs.push(artifact)
    }

    const id = rule.spec.id
      ? rule.spec.id(vars)
      : `${rule.spec.name}:${varsKey(vars)}`

    return new Task({
      id,
      inputs: inputItems,
      outputs: outputRefs,
      run: async (ctx) => {
        for (const name of Object.keys(rule.spec.outputs)) {
          const pattern = rule.spec.outputs[name]
          if (!pattern) continue
          const artifact = outputs[name]
          if (artifact) {
            await pattern.prepareOutput(artifact)
            continue
          }
          const prefix = prefixes[name]
          if (prefix) {
            await pattern.preparePrefix(prefix)
          }
        }
        await rule.spec.run(
          contextFor(vars, inputs, outputs, prefixes, ctx.signal, ctx.produced),
        )
      },
    })
  }

  private itemsFor(slot: Slot, vars: Vars): Item[] {
    const items: Item[] = []
    for (const row of slot.rows.values()) {
      if (!compatible(row.binding, vars)) continue
      items.push(row.item)
    }
    items.sort((a, b) => {
      const left = slot.pattern.sortKey(a)
      const right = slot.pattern.sortKey(b)
      if (left < right) return -1
      if (left > right) return 1
      return 0
    })
    return items
  }
}

function contextFor(
  vars: Vars,
  inputs: Record<string, ItemInput>,
  outputs: Record<string, Item>,
  prefixes: Record<string, Prefix>,
  signal: AbortSignal,
  produced: (artifact: Item) => void,
): FileContext {
  return {
    vars,
    inputs,
    outputs,
    signal,
    file: (name: string) => asFile(namedInput(inputs, name), name),
    files: (name: string) => asFiles(inputs[name], name),
    item: (name: string) => asItem(namedInput(inputs, name), name),
    items: (name: string) => asItems(inputs[name]),
    outputFile: (name: string) => {
      const out = outputs[name]
      if (!(out instanceof FileArtifact)) {
        throw new Error(`output '${name}' is not a FileArtifact`)
      }
      return out
    },
    outputObject: (name: string) => {
      const out = outputs[name]
      if (!(out instanceof S3ObjectArtifact)) {
        throw new Error(`output '${name}' is not an S3ObjectArtifact`)
      }
      return out
    },
    outputPrefix: (name: string) => {
      const prefix = prefixes[name]
      if (!prefix) {
        throw new Error(`output '${name}' is not a prefix`)
      }
      return prefix
    },
    produced,
  }
}

function namedInput(inputs: Record<string, ItemInput>, name: string): ItemInput {
  return inputs[name]
}

function asItem(value: ItemInput, name: string): Item {
  if (!value || Array.isArray(value)) {
    throw new Error(`input '${name}' is not a single item`)
  }
  return value
}

function asFile(value: ItemInput, name: string): FileArtifact {
  const item = asItem(value, name)
  if (!(item instanceof FileArtifact)) {
    throw new Error(`input '${name}' is not a FileArtifact`)
  }
  return item
}

function asItems(value: ItemInput): Item[] {
  if (value === undefined) return []
  if (Array.isArray(value)) return value
  return [value]
}

function asFiles(value: ItemInput, name: string): FileArtifact[] {
  const items = asItems(value)
  const files: FileArtifact[] = []
  for (const item of items) {
    if (!(item instanceof FileArtifact)) {
      throw new Error(`input '${name}' is not a FileArtifact list`)
    }
    files.push(item)
  }
  return files
}

function innerJoin(left: Vars[], right: Vars[]): Vars[] {
  const out: Vars[] = []
  for (const l of left) {
    for (const r of right) {
      if (!compatible(l, r)) continue
      out.push(mergeVars(l, r))
    }
  }
  return out
}

function leftJoin(left: Vars[], right: Vars[]): Vars[] {
  const out: Vars[] = []
  for (const l of left) {
    let matched = false
    for (const r of right) {
      if (!compatible(l, r)) continue
      out.push(mergeVars(l, r))
      matched = true
    }
    if (!matched) out.push(l)
  }
  return out
}

function taskSnapshot(task: Task): string {
  const ins: string[] = []
  for (const ref of task.inputs) {
    ins.push(ref.id)
  }
  ins.sort()
  const outs: string[] = []
  for (const ref of task.outputs) {
    outs.push(ref.id)
  }
  outs.sort()
  return `${ins.join(",")}>${outs.join(",")}`
}
