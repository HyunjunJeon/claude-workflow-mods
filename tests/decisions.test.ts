import { expect, test } from 'claude-code/testing'
import { appendDecisions, DECISION_LIMIT, parseDecisionLog, type DecisionRecord } from '../hooks/engine/decisions.ts'

const record: DecisionRecord = {
  id: 'd', at: 1, sessionId: 's', kind: 'routing', subject: 'node',
  proposed: 'quick', selected: 'architect', source: 'jev', outcome: 'applied',
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
  const ruled: DecisionRecord = { ...record, proposed: 'quick', selected: 'unspecified-low', source: 'rule', outcome: 'low-confidence', confidence: 0.6 }
  expect(parseDecisionLog({ schemaVersion: 1, projectRoot: '/p', sessionId: 's', records: [ruled] }, '/p', 's')).toEqual([ruled])
})
