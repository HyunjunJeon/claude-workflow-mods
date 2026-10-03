import { focusOf, frontiersOf, isRelated, onFocusPath, type Edge, type Focus, type GraphModel, type GraphNode } from './graph-model.ts'
import { ACCENT, fit, fitTail, GLYPHS, paintRuns, width, type Line, type Segment } from './text.ts'

const MIN_BOX = 26
const MAX_BOX = 34
const GAP = 2
const MAX_LANES = 4
const MAX_ROWS = 6

type Row = { nodes: GraphNode[]; boxWidth: number; left: number; centers: Map<string, number>; wraps: boolean }

// An edge that skips box rows runs down a lane in the left gutter: it leaves
// its source in the band below the source's row and enters the target in the
// band above the target's row. One lane per target, so a fan-in shares it.
type Lane = { target: string; sources: { id: string; row: number }[]; start: number; end: number; x: number; hot: boolean }

function perRowFor(area: number): number {
  return Math.max(1, Math.floor((area + GAP) / (MIN_BOX + GAP)))
}

function buildRows(frontiers: GraphNode[][], area: number, offset: number): Row[] {
  const perRow = perRowFor(area)
  const rows: Row[] = []
  for (const frontier of frontiers) {
    for (let start = 0; start < frontier.length; start += perRow) {
      const nodes = frontier.slice(start, start + perRow)
      const boxWidth = Math.min(MAX_BOX, Math.floor((area - GAP * (nodes.length - 1)) / nodes.length))
      const left = offset + Math.max(0, Math.floor((area - (boxWidth * nodes.length + GAP * (nodes.length - 1))) / 2))
      const centers = new Map(nodes.map((node, i) => [node.id, left + i * (boxWidth + GAP) + Math.floor(boxWidth / 2)] as const))
      rows.push({ nodes, boxWidth, left, centers, wraps: start + perRow < frontier.length })
    }
  }
  return rows
}

function routeLanes(rows: Row[], edges: Edge[], focus: Focus | null): { lanes: Lane[]; dropped: number } {
  const rowOf = new Map<string, number>()
  rows.forEach((row, r) => row.nodes.forEach(node => rowOf.set(node.id, r)))
  const byTarget = new Map<string, Lane>()
  for (const edge of edges) {
    const from = rowOf.get(edge.from)
    const to = rowOf.get(edge.to)
    if (from === undefined || to === undefined || to - from < 2) continue
    const lane = byTarget.get(edge.to) ?? { target: edge.to, sources: [], start: from, end: to - 1, x: -1, hot: false }
    lane.sources.push({ id: edge.from, row: from })
    lane.start = Math.min(lane.start, from)
    lane.hot ||= onFocusPath(focus, edge)
    byTarget.set(edge.to, lane)
  }
  const columnEnds: number[] = []
  const lanes: Lane[] = []
  let dropped = 0
  for (const lane of [...byTarget.values()].sort((a, b) => a.start - b.start || a.end - b.end)) {
    let column = columnEnds.findIndex(end => end < lane.start)
    if (column === -1) {
      if (columnEnds.length >= MAX_LANES) {
        dropped++
        continue
      }
      column = columnEnds.length
      columnEnds.push(lane.end)
    } else columnEnds[column] = lane.end
    lanes.push({ ...lane, x: 2 * column })
  }
  return { lanes, dropped }
}

function gutterOf(lanes: Lane[]): number {
  return lanes.length ? Math.max(...lanes.map(lane => lane.x)) + 3 : 0
}

function gutterSegments(lanes: Lane[], gutter: number, row: number, focus: Focus | null): Segment[] {
  if (gutter === 0) return []
  const through = lanes.filter(lane => lane.start <= row - 1 && lane.end >= row)
  const chars = Array.from({ length: gutter }, (_, x) => (through.some(lane => lane.x === x) ? '│' : ' '))
  const hot = chars.map((_, x) => through.some(lane => lane.x === x && lane.hot))
  return paintRuns(chars, hot, focus !== null, false)
}

