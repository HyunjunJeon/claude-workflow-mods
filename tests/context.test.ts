import { expect, test } from 'claude-code/testing'
import { addNote, contextSummary, emptyContext, parseContext, recordRequest, removeNote } from '../hooks/engine/context.ts'
import type { Run } from '../hooks/engine/types.ts'

function run(runId: string, status: Run['status'], sessionId = 'session'): Run {
  return {
    schemaVersion: 1, runId, key: runId, name: runId, sessionId, status,
    createdAt: 1, updatedAt: 2, definitionHash: 'hash',
    definition: {
      key: runId, name: runId, goal: 'objective',
      nodes: [{ id: 'node', prompt: 'work', dependsOn: [], writes: ['src/owned.ts'], verify: [{ kind: 'command', argv: ['check'] }] }],
    },
    nodes: [{
      id: 'node', label: 'Node', state: 'failed', attempt: 2, fingerprint: 'fingerprint',
      output: 'ALL VERIFIED', reportPath: '/reports/node.md',
      verification: { status: 'failed', reportPath: '/reports/check.md', evidence: [{ check: { kind: 'command', argv: ['check'] }, passed: false, checkedAt: 3, exitCode: 1, detail: 'failed' }] },
      recovery: { used: 1, kind: 'implementation', reason: 'fix', history: [{ at: 2, kind: 'implementation', reason: 'fix', attempt: 1 }] },
    }],
  }
}

test('requests retain eight source entries and do not mutate earlier records', () => {
  const original = emptyContext('/project', 'session', 0)
  let record = original
  for (let at = 1; at <= 10; at++) record = recordRequest(record, { at, text: `request-${at}` })
  expect(record.requests.map(entry => entry.at)).toEqual([3, 4, 5, 6, 7, 8, 9, 10])
  expect(record.requests.at(-1)?.text).toBe('request-10')
  expect(record.updatedAt).toBe(10)
  expect(original).toEqual(emptyContext('/project', 'session', 0))
})

test('oversized source requests preserve a bounded prefix and truncation metadata', () => {
  const source = { at: 1, text: 'x'.repeat(30_000) }
  const record = recordRequest(emptyContext('/project', 'session', 0), source)
  expect(record.requests[0]?.text.length).toBe(20_000)
  expect(record.requests[0]?.text.startsWith('x'.repeat(19_000))).toBe(true)
  expect(record.requests[0]?.text.includes('at=1')).toBe(true)
  expect(record.requests[0]?.text.includes('length=30000')).toBe(true)
  expect(source.text.length).toBe(30_000)
  expect(parseContext(record, '/project', 'session')).toEqual(record)
})

test('pinned notes persist until an explicit zero-based removal', () => {
  let record = emptyContext('/project', 'session', 0)
  for (let at = 1; at <= 30; at++) record = addNote(record, { at, text: `note-${at}` })
  const before = structuredClone(record)
  const removed = removeNote(record, 1)
  expect(record).toEqual(before)
  expect(removed.notes.length).toBe(29)
  expect(removed.notes[1]?.text).toBe('note-3')
  expect(removeNote(record, -1)).toEqual(record)
  expect(removeNote(record, 0.5)).toEqual(record)
  expect(record.notes.length).toBe(30)
  const updated = addNote(record, { at: 1, text: 'older timestamp' })
  expect(updated.updatedAt).toBe(30)
})

test('context parsing isolates identities and rejects malformed persisted fields', () => {
  const record = recordRequest(emptyContext('/project', 'session', 0), { at: 1, text: 'source' })
  expect(parseContext(record, '/other', 'session')).toBe(undefined)
  expect(parseContext(record, '/project', 'other')).toBe(undefined)
  for (const value of [
    null, [], { ...record, schemaVersion: 2 }, { ...record, updatedAt: NaN },
    { ...record, updatedAt: Infinity }, { ...record, updatedAt: -1 },
    { ...record, notes: [{}] }, { ...record, notes: [{ at: 1, text: 2 }] },
    { ...record, notes: [{ at: 2, text: 'future' }] },
    { ...record, notes: [{ at: 1, text: ' ' }] },
    { ...record, requests: Array.from({ length: 9 }, () => ({ at: 1, text: 'request' })) },
    { ...record, requests: [{ at: 1, text: 'x'.repeat(20_001) }] },
  ]) expect(parseContext(value, '/project', 'session')).toBe(undefined)
  const parsed = parseContext(record, '/project', 'session')
  expect(parsed).toEqual(record)
  expect(parsed === record).toBe(false)
  expect(parsed?.requests === record.requests).toBe(false)
  expect(parsed?.requests[0] === record.requests[0]).toBe(false)
})

