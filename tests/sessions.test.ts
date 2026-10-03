import { expect, test } from 'claude-code/testing'
import { createRun, markFinished, markRunning } from '../hooks/engine/run.ts'
import {
  acceptHandoff, cancelHandoff, offerHandoff, parseSession, projectSessions,
  requestHandoff, sessionConflicts, type SessionRecord,
} from '../hooks/engine/sessions.ts'
import type { Result, Run } from '../hooks/engine/types.ts'

const root = '/project'
const now = 100_000
const owner = { projectRoot: root, sessionId: 'owner', now }
const target = { projectRoot: root, sessionId: 'target', now }

function session(sessionId: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    schemaVersion: 1, sessionId, projectRoot: root, updatedAt: now,
    status: 'active', runIds: ['r'], writes: [], ...overrides,
  }
}

function run(): Run {
  return createRun({
    key: 'k', name: 'Work', nodes: [
      { id: 'a', prompt: 'A', dependsOn: [] },
      { id: 'b', prompt: 'B', dependsOn: ['a'] },
      { id: 'c', prompt: 'C', dependsOn: [] },
    ],
  }, { runId: 'r', sessionId: 'owner', now: 1 })
}

function value(result: Result<Run>): Run {
  if (!result.ok) throw new Error(result.error.code)
  return result.value
}

function states(run: Run) {
  return Object.fromEntries(run.nodes.map(node => [node.id, node.state]))
}

test('parseSession parses records without sharing input arrays', () => {
  const input = session('owner', { writes: ['src'] })
  const parsed = parseSession(input)
  expect(parsed).toEqual(input)
  input.writes.push('other')
  expect(parsed?.writes).toEqual(['src'])
})

test('parseSession rejects malformed boundary data', () => {
  for (const input of [
    null, [], {}, { ...session('s'), schemaVersion: 2 },
    { ...session('s'), sessionId: '' }, { ...session('s'), projectRoot: ' ' },
    { ...session('s'), updatedAt: Infinity }, { ...session('s'), status: 'stale' },
    { ...session('s'), runIds: [1] }, { ...session('s'), writes: [''] },
  ]) expect(parseSession(input)).toBe(undefined)
})

test('projectSessions filters projects and derives inclusive freshness deterministically', () => {
  const records = [
    session('z', { updatedAt: now - 60_001 }),
    session('b', { updatedAt: now - 60_000 }),
    session('a', { status: 'closed' }),
    session('future', { updatedAt: now + 1 }),
    session('other', { projectRoot: '/other' }),
  ]
  const projected = projectSessions(records, root, now)
  expect(projected.map(record => [record.sessionId, record.liveness])).toEqual([
    ['a', 'closed'], ['b', 'active'], ['future', 'stale'], ['z', 'stale'],
  ])
  expect(projectSessions([...records].reverse(), root, now)).toEqual(projected)
  expect(records[0]?.status).toBe('active')
})

test('sessionConflicts reports exact and ancestor scopes but not prefix siblings', () => {
  const records = [
    session('b', { writes: ['src/file.ts', 'same', 'foobar'] }),
    session('a', { writes: ['src/', 'same', 'foo'] }),
  ]
  expect(sessionConflicts(records, root, now)).toEqual([
    { sessionIds: ['a', 'b'], writes: ['same', 'same'] },
    { sessionIds: ['a', 'b'], writes: ['src/', 'src/file.ts'] },
  ])
  expect(sessionConflicts([...records].reverse(), root, now)).toEqual(sessionConflicts(records, root, now))
})

test('sessionConflicts ignores unknown scopes and inactive or foreign sessions', () => {
  const records = [
    session('a', { writes: ['src'] }),
    session('empty'), session('glob', { writes: ['src/*'] }),
    session('old', { writes: ['src/a'], updatedAt: now - 60_001 }),
    session('closed', { writes: ['src/a'], status: 'closed' }),
    session('foreign', { writes: ['src/a'], projectRoot: '/other' }),
    session('a', { writes: ['src/a'] }),
  ]
  expect(sessionConflicts(records, root, now)).toEqual([])
})

test('requestHandoff rejects wrong owner, project, target and stale sessions', () => {
  const input = run()
  for (const [record, context] of [
    [session('target'), target],
    [session('target', { projectRoot: '/other' }), owner],
    [session('target', { updatedAt: now - 60_001 }), owner],
    [session('target', { status: 'closed' }), owner],
    [session('owner'), owner],
  ] satisfies [SessionRecord, typeof owner][]) {
    expect(requestHandoff(input, record, context).ok).toBe(false)
  }
  expect(input.handoff).toBe(undefined)
})

