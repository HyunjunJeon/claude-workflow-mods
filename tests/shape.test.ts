import { expect, test } from 'claude-code/testing'
import { parseArgs } from '../eval/options.ts'
import { classifyToolResults, scenarioMatched, summarizeRepeats, transcriptCounts, verificationOf } from '../eval/report.ts'
import { classifyShape, shapeOf } from '../eval/shape.ts'
import { parseDefinition } from '../hooks/engine/definition.ts'
import type { Definition, NodeRun, Run } from '../hooks/engine/types.ts'

function nodeRun(id: string, extra: Partial<NodeRun> = {}): NodeRun {
  return { id, label: id, state: 'completed', attempt: 1, fingerprint: id, ...extra }
}

function runWith(nodes: NodeRun[]): Run {
  return { nodes } as unknown as Run
}

function graph(edges: Record<string, string[]>): Definition {
  const parsed = parseDefinition({ key: 'g', goal: 'a fixture goal', nodes: Object.entries(edges).map(([id, dependsOn]) => ({ id, prompt: 'p', dependsOn })) })
  if (!parsed.ok) throw new Error(parsed.error.message)
  return parsed.value
}

test('each topology gets its own shape class', async () => {
  const shape = (edges: Record<string, string[]>) => classifyShape(graph(edges).nodes)
  expect(shape({ a: [] })).toBe('single')
  expect(shape({ a: [], b: [], c: [] })).toBe('parallel')
  expect(shape({ a: [], b: ['a'], c: ['b'] })).toBe('chain')
  expect(shape({ a: [], b: ['a'], c: ['a'], d: ['b', 'c'] })).toBe('diamond')
  expect(shape({ a: [], b: [], c: [], d: ['a', 'b', 'c'] })).toBe('fan-out/fan-in')
  expect(shape({ a: [], b: ['a'], c: ['a'] })).toBe('fan-out')
  expect(shape({ a: [], b: ['a'], c: [], d: ['c'] })).toBe('mixed')
})

test('metrics report widths, joins and the producer shape without the verification node', async () => {
  const m = shapeOf(graph({ fix1: [], fix2: [], fix3: [], verify: ['fix1', 'fix2', 'fix3'] }))
  expect(m).toMatchObject({ nodes: 4, edges: 3, depth: 2, widths: [3, 1], maxWidth: 3, fanInNodes: 1, verify: true, shape: 'fan-out/fan-in', producerShape: 'parallel' })
  expect(m.categories).toEqual({ '(session)': 4 })
  // Four prompt-contract warnings, and verify is a final audit without a category, which routes as trivial.
  expect(m.warnings).toBe(5)
  expect(shapeOf(graph({ build: [], verify: ['build'] })).producerShape).toBe('single')
})

test('Given tool results with each marker, when classified, then every counter increments once', async () => {
  const dag = (text: string) => ({ tool: 'mcp__dag-workflow__dag', isError: false, text })
  const counts = classifyToolResults([
    dag('{"error":"planning_skill_required"}'),
    { tool: 'Bash', isError: true, text: '<tool_use_error>dag-workflow refused Bash in the main conversation' },
    dag('{"error":{"code":"verification_required"}}'),
    dag('{"error":{"code":"invalid_verification"}}'),
    dag('all good'),
  ])
  expect(counts).toEqual({ planningRefusals: 1, toolDenials: 1, denials: [{ tool: 'Bash', reason: 'unknown', count: 1 }], verificationRequired: 1, invalidVerification: 1 })
})

test('Given results without markers, when classified, then all counters are zero', async () => {
  expect(classifyToolResults([{ tool: 'Read', isError: false, text: 'ok' }, { tool: 'mcp__dag-workflow__dag', isError: false, text: '' }]))
    .toEqual({ planningRefusals: 0, toolDenials: 0, denials: [], verificationRequired: 0, invalidVerification: 0 })
})

test('Given a Read of the planning reference that quotes refusal codes, when classified, then nothing is counted', async () => {
  const quoted = 'Missing checks are refused with `verification_required`, malformed ones with `invalid_verification`; planning_skill_required; dag-workflow refused'
  expect(classifyToolResults([{ tool: 'Read', isError: false, text: quoted }]))
    .toEqual({ planningRefusals: 0, toolDenials: 0, denials: [], verificationRequired: 0, invalidVerification: 0 })
})