// A band is the space between two box rows. Line 0 holds the stubs under the
// sources; then each lane leaving or entering here gets a line of its own, so
// lanes never share a horizontal with each other or with the direct edges,
// which take the next line; the last line carries the arrows. A lane that
// only passes by is one vertical through every line.
function band(edges: Edge[], upper: Row, lower: Row, index: number, lanes: Lane[], columns: number, focus: Focus | null): Line[] {
  const direct = edges.filter(edge => upper.centers.has(edge.from) && lower.centers.has(edge.to))
  const leaving = lanes.filter(lane => lane.sources.some(source => source.row === index && upper.centers.has(source.id)))
  const entering = lanes.filter(lane => lane.end === index && lower.centers.has(lane.target))
  const through = lanes.filter(lane => lane.start < index && lane.end > index && !leaving.includes(lane))
  if (direct.length === 0 && leaving.length === 0 && entering.length === 0) {
    if (through.length === 0) return []
    const chars = Array<string>(columns).fill(' ')
    for (const lane of through) chars[lane.x] = '│'
    return [paintRuns(chars, chars.map((_, x) => through.some(lane => lane.x === x && lane.hot)), focus !== null)]
  }
  const leaveAt = new Map(leaving.map((lane, i) => [lane, 1 + i]))
  const enterAt = new Map(entering.map((lane, i) => [lane, 1 + leaving.length + i]))
  const directAt = direct.length ? 1 + leaving.length + entering.length : -1
  const arrowAt = 1 + leaving.length + entering.length + (direct.length ? 1 : 0)
  const height = arrowAt + 1
  const grid = Array.from({ length: height }, () => Array<number>(columns).fill(0))
  const hot = Array.from({ length: height }, () => Array<boolean>(columns).fill(false))
  const targets = new Set<number>()
  const mark = (y: number, x: number, bits: number, lit: boolean) => {
    if (x < 0 || x >= columns) return
    grid[y]![x]! |= bits
    if (lit) hot[y]![x] = true
  }
  const horizontal = (y: number, a: number, b: number, lit: boolean) => {
    for (let x = Math.min(a, b); x < Math.max(a, b); x++) {
      mark(y, x, 2, lit)
      mark(y, x + 1, 8, lit)
    }
  }
  const vertical = (x: number, from: number, to: number, lit: boolean) => {
    for (let y = from; y <= to; y++) mark(y, x, (y > from ? 1 : 0) | (y < to ? 4 : 0), lit)
  }
  const stubs = new Map<number, { last: number; lit: boolean }>()
  const use = (x: number, y: number, lit: boolean) => {
    const seen = stubs.get(x)
    stubs.set(x, { last: Math.max(seen?.last ?? 0, y), lit: (seen?.lit ?? false) || lit })
  }
  for (const edge of direct) {
    const a = upper.centers.get(edge.from) as number
    const b = lower.centers.get(edge.to) as number
    const lit = onFocusPath(focus, edge)
    use(a, directAt, lit)
    horizontal(directAt, a, b, lit)
    vertical(b, directAt, arrowAt, lit)
    targets.add(b)
  }
  for (const lane of leaving) {
    const y = leaveAt.get(lane) as number
    for (const source of lane.sources) {
      const c = source.row === index ? upper.centers.get(source.id) : undefined
      if (c === undefined) continue
      const lit = onFocusPath(focus, { from: source.id, to: lane.target })
      use(c, y, lit)
      horizontal(y, c, lane.x, lit)
    }
    if (lane.start < index) {
      mark(0, lane.x, 1, lane.hot)
      vertical(lane.x, 0, y, lane.hot)
    }
    vertical(lane.x, y, arrowAt, lane.hot)
    mark(arrowAt, lane.x, 4, lane.hot)
  }
  for (const lane of entering) {
    const y = enterAt.get(lane) as number
    const t = lower.centers.get(lane.target) as number
    mark(0, lane.x, 1, lane.hot)
    vertical(lane.x, 0, y, lane.hot)
    horizontal(y, lane.x, t, lane.hot)
    vertical(t, y, arrowAt, lane.hot)
    targets.add(t)
  }
  for (const lane of through) {
    mark(0, lane.x, 1, lane.hot)
    vertical(lane.x, 0, arrowAt, lane.hot)
    mark(arrowAt, lane.x, 4, lane.hot)
  }
  for (const [x, stub] of stubs) {
    mark(0, x, 1, stub.lit)
    vertical(x, 0, stub.last, stub.lit)
  }
  return grid.map((row, y) =>
    paintRuns(row.map((bits, x) => (y === arrowAt && targets.has(x) ? '▼' : GLYPHS[bits] ?? ' ')), hot[y]!, focus !== null),
  )
}

function border(node: GraphNode, focus: Focus | null): Omit<Segment, 'text'> {
  if (!isRelated(focus, node.id)) return { dim: true }
  if (node.selected) return { color: node.color || ACCENT, bold: true }
  return node.color ? { color: node.color } : { dim: true }
}

