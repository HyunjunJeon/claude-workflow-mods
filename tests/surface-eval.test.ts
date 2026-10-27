import { expect, test } from 'claude-code/testing'
import {
  agreement,
  appliedMode,
  appliedSurface,
  calibration,
  confusion,
  groupRates,
  modeAccuracy,
  modeDrift,
  outcomes,
  percentile,
  sweep,
  type SurfaceCase,
  type SurfaceSample,
} from '../eval/surface.ts'

const cases: SurfaceCase[] = [
  { id: 'b1', group: 'tables', request: 'compare three options', expect: 'board', expectMode: 'dag' },
  { id: 'b2', group: 'tables', request: 'list the results', expect: 'board' },
  { id: 'c1', group: 'talk', request: 'thanks', expect: 'chat', expectMode: 'direct' },
  { id: 'x1', group: 'talk', request: 'arguable', expect: 'contested' },
]

function sample(caseId: string, choice: string | undefined, confidence = 0.9, extra: Partial<SurfaceSample> = {}): SurfaceSample {
  return { caseId, repeat: 0, outcome: 'answered', latencyMs: 100, surface: choice === undefined ? undefined : { choice, confidence }, ...extra }
}

test('a board answer applies only at or above the bar', async () => {
  expect(appliedSurface({ choice: 'board', confidence: 0.8 }, 0.8)).toBe('board')
  expect(appliedSurface({ choice: 'board', confidence: 0.79 }, 0.8)).toBe('chat')
  expect(appliedSurface({ choice: 'chat', confidence: 1 }, 0.8)).toBe('chat')
})

test('a missing surface answer counts as chat', async () => {
  expect(appliedSurface(undefined, 0.5)).toBe('chat')
  expect(confusion(cases, [sample('b1', undefined)], 0.8).falseNegative).toBe(1)
})

test('a dag mode applies only at or above the default mode bar', async () => {
  expect(appliedMode({ choice: 'dag', confidence: 0.8 })).toBe('dag')
  expect(appliedMode({ choice: 'dag', confidence: 0.79 })).toBe('direct')
  expect(appliedMode(undefined)).toBe('direct')
})

test('confusion counts the four cells and skips contested and unknown cases', async () => {
  const samples = [sample('b1', 'board'), sample('b2', 'chat'), sample('c1', 'board'), sample('c1', 'chat'), sample('x1', 'board'), sample('nope', 'board')]
  const result = confusion(cases, samples, 0.8)
  expect([result.truePositive, result.falseNegative, result.falsePositive, result.trueNegative, result.scored]).toEqual([1, 1, 1, 1, 4])
  expect(result.precision).toBe(0.5)
  expect(result.recall).toBe(0.5)
  expect(result.accuracy).toBe(0.5)
})

test('precision and recall are null on empty denominators', async () => {
  const empty = confusion(cases, [], 0.8)
  expect([empty.precision, empty.recall, empty.accuracy]).toEqual([null, null, null])
  const onlyChat = confusion(cases, [sample('c1', 'chat')], 0.8)
  expect([onlyChat.precision, onlyChat.recall, onlyChat.accuracy]).toEqual([null, null, 1])
})

test('raising the bar trades recall for precision', async () => {
  const samples = [sample('b1', 'board', 0.95), sample('b2', 'board', 0.6), sample('c1', 'board', 0.55), sample('c1', 'board', 0.6)]
  const [low, high] = sweep(cases, samples, [0.5, 0.9])
  // SAFETY: sweep returns one entry per bar passed, and two bars were passed.
  expect(low!.recall).toBe(1)
  expect(low!.precision).toBe(0.5)
  expect(high!.recall).toBe(0.5)
  expect(high!.precision).toBe(1)
})

test('group rates include contested cases in first-seen order', async () => {
  const samples = [sample('b1', 'board'), sample('x1', 'board'), sample('c1', 'chat')]
  expect(groupRates(cases, samples, 0.8)).toEqual([
    { group: 'tables', samples: 1, board: 1 },
    { group: 'talk', samples: 2, board: 1 },
  ])
})

test('calibration puts confidence 1 in the last bucket and scores the raw choice', async () => {
  const samples = [sample('b1', 'board', 1), sample('c1', 'board', 0.8), sample('x1', 'board', 0.9), sample('b2', undefined)]
  const buckets = calibration(cases, samples)
  expect(buckets.at(-1)).toEqual({ from: 0.9, to: 1, answers: 1, correct: 1 })
  expect(buckets.find((bucket) => bucket.from === 0.8)).toEqual({ from: 0.8, to: 0.9, answers: 1, correct: 0 })
  expect(buckets.reduce((sum, bucket) => sum + bucket.answers, 0)).toBe(2)
})

test('agreement lists the cases whose answers differ across repeats', async () => {
  const samples = [sample('b1', 'board'), sample('b1', 'board'), sample('c1', 'chat'), sample('c1', 'board'), sample('b2', 'board')]
  expect(agreement(samples)).toEqual({ cases: 2, agreed: 1, split: ['c1'] })
})

test('mode drift reports samples whose applied mode changes without the surface question', async () => {
  const samples = [
    sample('b1', 'board', 0.9, { mode: { choice: 'dag', confidence: 0.9 }, modeAlone: { choice: 'direct', confidence: 0.9 } }),
    sample('c1', 'chat', 0.9, { repeat: 1, mode: { choice: 'direct', confidence: 0.9 }, modeAlone: { choice: 'dag', confidence: 0.5 } }),
    sample('b2', 'board'),
  ]
  expect(modeDrift(samples)).toEqual({ compared: 2, drifted: [{ caseId: 'b1', repeat: 0, withSurface: 'dag', alone: 'direct' }] })
})

test('mode accuracy scores only cases with an expected mode', async () => {
  const samples = [
    sample('b1', 'board', 0.9, { mode: { choice: 'dag', confidence: 0.9 } }),
    sample('c1', 'chat', 0.9, { mode: { choice: 'dag', confidence: 0.9 } }),
    sample('b2', 'board', 0.9, { mode: { choice: 'dag', confidence: 0.9 } }),
  ]
  expect(modeAccuracy(cases, samples)).toEqual({ scored: 2, correct: 1 })
})

test('percentile uses the nearest rank and is undefined for an empty list', async () => {
  expect(percentile([], 50)).toBeUndefined()
  expect(percentile([40, 10, 30, 20], 50)).toBe(20)
  expect(percentile([40, 10, 30, 20], 95)).toBe(40)
  expect(percentile([7], 0)).toBe(7)
})

test('outcomes counts samples per outcome', async () => {
  const samples = [sample('b1', 'board'), sample('b2', 'board'), { ...sample('c1', undefined), outcome: 'timeout' as const }]
  expect(outcomes(samples)).toEqual({ answered: 2, timeout: 1 })
})