test('Given passed, failed and unrecorded nodes, when summarized, then per-node values and totals match', async () => {
  const run = runWith([
    nodeRun('a', { verification: { status: 'passed', evidence: [] } }),
    nodeRun('b', { state: 'failed', verification: { status: 'failed', evidence: [], error: 'x' } }),
    nodeRun('c'),
  ])
  const { nodes, totals } = verificationOf(run)
  expect(nodes.map(n => [n.id, n.verification])).toEqual([['a', 'passed'], ['b', 'failed'], ['c', 'unrecorded']])
  expect(totals).toEqual({ verifiedNodes: 1, failedVerification: 1, missingVerification: 0, autoRetries: 0 })
})

test('Given a missing verification status, when summarized, then it is counted as missing', async () => {
  const { nodes, totals } = verificationOf(runWith([nodeRun('a', { verification: { status: 'missing', evidence: [] } })]))
  expect(nodes[0]?.verification).toBe('missing')
  expect(totals.missingVerification).toBe(1)
})

test('Given recovery and routing on a node, when summarized, then they are carried with retries totaled', async () => {
  const run = runWith([
    nodeRun('a', {
      attempt: 3,
      routing: { source: 'jev', category: 'trivial', confidence: 0.9 },
      recovery: { used: 2, kind: 'implementation', reason: 'r', model: 'opus', history: [] },
    }),
    nodeRun('b'),
  ])
  const { nodes, totals } = verificationOf(run)
  expect(nodes[0]).toEqual({ id: 'a', state: 'completed', attempt: 3, verification: 'unrecorded', recoveryUsed: 2, recoveryKind: 'implementation', routedCategory: 'trivial', routingSource: 'jev' })
  expect(nodes[1]).toEqual({ id: 'b', state: 'completed', attempt: 1, verification: 'unrecorded', recoveryUsed: 0 })
  expect(totals.autoRetries).toBe(2)
})

const DAG = 'mcp__dag-workflow__dag'

function row(content: unknown[], extra: object = {}): string {
  return JSON.stringify({ type: 'assistant', message: { content }, ...extra })
}

function refusal(tool: string, reason: string): string {
  return `dag-workflow refused ${tool} in the main conversation: ${reason}.\nDAG orchestration is mandatory here.`
}

test('Given rows written twice, when counted, then each tool_use id and tool_use_id counts once', async () => {
  const start = row([{ type: 'tool_use', id: 'u1', name: DAG, input: { action: 'start' } }])
  const ask = row([{ type: 'tool_use', id: 'u2', name: 'AskUserQuestion', input: {} }])
  const bash = row([{ type: 'tool_use', id: 'u3', name: 'Bash', input: {} }])
  const denied = row([{ type: 'tool_result', tool_use_id: 'u3', is_error: true, content: refusal('Bash', 'it runs a mutating command') }])
  const once = transcriptCounts([start, ask, bash, denied])
  const twice = transcriptCounts([start, start, ask, ask, bash, denied, denied])
  expect(twice).toEqual(once)
  expect(twice.starts).toBe(1)
  expect(twice.askUserQuestions).toBe(1)
  expect(twice.toolDenials).toBe(1)
})

test('Given a sidechain row, when counted, then it is skipped', async () => {
  const start = row([{ type: 'tool_use', id: 'u1', name: DAG, input: { action: 'start' } }], { isSidechain: true })
  expect(transcriptCounts([start]).starts).toBe(0)
})

test('Given a planning skill load before the first start, when counted, then skillBeforeStart is true', async () => {
  const skill = row([{ type: 'tool_use', id: 's1', name: 'Skill', input: { skill: 'dag-workflow:planning' } }])
  const start = row([{ type: 'tool_use', id: 'u1', name: DAG, input: { action: 'start' } }])
  expect(transcriptCounts([skill, start]).skillBeforeStart).toBe(true)
  expect(transcriptCounts([start, skill]).skillBeforeStart).toBe(false)
  expect(transcriptCounts([skill]).skillBeforeStart).toBe(null)
})

