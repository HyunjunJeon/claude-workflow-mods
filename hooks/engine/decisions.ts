export const DECISION_LIMIT = 200
export const JEV_RULESET_VERSION = 'dag-policy-2026-10-02-v2'

export type DecisionOutcome =
  | 'applied' | 'low-confidence' | 'ask' | 'existing-decision'
  | 'disabled' | 'missing-key' | 'timeout' | 'http-error' | 'invalid-response' | 'transport-error'

export type DecisionRecord = {
  readonly id: string
  readonly at: number
  readonly sessionId: string
  readonly kind: 'routing' | 'permission' | 'recovery'
  readonly subject: string
  readonly proposed: string
  readonly selected: string
  // rule: the final-audit rule raised a quick final audit to unspecified-low, whatever Jev answered.
  readonly source: 'jev' | 'baseline' | 'rule'
  // Which Jev backend answered or failed; absent in records written before the model fallback or without a call.
  readonly backend?: 'http' | 'model'
  readonly outcome: DecisionOutcome
  readonly ruleset: string
  readonly threshold: number
  readonly latencyMs: number
  readonly stateHash: string
  readonly confidence?: number
  readonly probabilities?: Readonly<Record<string, number>>
  readonly runId?: string
  readonly nodeId?: string
}

export type DecisionLog = {
  readonly schemaVersion: 1
  readonly projectRoot: string
  readonly sessionId: string
  readonly records: readonly DecisionRecord[]
}

export function appendDecisions(current: readonly DecisionRecord[], added: readonly DecisionRecord[]): DecisionRecord[] {
  return [...current, ...added].slice(-DECISION_LIMIT)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isDecision(value: unknown): value is DecisionRecord {
  if (!isRecord(value)) return false
  const outcomes = ['applied', 'low-confidence', 'ask', 'existing-decision', 'disabled', 'missing-key', 'timeout', 'http-error', 'invalid-response', 'transport-error']
  if (!['id', 'sessionId', 'subject', 'proposed', 'selected', 'ruleset', 'stateHash'].every(key => typeof value[key] === 'string')) return false
  if (!['at', 'threshold', 'latencyMs'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key]))) return false
  if (value.kind !== 'routing' && value.kind !== 'permission' && value.kind !== 'recovery') return false
  if (value.source !== 'jev' && value.source !== 'baseline' && value.source !== 'rule') return false
  if (typeof value.outcome !== 'string' || !outcomes.includes(value.outcome)) return false
  if (value.confidence !== undefined && (typeof value.confidence !== 'number' || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1)) return false
  if (value.backend !== undefined && value.backend !== 'http' && value.backend !== 'model') return false
  if (value.runId !== undefined && typeof value.runId !== 'string') return false
  if (value.nodeId !== undefined && typeof value.nodeId !== 'string') return false
  if (value.probabilities !== undefined && (!isRecord(value.probabilities) || !Object.values(value.probabilities).every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1))) return false
  return true
}

export function parseDecisionLog(value: unknown, projectRoot: string, sessionId: string): DecisionRecord[] {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.projectRoot !== projectRoot || value.sessionId !== sessionId || !Array.isArray(value.records)) return []
  return value.records.filter(isDecision).filter(record => record.sessionId === sessionId).slice(-DECISION_LIMIT)
}
