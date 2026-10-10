import { expect, test } from 'claude-code/testing'
import { parseDefinition } from '../hooks/engine/definition.ts'
import {
  amendRun,
  approveRun,
  createRun,
  isSettled,
  markFinished,
  markRunning,
  nextToStart,
  rejectRun,
  requestApproval,
  snapshotOf,
} from '../hooks/engine/run.ts'
import type { Definition, Run } from '../hooks/engine/types.ts'

function def(input: unknown): Definition {
  const parsed = parseDefinition(input)
  if (!parsed.ok) throw new Error(parsed.error.message)
  return parsed.value
}

const FAN_IN = {
  key: 'fan-in',
  name: 'Fan in',
  nodes: [
    { id: 'a', prompt: 'A' },
    { id: 'b', prompt: 'B' },
    { id: 'c', prompt: 'C', dependsOn: ['a', 'b'] },
  ],
}

function fresh(): Run {
  return createRun(def(FAN_IN), { runId: 'run-1', sessionId: 's-1', now: 1 })
}

function states(run: Run): Record<string, string> {
  return Object.fromEntries(run.nodes.map(n => [n.id, n.state]))
}

test('a run held for approval starts no node, even with free slots', async () => {
  const run = fresh()
  expect(nextToStart(run, 4)).toEqual(['a', 'b'])

  const held = requestApproval(run, 5)

  expect(held.approval).toEqual({ requestedAt: 5 })
  expect(held.updatedAt).toBe(5)
  expect(nextToStart(held, 4)).toEqual([])
})

test('approving a held run lets the roots start again and clears the hold', async () => {
  const held = requestApproval(fresh(), 5)

  const approved = approveRun(held, 8)

  expect('approval' in approved).toBe(false)
  expect(approved.updatedAt).toBe(8)
  expect(nextToStart(approved, 4)).toEqual(['a', 'b'])
})

test('rejecting a held run cancels every unfinished node with the reason and ends the run cancelled', async () => {
  const rejected = rejectRun(requestApproval(fresh(), 5), 'wrong scope', 9)

  expect(states(rejected)).toEqual({ a: 'cancelled', b: 'cancelled', c: 'cancelled' })
  for (const node of rejected.nodes) {
    expect(node.error).toBe('Rejected by the user: wrong scope')
    expect(node.finishedAt).toBe(9)
  }
  expect(rejected.status).toBe('cancelled')
  expect(rejected.cancelReason).toBe('Rejected by the user: wrong scope')
  expect(isSettled(rejected)).toBe(true)
  expect('approval' in rejected).toBe(false)
  expect(nextToStart(rejected, 4)).toEqual([])
})

test('rejecting without a reason says only that the user rejected it', async () => {
  const rejected = rejectRun(requestApproval(fresh(), 5), '', 9)

  expect(rejected.nodes.map(n => n.error)).toEqual(['Rejected by the user.', 'Rejected by the user.', 'Rejected by the user.'])
  expect(rejected.cancelReason).toBe('Rejected by the user.')
  expect(rejected.status).toBe('cancelled')
})

test('rejecting leaves a node that already finished as it was', async () => {
  const started = markRunning(fresh(), 'a', 'agent-a', 2)
  const done = markFinished(started, 'a', { state: 'completed', answer: 'a done' }, 3)

  const rejected = rejectRun(requestApproval(done, 5), 'no', 9)

  expect(states(rejected)).toEqual({ a: 'completed', b: 'cancelled', c: 'cancelled' })
  expect(rejected.nodes[0]?.answer).toBe('a done')
  expect(rejected.nodes[0]?.error).toBeUndefined()
  expect(rejected.status).toBe('cancelled')
})

test('the snapshot reports awaiting_approval only while an approval is pending', async () => {
  const run = fresh()
  const held = requestApproval(run, 5)

  expect(snapshotOf(held).awaiting_approval).toBe(true)
  expect(Object.keys(snapshotOf(run))).not.toContain('awaiting_approval')
  expect(Object.keys(snapshotOf(approveRun(held, 6)))).not.toContain('awaiting_approval')
  expect(Object.keys(snapshotOf(rejectRun(held, 'no', 6)))).not.toContain('awaiting_approval')
})

test('the snapshot keeps every other field when a run is held', async () => {
  const run = fresh()
  const { awaiting_approval, ...rest } = snapshotOf(requestApproval(run, 5))

  expect(awaiting_approval).toBe(true)
  expect(rest).toEqual({ ...snapshotOf(run), updated_at: 5 })
})

test('amending a held run keeps its pending approval', async () => {
  const held = requestApproval(fresh(), 5)
  const edited = def({ ...FAN_IN, nodes: [...FAN_IN.nodes.slice(0, 2), { id: 'c', prompt: 'C changed', dependsOn: ['a', 'b'] }] })

  const amended = amendRun(held, edited, 7)

  if (!amended.ok) throw new Error(amended.error.message)
  expect(amended.value.rerun).toEqual(['c'])
  expect(amended.value.run.approval).toEqual({ requestedAt: 5 })
  expect(nextToStart(amended.value.run, 4)).toEqual([])
})

test('the approval transitions return new runs and leave their input untouched', async () => {
  const run = fresh()
  const held = requestApproval(run, 5)
  const runBefore = JSON.stringify(run)
  const heldBefore = JSON.stringify(held)

  requestApproval(run, 6)
  approveRun(held, 7)
  rejectRun(held, 'no', 8)

  expect(JSON.stringify(run)).toBe(runBefore)
  expect(JSON.stringify(held)).toBe(heldBefore)
})
