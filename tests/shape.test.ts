import { expect, test } from 'claude-code/testing'
import { classifyToolResults, verificationOf } from '../eval/report.ts'
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
  const parsed = parseDefinition({ key: 'g', nodes: Object.entries(edges).map(([id, dependsOn]) => ({ id, prompt: 'p', dependsOn })) })
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
  // Four prompt-contract warnings, and verify is a final audit without a category, which routes as quick.
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
  expect(counts).toEqual({ planningRefusals: 1, toolDenials: 1, verificationRequired: 1, invalidVerification: 1 })
})

test('Given results without markers, when classified, then all counters are zero', async () => {
  expect(classifyToolResults([{ tool: 'Read', isError: false, text: 'ok' }, { tool: 'mcp__dag-workflow__dag', isError: false, text: '' }]))
    .toEqual({ planningRefusals: 0, toolDenials: 0, verificationRequired: 0, invalidVerification: 0 })
})

test('Given a Read of the planning reference that quotes refusal codes, when classified, then nothing is counted', async () => {
  const quoted = 'Missing checks are refused with `verification_required`, malformed ones with `invalid_verification`; planning_skill_required; dag-workflow refused'
  expect(classifyToolResults([{ tool: 'Read', isError: false, text: quoted }]))
    .toEqual({ planningRefusals: 0, toolDenials: 0, verificationRequired: 0, invalidVerification: 0 })
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
      routing: { source: 'jev', category: 'quick', confidence: 0.9 },
      recovery: { used: 2, kind: 'implementation', reason: 'r', model: 'opus', history: [] },
    }),
    nodeRun('b'),
  ])
  const { nodes, totals } = verificationOf(run)
  expect(nodes[0]).toEqual({ id: 'a', state: 'completed', attempt: 3, verification: 'unrecorded', recoveryUsed: 2, recoveryKind: 'implementation', routedCategory: 'quick', routingSource: 'jev' })
  expect(nodes[1]).toEqual({ id: 'b', state: 'completed', attempt: 1, verification: 'unrecorded', recoveryUsed: 0 })
  expect(totals.autoRetries).toBe(2)
})
