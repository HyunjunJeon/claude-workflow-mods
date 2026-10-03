import { expect, mock, test, type Engine } from 'claude-code/testing'
import type { HttpInit, HttpResponse, On } from 'claude-code'
import { parseDefinition } from '../hooks/engine/definition.ts'
import { createRun } from '../hooks/engine/run.ts'
import type { Run } from '../hooks/engine/types.ts'

const DAG = 'mcp__dag-workflow__dag'
const API = 'https://api.typesafe.ai/v1/systemone'
const PROBE = 'Write'
const VERIFY = [{ kind: 'command', argv: ['test', '-d', '/work'] }]
const DEFINITION = {
  key: 'jev-runtime',
  goal: 'Ship a scoped change',
  nodes: [
    { id: 'a', prompt: 'Implement A', category: 'quick', verify: VERIFY },
    { id: 'b', prompt: 'Audit B', category: 'writing', verify: VERIFY },
    { id: 'c', prompt: 'Check C', dependsOn: ['a'], verify: VERIFY },
  ],
}

function response(answers: unknown, status = 200): HttpResponse {
  return { status, ok: status >= 200 && status < 300, headers: {}, text: JSON.stringify({ answers }) }
}

function choice(value: string, confidence = 0.95) {
  return { type: 'choice', choice: value, confidence }
}

