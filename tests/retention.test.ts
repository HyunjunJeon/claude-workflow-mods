import { expect, test } from 'claude-code/testing'
import { retentionPlan, trajectoryPlan, type RetentionInput, type TrajectoryRetentionInput } from '../hooks/engine/retention.ts'
import { createRun } from '../hooks/engine/run.ts'
import type { SessionRecord } from '../hooks/engine/sessions.ts'
import type { Run } from '../hooks/engine/types.ts'

const DAY = 86_400_000
const now = 100 * DAY
const old = now - 40 * DAY

function makeRun(id: string, sessionId: string, updatedAt: number): Run {
  const run = createRun({ key: id, name: id, nodes: [{ id: 'a', prompt: 'A', dependsOn: [] }] }, { runId: id, sessionId, now: updatedAt })
  return { ...run, status: 'paused', updatedAt }
}

function record(sessionId: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return { schemaVersion: 1, sessionId, projectRoot: '/project', updatedAt: old, status: 'closed', runIds: [], writes: [], ...overrides }
}

function plan(overrides: Partial<RetentionInput> = {}) {
  return retentionPlan({
    runs: [], now, retentionDays: 30, currentSession: 'cur',
    runDirNames: [], contextFiles: [], decisionFiles: [], boardFiles: [], sessionRecords: [], ...overrides,
  })
}

test('expired run returns its json run and directory', () => {
  const run = makeRun('dag_old', 'other', old)
  const result = plan({ runs: [run], runDirNames: ['dag_old'] })
  expect(result.runs.map(r => r.runId)).toEqual(['dag_old'])
  expect(result.runDirs).toEqual(['dag_old'])
})

test('current session files are kept', () => {
  const files = [{ name: 'cur.json', mtimeMs: old }]
  const result = plan({ contextFiles: files, decisionFiles: files, boardFiles: files })
  expect(result.contextFiles).toEqual([])
  expect(result.decisionFiles).toEqual([])
  expect(result.boardFiles).toEqual([])
})

test('files referenced by a kept run are kept', () => {
  const fresh = makeRun('dag_new', 'other', now)
  const files = [{ name: 'other.json', mtimeMs: old }]
  const result = plan({ runs: [fresh], contextFiles: files, decisionFiles: files, boardFiles: files })
  expect(result.contextFiles).toEqual([])
  expect(result.decisionFiles).toEqual([])
  expect(result.boardFiles).toEqual([])
})

test('fresh files are kept and old unreferenced files are returned', () => {
  const result = plan({
    contextFiles: [{ name: 'fresh.json', mtimeMs: now - DAY }, { name: 'stale.json', mtimeMs: old }],
    decisionFiles: [{ name: 'fresh.json', mtimeMs: now - DAY }, { name: 'stale.json', mtimeMs: old }],
    boardFiles: [{ name: 'fresh.json', mtimeMs: now - DAY }, { name: 'stale.json', mtimeMs: old }],
  })
  expect(result.contextFiles).toEqual(['stale.json'])
  expect(result.decisionFiles).toEqual(['stale.json'])
  expect(result.boardFiles).toEqual(['stale.json'])
})

test('an active peer session keeps its files and record', () => {
  const peer = record('peer', { status: 'active', updatedAt: now - 1000 })
  const files = [{ name: 'peer.json', mtimeMs: old }]
  const result = plan({ sessionRecords: [peer], contextFiles: files, decisionFiles: files, boardFiles: files })
  expect(result.contextFiles).toEqual([])
  expect(result.decisionFiles).toEqual([])
  expect(result.boardFiles).toEqual([])
  expect(result.sessionKeys).toEqual([])
})

test('retentionDays 0 keeps everything', () => {
  const run = makeRun('dag_old', 'other', old)
  const files = [{ name: 'stale.json', mtimeMs: old }]
  const result = plan({
    retentionDays: 0, runs: [run], runDirNames: ['dag_old', 'dag_orphan'],
    contextFiles: files, decisionFiles: files, boardFiles: files, sessionRecords: [record('stale')],
  })
  expect(result).toEqual({ runs: [], runDirs: [], contextFiles: [], decisionFiles: [], boardFiles: [], sessionKeys: [] })
})

test('unsafe file names are ignored', () => {
  const names = ['../x.json', 'a..b.json', 'a/b.json', 'x.txt', '.json', 'sp ace.json']
  const files = names.map(name => ({ name, mtimeMs: old }))
  const result = plan({ contextFiles: files, decisionFiles: files, boardFiles: files })
  expect(result.contextFiles).toEqual([])
  expect(result.decisionFiles).toEqual([])
  expect(result.boardFiles).toEqual([])
})

test('orphan run directories are returned unless a kept run owns them', () => {
  const fresh = makeRun('dag_kept', 'other', now)
  const result = plan({ runs: [fresh], runDirNames: ['dag_orphan', 'dag_kept', 'notes', 'dag_bad.name'] })
  expect(result.runDirs).toEqual(['dag_orphan'])
})

