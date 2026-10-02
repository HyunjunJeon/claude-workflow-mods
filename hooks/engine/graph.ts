import type { NodeDef } from './types.ts'

export type Edge = { from: string; to: string }

export function edgesOf(nodes: NodeDef[]): Edge[] {
  return nodes.flatMap(node => node.dependsOn.map(dep => ({ from: dep, to: node.id })))
}

export function layers(ids: string[], edges: Edge[]): string[][] {
  const remaining = new Set(ids)
  const done = new Set<string>()
  const rows: string[][] = []
  while (remaining.size > 0) {
    const row = ids.filter(id => remaining.has(id) && edges.every(e => e.to !== id || done.has(e.from)))
    if (row.length === 0) throw new Error('The graph has a dependency cycle.')
    rows.push(row)
    for (const id of row) {
      remaining.delete(id)
      done.add(id)
    }
  }
  return rows
}

export function downstream(nodes: NodeDef[], roots: Iterable<string>): Set<string> {
  const dependents = new Map<string, string[]>()
  for (const node of nodes) {
    for (const dep of node.dependsOn) dependents.set(dep, [...(dependents.get(dep) ?? []), node.id])
  }
  const found = new Set<string>()
  const stack = [...roots]
  while (stack.length > 0) {
    const id = stack.pop() as string
    for (const next of dependents.get(id) ?? []) {
      if (!found.has(next)) {
        found.add(next)
        stack.push(next)
      }
    }
  }
  return found
}

export function upstream(nodes: NodeDef[], id: string): Set<string> {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const found = new Set<string>()
  const stack = [...(byId.get(id)?.dependsOn ?? [])]
  while (stack.length > 0) {
    const dep = stack.pop() as string
    if (found.has(dep)) continue
    found.add(dep)
    stack.push(...(byId.get(dep)?.dependsOn ?? []))
  }
  return found
}

export function findCycle(nodes: NodeDef[]): string[] | undefined {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const color = new Map<string, 'visiting' | 'done'>()
  const path: string[] = []
  const visit = (id: string): string[] | undefined => {
    if (color.get(id) === 'done') return undefined
    if (color.get(id) === 'visiting') return [...path.slice(path.indexOf(id)), id]
    color.set(id, 'visiting')
    path.push(id)
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      const cycle = visit(dep)
      if (cycle) return cycle
    }
    path.pop()
    color.set(id, 'done')
    return undefined
  }
  for (const node of nodes) {
    const cycle = visit(node.id)
    if (cycle) return cycle.reverse()
  }
  return undefined
}
