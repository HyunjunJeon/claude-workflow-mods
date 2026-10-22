import { expect, mock, test, type Engine } from 'claude-code/testing'
import type { HttpInit, HttpResponse, ModelCompleteInput, ModelCompleteResult, On } from 'claude-code'
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
    { id: 'a', prompt: 'Implement A', category: 'trivial', verify: VERIFY },
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

const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

function modelReply(choice: string, confidence = 0.95): ModelCompleteResult {
  const answer = { type: 'choice', choice, confidence, probabilities: { [choice]: confidence } }
  return { isAnswered: true, text: JSON.stringify({ answers: { permission: answer } }), usage: USAGE }
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
    sessionId: 'jev-session',
    reply: response({ a: choice('architect'), b: choice('trivial'), c: choice('writing') }),
    failure: false,
    model: { isAnswered: false, reason: 'empty-reply', usage: USAGE } as ModelCompleteResult | Error,
    modelFor: undefined as ((prompt: string) => ModelCompleteResult) | undefined,
  }
  const models: ModelCompleteInput[] = []
  on('model.complete', ($, e) => {
    models.push(e)
    if (control.modelFor) return { value: control.modelFor(e.prompt) }
    if (control.model instanceof Error) throw control.model
    return { value: control.model }
  })
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
  on('session.id', () => ({ value: control.sessionId }))
  on('process.run', ($, e) => {
    // persist swaps a checkpoint in with `mv -f <temp> <path>` and removes a failed temp file with `rm -f`.
    const [program, source, destination] = [e.argv[0], e.argv.at(-2), e.argv.at(-1)]
    const text = source === undefined ? undefined : files.get(source)
    if (program === 'mv' && source !== undefined && destination !== undefined && text !== undefined) {
      files.set(destination, text)
      files.delete(source)
    }
    if (program === 'rm' && destination !== undefined) files.delete(destination)
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.list', () => ({ value: [] }))
  on('fs.exists', ($, e) => ({ value: files.has(e.path) || [...files.keys()].some(file => file.startsWith(e.path.replace(/\/$/, '') + '/')) }))
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
    clock, files, requests, spawns, order, control, models,
    transport(value: () => Promise<HttpResponse>) { transport = value },
  }
}