test('requestHandoff pauses unstarted work while running work drains', () => {
  const input = markRunning(run(), 'a', 'agent-a', 2)
  const requested = value(requestHandoff(input, session('target'), owner))
  expect(states(requested)).toEqual({ a: 'running', b: 'paused', c: 'paused' })
  expect(requested.status).toBe('running')
  expect(requested.nodes.find(node => node.id === 'a')).toEqual(input.nodes.find(node => node.id === 'a'))
  expect(requested.handoff).toEqual({ from: 'owner', to: 'target', requestedAt: now })
  expect(acceptHandoff(requested, target, session('owner')).ok).toBe(false)
  expect(requestHandoff(requested, session('another'), owner).ok).toBe(false)
  expect(states(input)).toEqual({ a: 'running', b: 'pending', c: 'scheduled' })
})

test('offerHandoff becomes ready only after running work finishes', () => {
  const requested = value(requestHandoff(markRunning(run(), 'a', 'agent-a', 2), session('target'), owner))
  const drained = markFinished(requested, 'a', { state: 'completed', answer: 'done' }, now + 1)
  const offered = offerHandoff(drained, now + 2)
  expect(offered.handoff?.offeredAt).toBe(now + 2)
  expect(offerHandoff(offered, now + 3).handoff?.offeredAt).toBe(now + 2)
  expect(states(offered)).toEqual({ a: 'completed', b: 'paused', c: 'paused' })
})

test('acceptHandoff requires addressed target and matching same-project source', () => {
  const offered = value(requestHandoff(run(), session('target'), owner))
  for (const source of [
    undefined, session('wrong'), session('owner', { projectRoot: '/other' }),
  ]) expect(acceptHandoff(offered, target, source).ok).toBe(false)
  expect(acceptHandoff(offered, owner, session('owner')).ok).toBe(false)
  expect(acceptHandoff(run(), target, session('owner')).ok).toBe(false)
  expect(acceptHandoff(offered, target, session('owner', { status: 'closed' })).ok).toBe(true)
})

test('acceptHandoff changes ownership and resumes only unfinished work', () => {
  const completed = markFinished(markRunning(run(), 'a', 'agent-a', 2), 'a', { state: 'completed', answer: 'done' }, 3)
  const offered = value(requestHandoff(completed, session('target'), owner))
  const accepted = value(acceptHandoff(offered, target, session('owner')))
  expect(accepted.sessionId).toBe('target')
  expect(accepted.handoff).toBe(undefined)
  expect(states(accepted)).toEqual({ a: 'completed', b: 'scheduled', c: 'scheduled' })
  expect(accepted.nodes.find(node => node.id === 'a')).toEqual(completed.nodes.find(node => node.id === 'a'))
  expect(offered.sessionId).toBe('owner')
})

test('cancelHandoff is owner-only and restores scheduling during drain', () => {
  const input = markRunning(run(), 'a', 'agent-a', 2)
  const requested = value(requestHandoff(input, session('target'), owner))
  expect(cancelHandoff(requested, 'target', now).ok).toBe(false)
  const cancelled = value(cancelHandoff(requested, 'owner', now + 1))
  expect(cancelled.handoff).toBe(undefined)
  expect(cancelled.sessionId).toBe('owner')
  expect(states(cancelled)).toEqual(states(input))
  expect(cancelHandoff(cancelled, 'owner', now + 2).ok).toBe(false)
})

test('handoffs preserve completed failed and cancelled terminal runs', () => {
  for (const status of ['completed', 'failed', 'cancelled'] satisfies Run['status'][]) {
    const input: Run = {
      ...run(), status,
      nodes: run().nodes.map(node => ({ ...node, state: status, answer: 'saved', output: 'saved' })),
      ...(status === 'cancelled' ? { cancelReason: 'stopped' } : {}),
    }
    const offered = value(requestHandoff(input, session('target'), owner))
    const accepted = value(acceptHandoff(offered, target, session('owner')))
    const cancelled = value(cancelHandoff(offered, 'owner', now))
    expect(accepted.status).toBe(status)
    expect(accepted.nodes).toEqual(input.nodes)
    expect(cancelled.status).toBe(status)
    expect(cancelled.nodes).toEqual(input.nodes)
  }
})

test('handoff does not resurrect failed dependencies or unrelated paused work', () => {
  const failed = markFinished(markRunning(run(), 'a', 'agent-a', 2), 'a', { state: 'failed' }, 3)
  const offered = value(requestHandoff(failed, session('target'), owner))
  expect(states(value(acceptHandoff(offered, target, session('owner'))))).toEqual({
    a: 'failed', b: 'skipped', c: 'scheduled',
  })
  const paused: Run = { ...run(), nodes: run().nodes.map(node => ({ ...node, state: 'paused' })) }
  expect(requestHandoff(paused, session('target'), owner).ok).toBe(false)
  expect(offerHandoff(paused, now)).toEqual(paused)
})
