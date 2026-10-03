import { expect, test } from 'claude-code/testing'
import { graphLines } from '../hooks/ui/graph-layout.ts'
import type { GraphModel, GraphNode } from '../hooks/ui/graph-model.ts'
import { laneLines } from '../hooks/ui/lane-layout.ts'
import type { Line } from '../hooks/ui/text.ts'
import { timelineLines } from '../hooks/ui/timeline-layout.ts'
import { activeView, viewLines } from '../hooks/ui/views.ts'

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

test('the lanes view draws one line per node and joins a fan-in into one lane', async () => {
  const lines = laneLines(model([node('a'), node('b'), node('c', ['a', 'b']), node('d', ['c'])]), 60).map(text)
  expect(lines).toEqual(['○   a  pending', '│ ○ b  pending', '├─┘', '○   c  pending', '○   d  pending'])
})

test('the lanes view never stacks an unrelated start node under an ended lane', async () => {
  expect(laneLines(model([node('a'), node('b')]), 40).map(text)).toEqual(['○   a  pending', '  ○ b  pending'])
})

test('the lanes view branches a fan-out and merges it again', async () => {
  const lines = laneLines(model([node('a'), node('b', ['a']), node('c', ['a']), node('d', ['b', 'c'])]), 60).map(text)
  expect(lines).toEqual(['○   a  pending', '├─┐', '○ │ b  pending', '│ ○ c  pending', '├─┘', '○   d  pending'])
})

test('the timeline scales bars to the run and marks the critical path', async () => {
  const s = 1_000
  const graph = model(
    [
      node('a', [], { startedAt: 0, finishedAt: 10 * s }),
      node('b', [], { startedAt: 0, finishedAt: 20 * s }),
      node('c', ['a', 'b'], { startedAt: 20 * s, finishedAt: 30 * s }),
      node('d', ['c']),
    ],
    { now: 30 * s },
  )
  const lines = timelineLines(graph, 60).map(text)
  expect(lines[0]).toBe(`○ a    ${'█'.repeat(14)}${' '.repeat(28)} 10s`)
  expect(lines[1]).toBe(`○ b    ${'█'.repeat(28)}${' '.repeat(14)} 20s ◆`)
  expect(lines[2]).toBe(`○ c    ${' '.repeat(28)}${'█'.repeat(14)} 10s ◆`)
  expect(lines[3]).toBe(`○ d    ${' '.repeat(42)} `)
  expect(lines[4]).toBe(`       0s${' '.repeat(18)}15s${' '.repeat(16)}30s`)
  expect(lines[5]).toBe('       ◆ critical path')
  expect(timelineLines(model([node('a')]), 60).map(text)).toEqual(['No node has started yet.'])
})

test('a frontier wider than two box rows folds into a summary box unless unfolded', async () => {
  const wide = Array.from({ length: 8 }, (_, i) => node(`n${i}`, [], i === 6 ? { icon: '●', state: 'running', color: 'cyan' } : {}))
  const folded = graphLines(model(wide), 60).map(text).join('\n')
  expect(folded).toContain('+5 more')
  expect(folded).toContain('… ○5')
  expect(folded).toContain('[+] n6')
  expect(folded).not.toContain('[+] n2')
  const open = graphLines(model(wide, { unfold: true }), 60).map(text).join('\n')
  expect(open).not.toContain('+5 more')
  expect(open).toContain('[+] n2')
})

test('selecting a node brightens its paths and dims unrelated boxes', async () => {
  const lines = graphLines(model([node('a', [], { selected: true, color: 'cyan' }), node('b'), node('c', ['a', 'b'])]), 60)
  expect(lines[0]![1]).toMatchObject({ color: 'cyan', bold: true })
  expect(lines[0]![3]).toMatchObject({ dim: true })
  const join = lines[6]!
  expect(join.some(s => s.bold)).toBe(true)
  expect(join.some(s => s.dim)).toBe(true)
})

test('auto picks the graph when it fits and lanes when it does not, with tabs saying which', async () => {
  const small = model([node('a'), node('b', ['a'])])
  expect(activeView(small, 89)).toBe('graph')
  const shards = Array.from({ length: 24 }, (_, i) => node(`s${i}`))
  expect(activeView(model([...shards, node('report', shards.map(s => s.id))]), 89)).toBe('lanes')
  expect(text(viewLines(small, 89)[0]!)).toBe('▸ Graph     Lanes     Timeline   (auto)')
  expect(text(viewLines({ ...small, view: 'timeline' }, 89)[0]!)).toBe('  Graph     Lanes   ▸ Timeline')
})
