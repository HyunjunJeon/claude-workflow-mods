import { expect, test } from 'claude-code/testing'
import { parseDefinition } from '../hooks/engine/definition.ts'
import { expiredRuns } from '../hooks/engine/retention.ts'
import { createRun, markFinished, markRunning } from '../hooks/engine/run.ts'
import { chunkArrived, finalReport, fromTranscript, isStalled, stepStarted, toolStarted, STALL_COARSE_MS, STALL_TOKEN_MS, STALL_WAIT_MS } from '../hooks/ui/activity.ts'
import { stringsFor } from '../hooks/ui/i18n.ts'
import { activityLine, buildPane, buildTasks, type Line } from '../hooks/ui/view-model.ts'

const text = (line: Line) => line.map(s => s.text).join('')
const EN = stringsFor('en')
const KO = stringsFor('ko')

test('streamed chunks move the phase and keep the newest text', async () => {
  let a = stepStarted(1_000)
  expect(a).toEqual({ phase: 'waiting', since: 1_000, lastAt: 1_000 })
  a = chunkArrived(a, { kind: 'thinking' }, 2_000)!
  expect(a).toMatchObject({ phase: 'thinking', since: 2_000, lastAt: 2_000 })
  a = chunkArrived(a, { kind: 'text', text: 'Hello ' }, 3_000)!
  a = chunkArrived(a, { kind: 'text', text: 'world' }, 4_000)!
  expect(a).toMatchObject({ phase: 'responding', since: 3_000, lastAt: 4_000, text: 'Hello world' })
  a = chunkArrived(a, { kind: 'tool', name: 'Write' }, 5_000)!
  a = chunkArrived(a, { kind: 'input' }, 6_000)!
  expect(a).toMatchObject({ phase: 'tool-input', tool: 'Write', since: 5_000, lastAt: 6_000 })
  expect(chunkArrived(a, { kind: 'stop' }, 7_000)).toBe(a)
})

test('stalls are flagged by silence, never while a tool runs', async () => {
  const waiting = stepStarted(0)
  expect(isStalled(waiting, STALL_WAIT_MS)).toBe(false)
  expect(isStalled(waiting, STALL_WAIT_MS + 1)).toBe(true)
  const talking = chunkArrived(waiting, { kind: 'text', text: 'x' }, 10)!
  expect(isStalled(talking, 10 + STALL_TOKEN_MS + 1)).toBe(true)
  expect(isStalled(toolStarted('Bash', 0), 3_600_000)).toBe(false)
})

test('transcript rows give coarse activity for agents whose stream hooks never fire', async () => {
  const toolRow = { role: 'assistant', text: '', toolUses: [{ tool: 'Bash' }] }
  const a = fromTranscript([{ role: 'user', text: 'task', toolUses: [] }, toolRow], undefined, 1_000)
  expect(a).toMatchObject({ phase: 'tool', tool: 'Bash', since: 1_000, coarse: true })
  expect(fromTranscript([{ role: 'user', text: 'task', toolUses: [] }, toolRow], a, 9_000)).toBe(a)
  const answered = { role: 'assistant', text: '', toolUses: [{ tool: 'Bash', result: 'ok' }] }
  const waiting = fromTranscript([toolRow, answered, { role: 'user', text: '', toolUses: [] }], a, 10_000)
  expect(waiting).toMatchObject({ phase: 'waiting', since: 10_000 })
  expect(isStalled(waiting, 10_000 + STALL_WAIT_MS + 1)).toBe(false)
  expect(isStalled(waiting, 10_000 + STALL_COARSE_MS + 1)).toBe(true)
  expect(isStalled(a, 1_000 + STALL_COARSE_MS * 2)).toBe(false)
  expect(fromTranscript([{ role: 'assistant', text: 'all done', toolUses: [] }], undefined, 0)).toMatchObject({ phase: 'responding', text: 'all done' })
})

test('the final report comes from the last hand-back, else the last assistant text', async () => {
  const handback = { role: 'assistant', text: '', toolUses: [{ tool: 'SubagentHandback', input: { message: 'report' } }] }
  expect(finalReport([{ role: 'assistant', text: 'older', toolUses: [] }, handback])).toBe('report')
  expect(finalReport([{ role: 'assistant', text: 'plain answer', toolUses: [] }, { role: 'user', text: '', toolUses: [] }])).toBe('plain answer')
  expect(finalReport([])).toBe('')
})

