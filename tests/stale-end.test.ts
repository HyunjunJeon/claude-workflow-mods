import { expect, test } from 'claude-code/testing'
import { boot, checkpoint, dag, finish, harness, start } from './control-harness.ts'

// No existing test ends a superseded agent after its node was retried (tests/headless-ask.test.ts retries only after
// the first agent ended); the second case here, agent A ending after attempt 2 completed, is covered by nothing else either.
const DEFINITION = { key: 'stale-end', nodes: [{ id: 'a', prompt: 'Produce artifact', verify: [{ kind: 'command', argv: ['check-control'] }] }] }
const NO_RECOVERY = { options: { auto_recovery: false } }

test('a retried node is settled by its own attempt agent, not by the earlier attempt agent ending late', NO_RECOVERY, async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = await start($, DEFINITION)
  const agentA = checkpoint(h, runId).nodes[0]?.agentId
  await dag($, { action: 'cancel', run_id: runId })
  // The cancelled attempt is still running until its agent ends; ending it is what settles it, so a retry needs that end.
  await finish($, h, agentA, true)
  expect(checkpoint(h, runId).nodes[0]).toMatchObject({ state: 'cancelled', attempt: 1 })
  await dag($, { action: 'retry', run_id: runId, node_id: 'a' })
  const agentB = checkpoint(h, runId).nodes[0]?.agentId
  expect(checkpoint(h, runId).nodes[0]).toMatchObject({ state: 'running', attempt: 2 })
  expect(agentB).not.toBe(agentA)

  await finish($, h, agentA)
  expect(checkpoint(h, runId).nodes[0]).toMatchObject({ state: 'running', attempt: 2, agentId: agentB })

  await finish($, h, agentB)
  expect(checkpoint(h, runId).nodes[0]).toMatchObject({ state: 'completed', attempt: 2 })
})

test('an earlier attempt agent ending after attempt 2 completed does not change the result', NO_RECOVERY, async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = await start($, DEFINITION)
  const agentA = checkpoint(h, runId).nodes[0]?.agentId
  await dag($, { action: 'cancel', run_id: runId })
  await finish($, h, agentA, true)
  await dag($, { action: 'retry', run_id: runId, node_id: 'a' })
  const agentB = checkpoint(h, runId).nodes[0]?.agentId
  await finish($, h, agentB)
  const settled = checkpoint(h, runId)
  expect(settled.nodes[0]).toMatchObject({ state: 'completed', attempt: 2 })

  await finish($, h, agentA, true)
  expect(checkpoint(h, runId)).toEqual(settled)
})