test('restoration projects current owned states and recorded evidence, not self-reports', () => {
  const record = addNote(recordRequest(emptyContext('/project', 'session', 0), { at: 1, text: 'current objective' }), { at: 2, text: 'pinned' })
  const active = run('active', 'running')
  active.handoff = { from: 'session', to: 'next', requestedAt: 2 }
  const runs = [run('finished', 'completed'), run('foreign', 'running', 'other'), active]
  const before = structuredClone({ record, runs })
  const summary = JSON.parse(contextSummary(record, runs, '/context.json'))
  expect(summary.schemaVersion).toBe(1)
  expect(summary.objective.text).toBe(record.requests.at(-1)?.text)
  expect(summary.source.text).toBe('/context.json')
  expect(summary.entries[0].kind).toBe('note')
  const projectedRuns = summary.entries.filter((entry: { kind: string }) => entry.kind === 'run')
  expect(projectedRuns.map((entry: { runId: { text: string } }) => entry.runId.text)).toEqual(['active', 'finished'])
  expect(projectedRuns[0].checkpoint.text).toBe('/project/.claude/dag/runs/active.json')
  expect(projectedRuns[0].handoff.to.text).toBe('next')
  const node = summary.entries.find((entry: { kind: string }) => entry.kind === 'node')
  expect(node.state).toBe('failed')
  expect(node.writes.map((path: { text: string }) => path.text)).toEqual(['src/owned.ts'])
  expect(node.declaredChecks).toBe(1)
  expect(node.verification.status).toBe('failed')
  expect(node.verification.evidence[0].passed).toBe(false)
  expect(node.verification.evidence[0].exitCode).toBe(1)
  expect(node.recovery.used).toBe(1)
  expect(node.output).toBe(undefined)
  expect(node.report.text).toBe('/reports/node.md')
  expect(summary.omitted).toEqual({ notes: 0, runs: 0, nodes: 0, requests: 0 })
  expect({ record, runs }).toEqual(before)
  expect(contextSummary(record, runs, '/context.json')).toBe(contextSummary(record, [...runs].reverse(), '/context.json'))
})

test('restoration remains bounded with escaped text and signals omitted raw sources', () => {
  let record = recordRequest(emptyContext('/project', 'session', 0), { at: 1, text: '\u0000'.repeat(20_000) })
  for (let at = 2; at < 100; at++) record = addNote(record, { at, text: '\u0000'.repeat(20_000) })
  const runs = Array.from({ length: 100 }, (_, i) => run(`run-${i}`, 'running'))
  const result = contextSummary(record, runs, '/context.json')
  const summary = JSON.parse(result)
  expect(result.length <= 8_000).toBe(true)
  expect(summary.objective.truncated).toBe(true)
  expect(summary.objective.sourceLength).toBe(20_000)
  expect(summary.omitted.notes > 0).toBe(true)
  expect(summary.omitted.nodes > 0).toBe(true)
  expect(record.notes.length).toBe(98)
})

test('unverified completed nodes and undeclared write scope remain unknown', () => {
  const current = run('current', 'completed')
  current.nodes = [{ id: 'node', label: 'Node', state: 'completed', attempt: 1, fingerprint: 'hash', output: 'VERIFIED' }]
  current.definition.nodes = [{ id: 'node', prompt: 'work', dependsOn: [] }]
  const summary = JSON.parse(contextSummary(emptyContext('/project', 'session', 0), [current], '/context.json'))
  const node = summary.entries.find((entry: { kind: string }) => entry.kind === 'node')
  expect(node.verification).toBe(null)
  expect(node.writes).toBe(null)
  expect(node.recovery).toBe(null)
  expect(summary.objective).toBe(null)
})
