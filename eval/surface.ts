// Pure metrics for the surface-judgment eval: how often Jev's chat/board answer matches a labelled case.
// The runner collects SurfaceSample records; everything here only counts them and does no I/O.
import type { JevChoice, JevOutcome } from '../hooks/engine/jev.ts'
import { MODE_CONFIDENCE } from '../hooks/engine/jev.ts'

export type Surface = 'chat' | 'board'
export type TurnMode = 'direct' | 'dag'

// expect 'contested' marks a case whose right answer is arguable: it is reported but never scored.
export type SurfaceCase = {
  id: string
  group: string
  request: string
  recent?: string[]
  previousReply?: string
  expect: Surface | 'contested'
  expectMode?: TurnMode
}

// modeAlone is the mode answer when the same case is asked without the surface question.
export type SurfaceSample = {
  caseId: string
  repeat: number
  outcome: JevOutcome
  latencyMs: number
  surface?: JevChoice
  mode?: JevChoice
  modeAlone?: JevChoice
}

// Board is the positive class; a ratio is null when its denominator is 0.
export type Confusion = {
  bar: number
  scored: number
  truePositive: number
  falsePositive: number
  falseNegative: number
  trueNegative: number
  precision: number | null
  recall: number | null
  accuracy: number | null
}

export type GroupRate = { group: string; samples: number; board: number }
export type CalibrationBucket = { from: number; to: number; answers: number; correct: number }
export type ModeDrift = { caseId: string; repeat: number; withSurface: TurnMode; alone: TurnMode }

export const SWEEP_BARS = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95]

const DEFAULT_EDGES = [0, 0.5, 0.6, 0.7, 0.8, 0.9, 1]

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator
}

function casesById(cases: readonly SurfaceCase[]): Map<string, SurfaceCase> {
  return new Map(cases.map((entry) => [entry.id, entry]))
}

export function appliedSurface(choice: JevChoice | undefined, bar: number): Surface {
  return choice !== undefined && choice.choice === 'board' && choice.confidence >= bar ? 'board' : 'chat'
}

export function appliedMode(choice: JevChoice | undefined, bar = MODE_CONFIDENCE): TurnMode {
  return choice !== undefined && choice.choice === 'dag' && choice.confidence >= bar ? 'dag' : 'direct'
}

export function confusion(cases: readonly SurfaceCase[], samples: readonly SurfaceSample[], bar: number): Confusion {
  const byId = casesById(cases)
  let truePositive = 0
  let falsePositive = 0
  let falseNegative = 0
  let trueNegative = 0
  for (const sample of samples) {
    const expected = byId.get(sample.caseId)?.expect
    if (expected !== 'board' && expected !== 'chat') continue
    const applied = appliedSurface(sample.surface, bar)
    if (expected === 'board') {
      if (applied === 'board') truePositive++
      else falseNegative++
    } else if (applied === 'board') falsePositive++
    else trueNegative++
  }
  const scored = truePositive + falsePositive + falseNegative + trueNegative
  return {
    bar,
    scored,
    truePositive,
    falsePositive,
    falseNegative,
    trueNegative,
    precision: ratio(truePositive, truePositive + falsePositive),
    recall: ratio(truePositive, truePositive + falseNegative),
    accuracy: ratio(truePositive + trueNegative, scored),
  }
}

export function sweep(cases: readonly SurfaceCase[], samples: readonly SurfaceSample[], bars: readonly number[] = SWEEP_BARS): Confusion[] {
  return bars.map((bar) => confusion(cases, samples, bar))
}

export function groupRates(cases: readonly SurfaceCase[], samples: readonly SurfaceSample[], bar: number): GroupRate[] {
  const byId = casesById(cases)
  const rates = new Map<string, GroupRate>()
  for (const sample of samples) {
    const group = byId.get(sample.caseId)?.group
    if (group === undefined) continue
    const rate = rates.get(group) ?? { group, samples: 0, board: 0 }
    rate.samples++
    if (appliedSurface(sample.surface, bar) === 'board') rate.board++
    rates.set(group, rate)
  }
  return [...rates.values()]
}

// Buckets are [from, to) except the last, which includes its upper edge.
export function calibration(cases: readonly SurfaceCase[], samples: readonly SurfaceSample[], edges: readonly number[] = DEFAULT_EDGES): CalibrationBucket[] {
  const byId = casesById(cases)
  const buckets: CalibrationBucket[] = []
  // SAFETY: the loop bound index + 1 < edges.length keeps both edge reads in range.
  for (let index = 0; index + 1 < edges.length; index++) buckets.push({ from: edges[index]!, to: edges[index + 1]!, answers: 0, correct: 0 })
  const last = buckets.length - 1
  for (const sample of samples) {
    const expected = byId.get(sample.caseId)?.expect
    if (sample.surface === undefined || (expected !== 'board' && expected !== 'chat')) continue
    const confidence = sample.surface.confidence
    const bucket = buckets.find((entry, index) => confidence >= entry.from && (confidence < entry.to || (index === last && confidence <= entry.to)))
    if (bucket === undefined) continue
    bucket.answers++
    if (sample.surface.choice === expected) bucket.correct++
  }
  return buckets
}

export function agreement(samples: readonly SurfaceSample[]): { cases: number; agreed: number; split: string[] } {
  const answers = new Map<string, Set<string>>()
  const counts = new Map<string, number>()
  for (const sample of samples) {
    if (sample.surface === undefined) continue
    counts.set(sample.caseId, (counts.get(sample.caseId) ?? 0) + 1)
    const seen = answers.get(sample.caseId) ?? new Set<string>()
    seen.add(sample.surface.choice)
    answers.set(sample.caseId, seen)
  }
  let cases = 0
  let agreed = 0
  const split: string[] = []
  for (const [caseId, seen] of answers) {
    if ((counts.get(caseId) ?? 0) < 2) continue
    cases++
    if (seen.size === 1) agreed++
    else split.push(caseId)
  }
  return { cases, agreed, split }
}

export function modeDrift(samples: readonly SurfaceSample[]): { compared: number; drifted: ModeDrift[] } {
  let compared = 0
  const drifted: ModeDrift[] = []
  for (const sample of samples) {
    if (sample.mode === undefined || sample.modeAlone === undefined) continue
    compared++
    const withSurface = appliedMode(sample.mode)
    const alone = appliedMode(sample.modeAlone)
    if (withSurface !== alone) drifted.push({ caseId: sample.caseId, repeat: sample.repeat, withSurface, alone })
  }
  return { compared, drifted }
}

export function modeAccuracy(cases: readonly SurfaceCase[], samples: readonly SurfaceSample[]): { scored: number; correct: number } {
  const byId = casesById(cases)
  let scored = 0
  let correct = 0
  for (const sample of samples) {
    const expected = byId.get(sample.caseId)?.expectMode
    if (expected === undefined) continue
    scored++
    if (appliedMode(sample.mode) === expected) correct++
  }
  return { scored, correct }
}

// Nearest-rank percentile, p in 0..100.
export function percentile(values: readonly number[], p: number): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length))
  return sorted[Math.min(rank, sorted.length) - 1]
}

export function outcomes(samples: readonly SurfaceSample[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const sample of samples) counts[sample.outcome] = (counts[sample.outcome] ?? 0) + 1
  return counts
}