test('Given refusals with different tools or reasons, when counted, then each pair is listed with its count', async () => {
  const calls = ['a', 'b', 'c', 'd'].map((id, i) => row([{ type: 'tool_use', id, name: i === 2 ? 'Write' : 'Bash', input: {} }]))
  const reasons = ['it mutates files', 'it mutates files', 'it writes a file', 'it needs the network']
  const results = ['a', 'b', 'c', 'd'].map((id, i) => row([{ type: 'tool_result', tool_use_id: id, is_error: true, content: refusal(i === 2 ? 'Write' : 'Bash', reasons[i] ?? "") }]))
  const counts = transcriptCounts([...calls, ...results])
  expect(counts.toolDenials).toBe(4)
  expect(counts.denials).toEqual([
    { tool: 'Bash', reason: 'it mutates files', count: 2 },
    { tool: 'Write', reason: 'it writes a file', count: 1 },
    { tool: 'Bash', reason: 'it needs the network', count: 1 },
  ])
})

test('Given a direct scenario, when matched, then only no run or strict single-node runs match', async () => {
  const one = { nodes: 1, shape: 'single', producerShape: 'single' } as const
  const two = { nodes: 2, shape: 'chain', producerShape: 'chain' } as const
  expect(scenarioMatched('direct', [], 'auto')).toBe(true)
  expect(scenarioMatched('direct', [one], 'strict')).toBe(true)
  expect(scenarioMatched('direct', [one], 'auto')).toBe(false)
  expect(scenarioMatched('direct', [one], undefined)).toBe(false)
  expect(scenarioMatched('direct', [two], 'strict')).toBe(false)
  expect(scenarioMatched('direct', [one, two], 'strict')).toBe(false)
  expect(scenarioMatched('chain', [two], 'auto')).toBe(true)
  expect(scenarioMatched('chain', [one], 'strict')).toBe(false)
})

test('Given no --repeat, when parsed, then one sample is requested', async () => {
  expect(parseArgs([])).toEqual({ options: expect.objectContaining({ repeat: 1 }) })
})

test('Given --repeat 2 or 3, when parsed, then it is accepted without confirmation', async () => {
  expect(parseArgs(['--repeat', '2'])).toEqual({ options: expect.objectContaining({ repeat: 2 }) })
  expect(parseArgs(['--repeat', '3'])).toEqual({ options: expect.objectContaining({ repeat: 3 }) })
})

test('Given --repeat 4 without --confirm-usage, when parsed, then the error names --confirm-usage', async () => {
  const parsed = parseArgs(['--repeat', '4'])
  expect('error' in parsed && parsed.error).toContain('--confirm-usage')
})

test('Given --repeat 4 with --confirm-usage, when parsed, then it is accepted', async () => {
  expect(parseArgs(['--repeat', '4', '--confirm-usage'])).toEqual({ options: expect.objectContaining({ repeat: 4 }) })
})

test('Given a --repeat that is not a positive integer, when parsed, then it is refused', async () => {
  for (const bad of ['0', 'x', '-1', '1.5', '']) expect(parseArgs(['--repeat', bad])).toEqual({ error: expect.stringContaining('--repeat') })
  expect(parseArgs(['--repeat'])).toEqual({ error: expect.stringContaining('--repeat') })
})

test('Given --list with --repeat 4, when parsed, then it is not refused', async () => {
  expect(parseArgs(['--list', '--repeat', '4'])).toEqual({ options: expect.objectContaining({ list: true, repeat: 4 }) })
})

test('Given samples with mixed matches and seconds, when summarized, then each scenario gets counts, shapes and min-median-max', async () => {
  const sample = (id: string, matched: boolean, shape: string, seconds: number) => ({ id, matched, shape, seconds })
  expect(
    summarizeRepeats([
      sample('a', true, 'single', 30),
      sample('b', false, 'chain', 5),
      sample('a', false, 'chain', 10),
      sample('a', true, 'single', 20),
      sample('b', true, 'chain', 9),
    ]),
  ).toEqual([
    { id: 'a', samples: 3, matched: 2, shapes: ['single', 'chain'], minSeconds: 10, medianSeconds: 20, maxSeconds: 30 },
    { id: 'b', samples: 2, matched: 1, shapes: ['chain'], minSeconds: 5, medianSeconds: 7, maxSeconds: 9 },
  ])
})
