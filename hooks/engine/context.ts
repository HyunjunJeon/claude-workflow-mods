import type { Run } from './types.ts'

export type ContextRecord = {
  schemaVersion: 1
  projectRoot: string
  sessionId: string
  updatedAt: number
  requests: { at: number; text: string }[]
  notes: { at: number; text: string }[]
  // The planning skill was loaded in this session. $.state holds the flag across /reload-plugins only; this file carries
  // it into a new process that resumes the same session id. Present only as true.
  planningLoaded?: true
}

// Source requests retain at most 20,000 UTF-16 code units, including an explicit
// notice identifying the original request by timestamp and original length.
const REQUEST_CAP = 20_000
const SUMMARY_CAP = 8_000

export function emptyContext(projectRoot: string, sessionId: string, now: number): ContextRecord {
  return { schemaVersion: 1, projectRoot, sessionId, updatedAt: now, requests: [], notes: [] }
}

export function recordRequest(record: ContextRecord, request: { text: string; at: number }): ContextRecord {
  const notice = `\n[TRUNCATED source request at=${request.at}; original UTF-16 length=${request.text.length}]`
  const text = request.text.length > REQUEST_CAP
    ? request.text.slice(0, REQUEST_CAP - notice.length) + notice
    : request.text
  return {
    ...record,
    updatedAt: Math.max(record.updatedAt, request.at),
    requests: [...record.requests.map(entry => ({ ...entry })), { at: request.at, text }].slice(-8),
    notes: record.notes.map(entry => ({ ...entry })),
  }
}

export function addNote(record: ContextRecord, note: { text: string; at: number }): ContextRecord {
  return {
    ...record,
    updatedAt: Math.max(record.updatedAt, note.at),
    requests: record.requests.map(entry => ({ ...entry })),
    notes: [...record.notes.map(entry => ({ ...entry })), { ...note }],
  }
}

export function removeNote(record: ContextRecord, index: number): ContextRecord {
  return {
    ...record,
    requests: record.requests.map(entry => ({ ...entry })),
    notes: record.notes.filter((_, i) => i !== index).map(entry => ({ ...entry })),
  }
}

function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function entries(value: unknown): { at: number; text: string }[] | undefined {
  if (!Array.isArray(value)) return undefined
  const parsed: { at: number; text: string }[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null ||
      !('at' in entry) || !timestamp(entry.at) ||
      !('text' in entry) || typeof entry.text !== 'string' || !entry.text.trim()) return undefined
    parsed.push({ at: entry.at, text: entry.text })
  }
  return parsed
}

export function parseContext(value: unknown, projectRoot: string, sessionId: string): ContextRecord | undefined {
  if (typeof value !== 'object' || value === null ||
    !('schemaVersion' in value) || value.schemaVersion !== 1 ||
    !('projectRoot' in value) || value.projectRoot !== projectRoot || !projectRoot.trim() ||
    !('sessionId' in value) || value.sessionId !== sessionId || !sessionId.trim() ||
    !('updatedAt' in value) || !timestamp(value.updatedAt) ||
    !('requests' in value) || !('notes' in value)) return undefined
  const requests = entries(value.requests)
  const notes = entries(value.notes)
  const updatedAt = value.updatedAt
  if (!requests || !notes || requests.length > 8 ||
    requests.some(entry => entry.text.length > REQUEST_CAP) ||
    [...requests, ...notes].some(entry => entry.at > updatedAt)) return undefined
  return {
    schemaVersion: 1, projectRoot, sessionId, updatedAt, requests, notes,
    ...('planningLoaded' in value && value.planningLoaded === true ? { planningLoaded: true as const } : {}),
  }
}

function preview(text: string, cap = 240) {
  return { text: text.slice(0, cap), truncated: text.length > cap, sourceLength: text.length }
}

/**
 * A bounded JSON restoration block, projected directly from raw records/runs.
 * `source` and `checkpoint` are authoritative; previews and omitted entries are
 * not replacements for them. No node answer/output is treated as verification.
 */
export function contextSummary(record: ContextRecord, runs: readonly Run[], sourcePath: string): string {
  const owned = runs.filter(run => run.sessionId === record.sessionId).slice().sort((a, b) => {
    const activeA = a.status === 'running' || a.status === 'paused'
    const activeB = b.status === 'running' || b.status === 'paused'
    return Number(activeB) - Number(activeA) || b.updatedAt - a.updatedAt ||
      (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0)
  })
  const current = record.requests.at(-1)
  const projected: unknown[] = []
  const block = {
    schemaVersion: 1,
    kind: 'context-restoration',
    source: preview(sourcePath, 120),
    projectRoot: preview(record.projectRoot, 120),
    sessionId: preview(record.sessionId, 120),
    updatedAt: record.updatedAt,
    objective: current ? { ...preview(current.text, 400), at: current.at, index: record.requests.length - 1 } : null,
    entries: projected,
    omitted: { notes: record.notes.length, runs: owned.length, nodes: owned.reduce((n, run) => n + run.nodes.length, 0), requests: Math.max(0, record.requests.length - 1) },
  }
  // This local accumulator is the only mutable value; all source objects stay intact.
  const append = (entry: unknown, limit = SUMMARY_CAP): boolean => {
    block.entries.push(entry)
    if (JSON.stringify(block).length <= limit) return true
    block.entries.pop()
    return false
  }
  for (const [index, note] of record.notes.entries()) {
    if (append({ kind: 'note', index, at: note.at, ...preview(note.text) }, 4_500)) block.omitted.notes--
  }
  for (const run of owned) {
    const checkpoint = `${record.projectRoot}/.claude/dag/runs/${run.runId}.json`
    if (append({
      kind: 'run', runId: preview(run.runId), status: run.status,
      updatedAt: run.updatedAt, checkpoint: preview(checkpoint),
      goal: preview(run.definition.goal ?? ''),
      handoff: run.handoff ? { from: preview(run.handoff.from), to: preview(run.handoff.to), requestedAt: run.handoff.requestedAt, offeredAt: run.handoff.offeredAt } : null,
    })) block.omitted.runs--
    const nodes = run.nodes.slice().sort((a, b) => {
      const resolved = (state: string) => state === 'completed' || state === 'cancelled' || state === 'skipped'
      return Number(resolved(a.state)) - Number(resolved(b.state))
    })
    for (const node of nodes) {
      const definition = run.definition.nodes.find(entry => entry.id === node.id)
      if (append({
        kind: 'node', runId: preview(run.runId), id: preview(node.id), state: node.state,
        attempt: node.attempt, checkpoint: preview(checkpoint),
        writes: definition?.writes?.map(path => preview(path)) ?? null,
        declaredChecks: definition?.verify?.length ?? 0,
        verification: node.verification ? {
          status: node.verification.status,
          evidence: node.verification.evidence.map(evidence => ({
            kind: evidence.check.kind, passed: evidence.passed, checkedAt: evidence.checkedAt,
            exitCode: evidence.exitCode,
          })),
          report: node.verification.reportPath ? preview(node.verification.reportPath) : null,
        } : null,
        recovery: node.recovery ? { used: node.recovery.used, kind: node.recovery.kind, reason: preview(node.recovery.reason) } : null,
        error: node.error ? preview(node.error) : null,
        report: node.reportPath ? preview(node.reportPath) : null,
      })) block.omitted.nodes--
    }
  }
  for (let index = record.requests.length - 2; index >= 0; index--) {
    const request = record.requests[index]
    if (request && append({ kind: 'request', index, at: request.at, ...preview(request.text) })) block.omitted.requests--
  }
  return JSON.stringify(block)
}
