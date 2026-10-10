import { edgesOf, layers, upstream } from './graph.ts'
import { isFinalAudit, lintDefinition, normalizePath } from './lint.ts'
import { CATEGORIES, spawnTarget } from './node-prompt.ts'
import type { Definition, NodeDef } from './types.ts'

export type PreviewNode = { id: string; wave: number; category: string; model: 'sonnet' | 'opus'; agent: string; depends_on: string[]; checks: number; writes: string[] | null; load_skills: string[] }
export type WriteConflict = { a: string; b: string; paths: string[] }
export type Preview = { node_count: number; waves: string[][]; critical_path: string[]; widest_wave: number; max_concurrent: number; nodes: PreviewNode[]; write_conflicts: WriteConflict[]; unchecked_writes: string[]; routing_note: string; warnings: string[] }

const ROUTING_NOTE = 'category and model are the definition\'s proposal after the final-audit rule; Jev may reroute a node when the run starts.'

// The category the node runs on at start. Same rule as the runtime: a final audit proposed as quick runs on unspecified-low.
// Jev may still reroute a node when the real start happens (it can answer a different category), so this is the proposal after the rule, not a promise.
function effectiveCategory(definition: Definition, node: NodeDef): string {
  const proposed = node.category ?? 'quick'
  return proposed === 'quick' && isFinalAudit(definition, node) ? 'unspecified-low' : proposed
}

// The most specific path of two normalized paths when they overlap, else undefined. "." is the project root and overlaps everything.
// sessions.ts sessionConflicts has the same equal-or-folder-prefix test, but inline, over resolved absolute scopes and with glob skipping, so it is not reusable on these relative paths.
function overlap(x: string, y: string): string | undefined {
  if (x === y) return x
  if (x === '.') return y
  if (y === '.') return x
  if (y.startsWith(`${x}/`)) return y
  if (x.startsWith(`${y}/`)) return x
  return undefined
}

// Compares two chains by the definition position of their nodes, root first.
function earlier(x: string[], y: string[], position: Map<string, number>): boolean {
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const diff = (position.get(x[i] as string) ?? 0) - (position.get(y[i] as string) ?? 0)
    if (diff !== 0) return diff < 0
  }
  return false
}

// The longest dependsOn chain by node count, root first. Chains of equal length go to the one that comes first in definition order.
function criticalPath(definition: Definition, waves: string[][]): string[] {
  const position = new Map(definition.nodes.map((node, index) => [node.id, index]))
  const byId = new Map(definition.nodes.map(node => [node.id, node]))
  const best = new Map<string, string[]>()
  for (const id of waves.flat()) {
    let prefix: string[] = []
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      const chain = best.get(dep) ?? []
      if (chain.length > prefix.length || (chain.length === prefix.length && earlier(chain, prefix, position))) prefix = chain
    }
    best.set(id, [...prefix, id])
  }
  let longest: string[] = []
  for (const chain of best.values()) {
    if (chain.length > longest.length || (chain.length === longest.length && earlier(chain, longest, position))) longest = chain
  }
  return longest
}

// Two nodes can run at the same time unless one is an ancestor of the other through dependsOn, transitively.
function concurrentPairs(definition: Definition): [NodeDef, NodeDef][] {
  const nodes = definition.nodes
  const ancestors = new Map(nodes.map(node => [node.id, upstream(nodes, node.id)]))
  return nodes.flatMap((a, i) => nodes.slice(i + 1)
    .filter(b => !ancestors.get(a.id)?.has(b.id) && !ancestors.get(b.id)?.has(a.id))
    .map((b): [NodeDef, NodeDef] => [a, b]))
}

// A node without writes never conflicts: an undeclared scope is unknown, not a conflict, so it is listed apart in unchecked_writes (see uncheckedWrites).
function writeConflicts(pairs: [NodeDef, NodeDef][]): WriteConflict[] {
  const conflicts: WriteConflict[] = []
  for (const [a, b] of pairs) {
    const paths: string[] = []
    for (const x of a.writes ?? []) {
      for (const y of b.writes ?? []) {
        const shared = overlap(normalizePath(x), normalizePath(y))
        if (shared !== undefined && !paths.includes(shared)) paths.push(shared)
      }
    }
    if (paths.length > 0) conflicts.push({ a: a.id, b: b.id, paths })
  }
  return conflicts
}

// Nodes with no writes field that share a moment with another node: their overlap with that peer was not checked. writes: [] is a declared read-only scope and is not listed.
// lintDefinition has no check for a missing writes, so this list is the only place an undeclared scope shows.
function uncheckedWrites(definition: Definition, pairs: [NodeDef, NodeDef][]): string[] {
  const withPeer = new Set(pairs.flatMap(([a, b]) => [a.id, b.id]))
  return definition.nodes.filter(node => node.writes === undefined && withPeer.has(node.id)).map(node => node.id)
}

// A category outside CATEGORIES is not an error at runtime: spawnTarget gives it sonnet. A typo such as deep-hgih would otherwise route quietly, so the preview says so.
function unknownCategoryWarnings(nodes: PreviewNode[]): string[] {
  return nodes
    .filter(node => !CATEGORIES.includes(node.category))
    .map(node => `node "${node.id}": category "${node.category}" is not a known category; it runs on ${node.model}.`)
}

export function previewDefinition(definition: Definition, options: { maxConcurrent: number }): Preview {
  const waves = layers(definition.nodes.map(node => node.id), edgesOf(definition.nodes))
  const wave = new Map(waves.flatMap((ids, index) => ids.map(id => [id, index + 1] as const)))
  const pairs = concurrentPairs(definition)
  const nodes = definition.nodes.map((node): PreviewNode => {
    const category = effectiveCategory(definition, node)
    const target = spawnTarget({ ...node, category })
    return {
      id: node.id,
      wave: wave.get(node.id) ?? 0,
      category,
      model: target.model,
      agent: target.subagentType,
      depends_on: [...node.dependsOn],
      checks: node.verify?.length ?? 0,
      // null is an undeclared scope; [] is a declared read-only scope (definition.ts and node-prompt.ts treat them apart too).
      writes: node.writes === undefined ? null : [...node.writes],
      load_skills: [...(node.load_skills ?? [])],
    }
  })
  return {
    node_count: definition.nodes.length,
    waves,
    critical_path: criticalPath(definition, waves),
    widest_wave: Math.max(0, ...waves.map(ids => ids.length)),
    max_concurrent: options.maxConcurrent,
    nodes,
    write_conflicts: writeConflicts(pairs),
    unchecked_writes: uncheckedWrites(definition, pairs),
    routing_note: ROUTING_NOTE,
    warnings: [...lintDefinition(definition), ...unknownCategoryWarnings(nodes)],
  }
}
