import { focusOf, frontiersOf, isRelated, type Edge, type GraphModel, type GraphNode } from './graph-model.ts'
import { fit, formatDuration, width, type Line } from './text.ts'

const PARTIAL = ['▏', '▎', '▍', '▌', '▋', '▊', '▉']
const TAIL = 11

function duration(node: GraphNode, now: number): number {
  return node.startedAt === null ? 0 : Math.max(0, (node.finishedAt ?? now) - node.startedAt)
}

export function criticalPath(order: GraphNode[], edges: Edge[], now: number): Set<string> {
  const best = new Map<string, number>()
  const previous = new Map<string, string>()
  for (const node of order) {
    let parent: string | undefined
    for (const edge of edges) {
      if (edge.to === node.id && (parent === undefined || (best.get(edge.from) ?? 0) > (best.get(parent) ?? 0))) parent = edge.from
    }
    best.set(node.id, duration(node, now) + (parent === undefined ? 0 : best.get(parent) ?? 0))
    if (parent !== undefined) previous.set(node.id, parent)
  }
  let end: string | undefined
  for (const [id, total] of best) if (total > 0 && (end === undefined || total > (best.get(end) ?? 0))) end = id
  const path = new Set<string>()
  for (let id = end; id !== undefined; id = previous.get(id)) path.add(id)
  return path
}

function bar(node: GraphNode, t0: number, span: number, cells: number, now: number): string {
  if (node.startedAt === null) return ' '.repeat(cells)
  const start = Math.min(cells - 1, Math.floor(((node.startedAt - t0) / span) * cells))
  const end = Math.max(start * 8 + 1, Math.round((((node.finishedAt ?? now) - t0) / span) * cells * 8))
  const full = Math.max(0, Math.floor(end / 8) - start)
  const rest = end % 8
  const drawn = ' '.repeat(start) + '█'.repeat(full) + (rest ? PARTIAL[rest - 1] : '')
  return drawn.slice(0, cells).padEnd(cells)
}

export function timelineLines(model: GraphModel, columns: number): Line[] {
  const order = frontiersOf(model).flat()
  if (columns <= 0 || order.length === 0) return []
  const started = order.filter(node => node.startedAt !== null)
  if (started.length === 0) return [[{ text: model.labels.notStarted, dim: true }]]
  const focus = focusOf(model)
  const t0 = Math.min(...started.map(node => node.startedAt as number))
  const span = Math.max(1_000, Math.max(...started.map(node => node.finishedAt ?? model.now)) - t0)
  const critical = criticalPath(order, model.edges, model.now)
  const labelWidth = Math.max(4, Math.min(Math.max(...order.map(node => width(node.label))), Math.floor(columns * 0.35)))
  const cells = Math.max(4, columns - 2 - labelWidth - 1 - TAIL)
  const rows: Line[] = order.map(node => {
    const related = isRelated(focus, node.id)
    const tone = related && node.color ? { color: node.color } : related ? {} : { dim: true as const }
    const spent = node.startedAt === null ? '' : formatDuration(duration(node, model.now))
    return [
      { text: `${node.icon} `, ...tone },
      { text: `${fit(node.label, labelWidth, true)} `, ...(node.selected ? { bold: true as const } : related ? {} : { dim: true as const }) },
      { text: bar(node, t0, span, cells, model.now), ...tone },
      { text: ` ${spent}`, dim: true },
      ...(critical.has(node.id) ? [{ text: ' ◆', bold: true as const }] : []),
    ]
  })
  const axis = Array<string>(cells).fill(' ')
  const put = (at: number, text: string) => [...text].forEach((ch, i) => at + i < cells && (axis[at + i] = ch))
  put(0, '0s')
  const middle = formatDuration(span / 2)
  put(Math.floor(cells / 2) - Math.floor(middle.length / 2), middle)
  const total = formatDuration(span)
  put(cells - total.length, total)
  return [
    ...rows,
    [{ text: `${' '.repeat(2 + labelWidth + 1)}${axis.join('')}`, dim: true }],
    ...(critical.size ? [[{ text: `${' '.repeat(2 + labelWidth + 1)}◆ ${model.labels.critical}`, dim: true as const }]] : []),
  ]
}
