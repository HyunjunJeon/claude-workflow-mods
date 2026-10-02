import { expect, test } from 'claude-code/testing'
import { parseDefinition } from '../hooks/engine/definition.ts'
import { createRun, markFinished, markRunning } from '../hooks/engine/run.ts'
import type { Run } from '../hooks/engine/types.ts'
import { buildPane, clampRunIndex, formatDuration, visibleRuns, type Line, type ViewState } from '../hooks/ui/view-model.ts'

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

test('an empty project explains how to start a run', async () => {
  const model = buildPane([], VIEW, 0)
  expect(model.empty).toContain('/dag run')
  expect(model.cards.length).toBe(0)
})

test('layers follow dependencies and nodes are listed in layer order', async () => {
  let run = markRunning(fanIn(), 'a', 'agent-aaaaaaaaaaaa', 1_000, 'claude-haiku')
  run = markFinished(markRunning(run, 'b', 'agent-b', 1_000), 'b', { state: 'completed', answer: 'wrote b\nDAG_NODE_STATUS: completed' }, 4_000)
  const model = buildPane([run], VIEW, 13_000)

  expect(text(model.header)).toContain('Fan in  running  1/3 done  run 1/1 · r1')
  expect(model.layers.map(text)).toEqual(['1 ● a  ✓ b', '2 ○ c'])
  expect(model.cards.map(c => c.id)).toEqual(['a', 'b', 'c'])
  expect(text(model.cards[2]!.header)).toContain('← a, b')
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
  expect(text(buildPane([mine, older], { ...VIEW, runIndex: 1 }, 0).header)).toContain('run 2/2 · older')
})

test('durations read as seconds, minutes and hours', async () => {
  expect(formatDuration(9_400)).toBe('9s')
  expect(formatDuration(65_000)).toBe('1m 05s')
  expect(formatDuration(3_720_000)).toBe('1h 02m')
})
