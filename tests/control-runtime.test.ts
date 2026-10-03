import { expect, test, type Engine, type Mounted } from 'claude-code/testing'
import type { SessionMessage } from 'claude-code'
import type { VerificationCheck } from '../hooks/engine/types.ts'
import type { DecisionRecord } from '../hooks/engine/decisions.ts'
import type { ContextRecord } from '../hooks/engine/context.ts'
import { hash } from '../hooks/engine/hash.ts'
import { boot, checkpoint, command, dag, finish, harness, KEY, ROOT, start } from './control-harness.ts'

const CHECK: VerificationCheck[] = [{ kind: 'command', argv: ['check-control'] }]
function definition(verify = CHECK) {
  return {
    key: 'control',
    nodes: [
      { id: 'a', prompt: 'Produce artifact', verify },
      { id: 'b', prompt: 'Consume artifact', dependsOn: ['a'], verify: CHECK },
    ],
  }
}

test('start and amend refuse missing verification before spawning', async ($, on) => {
  const h = harness(on)
  await boot($)
  const missing = { key: 'missing', nodes: [{ id: 'a', prompt: 'Produce artifact' }] }
  expect(await dag($, { action: 'start', definition: missing })).toMatchObject({ error: { code: 'verification_required' } })
  expect(h.spawns).toHaveLength(0)
  const runId = await start($, definition())
  const before = checkpoint(h, runId)
  expect(await dag($, { action: 'amend', run_id: runId, definition: { ...missing, key: 'control' } })).toMatchObject({ error: { code: 'verification_required' } })
  expect(checkpoint(h, runId)).toEqual(before)
  expect(h.spawns).toHaveLength(1)
})

for (const scenario of ['command-pass', 'command-fail', 'file-pass', 'file-missing', 'file-content'] as const) {
  test(`completion is gated by host evidence: ${scenario}`, { options: { auto_recovery: false } }, async ($, on) => {
    const h = harness(on)
    const file = scenario.startsWith('file')
    const pass = scenario.endsWith('pass')
    const checks: VerificationCheck[] = file ? [{ kind: 'file', path: 'artifact.txt', contains: 'TOKEN' }] : CHECK
    if (scenario !== 'file-missing') h.files.set('/work/artifact.txt', pass ? 'TOKEN' : 'wrong')
    h.control.exitCode = pass ? 0 : 1
    await boot($)
    const runId = await start($, definition(checks))
    expect(h.processes.filter(e => e.argv[0] === 'check-control')).toHaveLength(0)
    await finish($, h)
    const saved = checkpoint(h, runId)
    expect(saved.nodes.map(node => node.state)).toEqual(pass ? ['completed', 'running'] : ['failed', 'skipped'])
    const verification = saved.nodes[0]?.verification
    expect(verification).toMatchObject({ status: pass ? 'passed' : 'failed', evidence: [{ check: checks[0], passed: pass, checkedAt: 1_000 }] })
    if (!verification?.reportPath) throw new Error('Missing separate verification evidence')
    const evidence: unknown = JSON.parse(h.files.get(verification.reportPath) ?? 'null')
    expect(evidence).toMatchObject({ status: pass ? 'passed' : 'failed' })
    expect(verification.reportPath).not.toBe(saved.nodes[0]?.reportPath)
    expect(h.spawns).toHaveLength(pass ? 2 : 1)
    if (file) {
      expect(h.stats).toEqual(['/work/artifact.txt'])
      if (scenario !== 'file-missing') expect(h.reads).toContain('/work/artifact.txt')
    } else {
      expect(h.processes.filter(e => e.argv[0] === 'check-control')).toMatchObject([{ argv: ['check-control'], init: { cwd: '/work', timeoutMs: 30_000 } }])
      expect(verification.evidence[0]?.exitCode).toBe(pass ? 0 : 1)
    }
  })
}

