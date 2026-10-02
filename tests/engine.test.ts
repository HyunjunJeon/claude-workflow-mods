import { expect, test } from 'claude-code/testing'
import { parseDefinition } from '../hooks/engine/definition.ts'
import { layers } from '../hooks/engine/graph.ts'
import { buildNodePrompt, parseOutcome, spawnTarget } from '../hooks/engine/node-prompt.ts'
import {
  amendRun,
  cancelRun,
  createRun,
  findReusable,
  markFinished,
  markRunning,
  nextToStart,
  pauseRunning,
  resumePaused,
  retryRun,
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

const CHAIN = {
  key: 'chain',
  nodes: [
    { id: 'a', prompt: 'A' },
    { id: 'b', prompt: 'B', dependsOn: ['a'] },
    { id: 'c', prompt: 'C', dependsOn: ['b'] },
    { id: 'd', prompt: 'D' },
  ],
}

function states(run: Run): Record<string, string> {
  return Object.fromEntries(run.nodes.map(n => [n.id, n.state]))
}

function finish(run: Run, id: string, state: 'completed' | 'failed' | 'cancelled', now = 10): Run {
  return markFinished(run, id, { state, answer: id + ' done', ...(state === 'completed' ? {} : { error: id + ' broke' }) }, now)
}

function start(run: Run, id: string, now = 5): Run {
  return markRunning(run, id, 'agent-' + id, now)
}

test('parseDefinition rejects malformed graphs with a specific code', async () => {
  const code = (input: unknown) => {
    const r = parseDefinition(input)
    return r.ok ? 'ok' : r.error.code
  }
  expect(code({ nodes: [{ id: 'a', prompt: 'x' }] })).toBe('invalid_definition')
  expect(code({ key: 'k', nodes: [] })).toBe('invalid_definition')
  expect(code({ key: 'k', nodes: [{ id: 'a', prompt: ' ' }] })).toBe('invalid_node')
  expect(code({ key: 'k', nodes: [{ id: 'a b', prompt: 'x' }] })).toBe('invalid_node')
  expect(code({ key: 'k', nodes: [{ id: 'a', prompt: 'x' }, { id: 'a', prompt: 'y' }] })).toBe('duplicate_node')
  expect(code({ key: 'k', nodes: [{ id: 'a', prompt: 'x', dependsOn: ['a'] }] })).toBe('invalid_dependency')
  expect(code({ key: 'k', nodes: [{ id: 'a', prompt: 'x', dependsOn: ['zz'] }] })).toBe('unknown_dependency')
  expect(code(FAN_IN)).toBe('ok')
})

test('parseDefinition names the nodes of a dependency cycle', async () => {
  const r = parseDefinition({
    key: 'k',
    nodes: [
      { id: 'a', prompt: 'x', dependsOn: ['c'] },
      { id: 'b', prompt: 'x', dependsOn: ['a'] },
      { id: 'c', prompt: 'x', dependsOn: ['b'] },
    ],
  })
  expect(r.ok).toBe(false)
  if (!r.ok) {
    expect(r.error.code).toBe('cycle')
    expect(r.error.message).toContain('a')
    expect(r.error.message).toContain('->')
  }
})

test('a new run schedules only the roots', async () => {
  const run = createRun(def(FAN_IN), { runId: 'r1', sessionId: 's1', now: 1 })
  expect(states(run)).toEqual({ a: 'scheduled', b: 'scheduled', c: 'pending' })
  expect(run.status).toBe('running')
  expect(nextToStart(run, 8)).toEqual(['a', 'b'])
  expect(nextToStart(run, 1)).toEqual(['a'])
})

test('a fan-in node waits for every dependency, then the run completes', async () => {
  let run = createRun(def(FAN_IN), { runId: 'r1', sessionId: 's1', now: 1 })
  run = start(start(run, 'a'), 'b')
  expect(nextToStart(run, 8)).toEqual([])
  run = finish(run, 'a', 'completed')
  expect(states(run).c).toBe('pending')
  run = finish(run, 'b', 'completed')
  expect(states(run).c).toBe('scheduled')
  run = finish(start(run, 'c'), 'c', 'completed')
  expect(run.status).toBe('completed')
  expect(run.nodes.find(n => n.id === 'c')?.attempt).toBe(1)
})

test('a failed node skips its dependents while independent nodes keep running', async () => {
  let run = createRun(def(CHAIN), { runId: 'r2', sessionId: 's1', now: 1 })
  run = start(start(run, 'a'), 'd')
  run = finish(run, 'a', 'failed')
  expect(states(run)).toEqual({ a: 'failed', b: 'skipped', c: 'skipped', d: 'running' })
  expect(run.status).toBe('running')
  run = finish(run, 'd', 'completed')
  expect(run.status).toBe('failed')
  expect(run.nodes.find(n => n.id === 'b')?.error).toContain('"a"')
})

test('retry refuses an active run, then re-runs failed nodes and their skipped dependents', async () => {
  let run = createRun(def(CHAIN), { runId: 'r3', sessionId: 's1', now: 1 })
  run = start(start(run, 'a'), 'd')
  run = finish(run, 'a', 'failed')
  const early = retryRun(run, {}, 11)
  expect(early.ok ? 'ok' : early.error.code).toBe('run_still_active')

  run = finish(run, 'd', 'completed')
  const retried = retryRun(run, {}, 12)
  expect(retried.ok).toBe(true)
  if (!retried.ok) return
  expect(states(retried.value)).toEqual({ a: 'scheduled', b: 'pending', c: 'pending', d: 'completed' })
  expect(retried.value.status).toBe('running')
})

test('retry validates explicit node ids and prompt overrides', async () => {
  let run = createRun(def(CHAIN), { runId: 'r4', sessionId: 's1', now: 1 })
  run = finish(start(run, 'd'), 'd', 'completed')
  run = finish(start(run, 'a'), 'a', 'failed')
  const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? 'ok' : r.error?.code)
  expect(code(retryRun(run, { nodeIds: ['d'] }, 20))).toBe('node_not_retryable')
  expect(code(retryRun(run, { nodeIds: ['b'] }, 20))).toBe('node_not_retryable')
  expect(code(retryRun(run, { nodeIds: ['nope'] }, 20))).toBe('unknown_node')
  expect(code(retryRun(run, { nodeIds: ['a', 'b'], prompt: 'x' }, 20))).toBe('invalid_request')

  const withPrompt = retryRun(run, { nodeIds: ['a'], prompt: 'Try A differently' }, 20)
  expect(withPrompt.ok).toBe(true)
  if (!withPrompt.ok) return
  const a = withPrompt.value.nodes.find(n => n.id === 'a')
  expect(a?.state).toBe('scheduled')
  expect(a?.promptOverride).toBe('Try A differently')
  const prompt = buildNodePrompt(withPrompt.value, withPrompt.value.definition.nodes[0]!, a!)
  expect(prompt).toContain('Try A differently')
  expect(prompt).toContain('attempt 2')
})

