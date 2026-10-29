import { expect, test } from 'claude-code/testing'
import type { GraphModel, GraphNode } from '../hooks/ui/graph-model.ts'
import { width, type Line } from '../hooks/ui/text.ts'
import { activeView, viewBody } from '../hooks/ui/views.ts'

// Claude Code 2.1.305 caps a docked pane at 45% of the terminal width.
const TERMINALS = [80, 120, 200]
const docked = (terminal: number) => Math.floor(0.45 * terminal)

const text = (line: Line) => line.map(s => s.text).join('')

const LABELS = {
  startNode: 'Start node',
  sameFrontier: 'Same frontier',
  more: '+{n} more',
  graph: 'Graph',
  lanes: 'Lanes',
  timeline: 'Timeline',
  auto: 'auto',
  notStarted: 'No node has started yet.',
  critical: 'critical path',
}

function node(id: string, incoming: string[] = [], extra: Partial<GraphNode> = {}): GraphNode {
  return { id, label: id, icon: '○', state: 'pending', color: '', activity: '', tail: '', incoming, selected: false, expanded: false, startedAt: null, finishedAt: null, ...extra }
}

function model(nodes: GraphNode[], extra: Partial<GraphModel> = {}): GraphModel {
  return { nodes, edges: nodes.flatMap(n => n.incoming.map(from => ({ from, to: n.id }))), view: 'auto', unfold: false, now: 0, labels: LABELS, ...extra }
}

const s = 1_000
const IDS = ['plan', 'api', 'ui', 'review', 'ship']
// A small fan-out and fan-in, with finished, running and pending nodes.
const run = (extra: Partial<GraphModel> = {}) =>
  model(
    [
      node('plan', [], { state: 'completed', icon: '✓', startedAt: 0, finishedAt: 10 * s }),
      node('api', ['plan'], { state: 'completed', icon: '✓', startedAt: 10 * s, finishedAt: 25 * s }),
      node('ui', ['plan'], { state: 'running', icon: '●', startedAt: 10 * s }),
      node('review', ['api', 'ui']),
      node('ship', ['review']),
    ],
    { now: 30 * s, ...extra },
  )

// The docked pane renders through GraphClient: host Buttons for the tab row, then viewBody at surface.columns.
// viewBody is the width-aware part; viewLines prepends a fixed-text tab line and is drawn only by the 60-column fallback.
for (const terminal of TERMINALS) {
  const columns = docked(terminal)
  for (const view of ['auto', 'graph', 'lanes', 'timeline'] as const) {
    test(`the ${view} view body at ${columns} columns (45% of ${terminal}) fits the pane and keeps every node id`, async () => {
      const m = run({ view })
      const lines = viewBody(m, columns, activeView(m, columns))
      for (const line of lines) expect(width(text(line))).toBeLessThanOrEqual(columns)
      const body = lines.map(text).join('\n')
      for (const id of IDS) expect(body).toContain(id)
    })
  }
}