for (const kind of ['implementation', 'transient']) {
  test(`${kind} recovery stops after two extra attempts`, async ($, on) => {
    const h = harness(on)
    h.control.exitCode = 1
    h.control.recovery = kind
    await boot($)
    const runId = await start($, definition())
    for (let attempt = 1; attempt <= 3; attempt++) await finish($, h, `agent-${attempt}`)
    const saved = checkpoint(h, runId)
    expect(h.spawns).toHaveLength(3)
    expect(h.spawns.map(spawn => spawn.model)).toEqual(kind === 'implementation' ? ['sonnet', 'opus', 'opus'] : ['sonnet', 'sonnet', 'sonnet'])
    expect(saved.nodes.map(node => node.state)).toEqual(['failed', 'skipped'])
    expect(saved.nodes[0]).toMatchObject({ attempt: 3, recovery: { used: 2, kind } })
    expect(h.requests.filter(request => 'recovery' in request.questions)).toHaveLength(2)
    expect(h.requests[0]?.questions).toHaveProperty('a')
    expect(h.requests[0]?.questions).toHaveProperty('b')
  })
}

test('local recovery starts while an independent node stays active', async ($, on) => {
  const h = harness(on)
  h.control.exitCode = 1
  await boot($)
  const flow = definition()
  const runId = await start($, { ...flow, nodes: [...flow.nodes, { id: 'independent', prompt: 'Independent work', verify: CHECK }] })
  await finish($, h)
  expect(h.spawns).toHaveLength(3)
  expect(checkpoint(h, runId).nodes.map(node => node.state)).toEqual(['running', 'pending', 'running'])
  h.control.exitCode = 0
  await finish($, h, 'agent-3')
  expect(checkpoint(h, runId).nodes.map(node => node.state)).toEqual(['completed', 'running', 'running'])
})

for (const scenario of ['missing-input', 'clarification', 'permanent', 'low-confidence', 'http-error', 'transport-error', 'disabled', 'cancelled'] as const) {
  test(`automatic recovery is suppressed for ${scenario}`, { options: { auto_recovery: scenario !== 'disabled' } }, async ($, on) => {
    const h = harness(on)
    h.control.exitCode = 1
    if (['missing-input', 'clarification', 'permanent'].includes(scenario)) h.control.recovery = scenario
    if (scenario === 'low-confidence') h.control.confidence = 0.5
    await boot($)
    const runId = await start($, definition())
    if (scenario === 'http-error') h.control.httpStatus = 503
    if (scenario === 'transport-error') h.control.transportError = true
    if (scenario === 'cancelled') await dag($, { action: 'cancel', run_id: runId })
    await finish($, h, 'agent-1', scenario === 'cancelled')
    expect(h.spawns).toHaveLength(1)
    expect(checkpoint(h, runId).nodes[0]?.state).toBe(scenario === 'cancelled' ? 'cancelled' : 'failed')
    expect(checkpoint(h, runId).nodes[0]?.recovery?.used ?? 0).toBe(0)
    if (scenario === 'disabled' || scenario === 'cancelled') expect(h.requests.filter(request => 'recovery' in request.questions)).toHaveLength(0)
  })
}

test('the pinned status line follows a run, clears when it settles, and routine completion raises no toast', async ($, on) => {
  const h = harness(on)
  await boot($)
  await start($, { key: 'status', nodes: [{ id: 'a', prompt: 'Produce artifact', verify: CHECK }] })
  expect(h.statuses.at(-1)).toContain('0/1 done · 1 running')
  await finish($, h)
  expect(h.statuses.at(-1)).toBe(undefined)
  expect(h.toasts).toEqual([])
})

test('a node failing verification raises exactly one attention toast', { options: { auto_recovery: false } }, async ($, on) => {
  const h = harness(on)
  h.control.exitCode = 1
  await boot($)
  const flow = definition()
  await start($, { ...flow, nodes: [...flow.nodes, { id: 'independent', prompt: 'Independent work', verify: CHECK }] })
  await finish($, h)
  expect(h.toasts).toHaveLength(1)
  expect(h.toasts[0]).toMatchObject({ text: expect.stringContaining('failed verification'), timeoutMs: 12_000 })
})

