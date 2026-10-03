import { expect, test } from 'claude-code/testing'
import { graphLines } from '../hooks/ui/graph-layout.ts'
import type { GraphModel, GraphNode } from '../hooks/ui/graph-model.ts'
import { fit, fitTail, width, type Line } from '../hooks/ui/text.ts'

const text = (line: Line) => line.map(s => s.text).join('')

function node(id: string, incoming: string[] = [], extra: Partial<GraphNode> = {}): GraphNode {
  return { id, label: id, icon: '○', state: 'pending', color: '', activity: '', tail: '', incoming, selected: false, expanded: false, startedAt: null, finishedAt: null, ...extra }
}

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

function graph(nodes: GraphNode[]): GraphModel {
  return {
    nodes,
    edges: nodes.flatMap(n => n.incoming.map(from => ({ from, to: n.id }))),
    view: 'graph',
    unfold: false,
    now: 0,
    labels: LABELS,
  }
}

const FAN_IN = graph([
  node('a', [], { icon: '●', state: 'running', color: 'cyan', selected: true, expanded: true }),
  node('b', [], { icon: '✓', state: 'completed', color: 'green' }),
  node('c', ['a', 'b']),
])

test('a fan-in draws one box row per frontier joined by connectors to the target', async () => {
  const lines = graphLines(FAN_IN, 60).map(text)
  expect(lines).toHaveLength(13)
  expect(lines[0]).toBe(`╭${'─'.repeat(27)}╮  ╭${'─'.repeat(27)}╮`)
  expect(lines[1]).toBe(`│ ${fit('> [-] a', 25, true)} │  │ ${fit('  [+] b', 25, true)} │`)
  expect(lines[2]).toContain('● running')
  expect(lines[3]).toContain('Start node')
  expect(lines[5]).toBe(`${' '.repeat(14)}│${' '.repeat(30)}│`)
  expect(lines[6]).toBe(`${' '.repeat(14)}└${'─'.repeat(15)}┬${'─'.repeat(14)}┘`)
  expect(lines[7]).toBe(`${' '.repeat(30)}▼`)
  expect(lines[8]).toBe(`${' '.repeat(13)}╭${'─'.repeat(32)}╮`)
  expect(lines[11]).toContain('← a, b')
  for (const line of lines) expect(width(line)).toBeLessThanOrEqual(60)
})

test('a chain connects straight down and colours borders by state', async () => {
  const lines = graphLines(graph([node('a', [], { color: 'green' }), node('b', ['a'])]), 30)
  expect(lines.slice(5, 8).map(text)).toEqual([`${' '.repeat(15)}│`, `${' '.repeat(15)}│`, `${' '.repeat(15)}▼`])
  expect(lines[0]![1]).toMatchObject({ color: 'green' })
  expect(lines[8]![1]).toMatchObject({ dim: true })
})

test('a frontier wider than the pane wraps and says so', async () => {
  const lines = graphLines(graph([node('a'), node('b'), node('c')]), 60).map(text)
  expect(lines[5]).toBe('  · Same frontier')
  expect(lines[6]).toBe(`${' '.repeat(13)}╭${'─'.repeat(32)}╮`)
})

test('an edge that skips a row runs down a gutter lane', async () => {
  const lines = graphLines(graph([node('a'), node('b', ['a']), node('c', ['a', 'b'])]), 40).map(text)
  expect(lines).toHaveLength(23)
  expect(lines[0]).toBe(`    ╭${'─'.repeat(32)}╮`)
  expect(lines.slice(5, 9)).toEqual([`${' '.repeat(21)}│`, `┌${'─'.repeat(20)}┤`, `│${' '.repeat(20)}│`, `│${' '.repeat(20)}▼`])
  expect(lines[9]).toBe(`│   ╭${'─'.repeat(32)}╮`)
  expect(lines.slice(14, 18)).toEqual([`│${' '.repeat(20)}│`, `└${'─'.repeat(20)}┤`, `${' '.repeat(21)}│`, `${' '.repeat(21)}▼`])
  expect(lines[18]).toBe(`    ╭${'─'.repeat(32)}╮`)
  for (const line of lines) expect(width(line)).toBeLessThanOrEqual(40)
})

test('lanes leaving or entering a band each get their own line', async () => {
  const lines = graphLines(graph([node('a'), node('b'), node('c'), node('m', ['a', 'b']), node('v', ['m']), node('r', ['m', 'a'])]), 60).map(text)
  expect(lines[6]).toBe(`┌${'─'.repeat(17)}┼${'─'.repeat(27)}┘`)
  expect(lines[7]).toBe(`│ ┌${'─'.repeat(15)}┘`)
  expect(lines[16]).toBe(`└─┼${'─'.repeat(29)}┐`)
  expect(lines[24]).toBe(`  └${'─'.repeat(29)}┼${'─'.repeat(13)}┐`)
  expect(lines[25]).toBe(`${' '.repeat(18)}┌${'─'.repeat(13)}┴${'─'.repeat(13)}┤`)
  expect(lines.filter(line => line.includes('▼'))).toHaveLength(2)
  for (const line of lines) expect(width(line)).toBeLessThanOrEqual(60)
})

test('a wrapped frontier joins its fan-in through one shared lane', async () => {
  const lines = graphLines(graph([node('a'), node('b'), node('c'), node('d', ['a', 'b', 'c'])]), 60).map(text)
  expect(lines[6]).toBe(`┌${'─'.repeat(15)}┴${'─'.repeat(28)}┘`)
  expect(lines[8]).toBe('│    · Same frontier')
  expect(lines[9]).toBe(`│${' '.repeat(13)}╭${'─'.repeat(32)}╮`)
  expect(lines.slice(14, 18)).toEqual([`│${' '.repeat(30)}│`, `└${'─'.repeat(30)}┤`, `${' '.repeat(31)}│`, `${' '.repeat(31)}▼`])
  expect(lines.join('\n').split('▼')).toHaveLength(2)
})

test('a narrow pane stacks boxes and keeps every line inside the width', async () => {
  const lines = graphLines(FAN_IN, 20).map(text)
  expect(lines[0]).toBe(`   ╭${'─'.repeat(15)}╮`)
  expect(lines[8]!.startsWith('│')).toBe(true)
  for (const line of lines) expect(width(line)).toBeLessThanOrEqual(20)
  expect(graphLines(FAN_IN, 0)).toEqual([])
})

test('streamed text keeps its newest characters and wide glyphs take two cells', async () => {
  const streaming = graph([node('a', [], { icon: '●', state: 'running', activity: '✎ now', tail: 'the very newest words' })])
  const room = 26 - width('● running ✎ now') - 1
  expect(text(graphLines(streaming, 30)[2]!)).toBe(`│ ${fit(`● running ✎ now ${fitTail('the very newest words', room)}`, 26, true)} │`)
  expect(text(graphLines(streaming, 30)[2]!)).toContain('words')
  expect(fitTail('abcdef', 4)).toBe('…def')
  expect(width('가나')).toBe(4)
  expect(fit('가나다', 5)).toBe('가나…')
})
