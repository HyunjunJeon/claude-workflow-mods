import { expect, test, type Engine } from 'claude-code/testing'
import { hash } from '../hooks/engine/hash.ts'
import { boot, checkpoint, command, dag, finish, harness, ROOT, start } from './control-harness.ts'

function definition() {
  return {
    key: 'handoff-robustness',
    nodes: [
      { id: 'a', prompt: 'Produce artifact', verify: [{ kind: 'command', argv: ['check-control'] }] },
      { id: 'b', prompt: 'Consume artifact', dependsOn: ['a'], verify: [{ kind: 'command', argv: ['check-control'] }] },
      { id: 'c', prompt: 'Finalize artifact', dependsOn: ['b'], verify: [{ kind: 'command', argv: ['check-control'] }] },
    ],
  }
}

async function offer($: Engine, h: ReturnType<typeof harness>) {
  await boot($)
  await command($, 'note Preserve the artifact scope during handoff')
  h.store.set(`dag-session:${hash('/work')}:target`, {
    schemaVersion: 1, sessionId: 'target', projectRoot: '/work', updatedAt: 1_000,
    status: 'active', runIds: [], writes: [],
  })
  const runId = await start($, definition())
  await command($, `handoff ${runId} target`)
  await finish($, h)
  h.control.sessionId = 'target'
  await boot($)
  return runId
}

test('stale external refresh preserves accepted ownership and the next wave', async ($, on) => {
  const h = harness(on)
  const runId = await offer($, h)
  const old = JSON.stringify(checkpoint(h, runId))
  await h.clock.advance(1)
  await command($, `accept ${runId}`)

  h.readOnce.set(`${ROOT}/runs/${runId}.json`, old)
  await $.session.receive({ origin: { kind: 'peer' }, text: `[dag-handoff] ${runId}` })

  expect(h.readOnce.size).toBe(0)
  expect(await dag($, { action: 'snapshot', run_id: runId })).toMatchObject({ session_id: 'target' })
  await finish($, h, 'agent-2')
  expect(h.spawns).toHaveLength(3)
  expect(checkpoint(h, runId)).toMatchObject({ sessionId: 'target' })
  expect(checkpoint(h, runId).nodes.map(node => node.state)).toEqual(['completed', 'completed', 'running'])
})

test('accepted handoff still schedules when the context write fails', async ($, on) => {
  const h = harness(on)
  const runId = await offer($, h)
  h.writeErrors.set(`${ROOT}/context/target.json`, 'context write unavailable')

  const reply = await command($, `accept ${runId}`)

  expect(reply.text).toContain('Accepted')
  expect(reply.text).toContain('Warning')
  expect(reply.text).toContain('fs.write')
  expect(h.logs.some(text => text.includes('fs.write'))).toBe(true)
  expect(h.spawns).toHaveLength(2)
  expect(checkpoint(h, runId).sessionId).toBe('target')
  expect(checkpoint(h, runId).nodes.map(node => node.state)).toEqual(['completed', 'running', 'pending'])
})

test('handoff reclaims a stale lock but refuses a fresh lock', async ($, on) => {
  const h = harness(on)
  await boot($)
  h.store.set(`dag-session:${hash('/work')}:target`, {
    schemaVersion: 1, sessionId: 'target', projectRoot: '/work', updatedAt: 1_000,
    status: 'active', runIds: [], writes: [],
  })
  const runId = await start($, definition())
  const lock = `${ROOT}/runs/.${runId}.handoff-lock`
  h.locks.add(lock)
  h.lockMtimes.set(lock, 1_000 - 60_001)

  const reclaimed = await command($, `handoff ${runId} target`)

  expect(reclaimed.text).toContain('Handoff requested')
  expect(checkpoint(h, runId).handoff).toMatchObject({ from: 'source', to: 'target' })
  expect(h.locks.has(lock)).toBe(false)
  h.locks.add(lock)
  h.lockMtimes.set(lock, 1_000)
  const refused = await command($, `handoff ${runId} cancel`)
  expect(refused.text).toContain('Another handoff operation owns this run')
  expect(checkpoint(h, runId).handoff).toMatchObject({ to: 'target' })
  expect(h.locks.has(lock)).toBe(true)
})
