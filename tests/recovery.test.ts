import { expect, test } from 'claude-code/testing'
import { recoverNode } from '../hooks/engine/recovery.ts'
import { createRun, markFinished, markRunning, snapshotOf } from '../hooks/engine/run.ts'
import type { Run } from '../hooks/engine/types.ts'
import { VERIFICATION_GUIDANCE } from '../hooks/engine/check-eval.ts'
import { buildNodePrompt } from '../hooks/engine/node-prompt.ts'
import { recoveryRequest } from '../hooks/engine/jev.ts'

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

test('recovery and snapshots deliver shared guidance and the previous check evidence', () => {
  const run = failedRun()
  const node = run.nodes[0]
  const def = run.definition.nodes[0]
  if (!node || !def) throw new Error('Missing fixture node')
  const check = { kind: 'command' as const, argv: ['check'] }
  def.verify = [check]
  node.verification = {
    status: 'failed', reportPath: '/evidence/a.json',
    evidence: [{ check, outcome: 'unknown', passed: false, checkedAt: 2, exitCode: 0, detail: 'output truncated' }],
  }
  expect(snapshotOf(run)).toMatchObject({ verification_guidance: VERIFICATION_GUIDANCE })
  expect(buildNodePrompt(run, def, node).includes(VERIFICATION_GUIDANCE)).toBe(true)
  expect(recoveryRequest(run, node).questions.recovery?.instructions.includes(VERIFICATION_GUIDANCE)).toBe(true)
  const recovered = recoverNode(run, 'a', { kind: 'transient', reason: 'retry', now: 3 })
  if (!recovered.ok) throw new Error(recovered.error.code)
  const recoveredNode = recovered.value.nodes[0]
  if (!recoveredNode) throw new Error('Missing recovered node')
  const prompt = recoveredNode.promptOverride ?? ''
  expect(buildNodePrompt(recovered.value, def, recoveredNode).includes(VERIFICATION_GUIDANCE)).toBe(true)
  const evidence = /<verification_evidence>\n([\s\S]*?)\n<\/verification_evidence>/.exec(prompt)?.[1]
  expect(evidence === undefined ? undefined : JSON.parse(evidence)).toEqual({
    attempt: 1, reportPath: '/evidence/a.json',
    checks: [{ index: 1, outcome: 'unknown', exitCode: 0, detail: 'output truncated' }],
  })
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

// A reviewer that fails on its verdict judged the work; a producer that fails on a verdict-like line did not.
function reviewedRun(error: string, reviewer = 'review-spec'): Run {
  let run = createRun({
    key: 'verdict', name: 'Verdict',
    nodes: [
      { id: 'build', prompt: 'Build it', dependsOn: [] },
      { id: reviewer, prompt: 'Review it', dependsOn: ['build'] },
    ],
  }, { runId: 'r', sessionId: 's', now: 0 })
  run = markFinished(markRunning(run, 'build', 'agent-build', 1, 'sonnet'), 'build', { state: 'completed', answer: 'done' }, 2)
  return markFinished(markRunning(run, reviewer, 'agent-review', 3, 'sonnet'), reviewer, { state: 'failed', error }, 4)
}

test('a reviewer or audit that failed on its FAIL verdict is never retried automatically', () => {
  for (const [reviewer, error] of [
    ['review-spec', 'Spec verdict: FAIL - (a) missing --json flag'],
    ['review-standards', 'out.md: lastLine expected "Standards verdict: PASS", got "Standards verdict: FAIL"'],
    ['review-security', 'Security verdict: FAIL - 2 confirmed breaches'],
    ['audit-plan', 'partial/supporting-output - plan.md unchanged since attempt 1'],
    ['verify-doc', 'Doc verdict FAIL: the table lacks a quicksort row'],
  ] as const) {
    const result = recoverNode(reviewedRun(error, reviewer), reviewer, { kind: 'implementation', reason: error, now: 5 })
    expect({ reviewer, code: result.ok ? 'ok' : result.error.code }).toEqual({ reviewer, code: 'recovery_needs_input' })
  }
  // A reviewer that broke for another reason still retries, and so does a producer whose own output says FAIL.
  expect(recoverNode(reviewedRun('The node agent ended with error.'), 'review-spec', { kind: 'transient', reason: 'api error', now: 5 }).ok).toBe(true)
  const producer = markFinished(markRunning(createRun({ key: 'p', name: 'P', nodes: [{ id: 'build', prompt: 'Build', dependsOn: [] }] }, { runId: 'p', sessionId: 's', now: 0 }), 'build', 'agent', 1, 'sonnet'), 'build', { state: 'failed', error: 'tests: lastLine expected "Verdict: PASS", got "Verdict: FAIL"' }, 2)
  expect(recoverNode(producer, 'build', { kind: 'implementation', reason: 'tests fail', now: 3 }).ok).toBe(true)
})
