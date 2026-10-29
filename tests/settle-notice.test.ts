import { expect, test } from 'claude-code/testing'
import { parseDefinition } from '../hooks/engine/definition.ts'
import { cancelRun, createRun, markFinished, markRunning } from '../hooks/engine/run.ts'
import type { Run } from '../hooks/engine/types.ts'
import { stringsFor } from '../hooks/ui/i18n.ts'
import { LONG_RUN_MS, settleNotice } from '../hooks/ui/settle-notice.ts'

const SESSION = 'session-1'
const CREATED = 5_000
const en = stringsFor('en')
const ko = stringsFor('ko')

function definition() {
  const parsed = parseDefinition({
    key: 'fan-in',
    name: 'Fan in',
    nodes: [
      { id: 'a', prompt: 'A' },
      { id: 'b', prompt: 'B' },
      { id: 'c', prompt: 'C', dependsOn: ['a', 'b'] },
      { id: 'd', prompt: 'D' },
    ],
  })
  if (!parsed.ok) throw new Error(parsed.error.message)
  return parsed.value
}

// Runs each id in order to the state given, the way the hooks do: started, then finished.
function settle(outcomes: [string, 'completed' | 'failed'][], sessionId = SESSION): Run {
  let run = createRun(definition(), { runId: 'dag_1', sessionId, now: CREATED })
  outcomes.forEach(([id, state], index) => {
    run = markRunning(run, id, `agent-${index}`, CREATED + 1)
    run = markFinished(run, id, { state }, CREATED + 2)
  })
  return run
}

const COMPLETED = (): Run => settle([['a', 'completed'], ['b', 'completed'], ['c', 'completed'], ['d', 'completed']])
// b and d fail, c is blocked behind b: two failed nodes and one completed of four.
const FAILED = (): Run => settle([['a', 'completed'], ['b', 'failed'], ['d', 'failed']])
const LONG = CREATED + LONG_RUN_MS

test('settle_notify off never raises a notification', () => {
  expect(settleNotice(COMPLETED(), SESSION, 'off', LONG * 10, en)).toBeUndefined()
  expect(settleNotice(FAILED(), SESSION, 'off', LONG * 10, en)).toBeUndefined()
})

test('settle_notify long skips a run that took less than 120 s and notifies from exactly 120 s', () => {
  expect(settleNotice(COMPLETED(), SESSION, 'long', LONG - 1, en)).toBeUndefined()
  expect(settleNotice(COMPLETED(), SESSION, 'long', LONG, en)).toEqual({ title: 'dag-workflow', text: 'DAG Fan in completed 4/4' })
  expect(settleNotice(COMPLETED(), SESSION, 'long', LONG + 600_000, en)).toMatchObject({ title: 'dag-workflow' })
})

test('settle_notify always notifies a run that settled at once', () => {
  expect(settleNotice(COMPLETED(), SESSION, 'always', CREATED, en)).toEqual({ title: 'dag-workflow', text: 'DAG Fan in completed 4/4' })
})

test('a failed run names its failed node count and how many completed', () => {
  const run = FAILED()
  expect(run.status).toBe('failed')
  expect(settleNotice(run, SESSION, 'always', LONG, en)).toEqual({ title: 'dag-workflow', text: 'DAG Fan in failed: 2 failed node(s), 1/4 completed' })
})

test('the notification speaks the language of the strings it is given and keeps the title', () => {
  expect(settleNotice(COMPLETED(), SESSION, 'always', LONG, ko)).toEqual({ title: 'dag-workflow', text: 'DAG Fan in 완료 4/4' })
  expect(settleNotice(FAILED(), SESSION, 'always', LONG, ko)).toEqual({ title: 'dag-workflow', text: 'DAG Fan in 실패: 실패 노드 2개, 1/4 완료' })
})

test('a cancelled run raises no notification in any mode', () => {
  const started = markRunning(createRun(definition(), { runId: 'dag_1', sessionId: SESSION, now: CREATED }), 'a', 'agent-0', CREATED + 1)
  const run = markFinished(cancelRun(started, 'stopped by the user', CREATED + 2).run, 'a', { state: 'cancelled' }, CREATED + 3)
  expect(run.status).toBe('cancelled')
  for (const mode of ['off', 'long', 'always'] as const) expect(settleNotice(run, SESSION, mode, LONG * 10, en)).toBeUndefined()
})

test('a run still running raises no notification', () => {
  const started = markRunning(createRun(definition(), { runId: 'dag_1', sessionId: SESSION, now: CREATED }), 'a', 'agent-0', CREATED + 1)
  expect(settleNotice(started, SESSION, 'always', LONG * 10, en)).toBeUndefined()
})

test("another session's run raises no notification", () => {
  expect(settleNotice(settle([['a', 'completed'], ['b', 'completed'], ['c', 'completed'], ['d', 'completed']], 'session-2'), SESSION, 'always', LONG, en)).toBeUndefined()
})
