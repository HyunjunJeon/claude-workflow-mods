import { focusOf, frontiersOf, isRelated, type GraphModel, type GraphNode } from './graph-model.ts'
import { ACCENT, fit, fitTail, GLYPHS, width, type Line, type Segment } from './text.ts'

type Step = { cells: number[]; node?: { col: number; model: GraphNode } }

function mark(cells: number[], cell: number, bits: number): void {
  while (cells.length <= cell) cells.push(0)
  cells[cell]! |= bits
}

function horizontal(cells: number[], a: number, b: number): void {
  for (let x = Math.min(a, b); x < Math.max(a, b); x++) {
    mark(cells, x, 2)
    mark(cells, x + 1, 8)
  }
}

// One line per node in layer order, with a lane per edge still in flight, as
// git draws history: lane i sits in cell 2i and carries the id it is heading
// to. Lanes into one node merge above it; edges whose target already has a
// lane join that lane at once, which keeps fan-ins narrow.
function walk(model: GraphModel, order: GraphNode[]): Step[] {
  const position = new Map(order.map((node, i) => [node.id, i]))
  const rank = (id: string) => position.get(id) ?? 0
  const lanes: (string | null)[] = []
  const steps: Step[] = []
  let ended = -1
  const alloc = (avoid: number) => {
    const free = lanes.findIndex((target, i) => target === null && i !== avoid)
    if (free !== -1) return free
    lanes.push(null)
    return lanes.length - 1
  }
  for (const node of order) {
    const incoming = lanes.flatMap((target, i) => (target === node.id ? [i] : []))
    const col = incoming[0] ?? alloc(ended)
    if (incoming.length > 1) {
      const cells: number[] = []
      lanes.forEach((target, j) => {
        if (target !== null && !incoming.includes(j)) mark(cells, 2 * j, 5)
      })
      mark(cells, 2 * col, 5)
      for (const j of incoming.slice(1)) {
        mark(cells, 2 * j, 1)
        horizontal(cells, 2 * col, 2 * j)
        lanes[j] = null
      }
      steps.push({ cells })
    }
    const cells: number[] = []
    lanes.forEach((target, j) => {
      if (target !== null && j !== col) mark(cells, 2 * j, 5)
    })
    steps.push({ cells, node: { col, model: node } })

    lanes[col] = null
    const passing = lanes.map(target => target !== null)
    const targets = model.edges.filter(edge => edge.from === node.id).map(edge => edge.to).sort((a, b) => rank(a) - rank(b))
    const joins: number[] = []
    const opens: number[] = []
    let continued = false
    for (const target of targets) {
      const j = lanes.indexOf(target)
      if (j !== -1) {
        if (!joins.includes(j)) joins.push(j)
      } else if (!continued) {
        lanes[col] = target
        continued = true
      } else {
        const k = alloc(col)
        lanes[k] = target
        opens.push(k)
      }
    }
    const branches = joins.length > 0 || opens.length > 0
    ended = continued || branches ? -1 : col
    if (!branches) continue
    const branch: number[] = []
    passing.forEach((active, j) => {
      if (active) mark(branch, 2 * j, 5)
    })
    mark(branch, 2 * col, continued ? 5 : 1)
    for (const j of joins) horizontal(branch, 2 * col, 2 * j)
    for (const k of opens) {
      mark(branch, 2 * k, 4)
      horizontal(branch, 2 * col, 2 * k)
    }
    steps.push({ cells: branch })
  }
  return steps
}

export function laneLines(model: GraphModel, columns: number): Line[] {
  if (columns <= 0 || model.nodes.length === 0) return []
  const focus = focusOf(model)
  const steps = walk(model, frontiersOf(model).flat())
  const laneWidth = Math.min(Math.floor(columns / 2), Math.max(...steps.map(step => Math.max(step.cells.length, step.node ? 2 * step.node.col + 1 : 0))))
  const glyphs = (cells: number[]) => Array.from({ length: laneWidth }, (_, x) => GLYPHS[cells[x] ?? 0] ?? ' ')
  return steps.map(step => {
    const chars = glyphs(step.cells)
    if (!step.node) return [{ text: chars.join('').trimEnd(), color: ACCENT }]
    const { col, model: node } = step.node
    const related = isRelated(focus, node.id)
    const lanes = (text: string): Segment => ({ text, color: ACCENT })
    const at = Math.min(2 * col, laneWidth - 1)
    const room = Math.max(1, columns - laneWidth - 1)
    const label = `${node.selected ? '> ' : ''}${node.label}`
    const state = `  ${node.state}${node.activity ? ` ${node.activity}` : ''}`
    const left = Math.max(0, room - width(state) - 1)
    const tail = node.tail && left > width(label) + 6 ? ` ${fitTail(node.tail, left - width(label) - 1)}` : ''
    const line: Line = [
      lanes(chars.slice(0, at).join('')),
      { text: node.icon, ...(related && node.color ? { color: node.color } : related ? {} : { dim: true }) },
      lanes(chars.slice(at + 1).join('')),
      { text: ' ' },
      { text: fit(label, Math.max(1, room - width(state))), ...(node.selected ? { bold: true } : related ? {} : { dim: true }) },
      { text: fit(state, Math.max(0, room - width(label))), ...(related && node.color ? { color: node.color } : { dim: true }) },
    ]
    if (tail && related) line.push({ text: tail, dim: true })
    return line
  })
}
