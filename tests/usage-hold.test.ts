import { expect, test, type Mounted } from 'claude-code/testing'
import type { Engine, Plugin } from 'claude-code/testing'
import type { SessionRateLimit } from 'claude-code'
import { parseDefinition } from '../hooks/engine/definition.ts'
import { createRun, markFinished, markRunning, requestApproval } from '../hooks/engine/run.ts'
import type { Run, VerificationCheck } from '../hooks/engine/types.ts'
import { stringsFor } from '../hooks/ui/i18n.ts'
import { buildPane, type ViewState } from '../hooks/ui/view-model.ts'
import { boot, checkpoint, dag, finish, harness, start } from './control-harness.ts'

const CHECK: VerificationCheck[] = [{ kind: 'command', argv: ['check-control'] }]
const node = (id: string, dependsOn: string[] = []) => ({ id, prompt: `Write ${id}`, dependsOn, verify: CHECK })
const PAIR = { key: 'pair', name: 'Pair', nodes: [node('a'), node('b')] }
const CHAIN = { key: 'chain', name: 'Chain', nodes: [node('a'), node('b', ['a'])] }
const SOLO = { key: 'solo', name: 'Solo', nodes: [node('a')] }
const FIVE_HOUR_95: SessionRateLimit[] = [{ kind: 'five_hour', percentUsed: 95 }]
const VIEW: ViewState = { runIndex: 0, details: false, prefs: {} }
const PANE = {
  plugin: 'dag-workflow', component: 'Pane', requestId: 'dag', surface: 'terminal', viewport: { columns: 140, rows: 40 },
  props: { title: 'DAG', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

function measure($: Engine, rateLimits: SessionRateLimit[]) {
  return $.session.measure({ context: { window: 200_000 }, rateLimits, changed: ['rateLimits'] })
}

function texts(h: ReturnType<typeof harness>): string[] {
  return h.toasts.map(toast => toast.text)
}

async function paneText($: Engine, text: string) {
  const ui = (await $.ui.mount(PANE)) as Mounted<'terminal', 'Pane'>
  const found = await ui.find({ type: 'Text', text })
  await ui.unmount()
  return found
}

async function headless($: Engine) {
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  await $.skill.prompt({ skill: 'dag-workflow:planning', text: '# planning' })
}

test('a run started at a five_hour reading of 95% spawns nothing, toasts once and reports usage_hold, and a 50% reading starts both nodes', async ($, on) => {
  const h = harness(on)
  h.control.rateLimits = FIVE_HOUR_95
  await boot($)
  const runId = await start($, PAIR)
  await h.clock.settle()
  expect(h.spawns).toHaveLength(0)
  expect(texts(h)).toEqual(['DAG paused new nodes: five_hour at 95%'])
  const held = await dag($, { action: 'snapshot', run_id: runId })
  expect(held.usage_hold).toEqual({ kind: 'five_hour', percent_used: 95 })
  expect(held.status).toBe('running')

  await measure($, [{ kind: 'five_hour', percentUsed: 50 }])
  await h.clock.settle()
  expect(h.spawns.map(spawn => spawn.description)).toEqual(['Pair: a', 'Pair: b'])
  expect((await dag($, { action: 'snapshot', run_id: runId })).usage_hold).toBeUndefined()
  expect(texts(h)).toHaveLength(1)
})

test('a 95% reading while A runs lets A finish but keeps B from starting until a 40% reading', async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = await start($, CHAIN)
  expect(h.spawns).toHaveLength(1)
  await measure($, FIVE_HOUR_95)
  await h.clock.settle()
  expect(texts(h)).toEqual([])

  await finish($, h, 'agent-1')
  expect(checkpoint(h, runId).nodes.map(current => current.state)).toEqual(['completed', 'scheduled'])
  expect(h.spawns).toHaveLength(1)
  expect(texts(h)).toEqual(['DAG paused new nodes: five_hour at 95%'])

  await measure($, [{ kind: 'five_hour', percentUsed: 40 }])
  await h.clock.settle()
  expect(h.spawns.map(spawn => spawn.description)).toEqual(['Chain: a', 'Chain: b'])
})

test('a hold whose window resets in 60 s lifts 5 s after the reset and the scheduled node spawns', async ($, on) => {
  const h = harness(on)
  h.control.rateLimits = [{ kind: 'five_hour', percentUsed: 95, resetsAt: new Date(h.clock.now() + 60_000).toISOString() }]
  await boot($)
  await start($, SOLO)
  await h.clock.settle()
  expect(texts(h)).toEqual(['DAG paused new nodes: five_hour at 95%, resets in 1 min'])
  await h.clock.advance(59_000)
  expect(h.spawns).toHaveLength(0)
  await h.clock.advance(6_001)
  expect(h.spawns.map(spawn => spawn.description)).toEqual(['Solo: a'])
})

test('a non-interactive session cancels a held run that has nothing running, naming the usage limit', async ($, on) => {
  const h = harness(on)
  h.control.rateLimits = [{ kind: 'seven_day', percentUsed: 97 }]
  await headless($)
  const runId = await start($, PAIR)
  await h.clock.settle()
  const run = checkpoint(h, runId)
  expect(h.spawns).toHaveLength(0)
  expect(run.status).toBe('cancelled')
  expect(run.cancelReason).toBe('usage limit: seven_day at 97%')
  expect(run.nodes.map(current => current.error)).toEqual(['Cancelled: usage limit: seven_day at 97%', 'Cancelled: usage limit: seven_day at 97%'])
})

test('a non-interactive session lets the running node finish, then cancels the rest with the reset time', async ($, on) => {
  const h = harness(on)
  await headless($)
  const runId = await start($, CHAIN)
  expect(h.spawns).toHaveLength(1)
  const resetsAt = new Date(h.clock.now() + 3_600_000).toISOString()
  await measure($, [{ kind: 'five_hour', percentUsed: 91.5, resetsAt }])
  await h.clock.settle()
  expect(checkpoint(h, runId).status).toBe('running')

  await finish($, h, 'agent-1')
  const run = checkpoint(h, runId)
  expect(h.spawns).toHaveLength(1)
  expect(run.nodes.map(current => current.state)).toEqual(['completed', 'cancelled'])
  expect(run.cancelReason).toBe(`usage limit: five_hour at 91.5%, resets at ${resetsAt}`)
})

test('an interactive session keeps a held run with nothing running scheduled, never cancelled', async ($, on) => {
  const h = harness(on)
  h.control.rateLimits = FIVE_HOUR_95
  await boot($)
  const runId = await start($, PAIR)
  await h.clock.advance(30_000)
  const run = checkpoint(h, runId)
  expect(run.cancelReason).toBeUndefined()
  expect(run.nodes.map(current => current.state)).toEqual(['scheduled', 'scheduled'])
})

test('with usage_hold_percent 0 a 99% reading does not block a start', { options: { usage_hold_percent: 0 } }, async ($, on) => {
  const h = harness(on)
  h.control.rateLimits = [{ kind: 'five_hour', percentUsed: 99 }]
  await boot($)
  await start($, PAIR)
  expect(h.spawns).toHaveLength(2)
  expect(texts(h)).toEqual([])
})

test('with usage_hold_percent 96 a 95% reading does not block a start', { options: { usage_hold_percent: 96 } }, async ($, on) => {
  const h = harness(on)
  h.control.rateLimits = FIVE_HOUR_95
  await boot($)
  await start($, PAIR)
  expect(h.spawns).toHaveLength(2)
})

// The kit refuses a second on('session.usage') from the test, and skips a hook that throws, so a plugin layer above the
// harness refuses the call instead.
const USAGE_FAILS: Plugin = {
  name: 'usage-fails',
  register(on) {
    on('session.usage', () => ({ deny: 'usage unavailable' }))
  },
}

test('a session whose usage reading fails starts nodes as before', { plugins: [USAGE_FAILS] }, async ($, on) => {
  const h = harness(on)
  h.control.rateLimits = FIVE_HOUR_95
  await boot($)
  await start($, PAIR)
  expect(h.spawns).toHaveLength(2)
  expect(h.logs.filter(line => line.startsWith("dag-workflow: could not read the account's rate-limit windows: "))).toHaveLength(1)
})

test('a second held run raises no second toast while the hold stays, and a hold that comes back toasts again', async ($, on) => {
  const h = harness(on)
  h.control.rateLimits = FIVE_HOUR_95
  await boot($)
  await start($, SOLO)
  await start($, { ...PAIR, key: 'pair-2' })
  await h.clock.settle()
  expect(texts(h)).toEqual(['DAG paused new nodes: five_hour at 95%'])

  await measure($, [{ kind: 'five_hour', percentUsed: 60 }])
  await h.clock.settle()
  expect(h.spawns).toHaveLength(3)
  await measure($, [{ kind: 'seven_day', percentUsed: 93 }])
  await h.clock.settle()
  await start($, { ...SOLO, key: 'solo-2' })
  await h.clock.settle()
  expect(h.spawns).toHaveLength(3)
  expect(texts(h)).toEqual(['DAG paused new nodes: five_hour at 95%', 'DAG paused new nodes: seven_day at 93%'])
})

test('wait and list report the hold of a held run, and wait says what lifts it', async ($, on) => {
  const h = harness(on)
  const resetsAt = new Date(h.clock.now() + 600_000).toISOString()
  h.control.rateLimits = [{ kind: 'five_hour', percentUsed: 95, resetsAt }]
  await boot($)
  const started = await dag($, { action: 'start', definition: PAIR })
  expect(started.usage_hold).toEqual({ kind: 'five_hour', percent_used: 95, resets_at: resetsAt })
  const runId = String(started.run_id)
  const waited = await dag($, { action: 'wait', run_id: runId })
  expect(waited.usage_hold).toEqual({ kind: 'five_hour', percent_used: 95, resets_at: resetsAt })
  expect(waited.note).toBe('New nodes are paused until the five_hour rate-limit window (now 95%) drops below usage_hold_percent (90%) or resets; running nodes continue. Do not poll; you will receive a message when the run settles.')
  const listed = await dag($, { action: 'list' })
  expect(listed.runs).toEqual([expect.objectContaining({ run_id: runId, usage_hold: { kind: 'five_hour', percent_used: 95, resets_at: resetsAt } })])
})

test('the Korean toast names the window, its percent and the minutes to its reset', { options: { language: 'ko' } }, async ($, on) => {
  const h = harness(on)
  h.control.rateLimits = [{ kind: 'five_hour', percentUsed: 95, resetsAt: new Date(h.clock.now() + 150_000).toISOString() }]
  await boot($)
  await start($, SOLO)
  await h.clock.settle()
  expect(texts(h)).toEqual(['DAG 새 노드 시작 대기: five_hour 95% 사용, 3분 뒤 초기화'])
})

test('the mounted pane badges a held run of this session as paused at usage limit, and a 50% reading clears the badge', async ($, on) => {
  const h = harness(on)
  h.control.rateLimits = FIVE_HOUR_95
  await boot($)
  await start($, PAIR)
  await h.clock.settle()
  expect(await paneText($, 'paused at usage limit: five_hour 95%')).toMatchObject({ props: { color: 'yellow' } })
  await measure($, [{ kind: 'five_hour', percentUsed: 50 }])
  await h.clock.settle()
  expect(await paneText($, 'paused at usage limit: five_hour 95%')).toBeUndefined()
})

test("the mounted pane shows another session's scheduled run with its own state, not this session's usage hold", async ($, on) => {
  const h = harness(on)
  h.control.rateLimits = FIVE_HOUR_95
  await boot($)
  await start($, PAIR)
  await h.clock.settle()
  h.control.sessionId = 'target'
  await boot($)
  expect(await paneText($, 'paused at usage limit: five_hour 95%')).toBeUndefined()
  expect(await paneText($, 'running')).toBeDefined()
})

function pairRun(): Run {
  const parsed = parseDefinition(PAIR)
  if (!parsed.ok) throw new Error(parsed.error.message)
  return createRun(parsed.value, { runId: 'r1', sessionId: 's1', now: 1 })
}

function stateSegment(run: Run, context: Parameters<typeof buildPane>[3]) {
  return buildPane([run], VIEW, 5_000, context).header[2]?.[0]
}

test('the pane header reads paused at usage limit in yellow while a held run of the session has a scheduled node', async () => {
  const usageHold = { kind: 'five_hour', percentUsed: 95 }
  expect(stateSegment(pairRun(), { usageHold, sessionId: 's1' })).toEqual({ text: 'paused at usage limit: five_hour 95%', color: 'yellow' })
  expect(stateSegment(pairRun(), { usageHold, sessionId: 's1', t: stringsFor('ko') })).toEqual({ text: '한도 대기: five_hour 95%', color: 'yellow' })
})

test('the pane header keeps the run state without a hold, without a scheduled node, under approval, and for another session', async () => {
  const usageHold = { kind: 'five_hour', percentUsed: 95 }
  expect(stateSegment(pairRun(), { sessionId: 's1' })?.text).toBe('running')
  const busy = markFinished(markRunning(markRunning(pairRun(), 'a', 'agent-a', 2), 'b', 'agent-b', 2), 'a', { state: 'completed' }, 3)
  expect(stateSegment(busy, { usageHold, sessionId: 's1' })?.text).toBe('running')
  expect(stateSegment(requestApproval(pairRun(), 2), { usageHold, sessionId: 's1' })?.text).toBe('awaiting approval')
  expect(stateSegment(pairRun(), { usageHold, sessionId: 's2' })?.text).toBe('running')
  expect(stateSegment(pairRun(), { usageHold })?.text).toBe('running')
})