test('amend re-runs only changed nodes and their dependents', async () => {
  let run = createRun(def(CHAIN), { runId: 'r5', sessionId: 's1', now: 1 })
  for (const id of ['a', 'd', 'b', 'c']) run = finish(start(run, id), id, 'completed')
  expect(run.status).toBe('completed')

  const edited = def({ ...CHAIN, nodes: CHAIN.nodes.map(n => (n.id === 'b' ? { ...n, prompt: 'B v2' } : n)) })
  const amended = amendRun(run, edited, 30)
  expect(amended.ok).toBe(true)
  if (!amended.ok) return
  expect(amended.value.rerun.sort()).toEqual(['b', 'c'])
  expect(states(amended.value.run)).toEqual({ a: 'completed', b: 'scheduled', c: 'pending', d: 'completed' })

  const skillsOnly = def({ ...CHAIN, nodes: CHAIN.nodes.map(n => (n.id === 'a' ? { ...n, load_skills: ['x'] } : n)) })
  const noRerun = amendRun(run, skillsOnly, 31)
  expect(noRerun.ok && noRerun.value.rerun.length).toBe(0)

  const added = def({ ...CHAIN, nodes: [...CHAIN.nodes, { id: 'e', prompt: 'E', dependsOn: ['c'] }] })
  const withNew = amendRun(run, added, 32)
  expect(withNew.ok && states(withNew.value.run).e).toBe('scheduled')
})

test('amend refuses to change a running node and a different key', async () => {
  const run = start(createRun(def(CHAIN), { runId: 'r6', sessionId: 's1', now: 1 }), 'a')
  const edited = def({ ...CHAIN, nodes: CHAIN.nodes.map(n => (n.id === 'a' ? { ...n, prompt: 'A v2' } : n)) })
  const r = amendRun(run, edited, 2)
  expect(r.ok ? 'ok' : r.error.code).toBe('amend_running_node')
  const other = amendRun(run, def({ ...CHAIN, key: 'other' }), 2)
  expect(other.ok ? 'ok' : other.error.code).toBe('key_mismatch')
})