test('closed old session keys are returned but never the current session', () => {
  const result = plan({
    sessionRecords: [record('gone'), record('cur'), record('recent', { updatedAt: now - DAY })],
  })
  expect(result.sessionKeys).toEqual(['gone'])
})

test('an old board file of a closed session is picked while current, live, kept-run and recent ones stay', () => {
  const peer = record('peer', { status: 'active', updatedAt: now - 1000 })
  const owner = makeRun('dag_new', 'owner', now)
  const result = plan({
    runs: [owner],
    sessionRecords: [record('gone'), peer],
    boardFiles: [
      { name: 'gone.json', mtimeMs: old },
      { name: 'cur.json', mtimeMs: old },
      { name: 'peer.json', mtimeMs: old },
      { name: 'owner.json', mtimeMs: old },
      { name: 'recent.json', mtimeMs: now - DAY },
    ],
  })
  expect(result.boardFiles).toEqual(['gone.json'])
})

// trajectoryPlan: what the trajectory log keeps under trajectory_retention_days and trajectory_max_mb.
const MB = 1024 * 1024
const NOW = 200 * DAY

function traj(name: string, ageDays: number, mb = 1) {
  return { name, mtimeMs: NOW - ageDays * DAY, bytes: mb * MB }
}

function trajPlan(entries: ReturnType<typeof traj>[], overrides: Partial<TrajectoryRetentionInput> = {}) {
  return trajectoryPlan({
    entries, now: NOW, retentionDays: 90, maxMb: 0, currentSession: 'cur', unsettledRunIds: new Set(), ...overrides,
  })
}

test('a trajectory whose newest file is older than the day limit goes and one at the limit stays', () => {
  expect(trajPlan([traj('dag_old', 100), traj('dag_edge', 90), traj('dag_new', 10)])).toEqual(['dag_old'])
})

test('over the size cap the settled entry with the oldest newest file goes first, until the rest fits', () => {
  const entries = [traj('dag_c', 10, 4), traj('dag_a', 30, 4), traj('dag_b', 20, 4)]
  expect(trajPlan(entries, { maxMb: 10 })).toEqual(['dag_a'])
  expect(trajPlan(entries, { maxMb: 5 })).toEqual(['dag_a', 'dag_b'])
  expect(trajPlan(entries, { maxMb: 12 })).toEqual([])
})

test('the age limit runs first, and what it frees counts toward the cap', () => {
  const entries = [traj('dag_old', 100, 8), traj('dag_a', 30, 6), traj('dag_b', 20, 6), traj('dag_c', 10, 6)]
  expect(trajPlan(entries, { maxMb: 15 })).toEqual(['dag_old', 'dag_a'])
  expect(trajPlan(entries, { maxMb: 26 })).toEqual(['dag_old'])
})

test('entries with the same newest file go in name order under the cap', () => {
  const entries = [traj('dag_b', 5, 4), traj('dag_a', 5, 4), traj('dag_c', 5, 4)]
  expect(trajPlan(entries, { maxMb: 8 })).toEqual(['dag_a'])
})

test('the current session\'s entry is never returned, however old or large', () => {
  const entries = [traj('session-cur', 400, 50), traj('session-other', 400, 1), traj('dag_old', 400, 1)]
  expect(trajPlan(entries, { maxMb: 1 })).toEqual(['dag_old', 'session-other'])
})

test('an unsettled run\'s entry is never returned, however old or large', () => {
  const entries = [traj('dag_busy', 400, 50), traj('dag_done', 400, 1)]
  expect(trajPlan(entries, { maxMb: 1, unsettledRunIds: new Set(['dag_busy']) })).toEqual(['dag_done'])
  expect(trajPlan(entries, { maxMb: 1 })).toEqual(['dag_busy', 'dag_done'])
})

test('protected entries count toward the cap, so when they alone exceed it every other entry goes', () => {
  const entries = [traj('dag_busy', 5, 20), traj('dag_a', 2, 1), traj('dag_b', 1, 1)]
  expect(trajPlan(entries, { maxMb: 10, unsettledRunIds: new Set(['dag_busy']) })).toEqual(['dag_a', 'dag_b'])
})

test('0 days leaves the age limit off and 0 MB leaves the cap off, each on its own', () => {
  const entries = [traj('dag_old', 400, 8), traj('dag_new', 1, 8)]
  expect(trajPlan(entries, { retentionDays: 0, maxMb: 0 })).toEqual([])
  expect(trajPlan(entries, { retentionDays: 0, maxMb: 10 })).toEqual(['dag_old'])
  expect(trajPlan(entries, { retentionDays: 90, maxMb: 0 })).toEqual(['dag_old'])
})

test('a name the safe-name check rejects is never returned', () => {
  const names = ['', '.', '..', 'a/b', '../dag_x', 'dag_', 'dag_a.b', 'dag_a b', 'notes', 'session-', 'session-a/b', 'session-..', 'session-a.b']
  expect(trajPlan(names.map(name => traj(name, 400, 50)), { maxMb: 1 })).toEqual([])
})
