import type { On } from 'claude-code'
import { expect, test, type Engine } from 'claude-code/testing'
import type { VerificationCheck } from '../hooks/engine/types.ts'
import { boot, finish, harness, start } from './control-harness.ts'

// Native notifications: a settled run (under settle_notify), a permission wait and a stopped automatic recovery raise one
// `ui.notify`, which the shared harness records in h.notifications and answers as h.control.notify says. A settle
// notification that is not sent or rejects leaves a toast for a completed run; `notify: false` silences the permission-wait
// and recovery-stop notifications, while settle_notify alone governs the settle one (tests/settle-notify.test.ts).

const CHECK: VerificationCheck[] = [{ kind: 'command', argv: ['check-control'] }]
const ONE = { key: 'solo', name: 'Solo', nodes: [{ id: 'a', prompt: 'Write a', dependsOn: [], verify: CHECK }] }
const COMPLETED_TEXT = 'DAG Solo completed 1/1'
const WAITING_TEXT = 'DAG Solo › a is waiting for your permission'

test('a settled run raises one notification naming the run and its outcome', { options: { settle_notify: 'always' } }, async ($, on) => {
  const h = harness(on)
  await boot($)
  await start($, ONE)
  await finish($, h)

  expect(h.notifications).toEqual([{ text: COMPLETED_TEXT, title: 'dag-workflow' }])
  expect(h.toasts).toEqual([])
})

test('a notification that is not sent shows the settle text as a toast', { options: { settle_notify: 'always' } }, async ($, on) => {
  const h = harness(on)
  h.control.notify = 'unsent'
  await boot($)
  await start($, ONE)
  await finish($, h)

  expect(h.notifications).toHaveLength(1)
  expect(h.toasts.map(toast => toast.text)).toEqual([COMPLETED_TEXT])
})

test('a notification that rejects does not fail the hook and still shows the toast', { options: { settle_notify: 'always' } }, async ($, on) => {
  const h = harness(on)
  h.control.notify = 'rejected'
  await boot($)
  const runId = await start($, ONE)
  await finish($, h)

  expect(h.notifications).toHaveLength(1)
  expect(h.toasts.map(toast => toast.text)).toEqual([COMPLETED_TEXT])
  expect(h.logs.some(line => line.includes(`could not raise the notification that ${runId} settled`))).toBe(true)
})

// notify governs only the permission-wait, question and recovery-stop notifications; the settle one follows settle_notify.
test('notify false leaves the settle notification to settle_notify', { options: { notify: false, settle_notify: 'always' } }, async ($, on) => {
  const h = harness(on)
  await boot($)
  await start($, ONE)
  await finish($, h)

  expect(h.notifications).toEqual([{ text: COMPLETED_TEXT, title: 'dag-workflow' }])
})

async function waitForPermission($: Engine, on: On): Promise<void> {
  on('tool.call', { tool: 'Write' }, async (_engine, e) => {
    await $.classic.PermissionRequest({ agent_id: e.agentId, tool_name: 'Write', tool_input: { file_path: e.file_path } })
    return { result: { type: 'create', filePath: e.file_path, content: e.content, structuredPatch: [], originalFile: null } }
  })
}

test('a node that starts waiting for a permission answer raises one notification and keeps its toast', async ($, on) => {
  await waitForPermission($, on)
  const h = harness(on)
  await boot($)
  await start($, ONE)
  await $.tool.call({ tool: 'Write', file_path: '/work/a', content: 'x', agentId: 'agent-1', tool_use_id: 'ask-call' })
  await h.clock.settle()

  expect(h.notifications).toEqual([{ text: WAITING_TEXT, title: 'dag-workflow' }])
  expect(h.toasts.map(toast => toast.text)).toEqual([WAITING_TEXT])
})

const RECOVERY_STOPPED_TEXT = 'Solo › a: automatic recovery stopped, the node still fails'
const FAILED_TOAST = 'DAG Solo: node a failed verification'

// The harness answers every recovery question with a confident `implementation` class, so a failing check makes each
// attempt retry until the two extra attempts are used up and the third failure stays failed.
async function failUntilRecoveryStops(h: ReturnType<typeof harness>, $: Engine): Promise<void> {
  h.control.exitCode = 1
  await boot($)
  await start($, ONE)
  for (const attempt of [1, 2, 3]) await finish($, h, `agent-${attempt}`)
}

test('automatic recovery that stops on a node it retried raises one notification naming the run and node', async ($, on) => {
  const h = harness(on)
  await failUntilRecoveryStops(h, $)

  expect(h.spawns).toHaveLength(3)
  expect(h.notifications.filter(note => note.text.includes('automatic recovery stopped'))).toEqual([{ text: RECOVERY_STOPPED_TEXT, title: 'dag-workflow' }])
})

test('a recovery-stop notification that is not sent leaves the node-failed toast', async ($, on) => {
  const h = harness(on)
  h.control.notify = 'unsent'
  await failUntilRecoveryStops(h, $)

  expect(h.notifications.map(note => note.text)).toContain(RECOVERY_STOPPED_TEXT)
  expect(h.toasts.map(toast => toast.text)).toContain(FAILED_TOAST)
})

test('notify false raises no recovery-stop notification', { options: { notify: false } }, async ($, on) => {
  const h = harness(on)
  await failUntilRecoveryStops(h, $)

  expect(h.spawns).toHaveLength(3)
  expect(h.notifications).toEqual([])
})

test('a node that fails with automatic recovery off raises no recovery-stop notification', { options: { auto_recovery: false } }, async ($, on) => {
  const h = harness(on)
  h.control.exitCode = 1
  await boot($)
  await start($, ONE)
  await finish($, h)

  expect(h.spawns).toHaveLength(1)
  expect(h.notifications.filter(note => note.text.includes('automatic recovery stopped'))).toEqual([])
})

test('a node that fails without a retry used raises no recovery-stop notification', async ($, on) => {
  const h = harness(on)
  h.control.exitCode = 1
  h.control.recovery = 'permanent'
  await boot($)
  await start($, ONE)
  await finish($, h)

  expect(h.spawns).toHaveLength(1)
  expect(h.notifications.filter(note => note.text.includes('automatic recovery stopped'))).toEqual([])
})
