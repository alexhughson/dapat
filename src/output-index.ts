import type { Artifact } from "./artifact"
import { IdTrie } from "./id-trie"
import { Prefix } from "./prefix"
import { isArtifact, isPrefix, type Ref } from "./task"

/** One output in the index, and its owner. */
type Entry<O> = { output: Ref; owner: O }
type ArtifactEntry<O> = { output: Artifact; owner: O }
type PrefixEntry<O> = { output: Prefix; owner: O }

/**
 * The outputs of a set of owners, by id. ownersFor() finds the owners whose outputs write an input:
 * - an artifact input: an artifact output with the same id, and each prefix output that covers it.
 * - a prefix input: each artifact output that it covers, and each prefix output that it overlaps.
 *
 * With the default covers() and overlaps(), the rules only compare the start of the id strings, so the
 * tries find the owners. A prefix class with its own rule can match any id, so the index checks every
 * output for it. That costs one check for each output in the index.
 */
export class OutputIndex<O> {
  // The artifact outputs, by output id.
  private readonly artifacts = new IdTrie<ArtifactEntry<O>>()
  // The same artifact outputs in a set. A prefix input with its own rule checks each of them.
  // A set is faster to visit than the whole trie.
  private readonly allArtifacts = new Set<ArtifactEntry<O>>()
  // The prefix outputs, by prefix id.
  private readonly prefixes = new IdTrie<PrefixEntry<O>>()
  // The prefix outputs whose class overrides covers(). The tries cannot find the ids that such a
  // prefix covers, so each artifact input checks each of them.
  private readonly customPrefixes = new Set<PrefixEntry<O>>()
  // The entries of each owner, so that delete() finds the entry of an output.
  private readonly entriesByOwner = new Map<O, Entry<O>[]>()

  add(output: Ref, owner: O): void {
    let entries = this.entriesByOwner.get(owner)
    if (entries === undefined) {
      entries = []
      this.entriesByOwner.set(owner, entries)
    }
    if (isArtifact(output)) {
      const entry: ArtifactEntry<O> = { output, owner }
      entries.push(entry)
      this.artifacts.add(output.id, entry)
      this.allArtifacts.add(entry)
    }
    if (isPrefix(output)) {
      const entry: PrefixEntry<O> = { output, owner }
      entries.push(entry)
      this.prefixes.add(output.id, entry)
      // A class that overrides covers() counts as custom, also when its rule is the same as the default.
      if (output.covers !== Prefix.prototype.covers) {
        this.customPrefixes.add(entry)
      }
    }
  }

  /** Deletes one entry of `output` for `owner`. Does nothing when there is none. */
  delete(output: Ref, owner: O): void {
    const entries = this.entriesByOwner.get(owner)
    if (entries === undefined) return
    const at = entries.findIndex((entry) => entry.output === output)
    if (at === -1) return
    const entry = entries[at]!
    entries.splice(at, 1)
    if (entries.length === 0) {
      this.entriesByOwner.delete(owner)
    }
    if (isArtifact(entry.output)) {
      this.artifacts.delete(entry.output.id, entry as ArtifactEntry<O>)
      this.allArtifacts.delete(entry as ArtifactEntry<O>)
    }
    if (isPrefix(entry.output)) {
      this.prefixes.delete(entry.output.id, entry as PrefixEntry<O>)
      this.customPrefixes.delete(entry as PrefixEntry<O>)
    }
  }

  /** Calls `visit` with the owner of each output that writes `input`. An owner can come more than one time. */
  ownersFor(input: Ref, visit: (owner: O) => void): void {
    if (isPrefix(input)) {
      this.ownersForPrefix(input, visit)
      return
    }
    this.ownersForArtifact(input, visit)
  }

  private ownersForPrefix(input: Prefix, visit: (owner: O) => void): void {
    const visitEntry = (entry: Entry<O>) => {
      visit(entry.owner)
    }
    const defaultCovers = input.covers === Prefix.prototype.covers
    const defaultOverlaps = input.overlaps === Prefix.prototype.overlaps
    if (defaultCovers && defaultOverlaps) {
      // A prefix output with its own rule can be narrower than its id, so its rule decides.
      const visitPrefixEntry = (entry: PrefixEntry<O>) => {
        if (this.customPrefixes.has(entry) && !entry.output.overlaps(input)) return
        visit(entry.owner)
      }
      // The artifact outputs under the input, the prefix outputs under it, and the prefix outputs above it.
      this.artifacts.withPrefix(input.id, visitEntry)
      this.prefixes.withPrefix(input.id, visitPrefixEntry)
      this.prefixes.startsOf(input.id, visitPrefixEntry)
      return
    }
    // A class with its own rule: check every output. withPrefix("") visits every prefix output.
    for (const entry of this.allArtifacts) {
      if (input.covers(entry.output)) {
        visit(entry.owner)
      }
    }
    this.prefixes.withPrefix("", (entry) => {
      if (input.overlaps(entry.output)) {
        visit(entry.owner)
      }
    })
  }

  private ownersForArtifact(input: Artifact, visit: (owner: O) => void): void {
    // The artifact outputs with the same id. startsOf also visits the ids that are a start of input.id.
    this.artifacts.startsOf(input.id, (entry) => {
      if (entry.output.id === input.id) {
        visit(entry.owner)
      }
    })
    // A prefix with the default covers() covers the ids that start with its id, so its key is a start
    // of input.id. covers() still decides, because a custom prefix is in the trie too.
    this.prefixes.startsOf(input.id, (entry) => {
      if (entry.output.covers(input)) {
        visit(entry.owner)
      }
    })
    // A custom covers() can cover any id, so check each custom prefix output.
    for (const entry of this.customPrefixes) {
      if (entry.output.covers(input)) {
        visit(entry.owner)
      }
    }
  }
}
