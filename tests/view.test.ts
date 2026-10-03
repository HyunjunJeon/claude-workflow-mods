import { expect, test } from 'claude-code/testing'
import { parseDefinition } from '../hooks/engine/definition.ts'
import { createRun, markFinished, markRunning } from '../hooks/engine/run.ts'
import type { Run } from '../hooks/engine/types.ts'
import { viewLines } from '../hooks/ui/views.ts'
import { buildPane, clampRunIndex, formatDuration, nodeOrder, stepSelection, visibleRuns, type Line, type ViewState } from '../hooks/ui/view-model.ts'

const VIEW: ViewState = { runIndex: 0, details: false, prefs: {} }

function fanIn(runId = 'r1', sessionId = 's1', createdAt = 1): Run {
  const parsed = parseDefinition({
    key: 'fan-in-' + runId,
    name: 'Fan in',
    nodes: [
      { id: 'a', prompt: 'A', category: 'quick', task_summary: 'write a.txt' },
      { id: 'b', prompt: 'B' },
      { id: 'c', prompt: 'C', dependsOn: ['a', 'b'] },
    ],
  })
  if (!parsed.ok) throw new Error(parsed.error.message)
  return createRun(parsed.value, { runId, sessionId, now: createdAt })
}

const text = (line: Line) => line.map(s => s.text).join('')

test('a node waiting for a permission answer shows a yellow badge in every graph view and its card', async () => {
  const run = markRunning(fanIn(), 'a', 'agent-a', 1_000)
  const waiting = new Map([['agent-a', 'Bash']])
  const badged = (line: Line) => line.some(s => s.text.includes('waiting: Bash') && s.color === 'yellow')
  for (const graphView of ['graph', 'lanes', 'timeline'] as const) {
    const model = buildPane([run], { ...VIEW, graphView }, 5_000, { waiting })
    expect(viewLines(model.graph!, 100).some(badged)).toBe(true)
    expect(badged(model.cards.find(card => card.id === 'a')!.header)).toBe(true)
  }
  expect(buildPane([run], VIEW, 5_000).cards.some(card => badged(card.header))).toBe(false)
})

test('an empty project explains how to start a run', async () => {
  const model = buildPane([], VIEW, 0)
  expect(model.empty).toContain('/dag run')
  expect(model.cards.length).toBe(0)
})

test('the header, graph, dependency list and cards follow the run', async () => {
  let run = markRunning(fanIn(), 'a', 'agent-aaaaaaaaaaaa', 1_000, 'claude-haiku')
  run = markFinished(markRunning(run, 'b', 'agent-b', 1_000), 'b', { state: 'completed', answer: 'wrote b\nDAG_NODE_STATUS: completed' }, 4_000)
  const model = buildPane([run], VIEW, 13_000, { taskCount: 2 })

  expect(model.header.map(text)).toEqual(['DAG  t Tasks (2)', 'Fan in  run 1/1 · r1', 'running · 1/3 done'])
  expect(model.graph!.nodes.map(n => [n.id, n.icon, n.color, n.incoming])).toEqual([
    ['a', '●', 'cyan', []],
    ['b', '✓', 'green', []],
    ['c', '○', '', ['a', 'b']],
  ])
  expect(model.dependencies.map(text)).toEqual(['  a → c', '  b → c'])
  expect(model.runs).toBe(null)
  expect(model.cards.map(c => c.id)).toEqual(['a', 'b', 'c'])
  expect(text(model.cards[2]!.header)).toContain('← a, b')
})

test('selection walks nodes in layer order and marks the card and the graph box', async () => {
  const run = markFinished(markRunning(fanIn(), 'a', 'agent-a', 1_000), 'a', { state: 'failed', error: 'no disk' }, 2_000)
  const order = nodeOrder(run)
  expect(order).toEqual(['a', 'b', 'c'])
  expect(stepSelection(order, undefined, 1)).toBe('a')
  expect(stepSelection(order, undefined, -1)).toBe('c')
  expect(stepSelection(order, 'c', 1)).toBe('a')
  expect(stepSelection(order, 'a', -1)).toBe('c')

  const model = buildPane([run], { ...VIEW, selected: 'b' }, 3_000)
  expect(model.cards.map(c => c.selected)).toEqual([false, true, false])
  expect(text(model.cards[1]!.header).startsWith('> ')).toBe(true)
  expect(model.graph!.nodes.map(n => n.selected)).toEqual([false, true, false])
  expect(model.header.map(text)[2]).toBe('running · 0/3 done · 1 failed')
  expect(model.errors.map(text)).toEqual(['× a: no disk', '× c: Skipped: dependency "a" ended as failed.'])
})

test('running nodes expand by default, others fold, and saved choices win', async () => {
  let run = markRunning(fanIn(), 'a', 'agent-aaaaaaaaaaaa', 1_000, 'claude-haiku')
  run = markFinished(markRunning(run, 'b', 'agent-b', 1_000), 'b', { state: 'completed', answer: 'wrote b\nDAG_NODE_STATUS: completed' }, 4_000)

  const auto = buildPane([run], VIEW, 13_000)
  expect(auto.cards.map(c => c.expanded)).toEqual([true, false, false])
  const a = auto.cards[0]!.lines.map(text)
  expect(a).toContain('write a.txt')
  expect(a).toContain('agent agent-aaaa · claude-haiku')
  expect(a).toContain('attempt 1 · 12s')

  const saved = buildPane([run], { ...VIEW, prefs: { r1: { a: false, b: true } } }, 13_000)
  expect(saved.cards.map(c => c.expanded)).toEqual([false, true, false])
  expect(saved.cards[1]!.lines.map(text)).toContain('wrote b')
})

test('details mode adds the task id and the answer', async () => {
  const run = markFinished(markRunning(fanIn(), 'a', 'agent-full-id', 1_000), 'a', { state: 'failed', answer: 'tried hard', error: 'no disk' }, 2_000)
  const model = buildPane([run], { ...VIEW, details: true, prefs: { r1: { a: true } } }, 3_000)
  const lines = model.cards[0]!.lines.map(text)
  expect(lines).toContain('no disk')
  expect(lines).toContain('task agent-full-id')
  expect(lines).toContain('tried hard')
})

test('the pane prefers this session and switches runs cyclically', async () => {
  const mine = fanIn('mine', 's1', 5)
  const older = fanIn('older', 's1', 2)
  const other = fanIn('other', 's2', 9)
  expect(visibleRuns([older, other, mine], 's1').map(r => r.runId)).toEqual(['mine', 'older'])
  expect(visibleRuns([older, other], 's3').map(r => r.runId)).toEqual(['other', 'older'])
  expect(clampRunIndex(-1, 2)).toBe(1)
  expect(clampRunIndex(2, 2)).toBe(0)
  const model = buildPane([mine, older], { ...VIEW, runIndex: 1 }, 0)
  expect(text(model.header[1]!)).toContain('run 2/2 · older')
  expect(model.runs!.rows.map(r => [r.index, r.selected])).toEqual([
    [0, false],
    [1, true],
  ])
  expect(text(model.runs!.rows[1]!.line)).toBe('> Fan in  0/3 done · 0 running · 3 waiting')
})

test('durations read as seconds, minutes and hours', async () => {
  expect(formatDuration(9_400)).toBe('9s')
  expect(formatDuration(65_000)).toBe('1m 05s')
  expect(formatDuration(3_720_000)).toBe('1h 02m')
})