function harness(on: On, key: string | null = 'fake-test-key') {
  const clock = mock.clock(on, { now: 1_000 })
  mock.store(on)
  // All environment reads are intercepted, including unrelated names.
  on('env.get', ($, e) => ({ value: e.name === 'TYPESAFE_API_KEY' ? key ?? undefined : undefined }))
  const files = new Map<string, string>()
  const requests: { url: string; init?: HttpInit }[] = []
  const spawns: { prompt: string; model?: string; description: string }[] = []
  const order: string[] = []
  const control = {
    reply: response({ a: choice('architect'), b: choice('quick'), c: choice('writing') }),
    failure: false,
  }
  // Mutable transport control is the API seam, never a production evaluator mock.
  let transport: (() => Promise<HttpResponse>) | undefined
  on('http.fetch', async ($, e) => {
    requests.push(e)
    order.push('http')
    if (control.failure) throw new Error('test transport failure')
    return { value: transport ? await transport() : control.reply }
  })
  on('session.start', () => ({ cwd: '/work' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.id', () => ({ value: 'jev-session' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.list', () => ({ value: [] }))
  on('fs.read', ($, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', ($, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('agent.list', () => ({ value: [] }))
  on('agent.spawn', ($, e) => {
    spawns.push(e)
    const agentId = `agent-${spawns.length}`
    return { model: e.model ?? 'sonnet', agentId, result: { status: 'async_launched', agentId } }
  })
  on('tool.register', () => ({ value: { tool: DAG } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.log', () => ({ value: undefined }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('skill.prompt', ($, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))
  on('classic.SessionStart', () => ({}))
  return {
    clock, files, requests, spawns, order, control,
    transport(value: () => Promise<HttpResponse>) { transport = value },
  }
}

async function boot($: Engine) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.skill.prompt({ skill: 'dag-workflow:dag-planning', text: '# planning' })
}

async function dag($: Engine, input: Record<string, unknown>) {
  const reply = await $.tool.call({ tool: DAG, ...input })
  if (typeof reply.result !== 'string') throw new Error('DAG did not return JSON text')
  return JSON.parse(reply.result)
}

function checkpoint(h: ReturnType<typeof harness>, runId: string): Run {
  const text = h.files.get(`/work/.claude/dag/runs/${runId}.json`)
  if (!text) throw new Error('Missing run checkpoint')
  return JSON.parse(text)
}

async function finish($: Engine, h: ReturnType<typeof harness>, agentId: string, failed = false) {
  await $.turn.complete({
    turnId: `turn-${agentId}`, agentId, reason: 'answer', isAborted: false,
    answer: `DAG_NODE_STATUS: ${failed ? 'failed: test failure' : 'completed'}`,
    durationMs: 1,
  })
  await h.clock.settle()
}

function body(h: ReturnType<typeof harness>, index: number) {
  const text = h.requests[index]?.init?.body
  if (!text) throw new Error('Missing HTTP request body')
  return JSON.parse(text)
}

test('new starts batch every node once, route spawns, and preserve definition and hash', async ($, on) => {
  const h = harness(on)
  await boot($)
  const started = await dag($, { action: 'start', definition: DEFINITION })
  expect(h.requests).toHaveLength(1)
  expect(h.requests[0]).toMatchObject({ url: API, init: { method: 'POST' } })
  expect(body(h, 0).model).toBe('jev-latest')
  expect(Object.keys(body(h, 0).questions)).toEqual(['a', 'b', 'c'])
  const saved = checkpoint(h, started.run_id)
  expect(saved.nodes.map(node => node.routing)).toEqual([
    { source: 'jev', category: 'architect', confidence: 0.95 },
    { source: 'jev', category: 'quick', confidence: 0.95 },
    { source: 'jev', category: 'writing', confidence: 0.95 },
  ])
  expect(h.spawns.map(spawn => spawn.model)).toEqual(['opus', 'sonnet'])
  const parsed = parseDefinition(DEFINITION)
  if (!parsed.ok) throw new Error(parsed.error.message)
  expect(saved.definition).toEqual(parsed.value)
  expect(saved.definitionHash).toBe(createRun(parsed.value, { runId: 'expected', sessionId: 'expected', now: 0 }).definitionHash)
  expect((await dag($, { action: 'start', definition: DEFINITION })).reused).toBe(true)
  expect(h.requests).toHaveLength(1)
  expect(h.spawns).toHaveLength(2)
})

for (const disabled of ['no-key', 'off']) {
  test(`routing and permission never use HTTP when ${disabled}`, { options: { jev_enabled: disabled !== 'off' } }, async ($, on) => {
    const h = harness(on, disabled === 'no-key' ? null : 'fake-test-key')
    on('tool.check', () => ({ decision: 'ask', reason: 'approval', rule: 'test-rule' }))
    await boot($)
    const started = await dag($, { action: 'start', definition: DEFINITION })
    expect(checkpoint(h, started.run_id).nodes.map(node => node.routing)).toEqual([
      { source: 'definition', category: 'quick' },
      { source: 'definition', category: 'writing' },
      { source: 'definition', category: 'quick' },
    ])
    expect(await $.tool.check({ tool: PROBE, input: {} })).toEqual({ decision: 'ask', reason: 'approval', rule: 'test-rule' })
    expect(h.requests).toHaveLength(0)
    expect(h.spawns.map(spawn => spawn.model)).toEqual(['sonnet', 'sonnet'])
  })
}

test('invalid, missing and low-confidence routes fall back independently', async ($, on) => {
  const h = harness(on)
  h.control.reply = response({ a: choice('architect', 0.899), b: choice('invalid', 1) })
  await boot($)
  const started = await dag($, { action: 'start', definition: DEFINITION })
  expect(checkpoint(h, started.run_id).nodes.map(node => node.routing)).toEqual([
    { source: 'definition', category: 'quick' },
    { source: 'definition', category: 'writing' },
    { source: 'definition', category: 'quick' },
  ])
})

test('retry classification uses the override and amend classifies only rerun nodes', async ($, on) => {
  const h = harness(on)
  await boot($)
  const started = await dag($, { action: 'start', definition: DEFINITION })
  await finish($, h, 'agent-1', true)
  await finish($, h, 'agent-2')
  await dag($, { action: 'retry', run_id: started.run_id, node_id: 'a', prompt: 'Reimplement A' })
  expect(Object.keys(body(h, 1).questions)).toEqual(['recovery'])
  expect(Object.keys(body(h, 2).questions)).toEqual(['a', 'c'])
  expect(body(h, 2).state.nodes.find((node: { id: string }) => node.id === 'a').task).toBe('Reimplement A')
  await finish($, h, 'agent-3')
  await finish($, h, 'agent-4')
  const before = checkpoint(h, started.run_id).nodes.find(node => node.id === 'a')?.routing
  await dag($, { action: 'amend', run_id: started.run_id, definition: {
    ...DEFINITION, nodes: DEFINITION.nodes.map(node => node.id === 'b' ? { ...node, prompt: 'Audit B again' } : node),
  } })
  expect(Object.keys(body(h, 3).questions)).toEqual(['b'])
  expect(checkpoint(h, started.run_id).nodes.find(node => node.id === 'a')?.routing).toEqual(before)
})

const DECISIONS: readonly ('allow' | 'deny')[] = ['allow', 'deny']

for (const decision of DECISIONS) {
  test(`baseline ${decision} remains exact without HTTP`, async ($, on) => {
    const h = harness(on)
    on('tool.check', () => { h.order.push('baseline'); return { decision, reason: 'existing reason', rule: 'existing rule' } })
    await boot($)
    expect(await $.tool.check({ tool: PROBE, input: { path: '/work/a' } })).toEqual({
      decision, reason: 'existing reason', rule: 'existing rule',
    })
    expect(h.order).toEqual(['baseline'])
    expect(h.requests).toHaveLength(0)
  })
}

const FALLBACKS = [
  { name: 'ask', reply: response({ permission: choice('ask', 1) }), failure: false },
  { name: 'low confidence', reply: response({ permission: choice('allow', 0.899) }), failure: false },
  { name: 'invalid choice', reply: response({ permission: choice('wrong', 1) }), failure: false },
  { name: 'missing answer', reply: response({}), failure: false },
  { name: 'invalid JSON', reply: { ...response({}), text: '{' }, failure: false },
  { name: 'HTTP failure', reply: response({}, 503), failure: false },
  { name: 'transport failure', reply: response({}), failure: true },
]

for (const item of FALLBACKS) {
  test(`${item.name} preserves the complete ask baseline`, async ($, on) => {
    const h = harness(on)
    h.control.reply = item.reply
    h.control.failure = item.failure
    on('tool.check', () => { h.order.push('baseline'); return { decision: 'ask', reason: 'baseline reason', rule: 'baseline rule' } })
    await boot($)
    expect(await $.tool.check({ tool: PROBE, input: { path: '/work/a' } })).toEqual({
      decision: 'ask', reason: 'baseline reason', rule: 'baseline rule',
    })
    expect(h.order).toEqual(['baseline', 'http'])
  })
}

for (const decision of DECISIONS) {
  test(`confident ${decision} controls the actual wrapped tool call`, async ($, on) => {
    const h = harness(on)
    on('tool.check', () => { h.order.push('baseline'); return { decision: 'ask', reason: 'baseline reason', rule: 'baseline rule' } })
    const executed: unknown[] = []
    // The test bottom acts as the host permission gate, using the real call ID.
    on('tool.call', { tool: PROBE }, async (_engine, e) => {
      const verdict = await $.tool.check({ tool: e.tool, input: { file_path: e.file_path, content: e.content }, tool_use_id: e.tool_use_id })
      if (verdict.decision !== 'allow') return { deny: verdict.reason ?? verdict.decision }
      executed.push(e.file_path)
      return { result: { type: 'create', filePath: e.file_path, content: e.content, structuredPatch: [], originalFile: null } }
    })
    await boot($)
    await $.prompt.submit({ text: 'Change only A', wait: false, origin: { kind: 'composer' } })
    const started = await dag($, { action: 'start', definition: DEFINITION })
    const agentId = checkpoint(h, started.run_id).nodes.find(node => node.id === 'a')?.agentId
    if (!agentId) throw new Error('Missing node agent')
    h.control.reply = response({ permission: choice(decision, 0.9) })
    const call = { tool: PROBE, file_path: '/work/a', content: 'done', agentId, tool_use_id: 'scoped-call' } as const
    const result = await $.tool.call(call)
    expect(executed).toEqual(decision === 'allow' ? ['/work/a'] : [])
    expect(decision === 'allow' ? result.result : result.deny).toBeDefined()
    expect(body(h, 1).state).toEqual({
      tool: PROBE, input: { file_path: '/work/a', content: 'done' }, request: 'Change only A',
      projectRoot: '/work', goal: 'Ship a scoped change', task: 'Implement A',
    })
    expect(Object.keys(body(h, 1).questions)).toEqual(['permission'])
    // A later query cannot inherit a completed call's node scope.
    await $.tool.check({ tool: PROBE, input: {}, tool_use_id: 'scoped-call' })
    expect(body(h, 2).state.task).toBeUndefined()
  })
}

test('configured confidence overrides the default threshold', { options: { jev_confidence: 0.99 } }, async ($, on) => {
  const h = harness(on)
  h.control.reply = response({ permission: choice('allow', 0.95) })
  on('tool.check', () => ({ decision: 'ask', reason: 'baseline', rule: 'rule' }))
  await boot($)
  expect(await $.tool.check({ tool: PROBE, input: {} })).toEqual({ decision: 'ask', reason: 'baseline', rule: 'rule' })
})

test('a hung HTTP request keeps ask at exactly the virtual 5000ms deadline', async ($, on) => {
  const h = harness(on)
  let release: (value: HttpResponse) => void = () => { throw new Error('Transport not started') }
  h.transport(() => new Promise<HttpResponse>(resolve => { release = resolve }))
  on('tool.check', () => ({ decision: 'ask', reason: 'baseline', rule: 'rule' }))
  await boot($)
  let settled = false
  const pending = $.tool.check({ tool: PROBE, input: {} }).then(value => { settled = true; return value })
  await h.clock.settle()
  expect(h.requests).toHaveLength(1)
  await h.clock.advance(4_999)
  expect(settled).toBe(false)
  await h.clock.advance(1)
  expect(await pending).toEqual({ decision: 'ask', reason: 'baseline', rule: 'rule' })
  release(response({ permission: choice('allow', 1) }))
  await h.clock.settle()
})

test('successful HTTP completion cancels its virtual deadline', async ($, on) => {
  const deadlines: AbortSignal[] = []
  on('clock.after', { ms: 5_000 }, async ($, e, next) => {
    deadlines.push(next.signal)
    return next(e)
  })
  const h = harness(on)
  let release: (value: HttpResponse) => void = () => { throw new Error('Transport not started') }
  h.transport(() => new Promise<HttpResponse>(resolve => { release = resolve }))
  on('tool.check', () => ({ decision: 'ask', reason: 'baseline' }))
  await boot($)
  const pending = $.tool.check({ tool: PROBE, input: {} })
  await h.clock.settle()
  expect(deadlines).toHaveLength(1)
  release(response({ permission: choice('allow', 1) }))
  expect((await pending).decision).toBe('allow')
  await h.clock.settle()
  expect(deadlines[0]?.aborted).toBe(true)
})
