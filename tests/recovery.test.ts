import { expect, test } from 'claude-code/testing'
import { recoverNode } from '../hooks/engine/recovery.ts'
import { createRun, markFinished, markRunning } from '../hooks/engine/run.ts'
import type { Run } from '../hooks/engine/types.ts'

function failedRun(): Run {
  let run = createRun({
    key: 'recovery', name: 'Recovery',
    nodes: [
      { id: 'a', prompt: 'Fix a', dependsOn: [] },
      { id: 'b', prompt: 'Use a', dependsOn: ['a'] },
      { id: 'independent', prompt: 'Other work', dependsOn: [] },
    ],
  }, { runId: 'r', sessionId: 's', now: 0 })
  run = markRunning(run, 'a', 'agent-a', 1, 'sonnet')
  run = markRunning(run, 'independent', 'agent-other', 1, 'sonnet')
  return markFinished(run, 'a', { state: 'failed', error: 'check failed' }, 2)
}

test('automatic recovery requeues only the failed lane and escalates implementation failures', () => {
  const before = failedRun()
  const result = recoverNode(before, 'a', { kind: 'implementation', reason: 'check failed', now: 3 })
  if (!result.ok) throw new Error(result.error.code)
  expect(result.value.nodes.map(node => node.state)).toEqual(['scheduled', 'pending', 'running'])
  expect(result.value.nodes[0]?.recovery).toMatchObject({ used: 1, model: 'opus', kind: 'implementation' })
  expect(result.value.nodes[2]).toEqual(before.nodes[2])
  expect(before.nodes[0]?.recovery).toBe(undefined)
})

test('a node gets at most two automatic attempts even across repeated failures', () => {
  let run = failedRun()
  for (let n = 1; n <= 2; n++) {
    const recovered = recoverNode(run, 'a', { kind: 'transient', reason: 'temporary failure', now: 3 + n })
    if (!recovered.ok) throw new Error(recovered.error.code)
    run = markFinished(markRunning(recovered.value, 'a', `agent-${n}`, 10 + n, 'sonnet'), 'a', { state: 'failed' }, 20 + n)
  }
  expect(run.nodes[0]?.attempt).toBe(3)
  const exhausted = recoverNode(run, 'a', { kind: 'transient', reason: 'still failing', now: 30 })
  expect(exhausted.ok ? '' : exhausted.error.code).toBe('recovery_exhausted')
})

test('input, authorization, cancellation and missing verification never auto-retry', () => {
  for (const kind of ['missing-input', 'clarification', 'permanent'] as const) {
    expect(recoverNode(failedRun(), 'a', { kind, reason: 'needs a decision', now: 3 }).ok).toBe(false)
  }
  const run = failedRun()
  expect(recoverNode({ ...run, cancelReason: 'user stopped' }, 'a', { kind: 'implementation', reason: '', now: 3 }).ok).toBe(false)
  const missing: Run = { ...run, nodes: run.nodes.map(node => node.id === 'a' ? { ...node, verification: { status: 'missing', evidence: [] } } : node) }
  expect(recoverNode(missing, 'a', { kind: 'implementation', reason: '', now: 3 }).ok).toBe(false)
})
