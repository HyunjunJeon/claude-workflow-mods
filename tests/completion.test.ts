import { expect, test } from 'claude-code/testing'
import { boot, checkpoint, dag, finish, harness, start } from './control-harness.ts'

test('completion spawns the next wave before returning without settling the clock', async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = await start($, {
    key: 'hook-frame-chain',
    nodes: [
      { id: 'a', prompt: 'Produce artifact', verify: [{ kind: 'command', argv: ['check-control'] }] },
      { id: 'b', prompt: 'Consume artifact', dependsOn: ['a'], verify: [{ kind: 'command', argv: ['check-control'] }] },
    ],
  })

  await $.turn.complete({
    turnId: 'turn-agent-1', agentId: 'agent-1', reason: 'answer',
    isAborted: false, answer: 'DAG_NODE_STATUS: completed', durationMs: 1,
  })

  expect(h.spawns.length).toBe(2)
  expect(checkpoint(h, runId).nodes[1]).toMatchObject({ state: 'running', agentId: 'agent-2' })
})

test('completion logs an apply failure and still returns through the hook', async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = await start($, {
    key: 'hook-frame-failure',
    nodes: [{ id: 'a', prompt: 'Produce artifact', verify: [{ kind: 'command', argv: ['check-control'] }] }],
  })
  h.writeErrors.set(`/work/.claude/dag/runs/${runId}.json`, 'checkpoint unavailable')

  const result = await $.turn.complete({
    turnId: 'turn-agent-1', agentId: 'agent-1', reason: 'answer',
    isAborted: false, answer: 'DAG_NODE_STATUS: completed', durationMs: 1,
  })

  expect(result).toMatchObject({ text: '' })
  expect(h.logs.some(log => log.startsWith('could not record the end of agent agent-1:'))).toBe(true)
})

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
  let signalVerification: (() => void) | undefined
  const verificationStarted = new Promise<void>(resolve => { signalVerification = resolve })
  on('process.run', { argv: 'deferred-check' }, async () => {
    signalVerification?.()
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
  const completion = finish($, h)
  await verificationStarted
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
    await completion
    await cancellation
  }
  expect(checkpoint(h, runA).nodes[0]?.state).toBe('completed')
})