const PANE = {
  plugin: 'dag-workflow', component: 'Pane', requestId: 'dag', surface: 'terminal', viewport: { columns: 140, rows: 40 },
  props: { title: 'DAG', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

async function paneShows($: Engine, text: RegExp): Promise<boolean> {
  const ui = (await $.ui.mount(PANE as any)) as Mounted<'terminal', 'Pane'>
  const found = await ui.find({ type: 'Text', text })
  await ui.unmount()
  return found !== undefined
}

test('a node waiting for a permission answer is badged, noticed and toasted once, and clears when the call resolves', async ($, on) => {
  let reached!: () => void
  let release!: () => void
  const prompted = new Promise<void>(resolve => { reached = resolve })
  const answered = new Promise<void>(resolve => { release = resolve })
  // Registered before the harness: the host's permission dialog stays open until the test answers it.
  on('tool.call', { tool: 'Write' }, async (_engine, e) => {
    await $.classic.PermissionRequest({ agent_id: e.agentId, tool_name: 'Write', tool_input: { file_path: e.file_path } })
    await $.classic.PermissionRequest({ agent_id: e.agentId, tool_name: 'Write', tool_input: { file_path: e.file_path } })
    reached()
    await answered
    return { result: { type: 'create', filePath: e.file_path, content: e.content, structuredPatch: [], originalFile: null } }
  })
  const h = harness(on)
  await boot($)
  await start($, { key: 'ask', name: 'ask', nodes: [{ id: 'a', prompt: 'Produce artifact', verify: CHECK }] })
  const call = { tool: 'Write', file_path: '/work/a', content: 'x', agentId: 'agent-1', tool_use_id: 'ask-call' } as const
  const pending = $.tool.call(call)
  await prompted
  expect(await paneShows($, /waiting: Write/)).toBe(true)
  expect(h.statuses.at(-1)).toContain('1 waiting for permission')
  expect(h.toasts).toEqual([{ text: 'DAG ask › a is waiting for your permission', timeoutMs: 12_000 }])
  expect(h.notices).toEqual([{ toolUseId: 'ask-call', text: 'DAG ask › a is waiting for your permission' }])
  release()
  await pending
  expect(await paneShows($, /waiting: Write/)).toBe(false)
  expect(h.statuses.at(-1)).not.toContain('waiting')
})

test('a permission request from an agent outside the DAG changes nothing', async ($, on) => {
  const h = harness(on)
  await boot($)
  await start($, { key: 'ask', name: 'ask', nodes: [{ id: 'a', prompt: 'Produce artifact', verify: CHECK }] })
  const statuses = [...h.statuses]
  await $.classic.PermissionRequest({ agent_id: 'stranger', tool_name: 'Write', tool_input: {} })
  expect(h.statuses).toEqual(statuses)
  expect(h.toasts).toEqual([])
  expect(h.notices).toEqual([])
  expect(await paneShows($, /waiting: /)).toBe(false)
})

test('context persists requests and notes and survives clear with the new session id', async ($, on) => {
  const h = harness(on)
  await boot($)
  await $.prompt.submit({ text: 'Build artifact TOKEN', wait: false, origin: { kind: 'composer' } })
  await $.prompt.submit({ text: 'Peer report is not a new user objective', wait: false, origin: { kind: 'peer' } })
  await command($, 'note Preserve TOKEN')
  const context = await dag($, { action: 'context' })
  expect(context).toMatchObject({
    source: `${ROOT}/context/source.json`,
    context: { requests: [{ text: 'Build artifact TOKEN' }], notes: [{ text: 'Preserve TOKEN' }] },
    summary: { kind: 'context-restoration', sessionId: { text: 'source' } },
  })
  const persisted: ContextRecord = JSON.parse(h.files.get(`${ROOT}/context/source.json`) ?? 'null')
  expect(persisted.requests).toHaveLength(1)
  expect(context.context).toEqual(persisted)
  const runId = await start($, definition())
  h.store.set(`dag-session:${hash('/work')}:target`, { schemaVersion: 1, sessionId: 'target', projectRoot: '/work', updatedAt: 1_000, status: 'active', runIds: [], writes: [] })
  await command($, `handoff ${runId} target`)
  h.control.sessionId = 'cleared'
  await $.classic.SessionStart({ source: 'clear' })
  const carried: ContextRecord = JSON.parse(h.files.get(`${ROOT}/context/cleared.json`) ?? 'null')
  expect(carried).toMatchObject({ sessionId: 'cleared', requests: persisted.requests, notes: persisted.notes })
  expect(checkpoint(h, runId).sessionId).toBe('cleared')
  expect(checkpoint(h, runId).handoff?.from).toBe('cleared')
})

test('main compaction appends restoration without replacing engine messages or active work', async ($, on) => {
  const h = harness(on)
  const kept: SessionMessage = { role: 'user', text: 'engine summary', toolUses: [], handle: 'engine-handle' }
  on('session.compact', () => ({ messages: [kept] }))
  await boot($)
  const runId = await start($, definition())
  const before = checkpoint(h, runId)
  const compacted = await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'Build the artifact', toolUses: [] }] })
  if (compacted.skip !== undefined) throw new Error(compacted.skip)
  expect(compacted.messages).toHaveLength(2)
  expect(compacted.messages[0]).toEqual(kept)
  const restored = compacted.messages[1]
  expect(restored).toMatchObject({ role: 'user', toolUses: [] })
  if (!restored) throw new Error('Missing restoration message')
  const summary: unknown = JSON.parse(restored.text.slice(restored.text.indexOf('\n') + 1))
  expect(summary).toMatchObject({ kind: 'context-restoration', entries: expect.arrayContaining([expect.objectContaining({ kind: 'run', runId: { text: runId } })]) })
  expect(checkpoint(h, runId)).toEqual(before)
  expect(h.spawns).toHaveLength(1)
  const subagent = await $.session.compact({ trigger: 'manual', agentId: 'agent-1', messages: [{ role: 'user', text: 'Subagent task', toolUses: [] }] })
  expect(subagent).toEqual({ messages: [kept] })
})