// These tests count Jev requests and were written for strict, the default before auto, which asks Jev about every
// user prompt; boot pins strict.
async function boot($: Engine) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.skill.prompt({ skill: 'dag-workflow:planning', text: '# planning' })
  await $.command.run({ command: 'dag', args: 'enforce strict', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
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
    { source: 'jev', category: 'trivial', confidence: 0.95 },
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
  test(`routing and permission never use HTTP when ${disabled}`, { options: { jev_enabled: disabled !== 'off', jev_model_fallback: disabled === 'off', jev_permission_scope: 'all' } }, async ($, on) => {
    const h = harness(on, disabled === 'no-key' ? null : 'fake-test-key')
    on('tool.check', () => ({ decision: 'ask', reason: 'approval', rule: 'test-rule' }))
    await boot($)
    const started = await dag($, { action: 'start', definition: DEFINITION })
    expect(checkpoint(h, started.run_id).nodes.map(node => node.routing)).toEqual([
      { source: 'definition', category: 'trivial' },
      { source: 'definition', category: 'writing' },
      { source: 'definition', category: 'trivial' },
    ])
    expect(await $.tool.check({ tool: PROBE, input: {} })).toEqual({ decision: 'ask', reason: 'approval', rule: 'test-rule' })
    expect(h.requests).toHaveLength(0)
    expect(h.models).toHaveLength(0)
    expect(h.spawns.map(spawn => spawn.model)).toEqual(['sonnet', 'sonnet'])
  })
}

const MODEL_FALLBACKS = [
  { name: 'missing key and an answered model', key: null, status: 200, model: modelReply('allow'), decision: 'allow' },
  { name: 'missing key and an aborted model', key: null, status: 200, model: { isAnswered: false, reason: 'aborted', usage: USAGE } as const, decision: 'ask' },
  { name: 'HTTP 503 and an answered model', key: 'fake-test-key', status: 503, model: modelReply('allow'), decision: 'allow' },
  { name: 'missing key and a rejected model call', key: null, status: 200, model: new Error('test model failure'), decision: 'ask' },
]

for (const item of MODEL_FALLBACKS) {
  test(`session model fallback with ${item.name} decides ${item.decision}`, { options: { jev_permission_scope: 'all' } }, async ($, on) => {
    const h = harness(on, item.key)
    h.control.reply = response({}, item.status)
    h.control.model = item.model
    on('tool.check', () => ({ decision: 'ask', reason: 'baseline', rule: 'rule' }))
    await boot($)
    const verdict = await $.tool.check({ tool: PROBE, input: {} })
    expect(verdict.decision).toBe(item.decision)
    if (item.decision === 'ask') expect(verdict).toEqual({ decision: 'ask', reason: 'baseline', rule: 'rule' })
    expect(h.requests).toHaveLength(item.key ? 1 : 0)
    expect(h.models).toHaveLength(1)
    expect(h.models[0]).toMatchObject({ model: 'sonnet', effort: 'low', timeoutMs: 10_000 })
    const [record] = (await dag($, { action: 'decisions' })).decisions
    expect(record).toMatchObject({ backend: 'model', source: item.decision === 'allow' ? 'jev' : 'baseline' })
  })
}

test('the session model routes each node in its own request and records each outcome', async ($, on) => {
  const h = harness(on, null)
  h.control.modelFor = prompt => {
    const [id = ''] = Object.keys(JSON.parse(prompt).questions)
    if (id === 'b') return { isAnswered: false, reason: 'aborted', usage: USAGE }
    const answer = id === 'a'
      ? { type: 'choice', choice: 'architect', confidence: 0.95, probabilities: { architect: 0.95, trivial: 0.05 } }
      : { type: 'choice', choice: 'writing', confidence: 0.5, probabilities: { writing: 0.5, trivial: 0.5 } }
    return { isAnswered: true, text: JSON.stringify({ answers: { [id]: answer } }), usage: USAGE }
  }
  await boot($)
  const started = await dag($, { action: 'start', definition: DEFINITION })
  expect(h.models.map(model => Object.keys(JSON.parse(model.prompt).questions))).toEqual([['a'], ['b'], ['c']])
  expect(h.models.map(model => JSON.parse(model.prompt).state.nodes)).toEqual([
    [{ id: 'a', task: 'Implement A', dependsOn: [], dependents: ['c'] }],
    [{ id: 'b', task: 'Audit B', dependsOn: [], dependents: [] }],
    [{ id: 'c', task: 'Check C', dependsOn: ['a'], dependents: [] }],
  ])
  expect(checkpoint(h, started.run_id).nodes.map(node => node.routing)).toEqual([
    { source: 'jev', category: 'architect', confidence: 0.95 },
    { source: 'definition', category: 'writing' },
    { source: 'definition', category: 'trivial' },
  ])
  const decisions: { subject: string; outcome: string; backend: string }[] = (await dag($, { action: 'decisions' })).decisions
  expect(decisions.map(record => [record.subject, record.outcome, record.backend])).toEqual([
    ['a', 'applied', 'model'],
    ['b', 'timeout', 'model'],
    ['c', 'low-confidence', 'model'],
  ])
})

test('invalid, missing and low-confidence routes fall back independently', async ($, on) => {
  const h = harness(on)
  h.control.reply = response({ a: choice('architect', 0.899), b: choice('invalid', 1) })
  await boot($)
  const started = await dag($, { action: 'start', definition: DEFINITION })
  expect(checkpoint(h, started.run_id).nodes.map(node => node.routing)).toEqual([
    { source: 'definition', category: 'trivial' },
    { source: 'definition', category: 'writing' },
    { source: 'definition', category: 'trivial' },
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
  test(`${item.name} preserves the complete ask baseline`, { options: { jev_permission_scope: 'all' } }, async ($, on) => {
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

// The host keeps these dialogs whatever a hook allows, so Jev could only deny the person's own question.
for (const tool of ['AskUserQuestion', 'ExitPlanMode']) {
  test(`${tool} keeps its ask without asking Jev`, { options: { jev_permission_scope: 'all' } }, async ($, on) => {
    const h = harness(on)
    h.control.reply = response({ permission: choice('deny', 1) })
    on('tool.check', () => { h.order.push('baseline'); return { decision: 'ask', reason: 'baseline reason', rule: 'baseline rule' } })
    await boot($)
    expect(await $.tool.check({ tool, input: {} })).toEqual({ decision: 'ask', reason: 'baseline reason', rule: 'baseline rule' })
    expect(h.order).toEqual(['baseline'])
    expect(h.requests).toHaveLength(0)
  })
}

for (const decision of DECISIONS) {
  test(`confident ${decision} controls the actual wrapped tool call`, { options: { jev_permission_scope: 'all' } }, async ($, on) => {
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

function answerEvery(picks: Record<string, string>, confidence: number) {
  return (prompt: string): ModelCompleteResult => {
    const ids = Object.keys(JSON.parse(prompt).questions)
    const answers = Object.fromEntries(ids.map(id => [id, { type: 'choice', choice: picks[id], confidence, probabilities: { [picks[id] ?? '']: confidence } }]))
    return { isAnswered: true, text: JSON.stringify({ answers }), usage: USAGE }
  }
}

test('session-model routing applies from its own lower threshold while permissions keep jev_confidence', { options: { jev_permission_scope: 'all' } }, async ($, on) => {
  const h = harness(on, null)
  h.control.modelFor = answerEvery({ a: 'architect', b: 'writing', c: 'trivial', permission: 'allow' }, 0.85)
  on('tool.check', () => ({ decision: 'ask', reason: 'baseline', rule: 'rule' }))
  await boot($)
  const started = await dag($, { action: 'start', definition: DEFINITION })
  expect(checkpoint(h, started.run_id).nodes.map(node => node.routing)).toEqual([
    { source: 'jev', category: 'architect', confidence: 0.85 },
    { source: 'jev', category: 'writing', confidence: 0.85 },
    { source: 'jev', category: 'trivial', confidence: 0.85 },
  ])
  expect(await $.tool.check({ tool: PROBE, input: {} })).toEqual({ decision: 'ask', reason: 'baseline', rule: 'rule' })
  const decisions: { kind: string; outcome: string; threshold: number }[] = (await dag($, { action: 'decisions' })).decisions
  expect(decisions.map(record => [record.kind, record.outcome, record.threshold])).toEqual([
    ['routing', 'applied', 0.8],
    ['routing', 'applied', 0.8],
    ['routing', 'applied', 0.8],
    ['permission', 'low-confidence', 0.9],
  ])
})

test('configured session-model routing confidence raises its bar', { options: { jev_model_routing_confidence: 0.99 } }, async ($, on) => {
  const h = harness(on, null)
  h.control.modelFor = answerEvery({ a: 'architect', b: 'writing', c: 'trivial' }, 0.95)
  await boot($)
  const started = await dag($, { action: 'start', definition: DEFINITION })
  expect(checkpoint(h, started.run_id).nodes.map(node => node.routing?.source)).toEqual(['definition', 'definition', 'definition'])
})

const AUDITED = {
  key: 'final-audit',
  goal: 'Ship A and B',
  nodes: [
    { id: 'a', prompt: 'Implement A', category: 'trivial', verify: VERIFY },
    { id: 'b', prompt: 'Implement B', category: 'trivial', verify: VERIFY },
    { id: 'audit', prompt: 'Audit A and B together', category: 'trivial', dependsOn: ['a', 'b'], verify: VERIFY },
    { id: 'design-review', prompt: 'Review the design of A and B', category: 'reasoning', dependsOn: ['a', 'b'], verify: VERIFY },
  ],
}

for (const jev of ['answers trivial', 'is off']) {
  test(`a trivial final audit runs on standard when Jev ${jev}`, { options: { jev_enabled: jev !== 'is off' } }, async ($, on) => {
    const h = harness(on)
    h.control.reply = response({ a: choice('trivial'), b: choice('trivial'), audit: choice('trivial', 0.99), 'design-review': choice('reasoning') })
    await boot($)
    const started = await dag($, { action: 'start', definition: AUDITED })
    expect(checkpoint(h, started.run_id).nodes.map(node => [node.id, node.routing?.source, node.routing?.category])).toEqual([
      ['a', jev === 'is off' ? 'definition' : 'jev', 'trivial'],
      ['b', jev === 'is off' ? 'definition' : 'jev', 'trivial'],
      ['audit', 'rule', 'standard'],
      ['design-review', jev === 'is off' ? 'definition' : 'jev', 'reasoning'],
    ])
    const decisions: { subject: string; proposed: string; selected: string; source: string }[] = (await dag($, { action: 'decisions' })).decisions
    expect(decisions.find(record => record.subject === 'audit')).toMatchObject({ proposed: 'trivial', selected: 'standard', source: 'rule' })
  })
}

test('configured confidence overrides the default threshold', { options: { jev_confidence: 0.99, jev_permission_scope: 'all' } }, async ($, on) => {
  const h = harness(on)
  h.control.reply = response({ permission: choice('allow', 0.95) })
  on('tool.check', () => ({ decision: 'ask', reason: 'baseline', rule: 'rule' }))
  await boot($)
  expect(await $.tool.check({ tool: PROBE, input: {} })).toEqual({ decision: 'ask', reason: 'baseline', rule: 'rule' })
})

test('a hung HTTP request keeps ask at exactly the virtual 5000ms deadline', { options: { jev_permission_scope: 'all' } }, async ($, on) => {
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

test('successful HTTP completion cancels its virtual deadline', { options: { jev_permission_scope: 'all' } }, async ($, on) => {
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

test('identical concurrent permission questions share HTTP while each keeps its own decision record', { options: { jev_permission_scope: 'all' } }, async ($, on) => {
  const h = harness(on)
  let release: (value: HttpResponse) => void = () => { throw new Error('Transport not started') }
  h.transport(() => new Promise<HttpResponse>(resolve => { release = resolve }))
  on('tool.check', () => ({ decision: 'ask' }))
  await boot($)
  const input = { tool: PROBE, input: { file_path: '/work/a.ts', content: 'a' } }
  const first = $.tool.check(input)
  const second = $.tool.check(input)
  await h.clock.settle()
  expect(h.requests).toHaveLength(1)
  release(response({ permission: choice('allow', 1) }))
  expect((await Promise.all([first, second])).map(result => result.decision)).toEqual(['allow', 'allow'])
  const log = JSON.parse(h.files.get('/work/.claude/dag/decisions/jev-session.json') ?? '{}')
  expect(log.records.filter((item: { kind: string }) => item.kind === 'permission')).toHaveLength(2)
})

test('different permission inputs never merge and resolved permission approvals are not cached', { options: { jev_permission_scope: 'all' } }, async ($, on) => {
  const h = harness(on)
  h.control.reply = response({ permission: choice('allow', 1) })
  on('tool.check', () => ({ decision: 'ask' }))
  await boot($)
  await Promise.all([
    $.tool.check({ tool: PROBE, input: { file_path: '/work/a.ts' } }),
    $.tool.check({ tool: PROBE, input: { file_path: '/work/b.ts' } }),
  ])
  await $.tool.check({ tool: PROBE, input: { file_path: '/work/a.ts' } })
  expect(h.requests).toHaveLength(3)
})

test('the call limit preserves ask and records why no further judgment ran', { options: { jev_max_calls: 1, jev_permission_scope: 'all' } }, async ($, on) => {
  const h = harness(on)
  h.control.reply = response({ permission: choice('allow', 1) })
  on('tool.check', () => ({ decision: 'ask', reason: 'baseline' }))
  await boot($)
  expect((await $.tool.check({ tool: PROBE, input: {} })).decision).toBe('allow')
  expect(await $.tool.check({ tool: PROBE, input: {} })).toEqual({ decision: 'ask', reason: 'baseline' })
  expect(h.requests).toHaveLength(1)
  expect(h.models).toHaveLength(0)
  const log = JSON.parse(h.files.get('/work/.claude/dag/decisions/jev-session.json') ?? '{}')
  expect(log.records.at(-1)).toMatchObject({ source: 'baseline', selected: 'ask', outcome: 'disabled', note: expect.stringContaining('budget-exhausted') })
})

test('a failed HTTP attempt consumes the limit before model fallback', { options: { jev_max_calls: 1, jev_permission_scope: 'all' } }, async ($, on) => {
  const h = harness(on)
  h.control.failure = true
  h.control.model = modelReply('allow', 1)
  on('tool.check', () => ({ decision: 'ask' }))
  await boot($)
  expect((await $.tool.check({ tool: PROBE, input: {} })).decision).toBe('ask')
  expect(h.requests).toHaveLength(1)
  expect(h.models).toHaveLength(0)
})

test('the model limit counts split routing calls and leaves remaining proposals unchanged', { options: { jev_max_calls: 1 } }, async ($, on) => {
  const h = harness(on, null)
  h.control.modelFor = prompt => {
    const data = JSON.parse(prompt)
    return { isAnswered: true, usage: USAGE, text: JSON.stringify({ answers: Object.fromEntries(Object.keys(data.questions).map(id => [id, { ...choice('architect', 1), probabilities: { architect: 1 } }])) }) }
  }
  await boot($)
  const started = await dag($, { action: 'start', definition: DEFINITION })
  const nodes = checkpoint(h, started.run_id).nodes
  expect(h.models).toHaveLength(1)
  expect(nodes[0]?.routing?.category).toBe('architect')
  expect(nodes[1]?.routing?.category).toBe('writing')
  expect(nodes[2]?.routing?.category).toBe('trivial')
})

test('clear cannot replenish the same session budget while a new session starts a new budget', { options: { jev_max_calls: 1, jev_permission_scope: 'all' } }, async ($, on) => {
  const h = harness(on)
  h.control.reply = response({ permission: choice('allow', 1) })
  on('tool.check', () => ({ decision: 'ask' }))
  await boot($)
  await $.tool.check({ tool: PROBE, input: {} })
  await $.classic.SessionStart({ source: 'clear' })
  expect((await $.tool.check({ tool: PROBE, input: {} })).decision).toBe('ask')
  h.control.sessionId = 'new-session'
  await $.classic.SessionStart({ source: 'resume' })
  expect((await $.tool.check({ tool: PROBE, input: {} })).decision).toBe('allow')
  expect(h.requests).toHaveLength(2)
})
