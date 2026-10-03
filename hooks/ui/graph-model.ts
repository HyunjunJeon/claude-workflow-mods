import { layers } from '../engine/graph.ts'

export type Edge = { from: string; to: string }
export type ViewKind = 'graph' | 'lanes' | 'timeline'

export type GraphNode = {
  id: string
  label: string
  icon: string
  state: string
  color: string
  activity: string
  tail: string
  /** Badge while the node's worker waits for a permission answer; the graph and lanes show it as `activity`. */
  waiting?: string
  incoming: string[]
  selected: boolean
  expanded: boolean
  startedAt: number | null
  finishedAt: number | null
}

export type GraphLabels = {
  startNode: string
  sameFrontier: string
  more: string
  graph: string
  lanes: string
  timeline: string
  auto: string
  notStarted: string
  critical: string
}

export type GraphModel = {
  nodes: GraphNode[]
  edges: Edge[]
  view: ViewKind | 'auto'
  unfold: boolean
  now: number
  labels: GraphLabels
}

export function frontiersOf(model: GraphModel): GraphNode[][] {
  const byId = new Map(model.nodes.map(node => [node.id, node]))
  return layers(model.nodes.map(node => node.id), model.edges).map(row => row.map(id => byId.get(id) as GraphNode))
}

export type Focus = { selected: string; up: Set<string>; down: Set<string> }

function reach(edges: Edge[], start: string, forward: boolean): Set<string> {
  const found = new Set<string>()
  const stack = [start]
  while (stack.length > 0) {
    const id = stack.pop() as string
    for (const edge of edges) {
      const [from, to] = forward ? [edge.from, edge.to] : [edge.to, edge.from]
      if (from === id && !found.has(to)) {
        found.add(to)
        stack.push(to)
      }
    }
  }
  return found
}

export function focusOf(model: GraphModel): Focus | null {
  const selected = model.nodes.find(node => node.selected)?.id
  if (selected === undefined) return null
  return { selected, up: reach(model.edges, selected, false), down: reach(model.edges, selected, true) }
}

export function isRelated(focus: Focus | null, id: string): boolean {
  return focus === null || id === focus.selected || focus.up.has(id) || focus.down.has(id)
}

export function onFocusPath(focus: Focus | null, edge: Edge): boolean {
  if (focus === null) return false
  const above = (id: string) => id === focus.selected || focus.up.has(id)
  const below = (id: string) => id === focus.selected || focus.down.has(id)
  return (above(edge.from) && above(edge.to)) || (below(edge.from) && below(edge.to))
}
