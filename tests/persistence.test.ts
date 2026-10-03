import { expect, test } from 'claude-code/testing'
import { boot, checkpoint, dag, finish, harness, ROOT, start } from './control-harness.ts'

const DEFINITION = {
  key: 'persistence',
  nodes: [{ id: 'a', prompt: 'Produce artifact', verify: [{ kind: 'command', argv: ['check-control'] }] }],
}

test('the first spawned agent is checkpointed while the second spawn is pending', async ($, on) => {
  let release: (() => void) | undefined
  const pending = new Promise<void>(resolve => { release = resolve })
  let spawnCount = 0
  let secondPending = false
  on('agent.spawn', { description: /^persistence:/ }, async ($, e, next) => {
    spawnCount += 1
    if (spawnCount === 2) {
      secondPending = true
      await pending
    }
    return next(e)
  })
  const h = harness(on)
  await boot($)
  let startFinished = false
  const starting = start($, {
    ...DEFINITION,
    nodes: [...DEFINITION.nodes, { ...DEFINITION.nodes[0], id: 'b' }],
  }).then(runId => { startFinished = true; return runId })
  await h.clock.settle()

  try {
    expect(secondPending).toBe(true)
    expect(startFinished).toBe(false)
    const path = [...h.files.keys()].find(path => path.startsWith(`${ROOT}/runs/`) && path.endsWith('.json'))
    expect(path).toBeDefined()
    if (!path) throw new Error('Missing first-wave checkpoint')
    const runId = path.slice(`${ROOT}/runs/`.length, -'.json'.length)
    expect(checkpoint(h, runId).nodes[0]).toMatchObject({ id: 'a', state: 'running', agentId: 'agent-1' })
    expect(checkpoint(h, runId).nodes[1]?.state).toBe('scheduled')
  } finally {
    release?.()
    await h.clock.settle()
    await starting
  }
})

test('a failed settle submission remains unnotified and is retried on session restart', async ($, on) => {
  let failSubmit = true
  let attempts = 0
  on('prompt.submit', { text: /settled:/ }, async ($, e, next) => {
    attempts += 1
    if (failSubmit) throw new Error('settle submission unavailable')
    return next(e)
  }).catch(($, e, next) => ({ drop: next.error.message ?? 'settle submission unavailable' }))
  const h = harness(on)
  await boot($)
  const runId = await start($, DEFINITION)
  await finish($, h)
  const failedCheckpoint = checkpoint(h, runId)
  expect(attempts).toBe(1)
  // Host hooks fail open unless their catch handler explicitly drops the prompt.
  const failureLogged = h.logs.some(text => text.includes('settle submission unavailable'))

  failSubmit = false
  await boot($)
  await h.clock.settle()

  expect(failedCheckpoint.settledNotified === true).toBe(false)
  expect(failureLogged).toBe(true)
  expect(attempts).toBe(2)
  expect(h.prompts.filter(text => text.includes('settled: completed')).length).toBe(1)
  expect(checkpoint(h, runId).settledNotified).toBe(true)
})

test('two ticks of a settled run do not duplicate an in-flight settle submission', async ($, on) => {
  let release: (() => void) | undefined
  const pending = new Promise<void>(resolve => { release = resolve })
  let submissions = 0
  on('prompt.submit', { text: /settled:/ }, async ($, e, next) => {
    if (e.text.includes('settled:')) {
      submissions += 1
      await pending
    }
    return next(e)
  })
  const h = harness(on)
  await boot($)
  const runId = await start($, DEFINITION)
  await finish($, h)

  try {
    // An unchanged amendment ticks the settled run without starting another worker.
    await dag($, { action: 'amend', run_id: runId, definition: DEFINITION })
    await dag($, { action: 'amend', run_id: runId, definition: DEFINITION })
    await h.clock.settle()
    expect(submissions).toBe(1)
    expect(checkpoint(h, runId).settledNotified === true).toBe(false)
  } finally {
    release?.()
    await h.clock.settle()
  }
  expect(checkpoint(h, runId).settledNotified).toBe(true)
  expect(h.prompts.filter(text => text.includes('settled: completed')).length).toBe(1)
})
