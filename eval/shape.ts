import { downstream, edgesOf, layers } from '../hooks/engine/graph.ts'
import { isVerificationNode, lintDefinition } from '../hooks/engine/lint.ts'
import type { Definition, NodeDef } from '../hooks/engine/types.ts'

export type ShapeClass = 'single' | 'parallel' | 'chain' | 'diamond' | 'fan-out/fan-in' | 'fan-out' | 'mixed'

export type ShapeMetrics = {
  nodes: number
  edges: number
  depth: number
  widths: number[]
  maxWidth: number
  fanInNodes: number
  fanOutNodes: number
  verify: boolean
  warnings: number
  categories: Record<string, number>
  shape: ShapeClass
  producerShape: ShapeClass
}

function dependentsCount(nodes: NodeDef[]): Map<string, number> {
  const counts = new Map(nodes.map(n => [n.id, 0]))
  for (const node of nodes) for (const dep of node.dependsOn) counts.set(dep, (counts.get(dep) ?? 0) + 1)
  return counts
}

export function classifyShape(nodes: NodeDef[]): ShapeClass {
  if (nodes.length <= 1) return 'single'
  const edges = edgesOf(nodes)
  if (edges.length === 0) return 'parallel'
  const widths = layers(nodes.map(n => n.id), edges).map(row => row.length)
  if (widths.every(w => w === 1)) return 'chain'
  const fanIns = nodes.filter(n => n.dependsOn.length >= 2)
  const fanOuts = [...dependentsCount(nodes)].filter(([, count]) => count >= 2).map(([id]) => id)
  const isDiamond = fanOuts.some(source => {
    const reachable = downstream(nodes, [source])
    return fanIns.some(join => join.dependsOn.filter(dep => reachable.has(dep)).length >= 2)
  })
  if (isDiamond) return 'diamond'
  if (fanIns.length > 0) return 'fan-out/fan-in'
  if (fanOuts.length > 0) return 'fan-out'
  return 'mixed'
}

function withoutVerification(nodes: NodeDef[]): NodeDef[] {
  const dependedOn = new Set(nodes.flatMap(n => n.dependsOn))
  const dropped = new Set(nodes.filter(n => isVerificationNode(n) && !dependedOn.has(n.id)).map(n => n.id))
  if (dropped.size === 0 || dropped.size === nodes.length) return nodes
  return nodes.filter(n => !dropped.has(n.id)).map(n => ({ ...n, dependsOn: n.dependsOn.filter(d => !dropped.has(d)) }))
}

export function shapeOf(definition: Definition): ShapeMetrics {
  const nodes = definition.nodes
  const edges = edgesOf(nodes)
  const widths = layers(nodes.map(n => n.id), edges).map(row => row.length)
  const categories: Record<string, number> = {}
  for (const node of nodes) {
    const key = node.category ?? '(session)'
    categories[key] = (categories[key] ?? 0) + 1
  }
  return {
    nodes: nodes.length,
    edges: edges.length,
    depth: widths.length,
    widths,
    maxWidth: Math.max(...widths),
    fanInNodes: nodes.filter(n => n.dependsOn.length >= 2).length,
    fanOutNodes: [...dependentsCount(nodes).values()].filter(count => count >= 2).length,
    verify: nodes.some(isVerificationNode),
    warnings: lintDefinition(definition).length,
    categories,
    shape: classifyShape(nodes),
    producerShape: classifyShape(withoutVerification(nodes)),
  }
}