test('activity lines describe each phase and mark a stall', async () => {
  expect(text(activityLine(stepStarted(0), 12_000, EN))).toBe('⏳ waiting for model 12s')
  expect(text(activityLine(toolStarted('Bash', 0), 65_000, EN))).toBe('▶ Bash running 1m 05s')
  const talking = chunkArrived(stepStarted(0), { kind: 'text', text: 'almost done' }, 1_000)!
  expect(text(activityLine(talking, 2_000, EN))).toBe('✎ now · …almost done')
  expect(text(activityLine(talking, 1_000 + STALL_TOKEN_MS + 1, EN))).toContain('⚠ possibly stalled')
  expect(text(activityLine(toolStarted('Bash', 0), 5_000, KO))).toBe('▶ Bash 실행 중 5s')
})

function fanIn(runId: string, sessionId: string, now: number) {
  const parsed = parseDefinition({ key: 'k-' + runId, name: 'Fan in', nodes: [{ id: 'a', prompt: 'A' }, { id: 'b', prompt: 'B', dependsOn: ['a'] }] })
  if (!parsed.ok) throw new Error(parsed.error.message)
  return createRun(parsed.value, { runId, sessionId, now })
}

test('a running node card shows its live activity and the pane can speak Korean', async () => {
  const run = markRunning(fanIn('r1', 's1', 0), 'a', 'agent-a', 1_000)
  const activity = new Map([['agent-a', chunkArrived(stepStarted(1_000), { kind: 'text', text: 'writing a.txt' }, 2_000)!]])
  const en = buildPane([run], { runIndex: 0, details: false, prefs: {} }, 3_000, { activity, t: EN })
  expect(en.cards[0]!.lines.map(text)).toContain('✎ now · …writing a.txt')
  const ko = buildPane([run], { runIndex: 0, details: false, prefs: {} }, 3_000, { activity, t: KO })
  expect(text(ko.header)).toContain('실행 중')
  expect(text(ko.header)).toContain('0/2 완료')
  expect(text(ko.cards[1]!.header)).toContain('대기')
})

test('the tasks view lists non-DAG subagents, running first, with activity', async () => {
  const agents = [
    { id: 'x1', description: 'Explore auth', type: 'Explore', status: 'completed' },
    { id: 'dag-node', description: 'Fan in: a', type: 'general-purpose', status: 'running' },
    { id: 'x2', description: 'Write tests', type: 'general-purpose', status: 'running' },
  ]
  const tasks = buildTasks(agents, new Set(['dag-node']), 5_000, { activity: new Map([['x2', toolStarted('Bash', 1_000)]]) })
  expect(text(tasks.header)).toBe('Tasks (2)')
  expect(tasks.rows.map(rows => text(rows[0]!))).toEqual(['● Write tests  general-purpose · running', '✓ Explore auth  Explore · completed'])
  expect(text(tasks.rows[0]![1]!)).toContain('▶ Bash running 4s')
  expect(text(buildTasks([], new Set(), 0).rows[0]![0]!)).toBe('No other subagents in this session.')
})

test('retention prunes only old settled runs of other sessions', async () => {
  const day = 86_400_000
  const oldDone = markFinished(markRunning(fanIn('old', 's0', 0), 'a', 'x', 0), 'a', { state: 'failed', error: 'x' }, 0)
  const oldRunning = markRunning(fanIn('busy', 's0', 0), 'a', 'y', 0)
  const mineOld = markFinished(markRunning(fanIn('mine', 's1', 0), 'a', 'z', 0), 'a', { state: 'failed', error: 'x' }, 0)
  const now = 20 * day
  expect(expiredRuns([oldDone, oldRunning, mineOld], now, 14, 's1').map(r => r.runId)).toEqual(['old'])
  expect(expiredRuns([oldDone], now, 0, 's1')).toEqual([])
  expect(expiredRuns([oldDone], now, 30, 's1')).toEqual([])
})