function boxes(model: GraphModel, row: Row, prefix: Segment[], prefixWidth: number, focus: Focus | null): Line[] {
  const { nodes, boxWidth } = row
  const lead = [...prefix, { text: ' '.repeat(Math.max(0, row.left - prefixWidth)) }]
  const inner = Math.max(1, boxWidth - 4)
  const edge = (open: string, close: string): Line => [
    ...lead,
    ...nodes.flatMap((node, i) => [
      ...(i > 0 ? [{ text: ' '.repeat(GAP) }] : []),
      { text: `${open}${'─'.repeat(Math.max(0, boxWidth - 2))}${close}`, ...border(node, focus) },
    ]),
  ]
  const interiors = nodes.map(node => {
    const head = `${node.icon} ${node.state}${node.activity ? ` ${node.activity}` : ''}`
    const room = inner - width(head) - 1
    const status = node.tail && room >= 4 ? `${head} ${fitTail(node.tail, room)}` : head
    const title = fit(`${node.selected ? '>' : ' '} [${node.expanded ? '-' : '+'}] ${node.label}`, inner, true)
    const from = fit(node.incoming.length ? `← ${node.incoming.join(', ')}` : model.labels.startNode, inner, true)
    if (!isRelated(focus, node.id)) return [{ text: title, dim: true as const }, { text: fit(status, inner, true), dim: true as const }, { text: from, dim: true as const }]
    return [
      node.selected ? { text: title, bold: true as const } : { text: title },
      { text: fit(status, inner, true), ...(node.color ? { color: node.color } : {}) },
      { text: from, dim: true as const },
    ]
  })
  const lines: Line[] = [edge('╭', '╮')]
  for (let line = 0; line < 3; line++) {
    lines.push([
      ...lead,
      ...nodes.flatMap((node, i) => [
        ...(i > 0 ? [{ text: ' '.repeat(GAP) }] : []),
        { text: '│ ', ...border(node, focus) },
        interiors[i]![line]!,
        { text: ' │', ...border(node, focus) },
      ]),
    ])
  }
  lines.push(edge('╰', '╯'))
  return lines
}

const FOLD_RANK = (node: GraphNode) => (node.selected ? 0 : node.color === 'yellow' ? 1 : node.color === 'red' ? 2 : node.color === ACCENT ? 3 : 4)

// A frontier wider than two box rows keeps its most telling nodes (selected,
// stalled, failed, running) and folds the rest into one summary box; edges of
// the folded nodes are drawn to and from that box.
function fold(model: GraphModel, frontiers: GraphNode[][], perRow: number): { frontiers: GraphNode[][]; edges: Edge[] } {
  const capacity = perRow * 2
  if (model.unfold || frontiers.every(frontier => frontier.length <= capacity)) return { frontiers, edges: model.edges }
  const summaryOf = new Map<string, string>()
  const folded = frontiers.map((frontier, k) => {
    if (frontier.length <= capacity) return frontier
    const keep = new Set([...frontier].sort((a, b) => FOLD_RANK(a) - FOLD_RANK(b) || frontier.indexOf(a) - frontier.indexOf(b)).slice(0, capacity - 1))
    const hidden = frontier.filter(node => !keep.has(node))
    const id = `+${k}`
    const counts = new Map<string, number>()
    for (const node of hidden) {
      summaryOf.set(node.id, id)
      counts.set(node.icon, (counts.get(node.icon) ?? 0) + 1)
    }
    const summary: GraphNode = {
      id,
      label: model.labels.more.replace('{n}', String(hidden.length)),
      icon: '…',
      state: [...counts].map(([icon, n]) => `${icon}${n}`).join(' '),
      color: '',
      activity: '',
      tail: '',
      incoming: [...new Set(hidden.flatMap(node => node.incoming))],
      selected: false,
      expanded: false,
      startedAt: null,
      finishedAt: null,
    }
    return [...frontier.filter(node => keep.has(node)), summary]
  })
  const seen = new Set<string>()
  const edges: Edge[] = []
  for (const edge of model.edges) {
    const from = summaryOf.get(edge.from) ?? edge.from
    const to = summaryOf.get(edge.to) ?? edge.to
    const key = `${from}\u0000${to}`
    if (from === to || seen.has(key)) continue
    seen.add(key)
    edges.push({ from, to })
  }
  return { frontiers: folded, edges }
}

export function graphFits(model: GraphModel, columns: number): boolean {
  const frontiers = frontiersOf(model)
  const perRow = perRowFor(columns)
  if (frontiers.some(frontier => frontier.length > perRow * 2)) return false
  const rows = buildRows(frontiers, columns, 0)
  return rows.length <= MAX_ROWS && routeLanes(rows, model.edges, null).dropped === 0
}

export function graphLines(model: GraphModel, columns: number): Line[] {
  if (columns <= 0 || model.nodes.length === 0) return []
  const focus = focusOf(model)
  const { frontiers, edges } = fold(model, frontiersOf(model), perRowFor(columns))
  let gutter = 0
  let rows = buildRows(frontiers, columns, 0)
  let lanes = routeLanes(rows, edges, focus).lanes
  for (let pass = 0; pass < 3 && gutterOf(lanes) !== gutter; pass++) {
    gutter = gutterOf(lanes)
    rows = buildRows(frontiers, Math.max(1, columns - gutter), gutter)
    lanes = routeLanes(rows, edges, focus).lanes
  }
  lanes = lanes.filter(lane => lane.x < gutter - 1)
  const out: Line[] = []
  rows.forEach((row, r) => {
    if (r > 0) {
      const above = rows[r - 1] as Row
      const joined = band(edges, above, row, r - 1, lanes, columns, focus)
      out.push(...joined)
      if (above.wraps) out.push([...gutterSegments(lanes, gutter, r, focus), { text: `  · ${model.labels.sameFrontier}`, dim: true }])
      else if (joined.length === 0) out.push([])
    }
    out.push(...boxes(model, row, gutterSegments(lanes, gutter, r, focus), gutter, focus))
  })
  return out
}
