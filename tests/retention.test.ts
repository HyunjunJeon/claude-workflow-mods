import { expect, test } from 'claude-code/testing'
import { retentionPlan, type RetentionInput } from '../hooks/engine/retention.ts'
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
    runDirNames: [], contextFiles: [], decisionFiles: [], sessionRecords: [], ...overrides,
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
  const result = plan({ contextFiles: files, decisionFiles: files })
  expect(result.contextFiles).toEqual([])
  expect(result.decisionFiles).toEqual([])
})

test('files referenced by a kept run are kept', () => {
  const fresh = makeRun('dag_new', 'other', now)
  const files = [{ name: 'other.json', mtimeMs: old }]
  const result = plan({ runs: [fresh], contextFiles: files, decisionFiles: files })
  expect(result.contextFiles).toEqual([])
  expect(result.decisionFiles).toEqual([])
})

test('fresh files are kept and old unreferenced files are returned', () => {
  const result = plan({
    contextFiles: [{ name: 'fresh.json', mtimeMs: now - DAY }, { name: 'stale.json', mtimeMs: old }],
    decisionFiles: [{ name: 'fresh.json', mtimeMs: now - DAY }, { name: 'stale.json', mtimeMs: old }],
  })
  expect(result.contextFiles).toEqual(['stale.json'])
  expect(result.decisionFiles).toEqual(['stale.json'])
})

test('an active peer session keeps its files and record', () => {
  const peer = record('peer', { status: 'active', updatedAt: now - 1000 })
  const files = [{ name: 'peer.json', mtimeMs: old }]
  const result = plan({ sessionRecords: [peer], contextFiles: files, decisionFiles: files })
  expect(result.contextFiles).toEqual([])
  expect(result.decisionFiles).toEqual([])
  expect(result.sessionKeys).toEqual([])
})

test('retentionDays 0 keeps everything', () => {
  const run = makeRun('dag_old', 'other', old)
  const files = [{ name: 'stale.json', mtimeMs: old }]
  const result = plan({
    retentionDays: 0, runs: [run], runDirNames: ['dag_old', 'dag_orphan'],
    contextFiles: files, decisionFiles: files, sessionRecords: [record('stale')],
  })
  expect(result).toEqual({ runs: [], runDirs: [], contextFiles: [], decisionFiles: [], sessionKeys: [] })
})

test('unsafe file names are ignored', () => {
  const names = ['../x.json', 'a..b.json', 'a/b.json', 'x.txt', '.json', 'sp ace.json']
  const files = names.map(name => ({ name, mtimeMs: old }))
  const result = plan({ contextFiles: files, decisionFiles: files })
  expect(result.contextFiles).toEqual([])
  expect(result.decisionFiles).toEqual([])
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
