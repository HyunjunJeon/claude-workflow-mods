import { expect, test } from 'claude-code/testing'
import { boot, checkpoint, dag, finish, harness, start } from './control-harness.ts'

test('completion processing fails and settles when transcript recovery throws', { options: { auto_recovery: false } }, async ($, on) => {
  const h = harness(on)
  on('session.messages', () => { throw new Error('transcript unavailable') })
  await boot($)
  const runId = await start($, {
    key: 'transcript-failure',
    nodes: [
      { id: 'a', prompt: 'Produce artifact', verify: [{ kind: 'command', argv: ['check-control'] }] },
      { id: 'b', prompt: 'Consume artifact', dependsOn: ['a'], verify: [{ kind: 'command', argv: ['check-control'] }] },
    ],
  })
  const promptsBefore = h.prompts.length

  await $.turn.complete({
    turnId: 'turn-agent-1', agentId: 'agent-1', reason: 'answer',
    isAborted: false, answer: '', durationMs: 1,
  })
  await h.clock.settle()

  const saved = checkpoint(h, runId)
  expect(saved.nodes[0]?.state).toBe('failed')
  expect(saved.nodes[0]?.error?.startsWith('Completion processing failed:')).toBe(true)
  expect(saved.nodes[1]?.state).toBe('skipped')
  expect(saved.status).not.toBe('running')
  expect(h.prompts.length).toBeGreaterThan(promptsBefore)
})

test('cancel resolves for another run while completion verification is pending', { options: { auto_recovery: false } }, async ($, on) => {
  let releaseVerification: (() => void) | undefined
  const verification = new Promise<void>(resolve => { releaseVerification = resolve })
  let verificationStarted = false
  on('process.run', { argv: 'deferred-check' }, async () => {
    verificationStarted = true
    await verification
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const h = harness(on)
  await boot($)
  const runA = await start($, {
    key: 'verification-pending',
    nodes: [{ id: 'a', prompt: 'Produce artifact', verify: [{ kind: 'command', argv: ['deferred-check'] }] }],
  })
  const runB = await start($, {
    key: 'cancel-during-verification',
    nodes: [{ id: 'b', prompt: 'Other work', verify: [{ kind: 'command', argv: ['check-control'] }] }],
  })
  await finish($, h)
  expect(verificationStarted).toBe(true)
  let cancelled = false

  const cancellation = dag($, { action: 'cancel', run_id: runB }).then(result => {
    cancelled = true
    return result
  })
  await h.clock.settle()

  try {
    expect(cancelled).toBe(true)
    await finish($, h, 'agent-2', true)
    expect(checkpoint(h, runB).status).toBe('cancelled')
  } finally {
    releaseVerification?.()
    await h.clock.settle()
    await cancellation
  }
  expect(checkpoint(h, runA).nodes[0]?.state).toBe('completed')
})
