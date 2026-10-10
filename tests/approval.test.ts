import { expect, test, type Mounted } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { parseDefinition } from '../hooks/engine/definition.ts'
import { createRun, requestApproval } from '../hooks/engine/run.ts'
import type { VerificationCheck } from '../hooks/engine/types.ts'
import { stringsFor } from '../hooks/ui/i18n.ts'
import { boot, checkpoint, command, dag, harness, ROOT } from './control-harness.ts'

const CHECK: VerificationCheck[] = [{ kind: 'command', argv: ['check-control'] }]
const node = (id: string, dependsOn: string[] = []) => ({ id, prompt: `Write ${id}`, dependsOn, verify: CHECK })
const FAN_IN = { key: 'fan-in', name: 'Fan in', nodes: [node('a'), node('b'), node('c', ['a', 'b'])] }
const SOLO = { key: 'solo', name: 'Solo', nodes: [node('a')] }
const ALWAYS = { options: { start_approval: 'always' } } as const
const NOTE = 'The user must approve this run in the /dag pane or with /dag approve <run_id> before any node starts. Do not poll; you will receive a message when it is approved or rejected.'
const USER_ONLY = 'This action requires a user command or pane control.'
const t = stringsFor('en')

const PANE = {
  plugin: 'dag-workflow', component: 'Pane', requestId: 'dag', surface: 'terminal', viewport: { columns: 140, rows: 40 },
  props: { title: 'DAG', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

type StartReply = { run_id: string; reused: boolean; awaiting_approval?: true; note?: string; snapshot: { awaiting_approval?: true } }

async function modelStart($: Engine, definition: unknown = FAN_IN): Promise<StartReply> {
  const reply = await dag($, { action: 'start', definition })
  if (typeof reply.run_id !== 'string') throw new Error(JSON.stringify(reply))
  return reply as StartReply
}

function sdkCommand($: Engine, args: string) {
  return $.command.run({ command: 'dag', args, origin: { kind: 'sdk' }, presentation: { isFullscreen: false, columns: 80 } })
}

function states(h: ReturnType<typeof harness>, runId: string): string[] {
  return checkpoint(h, runId).nodes.map(current => current.state)
}

test('under the default setting a model start spawns its roots at once', async ($, on) => {
  const h = harness(on)
  await boot($)
  const reply = await modelStart($)
  expect(h.spawns.map(spawn => spawn.description)).toEqual(['Fan in: a', 'Fan in: b'])
  expect(reply.awaiting_approval).toBeUndefined()
  expect(reply.snapshot.awaiting_approval).toBeUndefined()
  expect(checkpoint(h, reply.run_id).approval).toBeUndefined()
})

test('with start_approval always a model start spawns nothing, says it awaits approval and keeps it in the checkpoint', ALWAYS, async ($, on) => {
  const h = harness(on)
  await boot($)
  const reply = await modelStart($)
  await h.clock.settle()
  expect(h.spawns).toHaveLength(0)
  expect(reply).toMatchObject({ reused: false, awaiting_approval: true, note: NOTE, snapshot: { awaiting_approval: true } })
  expect(checkpoint(h, reply.run_id).approval).toEqual({ requestedAt: expect.any(Number) })
  expect(states(h, reply.run_id)).toEqual(['scheduled', 'scheduled', 'pending'])
  expect(h.toasts.map(toast => toast.text)).toContain(t.toastApproval('Fan in'))
  // A reload (session.start again) reads the checkpoint back and keeps the run waiting.
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await h.clock.settle()
  expect(h.spawns).toHaveLength(0)
  expect(checkpoint(h, reply.run_id).approval).toBeDefined()
})

test('a model start of the definition a waiting run holds returns that run as before and starts nothing', ALWAYS, async ($, on) => {
  const h = harness(on)
  await boot($)
  const first = await modelStart($)
  const again = await modelStart($)
  expect(again).toMatchObject({ reused: true, run_id: first.run_id, snapshot: { awaiting_approval: true } })
  expect(h.spawns).toHaveLength(0)
})

test('the session override always holds a model start under the default setting', async ($, on) => {
  const h = harness(on)
  await boot($)
  expect((await command($, 'approval always')).text).toBe('DAG start approval: always (session override)')
  const reply = await modelStart($)
  expect(reply.awaiting_approval).toBe(true)
  expect(h.spawns).toHaveLength(0)
})

test('/dag approve starts a waiting run, spawns its roots and tells the model', ALWAYS, async ($, on) => {
  const h = harness(on)
  await boot($)
  const { run_id: runId } = await modelStart($)
  const out = await command($, `approve ${runId}`)
  await h.clock.settle()
  expect(h.spawns.map(spawn => spawn.description)).toEqual(['Fan in: a', 'Fan in: b'])
  expect(checkpoint(h, runId).approval).toBeUndefined()
  expect(states(h, runId)).toEqual(['running', 'running', 'pending'])
  expect(out.text).not.toContain('awaiting approval')
  expect(h.prompts.filter(text => text.includes(runId))).toEqual([`DAG run "Fan in" (${runId}) was approved by the user and has started.`])
})

test('/dag reject cancels a waiting run with the reason, tells the model once and spawns nothing', ALWAYS, async ($, on) => {
  const h = harness(on)
  await boot($)
  const { run_id: runId } = await modelStart($)
  await command($, `reject ${runId} too broad for now`)
  await h.clock.settle()
  expect(h.spawns).toHaveLength(0)
  const saved = checkpoint(h, runId)
  expect(saved).toMatchObject({ status: 'cancelled', cancelReason: 'Rejected by the user: too broad for now', settledNotified: true })
  expect(saved.approval).toBeUndefined()
  expect(states(h, runId)).toEqual(['cancelled', 'cancelled', 'cancelled'])
  // The rejection is the one message about this run: no settle summary follows it, now or after a reload.
  expect(h.prompts.filter(text => text.includes(runId))).toEqual([`DAG run "Fan in" (${runId}) was rejected by the user: too broad for now. Nothing ran.`])
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await h.clock.settle()
  expect(h.prompts.filter(text => text.includes(runId))).toHaveLength(1)
})

test('/dag reject without a reason says so without one', ALWAYS, async ($, on) => {
  const h = harness(on)
  await boot($)
  const { run_id: runId } = await modelStart($)
  await command($, `reject ${runId}`)
  await h.clock.settle()
  expect(checkpoint(h, runId).cancelReason).toBe('Rejected by the user.')
  expect(h.prompts.filter(text => text.includes(runId))).toEqual([`DAG run "Fan in" (${runId}) was rejected by the user. Nothing ran.`])
})

test('approve, reject and setting the approval from a non-composer origin are refused', ALWAYS, async ($, on) => {
  const h = harness(on)
  await boot($)
  const { run_id: runId } = await modelStart($)
  expect((await sdkCommand($, `approve ${runId}`)).text).toBe(USER_ONLY)
  expect((await sdkCommand($, `reject ${runId}`)).text).toBe(USER_ONLY)
  expect((await sdkCommand($, 'approval off')).text).toBe(USER_ONLY)
  expect((await sdkCommand($, 'approval')).text).toBe('DAG start approval: always (setting)')
  await h.clock.settle()
  expect(h.spawns).toHaveLength(0)
  expect(checkpoint(h, runId).approval).toBeDefined()
  expect(states(h, runId)).toEqual(['scheduled', 'scheduled', 'pending'])
})

test('approve or reject of a run that is not waiting is refused and changes nothing', async ($, on) => {
  const h = harness(on)
  await boot($)
  const { run_id: runId } = await modelStart($)
  expect((await command($, `approve ${runId}`)).text).toBe(`Run ${runId} is not awaiting approval.`)
  expect((await command($, `reject ${runId}`)).text).toBe(`Run ${runId} is not awaiting approval.`)
  expect((await command($, 'approve dag_missing')).text).toContain('Unknown run "dag_missing"')
  expect(h.spawns).toHaveLength(2)
  expect(states(h, runId)).toEqual(['running', 'running', 'pending'])
})

test('a waiting run owned by another session cannot be approved from this one', ALWAYS, async ($, on) => {
  const h = harness(on)
  await boot($)
  const { run_id: runId } = await modelStart($)
  const saved = checkpoint(h, runId)
  h.files.set(`${ROOT}/runs/${runId}.json`, JSON.stringify({ ...saved, sessionId: 'other-session' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect((await command($, `approve ${runId}`)).text).toBe(`Run ${runId} belongs to session other-session; only that session can approve or reject it.`)
  expect(h.spawns).toHaveLength(0)
})

test('a non-interactive session never waits for approval', ALWAYS, async ($, on) => {
  const h = harness(on)
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  await $.skill.prompt({ skill: 'dag-workflow:planning', text: '# planning' })
  const reply = await modelStart($)
  expect(reply.awaiting_approval).toBeUndefined()
  expect(h.spawns).toHaveLength(2)
})

test('a user-typed /dag run never waits for approval', ALWAYS, async ($, on) => {
  const h = harness(on)
  h.files.set('/work/flows/fan.json', JSON.stringify(FAN_IN))
  await boot($)
  const out = await command($, 'run flows/fan.json')
  expect(h.spawns).toHaveLength(2)
  expect(out.text).not.toContain('awaiting approval')
})

test('/dag approval shows the setting and its source, and a session override wins over it', ALWAYS, async ($, on) => {
  const h = harness(on)
  await boot($)
  expect((await command($, 'approval')).text).toBe('DAG start approval: always (setting)')
  expect((await command($, 'approval sometimes')).text).toBe('Unknown start approval "sometimes". Use off or always.')
  expect((await command($, 'approval off')).text).toBe('DAG start approval: off (session override)')
  expect((await command($, 'approval')).text).toBe('DAG start approval: off (session override)')
  const reply = await modelStart($)
  expect(reply.awaiting_approval).toBeUndefined()
  expect(h.spawns).toHaveLength(2)
})

test('a waiting run read back at session start stays waiting until approved', async ($, on) => {
  const h = harness(on)
  const parsed = parseDefinition(FAN_IN)
  if (!parsed.ok) throw new Error(parsed.error.message)
  const held = requestApproval(createRun(parsed.value, { runId: 'dag_held', sessionId: 'source', now: 500 }), 500)
  h.files.set(`${ROOT}/runs/dag_held.json`, JSON.stringify(held))
  await boot($)
  await h.clock.settle()
  expect(h.spawns).toHaveLength(0)
  expect((await command($, 'status dag_held')).text).toContain('awaiting approval')
  await command($, 'approve dag_held')
  expect(h.spawns.map(spawn => spawn.description)).toEqual(['Fan in: a', 'Fan in: b'])
})

test('/dag status and /dag list show a waiting run as waiting, and stop once it is approved', ALWAYS, async ($, on) => {
  const h = harness(on)
  await boot($)
  const { run_id: runId } = await modelStart($)
  const status = (await command($, `status ${runId}`)).text ?? ''
  expect(status.split('\n')[1]).toBe(`  awaiting approval: /dag approve ${runId} starts it, /dag reject ${runId} [reason] cancels it`)
  expect((await command($, 'list')).text).toMatch(new RegExp(`^${runId} .*\\[awaiting approval\\]$`))
  await command($, `approve ${runId}`)
  expect((await command($, `status ${runId}`)).text).not.toContain('awaiting approval')
  expect((await command($, 'list')).text).not.toContain('awaiting approval')
  expect(h.spawns).toHaveLength(2)
})

test('/dag approve typed during a model turn starts the run when that turn ends', ALWAYS, async ($, on) => {
  const h = harness(on)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  await boot($)
  const { run_id: runId } = await modelStart($)
  await $.turn.start({ turnId: 'main-turn', text: 'go' })
  const out = await command($, `approve ${runId}`)
  expect(out.text).toContain(t.runDeferred)
  expect(h.spawns).toHaveLength(0)
  expect(checkpoint(h, runId).approval).toBeUndefined()
  await $.turn.complete({ turnId: 'main-turn', answer: '', durationMs: 5, isAborted: false, reason: 'answer' })
  await h.clock.settle()
  expect(h.spawns).toHaveLength(2)
})

test('a model cancel of a waiting run leaves nothing awaiting approval', ALWAYS, async ($, on) => {
  const h = harness(on)
  await boot($)
  const { run_id: runId } = await modelStart($)
  const cancelled = await dag($, { action: 'cancel', run_id: runId })
  expect(cancelled.awaiting_approval).toBeUndefined()
  expect(checkpoint(h, runId)).toMatchObject({ status: 'cancelled' })
  expect(checkpoint(h, runId).approval).toBeUndefined()
  expect((await command($, `approve ${runId}`)).text).toBe(`Run ${runId} is not awaiting approval.`)
})

test('the pane shows a waiting run with Approve and Reject buttons, and Approve starts it', ALWAYS, async ($, on) => {
  const h = harness(on)
  await boot($)
  const { run_id: runId } = await modelStart($)
  const ui = (await $.ui.mount(PANE)) as Mounted<'terminal', 'Pane'>
  expect(await ui.find({ type: 'Text', text: t.approvalWaiting })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'approve' })).toMatchObject({ props: { hotkey: 'a', label: t.approve } })
  expect(await ui.find({ type: 'Button', key: 'reject' })).toMatchObject({ props: { hotkey: 'r', label: t.reject } })
  await ui.press({ key: 'approve' })
  await h.clock.settle()
  expect(h.spawns).toHaveLength(2)
  expect(h.prompts).toContain(`DAG run "Fan in" (${runId}) was approved by the user and has started.`)
  await ui.redraw(PANE.props)
  expect(await ui.find({ type: 'Button', key: 'approve' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: t.approvalWaiting })).toBeUndefined()
  await ui.unmount()
})

test('the pane Reject button cancels a waiting run without a reason', ALWAYS, async ($, on) => {
  const h = harness(on)
  await boot($)
  const { run_id: runId } = await modelStart($, SOLO)
  const ui = (await $.ui.mount(PANE)) as Mounted<'terminal', 'Pane'>
  await ui.press({ key: 'reject' })
  await h.clock.settle()
  expect(h.spawns).toHaveLength(0)
  expect(checkpoint(h, runId)).toMatchObject({ status: 'cancelled', cancelReason: 'Rejected by the user.' })
  expect(h.prompts).toContain(`DAG run "Solo" (${runId}) was rejected by the user. Nothing ran.`)
  await ui.unmount()
})

test('a and r typed in the graph answer a waiting run, and do nothing once it no longer waits', ALWAYS, async ($, on) => {
  const h = harness(on)
  await boot($)
  const { run_id: runId } = await modelStart($)
  const ui = (await $.ui.mount(PANE)) as Mounted<'terminal', 'Pane'>
  await ui.key({ key: 'a', in: 'graph' })
  await h.clock.settle()
  expect(h.spawns).toHaveLength(2)
  await ui.key({ key: 'r', in: 'graph' })
  await h.clock.settle()
  expect(states(h, runId)).toEqual(['running', 'running', 'pending'])
  await ui.unmount()
})

test('the pane draws no approval buttons for a run that is not waiting', async ($, on) => {
  harness(on)
  await boot($)
  await modelStart($)
  const ui = (await $.ui.mount(PANE)) as Mounted<'terminal', 'Pane'>
  expect(await ui.find({ type: 'Button', key: 'approve' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'reject' })).toBeUndefined()
  await ui.unmount()
})

test('/dag preview of a one-node definition counts 1 node and 1 wave', async ($, on) => {
  const h = harness(on)
  h.files.set('/work/flows/solo.json', JSON.stringify(SOLO))
  await boot($)
  const out = await command($, 'preview flows/solo.json')
  expect(out.text?.split('\n')[0]).toBe('Preview (nothing started): 1 node, 1 wave, widest wave 1, max concurrent 8')
})
