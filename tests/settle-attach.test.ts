import { expect, test } from 'claude-code/testing'
import { parseDefinition } from '../hooks/engine/definition.ts'
import { createRun, markFinished, markRunning } from '../hooks/engine/run.ts'
import type { VerificationCheck } from '../hooks/engine/types.ts'
import { boot, dag, finish, harness, ROOT, start } from './control-harness.ts'

// A run whose settle was announced before this process ran (by an earlier process, or by the session that owned the run
// before an attach adopted it) must not raise its settle notification, failure toast or trajectory record a second time.

const CHECK: VerificationCheck[] = [{ kind: 'command', argv: ['check-control'] }]
const SOLO = { key: 'solo', name: 'Solo', nodes: [{ id: 'a', prompt: 'Write a', verify: CHECK }] }
const RUN_ID = 'dag_gone'
const TITLE = 'dag-workflow'
const FAILED_TEXT = 'DAG Solo failed: 1 failed node(s), 0/1 completed'
const OPTIONS = { settle_notify: 'always', trajectory_log: true } as const

// A checkpoint written by a session this process never ran: its one node failed and the run settled.
function goneRun(settledNotified: boolean): string {
  const parsed = parseDefinition(SOLO)
  if (!parsed.ok) throw new Error(parsed.error.message)
  const created = createRun(parsed.value, { runId: RUN_ID, sessionId: 'gone-session', now: 500 })
  const running = markRunning(created, 'a', 'agent-gone', 600)
  const failed = markFinished(running, 'a', { state: 'failed', error: 'the check failed' }, 700)
  return JSON.stringify({ ...failed, settledNotified })
}

// The kinds of the events the trajectory log holds for a run, in file order.
function loggedKinds(h: ReturnType<typeof harness>, runId: string): string[] {
  const prefix = `${ROOT}/trajectories/${runId}/`
  return [...h.files.keys()].filter(path => path.startsWith(prefix)).sort().map(path => JSON.parse(h.files.get(path) ?? 'null').kind)
}

test('attaching a failed run whose settle was already announced raises no notification, no failure toast and no run.settle record', { options: OPTIONS }, async ($, on) => {
  const h = harness(on)
  h.files.set(`${ROOT}/runs/${RUN_ID}.json`, goneRun(true))
  await boot($)
  const reply = await dag($, { action: 'attach', run_id: RUN_ID })
  await h.clock.settle()
  expect(reply.adopted).toBe(true)
  expect(h.notifications).toEqual([])
  expect(h.toasts).toEqual([])
  expect(loggedKinds(h, RUN_ID)).not.toContain('run.settle')
  expect(h.files.has(`${ROOT}/trajectories/${RUN_ID}.jsonl`)).toBe(false)
})

test('attaching a failed run whose settle was never announced raises one notification, one failure toast and one run.settle record', { options: OPTIONS }, async ($, on) => {
  const h = harness(on)
  h.files.set(`${ROOT}/runs/${RUN_ID}.json`, goneRun(false))
  await boot($)
  const reply = await dag($, { action: 'attach', run_id: RUN_ID })
  await h.clock.settle()
  expect(reply.adopted).toBe(true)
  expect(h.notifications).toEqual([{ text: FAILED_TEXT, title: TITLE }])
  expect(h.toasts.map(toast => toast.text)).toEqual(['DAG Solo settled with 1 failed node(s)'])
  expect(loggedKinds(h, RUN_ID).filter(kind => kind === 'run.settle')).toHaveLength(1)
  expect(h.files.has(`${ROOT}/trajectories/${RUN_ID}.jsonl`)).toBe(true)
})

test('a run retried after its settle was announced notifies again when it settles again', { options: { settle_notify: 'always', auto_recovery: false } }, async ($, on) => {
  const h = harness(on)
  h.control.exitCode = 1
  await boot($)
  const runId = await start($, SOLO)
  await finish($, h)
  expect(h.notifications).toHaveLength(1)
  await dag($, { action: 'retry', run_id: runId })
  await finish($, h, 'agent-2')
  expect(h.notifications.map(note => note.text)).toEqual([FAILED_TEXT, FAILED_TEXT])
})
