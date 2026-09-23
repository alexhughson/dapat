import type { Stamp, TaskState } from "../../src/store"

export type EncodedStamp = {
  order?: string
  content?: string
}

export type EncodedTaskState = {
  inputStamps: Record<string, EncodedStamp>
  outputStamps: Record<string, EncodedStamp>
}

export function encodeState(state: TaskState): EncodedTaskState {
  return {
    inputStamps: encodeStampMap(state.inputStamps),
    outputStamps: encodeStampMap(state.outputStamps),
  }
}

export function decodeState(state: EncodedTaskState): TaskState {
  return {
    inputStamps: decodeStampMap(state.inputStamps),
    outputStamps: decodeStampMap(state.outputStamps),
  }
}

function encodeStampMap(stamps: Record<string, Stamp>): Record<string, EncodedStamp> {
  const out: Record<string, EncodedStamp> = {}
  for (const id of Object.keys(stamps)) {
    const stamp = stamps[id]
    if (!stamp) continue
    const encoded: EncodedStamp = {}
    if (stamp.order !== undefined) encoded.order = stamp.order.toString()
    if (stamp.content !== undefined) encoded.content = stamp.content
    out[id] = encoded
  }
  return out
}

function decodeStampMap(stamps: Record<string, EncodedStamp>): Record<string, Stamp> {
  const out: Record<string, Stamp> = {}
  for (const id of Object.keys(stamps)) {
    const encoded = stamps[id]
    if (!encoded) continue
    const stamp: Stamp = {}
    if (encoded.order !== undefined) stamp.order = BigInt(encoded.order)
    if (encoded.content !== undefined) stamp.content = encoded.content
    out[id] = stamp
  }
  return out
}