test('the same key reuses its run, a changed definition conflicts', async () => {
  const run = createRun(def(FAN_IN), { runId: 'r7', sessionId: 's1', now: 1 })
  const same = findReusable([run], def(FAN_IN))
  expect(same.ok && same.value?.runId).toBe('r7')
  const changed = findReusable([run], def({ ...FAN_IN, nodes: [...FAN_IN.nodes, { id: 'd', prompt: 'D' }] }))
  expect(changed.ok ? 'ok' : changed.error.code).toBe('definition_conflict')
  const fresh = findReusable([run], def({ ...FAN_IN, key: 'new' }))
  expect(fresh.ok && fresh.value).toBe(undefined)
})

test('cancel stops running agents and cancels everything that has not started', async () => {
  let run = start(createRun(def(FAN_IN), { runId: 'r8', sessionId: 's1', now: 1 }), 'a')
  const cancelled = cancelRun(run, 'superseded', 3)
  expect(cancelled.stopAgents).toEqual(['agent-a'])
  expect(states(cancelled.run)).toEqual({ a: 'running', b: 'cancelled', c: 'cancelled' })
  expect(cancelled.run.status).toBe('running')
  run = finish(cancelled.run, 'a', 'cancelled')
  expect(run.status).toBe('cancelled')
})

test('pausing and resuming hand nodes back to the scheduler', async () => {
  let run = start(createRun(def(FAN_IN), { runId: 'r9', sessionId: 's1', now: 1 }), 'a')
  run = pauseRunning(run, 2)
  expect(states(run)).toEqual({ a: 'paused', b: 'paused', c: 'pending' })
  expect(run.status).toBe('paused')
  run = resumePaused(run, 's2', 3)
  expect(states(run)).toEqual({ a: 'scheduled', b: 'scheduled', c: 'pending' })
  expect(run.sessionId).toBe('s2')
  expect(run.nodes.find(n => n.id === 'a')?.agentId).toBe(undefined)
})

test('node outcomes come from the turn end reason and the status line', async () => {
  expect(parseOutcome({ reason: 'aborted', isAborted: true, answer: '' }).state).toBe('cancelled')
  expect(parseOutcome({ reason: 'error', isAborted: false, answer: 'x' }).state).toBe('failed')
  const failed = parseOutcome({ reason: 'answer', isAborted: false, answer: 'tried\nDAG_NODE_STATUS: failed: tests do not compile' })
  expect(failed).toMatchObject({ state: 'failed', error: 'tests do not compile' })
  expect(parseOutcome({ reason: 'answer', isAborted: false, answer: 'all good\nDAG_NODE_STATUS: completed' }).state).toBe('completed')
  expect(parseOutcome({ reason: 'answer', isAborted: false, answer: 'no status line' }).state).toBe('completed')
})

test('categories route to models and an explicit agent type', async () => {
  expect(spawnTarget({ id: 'x', prompt: 'p', dependsOn: [], category: 'quick' })).toEqual({ subagentType: 'general-purpose', model: 'haiku' })
  expect(spawnTarget({ id: 'x', prompt: 'p', dependsOn: [], agent: 'Explore' })).toEqual({ subagentType: 'Explore' })
  expect(spawnTarget({ id: 'x', prompt: 'p', dependsOn: [], category: 'unknown' })).toEqual({ subagentType: 'general-purpose' })
})

test('snapshots use the omo projection shape and layers follow dependencies', async () => {
  const run = start(createRun(def(FAN_IN), { runId: 'r10', sessionId: 's1', now: 1 }), 'a')
  const snap = snapshotOf(run)
  expect(snap).toMatchObject({ run_id: 'r10', run_key: 'fan-in', name: 'Fan in', status: 'running' })
  expect(snap.edges).toEqual([{ from: 'a', to: 'c' }, { from: 'b', to: 'c' }])
  expect(snap.nodes[0]).toMatchObject({ id: 'a', state: 'running', task_id: 'agent-a', attempt: 1 })
  expect(layers(snap.nodes.map(n => n.id), snap.edges)).toEqual([['a', 'b'], ['c']])
})