test('compacting an empty conversation is skipped without calling the hooks beneath', async ($, on) => {
  harness(on)
  const kept: SessionMessage = { role: 'user', text: 'engine summary', toolUses: [], handle: 'engine-handle' }
  const below: unknown[] = []
  on('session.compact', (_$, e) => { below.push(e); return { messages: [kept] } })
  await boot($)
  expect(await $.session.compact({ trigger: 'manual', messages: [] })).toEqual({ skip: 'Not enough messages to compact.' })
  expect(await $.session.compact({ trigger: 'manual', agentId: 'agent-1', messages: [] })).toEqual({ skip: 'Not enough messages to compact.' })
  expect(below).toEqual([])
})

test('decisions expose persisted outcomes and rules without credentials', async ($, on) => {
  const h = harness(on)
  await boot($)
  await start($, definition())
  const routeLog = h.logs.findIndex(log => log.includes('dag-workflow: Jev route'))
  expect(routeLog).toBeGreaterThanOrEqual(0)
  expect(h.logOptions[routeLog]).toEqual({ to: 'debug' })
  const result = await dag($, { action: 'decisions' })
  const log: { records: DecisionRecord[] } = JSON.parse(h.files.get(`${ROOT}/decisions/source.json`) ?? 'null')
  expect(result.decisions).toEqual(log.records)
  expect(log.records).toHaveLength(2)
  for (const record of log.records) {
    expect(record).toMatchObject({ kind: 'routing', outcome: 'applied', proposed: 'quick', selected: 'quick', source: 'jev' })
    expect(typeof record.ruleset).toBe('string')
    expect(record.ruleset.length).toBeGreaterThan(0)
  }
  expect(JSON.stringify(result).includes(KEY)).toBe(false)
})

test('refused main-loop tools remain visible in the transcript', async ($, on) => {
  const h = harness(on)
  on('tool.check', () => ({ decision: 'allow' }))
  await boot($)
  await $.tool.call({ tool: 'Write', file_path: '/work/file.txt', content: 'x' })
  const refusalLog = h.logs.findIndex(log => log.startsWith('refused Write'))
  expect(refusalLog).toBeGreaterThanOrEqual(0)
  expect(h.logOptions[refusalLog]).not.toEqual({ to: 'debug' })
})

