/**
 * A radix tree from id strings to sets of values. Build uses it to find the producers of an input
 * without a scan of every output: the values whose key starts with a string, and the values whose
 * key is a start of a string. Each operation costs the length of the string, plus the values it visits.
 */
export class IdTrie<V> {
  private readonly root = new TrieNode<V>("")

  add(key: string, value: V): void {
    let node = this.root
    let at = 0
    while (at < key.length) {
      const child = node.edges.get(key[at]!)
      if (child === undefined) {
        const leaf = new TrieNode<V>(key.slice(at))
        node.edges.set(key[at]!, leaf)
        node = leaf
        break
      }
      const common = commonLength(child.label, key, at)
      if (common < child.label.length) {
        // Split the edge: a new node takes the common part, and the old child hangs below it.
        const middle = new TrieNode<V>(child.label.slice(0, common))
        child.label = child.label.slice(common)
        middle.edges.set(child.label[0]!, child)
        node.edges.set(key[at]!, middle)
        node = middle
      } else {
        node = child
      }
      at += common
    }
    if (node.values === null) node.values = new Set()
    node.values.add(value)
  }

  delete(key: string, value: V): void {
    const path: TrieNode<V>[] = [this.root]
    let node = this.root
    let at = 0
    while (at < key.length) {
      const child = node.edges.get(key[at]!)
      if (child === undefined || !key.startsWith(child.label, at)) return
      at += child.label.length
      node = child
      path.push(node)
    }
    if (node.values === null) return
    node.values.delete(value)
    if (node.values.size > 0) return
    node.values = null
    // Remove the empty leaf, and merge a node that keeps one edge and no values into its child.
    for (let i = path.length - 1; i > 0; i--) {
      const current = path[i]!
      const parent = path[i - 1]!
      if (current.values !== null) break
      if (current.edges.size === 0) {
        parent.edges.delete(current.label[0]!)
        continue
      }
      if (current.edges.size === 1) {
        const only = current.edges.values().next().value!
        only.label = current.label + only.label
        parent.edges.set(only.label[0]!, only)
      }
      break
    }
  }

  /** Calls `visit` for each value whose key starts with `start`, also the key equal to it. */
  withPrefix(start: string, visit: (value: V) => void): void {
    let node = this.root
    let at = 0
    while (at < start.length) {
      const child = node.edges.get(start[at]!)
      if (child === undefined) return
      const rest = start.length - at
      if (child.label.length >= rest) {
        // The rest of `start` ends inside this edge: every key below the edge starts with it.
        if (!child.label.startsWith(start.slice(at))) return
        visitAll(child, visit)
        return
      }
      if (!start.startsWith(child.label, at)) return
      at += child.label.length
      node = child
    }
    visitAll(node, visit)
  }

  /** Calls `visit` for each value whose key is a start of `id`, also the key equal to it. */
  startsOf(id: string, visit: (value: V) => void): void {
    let node = this.root
    let at = 0
    while (true) {
      if (node.values !== null) node.values.forEach((value) => visit(value))
      if (at >= id.length) return
      const child = node.edges.get(id[at]!)
      if (child === undefined || !id.startsWith(child.label, at)) return
      at += child.label.length
      node = child
    }
  }
}

class TrieNode<V> {
  // The child nodes, by the first character of their label.
  readonly edges = new Map<string, TrieNode<V>>()
  values: Set<V> | null = null
  constructor(
    // The characters between the parent and this node.
    public label: string,
  ) {}
}

function visitAll<V>(top: TrieNode<V>, visit: (value: V) => void): void {
  const stack = [top]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (node.values !== null) node.values.forEach((value) => visit(value))
    for (const child of node.edges.values()) stack.push(child)
  }
}

/** The number of characters at the start of `label` that equal `key` from `at`. */
function commonLength(label: string, key: string, at: number): number {
  let i = 0
  while (i < label.length && at + i < key.length && label[i] === key[at + i]) i++
  return i
}
