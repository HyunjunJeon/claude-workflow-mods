import { expect, test, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { DecisionRecord } from '../hooks/engine/decisions.ts'
import { ROOT, boot, checkpoint, dag, finish, harness, start } from './control-harness.ts'

const DEFINITION = { key: 'headless-ask', nodes: [{ id: 'a', prompt: 'Produce artifact', verify: [{ kind: 'command', argv: ['check-control'] }] }] }
const FIX = 'allow it up front with --allowedTools Write or a --permission-mode that covers it'
const NOTE = 'Write needs approval that this non-interactive session cannot ask for'
const NEEDS = 'needs approval that this non-interactive session cannot ask for'
const HINT = (tools: string) => `; needed approval this non-interactive session cannot give: ${tools} (allow them up front with --allowedTools)`

// Registered before the shared harness so this gate, not its catch-all tool.call, answers Write.
// The test bottom acts as the host permission gate, asking tool.check with the real tool_use_id.
// It denies with the verdict as the reason, so an unchanged ask reads { deny: 'ask' }.
function askGate(on: On, $: Engine) {
  on('tool.check', () => ({ decision: 'ask' }))
  on('tool.call', { tool: 'Write' }, async (_engine, e) => {
    const verdict = await $.tool.check({ tool: e.tool, input: { file_path: e.file_path, content: e.content }, tool_use_id: e.tool_use_id })
    if (verdict.decision !== 'allow') return { deny: verdict.reason ?? verdict.decision }
    return { result: { type: 'create', filePath: e.file_path, content: e.content, structuredPatch: [], originalFile: null } }
  })
}

// A `claude -p` session: no surface, nobody to answer an ask.
async function bootHeadless($: Engine) {
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  await $.skill.prompt({ skill: 'dag-workflow:dag-planning', text: '# planning' })
}

function agentOf(h: ReturnType<typeof harness>, runId: string): string {
  const agentId = checkpoint(h, runId).nodes.find(node => node.id === 'a')?.agentId
  if (!agentId) throw new Error('Missing node agent')
  return agentId
}

async function nodeCall($: Engine, h: ReturnType<typeof harness>, runId: string, toolUseId: string) {
  const agentId = agentOf(h, runId)
  const call = { tool: 'Write', file_path: '/work/a', content: 'done', agentId, tool_use_id: toolUseId } as const
  return $.tool.call(call)
}

function permissionRecords(h: ReturnType<typeof harness>): DecisionRecord[] {
  const text = h.files.get(`${ROOT}/decisions/source.json`)
  const records: DecisionRecord[] = text ? JSON.parse(text).records : []
  return records.filter(record => record.kind === 'permission')
}

function explained(h: ReturnType<typeof harness>): string[] {
  return h.logs.filter(line => line.includes(NOTE))
}

test('a non-interactive node call left at ask is explained once, naming the node, the tool and the fix', async ($, on) => {
  askGate(on, $)
  const h = harness(on)
  h.control.permission = { choice: 'allow', confidence: 0.88 }
  await bootHeadless($)
  const runId = await start($, DEFINITION)
  expect(await nodeCall($, h, runId, 'headless-call')).toEqual({ deny: 'ask' })
  expect(explained(h)).toEqual([`${runId}/a: ${NOTE} (Jev low-confidence: allow at 0.88, jev_confidence 0.9); ${FIX}`])
  // The default destination puts it in the transcript; the debug log would hide it from a `claude -p` user.
  expect(h.logOptions[h.logs.findIndex(line => line.includes(NOTE))]?.to).not.toBe('debug')
  expect(permissionRecords(h)).toMatchObject([{
    runId, nodeId: 'a', selected: 'ask', outcome: 'low-confidence',
    note: `${NOTE} (Jev low-confidence: allow at 0.88, jev_confidence 0.9); ${FIX}`,
  }])
})

test('the same node call asked again keeps the verdict and adds no second line', async ($, on) => {
  askGate(on, $)
  const h = harness(on)
  h.control.permission = { choice: 'allow', confidence: 0.88 }
  await bootHeadless($)
  const runId = await start($, DEFINITION)
  expect(await nodeCall($, h, runId, 'again')).toEqual({ deny: 'ask' })
  expect(await nodeCall($, h, runId, 'again')).toEqual({ deny: 'ask' })
  expect(explained(h)).toHaveLength(1)
  expect(permissionRecords(h).map(record => record.note)).toHaveLength(2)
})

test('an interactive session leaves the node call at ask with no line and no note, but a record that names the node', async ($, on) => {
  askGate(on, $)
  const h = harness(on)
  h.control.permission = { choice: 'allow', confidence: 0.88 }
  await boot($)
  const runId = await start($, DEFINITION)
  expect(await nodeCall($, h, runId, 'interactive-call')).toEqual({ deny: 'ask' })
  expect(explained(h)).toEqual([])
  const [record] = permissionRecords(h)
  expect(record).toMatchObject({ runId, nodeId: 'a', selected: 'ask', outcome: 'low-confidence' })
  expect(record).not.toHaveProperty('note')
})

test('a non-interactive main-conversation ask gets no line, no note and no node on its record', async ($, on) => {
  on('tool.check', () => ({ decision: 'ask' }))
  const h = harness(on)
  h.control.permission = { choice: 'allow', confidence: 0.88 }
  await bootHeadless($)
  expect(await $.tool.check({ tool: 'Write', input: { file_path: '/work/a', content: 'x' } })).toEqual({ decision: 'ask' })
  expect(explained(h)).toEqual([])
  const [record] = permissionRecords(h)
  expect(record).toMatchObject({ selected: 'ask', outcome: 'low-confidence' })
  expect(record).not.toHaveProperty('note')
  expect(record).not.toHaveProperty('runId')
  expect(record).not.toHaveProperty('nodeId')
})

test('a worker identified by the host agent id alone is explained when the dag scope never asks Jev', { options: { jev_permission_scope: 'dag' } }, async ($, on) => {
  on('tool.check', () => ({ decision: 'ask' }))
  const h = harness(on)
  await bootHeadless($)
  const runId = await start($, DEFINITION)
  const agentId = checkpoint(h, runId).nodes.find(node => node.id === 'a')?.agentId
  if (!agentId) throw new Error('Missing node agent')
  const before = h.requests.length
  // No tool.call reached the plugin for this call, so only the host's agentId names the worker.
  expect(await $.tool.check({ tool: 'Write', input: { file_path: '/work/a', content: 'x' }, tool_use_id: 'late-wave', agentId })).toEqual({ decision: 'ask' })
  expect(explained(h)).toEqual([`${runId}/a: ${NOTE} (Jev not asked: jev_permission_scope is dag and the call carries no node task); ${FIX}`])
  expect(h.requests).toHaveLength(before)
  expect(permissionRecords(h)).toEqual([])
})

test('a Jev failure without an answer is explained by its outcome alone', { options: { jev_model_fallback: false } }, async ($, on) => {
  askGate(on, $)
  const h = harness(on)
  h.control.httpStatus = 503
  await bootHeadless($)
  const runId = await start($, DEFINITION)
  expect(await nodeCall($, h, runId, 'failed-jev')).toEqual({ deny: 'ask' })
  expect(explained(h)).toEqual([`${runId}/a: ${NOTE} (Jev http-error); ${FIX}`])
  expect(permissionRecords(h)).toMatchObject([{ runId, nodeId: 'a', note: `${NOTE} (Jev http-error); ${FIX}` }])
})

test('a confident Jev answer that settles the call adds no line and no note', async ($, on) => {
  askGate(on, $)
  const h = harness(on)
  h.control.permission = { choice: 'allow', confidence: 0.95 }
  await bootHeadless($)
  const runId = await start($, DEFINITION)
  expect(await nodeCall($, h, runId, 'settled')).toHaveProperty('result')
  expect(explained(h)).toEqual([])
  const [record] = permissionRecords(h)
  expect(record).toMatchObject({ runId, nodeId: 'a', selected: 'allow', outcome: 'applied' })
  expect(record).not.toHaveProperty('note')
})

// Every line the plugin logged for a call left at ask, whatever the tool.
function asks(h: ReturnType<typeof harness>): string[] {
  return h.logs.filter(line => line.includes(NEEDS))
}

// The run-settled summaries the main model was handed, oldest first.
function settles(h: ReturnType<typeof harness>): string[] {
  return h.prompts.filter(text => text.includes(' settled: '))
}

// The node's head: from its `- id: ` line up to its output excerpt, the next node or the closing instructions. A failed
// node's error can span several physical lines, so this is not just the first line.
function headOf(summary: string | undefined, nodeId: string): string {
  const from = summary?.indexOf(`- ${nodeId}: `) ?? -1
  if (!summary || from < 0) throw new Error(`No ${nodeId} line in the settle summary`)
  const rest = summary.slice(from)
  const end = rest.search(/\n(?: {4}|- )|\n\nTREAT/)
  return end < 0 ? rest : rest.slice(0, end)
}

// A second tool for the same node attempt; the host would send tool.check with the worker's agentId.
function bashCheck($: Engine, agentId: string, toolUseId: string) {
  return $.tool.check({ tool: 'Bash', input: { command: 'make test' }, tool_use_id: toolUseId, agentId })
}

test('a node call left at ask in a non-interactive session ends that node line of the settle summary with the hint', async ($, on) => {
  askGate(on, $)
  const h = harness(on)
  h.control.permission = { choice: 'allow', confidence: 0.88 }
  await bootHeadless($)
  const runId = await start($, DEFINITION)
  expect(await nodeCall($, h, runId, 'hinted')).toEqual({ deny: 'ask' })
  await finish($, h)
  expect(settles(h)).toHaveLength(1)
  const line = headOf(settles(h)[0], 'a')
  expect(line.startsWith('- a: completed; verification: passed')).toBe(true)
  expect(line.endsWith(HINT('Write'))).toBe(true)
  expect(settles(h)[0]?.split('\n').filter(text => text.includes('needed approval'))).toEqual([line])
})

test('an interactive session leaves the settle summary without the hint', async ($, on) => {
  askGate(on, $)
  const h = harness(on)
  h.control.permission = { choice: 'allow', confidence: 0.88 }
  await boot($)
  const runId = await start($, DEFINITION)
  expect(await nodeCall($, h, runId, 'interactive-settle')).toEqual({ deny: 'ask' })
  await finish($, h)
  expect(settles(h)).toHaveLength(1)
  expect(settles(h)[0]).not.toContain('needed approval')
})

test('two tools left at ask by one node attempt log two lines and the hint lists both, once each', async ($, on) => {
  askGate(on, $)
  const h = harness(on)
  h.control.permission = { choice: 'allow', confidence: 0.88 }
  await bootHeadless($)
  const runId = await start($, DEFINITION)
  expect(await nodeCall($, h, runId, 'first-tool')).toEqual({ deny: 'ask' })
  expect(await bashCheck($, agentOf(h, runId), 'second-tool')).toEqual({ decision: 'ask' })
  expect(await nodeCall($, h, runId, 'first-tool-again')).toEqual({ deny: 'ask' })
  expect(asks(h)).toEqual([
    `${runId}/a: Write ${NEEDS} (Jev low-confidence: allow at 0.88, jev_confidence 0.9); ${FIX}`,
    `${runId}/a: Bash ${NEEDS} (Jev low-confidence: allow at 0.88, jev_confidence 0.9); allow it up front with --allowedTools Bash or a --permission-mode that covers it`,
  ])
  await finish($, h)
  expect(headOf(settles(h)[0], 'a').endsWith(HINT('Write, Bash'))).toBe(true)
})

test('a new attempt of the node left at ask again logs a new line and hints only for that attempt', { options: { auto_recovery: false } }, async ($, on) => {
  askGate(on, $)
  const h = harness(on)
  h.control.permission = { choice: 'allow', confidence: 0.88 }
  await bootHeadless($)
  const runId = await start($, DEFINITION)
  h.control.exitCode = 1
  expect(await nodeCall($, h, runId, 'attempt-one')).toEqual({ deny: 'ask' })
  await finish($, h)
  expect(checkpoint(h, runId).nodes[0]).toMatchObject({ state: 'failed', attempt: 1 })
  expect(asks(h)).toHaveLength(1)
  expect(headOf(settles(h)[0], 'a').endsWith(HINT('Write'))).toBe(true)

  h.control.exitCode = 0
  await dag($, { action: 'retry', run_id: runId, node_id: 'a' })
  expect(checkpoint(h, runId).nodes[0]).toMatchObject({ state: 'running', attempt: 2 })
  expect(await nodeCall($, h, runId, 'attempt-two')).toEqual({ deny: 'ask' })
  expect(await nodeCall($, h, runId, 'attempt-two-again')).toEqual({ deny: 'ask' })
  expect(asks(h)).toEqual([
    `${runId}/a: ${NOTE} (Jev low-confidence: allow at 0.88, jev_confidence 0.9); ${FIX}`,
    `${runId}/a: ${NOTE} (Jev low-confidence: allow at 0.88, jev_confidence 0.9); ${FIX}`,
  ])
  await finish($, h, agentOf(h, runId))
  expect(settles(h)).toHaveLength(2)
  expect(headOf(settles(h)[1], 'a').endsWith(HINT('Write'))).toBe(true)
})

test('a retry that asks for nothing does not inherit the hint of the attempt before it', { options: { auto_recovery: false } }, async ($, on) => {
  askGate(on, $)
  const h = harness(on)
  h.control.permission = { choice: 'allow', confidence: 0.88 }
  await bootHeadless($)
  const runId = await start($, DEFINITION)
  h.control.exitCode = 1
  expect(await nodeCall($, h, runId, 'attempt-one')).toEqual({ deny: 'ask' })
  await finish($, h)
  expect(headOf(settles(h)[0], 'a')).toContain(HINT('Write'))

  h.control.exitCode = 0
  await dag($, { action: 'retry', run_id: runId, node_id: 'a' })
  await finish($, h, agentOf(h, runId))
  expect(checkpoint(h, runId).nodes[0]).toMatchObject({ state: 'completed', attempt: 2 })
  expect(settles(h)).toHaveLength(2)
  expect(settles(h)[1]).not.toContain('needed approval')
  expect(asks(h)).toHaveLength(1)
})

test('a non-interactive main-conversation call made while a node runs is not attributed to that node', async ($, on) => {
  on('tool.check', () => ({ decision: 'ask' }))
  const h = harness(on)
  h.control.permission = { choice: 'allow', confidence: 0.88 }
  await bootHeadless($)
  const runId = await start($, DEFINITION)
  expect(checkpoint(h, runId).nodes[0]).toMatchObject({ state: 'running', agentId: 'agent-1' })
  expect(await $.tool.check({ tool: 'Write', input: { file_path: '/work/a', content: 'x' }, tool_use_id: 'main-while-node-runs' })).toEqual({ decision: 'ask' })
  expect(asks(h)).toEqual([])
  const [record] = permissionRecords(h)
  expect(record).toMatchObject({ selected: 'ask', outcome: 'low-confidence' })
  expect(record).not.toHaveProperty('runId')
  expect(record).not.toHaveProperty('nodeId')
  expect(record).not.toHaveProperty('note')
  await finish($, h)
  expect(settles(h)).toHaveLength(1)
  expect(settles(h)[0]).not.toContain('needed approval')
})