test('sessions refresh same-project records and manual handoff drains then explicitly accepts', async ($, on) => {
  const h = harness(on)
  on('tool.check', () => ({ decision: 'ask' }))
  await boot($)
  const prefix = `dag-session:${hash('/work')}:`
  h.store.set(prefix + 'target', { schemaVersion: 1, sessionId: 'target', projectRoot: '/work', updatedAt: 1_000, status: 'active', runIds: [], writes: [] })
  h.store.set(`dag-session:${hash('/other')}:foreign`, { schemaVersion: 1, sessionId: 'foreign', projectRoot: '/other', updatedAt: 1_000, status: 'active', runIds: [], writes: [] })
  const listed = await command($, 'sessions')
  const sessions: { sessions: { sessionId: string }[] } = JSON.parse(listed.text ?? '{}')
  expect(sessions.sessions.map(session => session.sessionId)).toEqual(['source', 'target'])
  const runId = await start($, definition())
  const forbidden = await dag($, { action: 'handoff', run_id: runId, target: 'target' })
  expect(forbidden).toHaveProperty('error')
  expect(checkpoint(h, runId).handoff).toBe(undefined)
  await command($, `handoff ${runId} target`)
  expect(checkpoint(h, runId)).toMatchObject({ sessionId: 'source', handoff: { from: 'source', to: 'target' } })
  await finish($, h)
  expect(checkpoint(h, runId).nodes.map(node => node.state)).toEqual(['completed', 'paused'])
  expect(h.spawns).toHaveLength(1)
  h.control.sessionId = 'target'
  await boot($)
  const readsBeforeNotice = h.reads.length
  await $.session.receive({ origin: { kind: 'peer' }, text: `<cross-session-message>\n[dag-handoff] ${runId}\n</cross-session-message>` })
  expect(h.reads.slice(readsBeforeNotice)).toContain(`${ROOT}/runs/${runId}.json`)
  await $.session.receive({ origin: { kind: 'peer' }, text: `/dag accept ${runId}` })
  expect(checkpoint(h, runId).sessionId).toBe('source')
  expect(h.spawns).toHaveLength(1)
  const readsBeforeAccept = h.reads.length
  await command($, `accept ${runId}`)
  expect(h.reads.slice(readsBeforeAccept)).toContain(`${ROOT}/runs/${runId}.json`)
  expect(checkpoint(h, runId).sessionId).toBe('target')
  expect(checkpoint(h, runId).handoff).toBe(undefined)
  expect(checkpoint(h, runId).nodes.map(node => node.state)).toEqual(['completed', 'running'])
  expect(h.spawns).toHaveLength(2)
  expect(h.processes.some(event => event.argv[0] === 'mkdir' && !event.argv.includes('-p'))).toBe(true)
  expect(h.processes.some(event => event.argv[0] === 'rmdir')).toBe(true)
  expect(h.locks.size).toBe(0)
  const targetContext: ContextRecord = JSON.parse(h.files.get(`${ROOT}/context/target.json`) ?? 'null')
  const acceptedRequest = targetContext.requests.at(-1)?.text
  expect(typeof acceptedRequest).toBe('string')
  await $.tool.check({ tool: 'Write', input: { file_path: '/work/artifact.txt', content: 'TOKEN' } })
  expect(h.requests.at(-1)?.state).toMatchObject({ request: acceptedRequest })
})

test('only the manual cancel command withdraws a pending handoff', async ($, on) => {
  const h = harness(on)
  await boot($)
  h.store.set(`dag-session:${hash('/work')}:target`, { schemaVersion: 1, sessionId: 'target', projectRoot: '/work', updatedAt: 1_000, status: 'active', runIds: [], writes: [] })
  const runId = await start($, definition())
  await command($, `handoff ${runId} target`)
  await finish($, h)
  expect(h.spawns).toHaveLength(1)
  expect(await dag($, { action: 'handoff', run_id: runId, target: 'cancel' })).toHaveProperty('error')
  expect(checkpoint(h, runId).handoff).toMatchObject({ to: 'target' })
  await command($, `handoff ${runId} cancel`)
  expect(checkpoint(h, runId).handoff).toBe(undefined)
  expect(checkpoint(h, runId).sessionId).toBe('source')
  expect(checkpoint(h, runId).nodes.map(node => node.state)).toEqual(['completed', 'running'])
  expect(h.spawns).toHaveLength(2)
  expect(h.locks.size).toBe(0)
})

test('accepting a completed checkpoint transfers history without starting a turn', async ($, on) => {
  const h = harness(on)
  await boot($)
  h.store.set(`dag-session:${hash('/work')}:target`, { schemaVersion: 1, sessionId: 'target', projectRoot: '/work', updatedAt: 1_000, status: 'active', runIds: [], writes: [] })
  const runId = await start($, definition())
  await finish($, h, 'agent-1')
  await finish($, h, 'agent-2')
  h.files.set(`${ROOT}/runs/${runId}.json`, JSON.stringify({ ...checkpoint(h, runId), settledNotified: false }))
  await command($, `handoff ${runId} target`)
  h.control.sessionId = 'target'
  await boot($)
  const before = h.prompts.length
  await command($, `accept ${runId}`)
  expect(checkpoint(h, runId).sessionId).toBe('target')
  expect(h.spawns).toHaveLength(2)
  expect(h.prompts).toHaveLength(before)
})
