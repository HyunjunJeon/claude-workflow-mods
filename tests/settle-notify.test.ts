import { expect, test } from 'claude-code/testing'
import type { VerificationCheck } from '../hooks/engine/types.ts'
import { boot, dag, finish, harness, start } from './control-harness.ts'

const CHECK: VerificationCheck[] = [{ kind: 'command', argv: ['check-control'] }]
const SOLO = { key: 'solo', name: 'Solo', nodes: [{ id: 'a', prompt: 'Write a', verify: CHECK }] }
const LONG_RUN_MS = 120_000
const TITLE = 'dag-workflow'

test('a run that took two minutes raises exactly one native notification naming the run, its result and its node counts', async ($, on) => {
  const h = harness(on)
  await boot($)
  await start($, SOLO)
  await h.clock.advance(LONG_RUN_MS + 30_000)
  await finish($, h)
  expect(h.notifications).toEqual([{ text: 'DAG Solo completed 1/1', title: TITLE }])
})

test('under the default long a run that settled within two minutes raises no notification', async ($, on) => {
  const h = harness(on)
  await boot($)
  await start($, SOLO)
  await h.clock.advance(LONG_RUN_MS - 2_000)
  await finish($, h)
  expect(h.notifications).toEqual([])
  // The settle message still goes out: only the native notification is skipped.
  expect(h.prompts.some(text => text.includes('settled: completed'))).toBe(true)
})

test('settle_notify always notifies a run that settled at once', { options: { settle_notify: 'always' } }, async ($, on) => {
  const h = harness(on)
  await boot($)
  await start($, SOLO)
  await finish($, h)
  expect(h.notifications.map(note => note.text)).toEqual(['DAG Solo completed 1/1'])
})

test('settle_notify off raises nothing for a long run', { options: { settle_notify: 'off' } }, async ($, on) => {
  const h = harness(on)
  await boot($)
  await start($, SOLO)
  await h.clock.advance(LONG_RUN_MS * 2)
  await finish($, h)
  expect(h.notifications).toEqual([])
})

test('an unknown settle_notify value keeps the default long: quiet for a short run, a notification for a long one', { options: { settle_notify: 'sometimes' } }, async ($, on) => {
  const h = harness(on)
  await boot($)
  await start($, SOLO)
  await finish($, h)
  expect(h.notifications).toEqual([])
  await start($, { ...SOLO, key: 'solo-again' })
  await h.clock.advance(LONG_RUN_MS)
  await finish($, h, 'agent-2')
  expect(h.notifications).toEqual([{ text: 'DAG Solo completed 1/1', title: TITLE }])
})

test('a failed run notifies its failed node count', { options: { settle_notify: 'always', auto_recovery: false } }, async ($, on) => {
  const h = harness(on)
  h.control.exitCode = 1
  await boot($)
  await start($, SOLO)
  await finish($, h)
  expect(h.notifications).toEqual([{ text: 'DAG Solo failed: 1 failed node(s), 0/1 completed', title: TITLE }])
})

test('a cancelled run raises no notification', { options: { settle_notify: 'always' } }, async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = await start($, SOLO)
  await dag($, { action: 'cancel', run_id: runId, reason: 'plan changed' })
  await finish($, h, 'agent-1', true)
  expect(h.prompts.some(text => text.includes('settled: cancelled'))).toBe(true)
  expect(h.notifications).toEqual([])
})

test('the notification speaks the configured language', { options: { settle_notify: 'always', language: 'ko' } }, async ($, on) => {
  const h = harness(on)
  await boot($)
  await start($, SOLO)
  await finish($, h)
  expect(h.notifications).toEqual([{ text: 'DAG Solo 완료 1/1', title: TITLE }])
})

test('ticking the settled run again does not notify a second time', { options: { settle_notify: 'always' } }, async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = await start($, SOLO)
  await finish($, h)
  // An unchanged amendment ticks the settled run without starting another worker.
  await dag($, { action: 'amend', run_id: runId, definition: SOLO })
  await h.clock.settle()
  expect(h.notifications).toHaveLength(1)
})

for (const outcome of ['rejected', 'unsent'] as const) {
  test(`a notification the host answers ${outcome} is logged to debug and the settle still goes out`, { options: { settle_notify: 'always' } }, async ($, on) => {
    const h = harness(on)
    h.control.notify = outcome
    await boot($)
    const runId = await start($, SOLO)
    await finish($, h)
    expect(h.notifications).toHaveLength(1)
    const index = h.logs.findIndex(text => text.includes('notification') && text.includes(runId))
    expect(index).toBeGreaterThanOrEqual(0)
    expect(h.logOptions[index]).toEqual({ to: 'debug' })
    expect(h.prompts.filter(text => text.includes('settled: completed'))).toHaveLength(1)
  })
}
