import { expect, test } from 'claude-code/testing'
import { appendDecisions, DECISION_LIMIT, parseDecisionLog, type DecisionRecord } from '../hooks/engine/decisions.ts'

const record: DecisionRecord = {
  id: 'd', at: 1, sessionId: 's', kind: 'routing', subject: 'node',
  proposed: 'trivial', selected: 'architect', source: 'jev', outcome: 'applied',
  ruleset: 'v1', threshold: 0.9, latencyMs: 12, stateHash: 'hash', confidence: 0.95,
}

test('decision history is bounded, ordered and isolated by project and session', () => {
  const initial = Array.from({ length: DECISION_LIMIT }, (_, i) => ({ ...record, id: `d${i}` }))
  const added = appendDecisions(initial, [{ ...record, id: 'last' }])
  expect(initial[0]?.id).toBe('d0')
  expect(added).toHaveLength(DECISION_LIMIT)
  expect(added[0]?.id).toBe('d1')
  expect(added.at(-1)?.id).toBe('last')
  const log = { schemaVersion: 1, projectRoot: '/p', sessionId: 's', records: [record] }
  expect(parseDecisionLog(log, '/p', 's')).toEqual([record])
  expect(parseDecisionLog(log, '/other', 's')).toEqual([])
  expect(parseDecisionLog(log, '/p', 'other')).toEqual([])
  expect(parseDecisionLog({ ...log, records: [{ ...record, confidence: 2 }] }, '/p', 's')).toEqual([])
})

test('a decision the final-audit rule made survives a reload', () => {
  const ruled: DecisionRecord = { ...record, proposed: 'trivial', selected: 'standard', source: 'rule', outcome: 'low-confidence', confidence: 0.6 }
  expect(parseDecisionLog({ schemaVersion: 1, projectRoot: '/p', sessionId: 's', records: [ruled] }, '/p', 's')).toEqual([ruled])
})

test('a permission note survives a reload and a note that is not text drops the record', () => {
  const noted: DecisionRecord = { ...record, kind: 'permission', subject: 'Write', proposed: 'ask', selected: 'ask', source: 'baseline', outcome: 'low-confidence', runId: 'dag_1', nodeId: 'a', note: 'Write needs approval' }
  const log = (records: unknown[]) => ({ schemaVersion: 1, projectRoot: '/p', sessionId: 's', records })
  expect(parseDecisionLog(log([noted]), '/p', 's')).toEqual([noted])
  expect(parseDecisionLog(log([{ ...noted, note: 7 }]), '/p', 's')).toEqual([])
})

test('a mode decision survives a reload', () => {
  const mode: DecisionRecord = { ...record, kind: 'mode', subject: 'request', proposed: 'dag', selected: 'direct', source: 'jev', outcome: 'applied', confidence: 0.86, probabilities: { direct: 0.86, dag: 0.14 } }
  const log = (records: unknown[]) => ({ schemaVersion: 1, projectRoot: '/p', sessionId: 's', records })
  expect(parseDecisionLog(log([mode]), '/p', 's')).toEqual([mode])
  expect(parseDecisionLog(log([{ ...mode, kind: 'unknown' }]), '/p', 's')).toEqual([])
})

test('a surface decision survives a reload and an unknown kind is still refused', () => {
  const surface: DecisionRecord = { ...record, kind: 'surface', subject: 'request', proposed: 'chat', selected: 'board', source: 'jev', outcome: 'applied', confidence: 0.91, probabilities: { chat: 0.09, board: 0.91 } }
  const log = (records: unknown[]) => ({ schemaVersion: 1, projectRoot: '/p', sessionId: 's', records })
  expect(parseDecisionLog(log([surface]), '/p', 's')).toEqual([surface])
  expect(parseDecisionLog(log([{ ...surface, kind: 'canvas' }]), '/p', 's')).toEqual([])
})

test('a question decision survives a reload and an unknown kind drops the record', () => {
  const asked: DecisionRecord = { ...record, kind: 'question', subject: 'a', proposed: 'json', selected: 'yaml', runId: 'dag_1', nodeId: 'a' }
  const log = (records: unknown[]) => ({ schemaVersion: 1, projectRoot: '/p', sessionId: 's', records })
  expect(parseDecisionLog(log([asked]), '/p', 's')).toEqual([asked])
  expect(parseDecisionLog(log([{ ...asked, kind: 'guess' }]), '/p', 's')).toEqual([])
})

test('a read-only decision survives a reload and keeps its note', () => {
  const readonly: DecisionRecord = { ...record, kind: 'readonly', subject: 'Bash', proposed: 'allow', selected: 'ask', source: 'baseline', outcome: 'existing-decision', latencyMs: 0, threshold: 0, note: 'git status' }
  const log = (records: unknown[]) => ({ schemaVersion: 1, projectRoot: '/p', sessionId: 's', records })
  expect(parseDecisionLog(log([readonly]), '/p', 's')).toEqual([readonly])
  expect(parseDecisionLog(log([{ ...readonly, kind: 'read-only' }]), '/p', 's')).toEqual([])
})
