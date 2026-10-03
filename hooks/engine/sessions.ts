import { deriveStatus, resumePaused } from './run.ts'
import { fail, type Result, type Run } from './types.ts'

export type SessionRecord = {
  schemaVersion: 1
  sessionId: string
  projectRoot: string
  updatedAt: number
  status: 'active' | 'closed'
  runIds: string[]
  writes: string[]
}

type SessionContext = { projectRoot: string; sessionId: string; now: number }

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string' && item.trim().length > 0)
}

export function parseSession(value: unknown): SessionRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  if (!('schemaVersion' in value) || value.schemaVersion !== 1
    || !('sessionId' in value) || typeof value.sessionId !== 'string' || !value.sessionId.trim()
    || !('projectRoot' in value) || typeof value.projectRoot !== 'string' || !value.projectRoot.trim()
    || !('updatedAt' in value) || typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)
    || !('status' in value) || (value.status !== 'active' && value.status !== 'closed')
    || !('runIds' in value) || !strings(value.runIds)
    || !('writes' in value) || !strings(value.writes)) return undefined
  return {
    schemaVersion: 1, sessionId: value.sessionId, projectRoot: value.projectRoot,
    updatedAt: value.updatedAt, status: value.status,
    runIds: [...value.runIds], writes: [...value.writes],
  }
}

function active(session: SessionRecord, now: number): boolean {
  return session.status === 'active' && now - session.updatedAt >= 0 && now - session.updatedAt <= 60_000
}

function resolveScope(root: string, scope: string): string {
  const parts: string[] = []
  for (const part of (scope.startsWith('/') ? scope : `${root}/${scope}`).split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return '/' + parts.join('/')
}

export function projectSessions(records: readonly SessionRecord[], root: string, now: number) {
  return records.filter(record => record.projectRoot === root)
    .map(record => ({
      ...record, runIds: [...record.runIds], writes: [...record.writes],
      liveness: record.status === 'closed' ? 'closed' : active(record, now) ? 'active' : 'stale',
    } satisfies SessionRecord & { liveness: 'active' | 'stale' | 'closed' }))
    .sort((a, b) => a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : b.updatedAt - a.updatedAt)
}

export function sessionConflicts(records: readonly SessionRecord[], root: string, now: number) {
  const sessions = projectSessions(records, root, now).filter(record => record.liveness === 'active')
  const conflicts: { sessionIds: string[]; writes: string[] }[] = []
  for (const [index, left] of sessions.entries()) {
    for (const right of sessions.slice(index + 1)) {
      if (left.sessionId === right.sessionId) continue
      for (const a of [...new Set(left.writes)].sort()) {
        for (const b of [...new Set(right.writes)].sort()) {
          if (/[?*[\]{}]/.test(a) || /[?*[\]{}]/.test(b)) continue
          const first = resolveScope(root, a)
          const second = resolveScope(root, b)
          if (first === second || first.startsWith(second.endsWith('/') ? second : second + '/')
            || second.startsWith(first.endsWith('/') ? first : first + '/')) {
            conflicts.push({ sessionIds: [left.sessionId, right.sessionId], writes: [a, b] })
          }
        }
      }
    }
  }
  return conflicts
}

export function requestHandoff(run: Run, target: SessionRecord, context: SessionContext): Result<Run> {
  if (run.sessionId !== context.sessionId) return fail('not_owner', 'Only the owner can request a handoff.')
  if (target.projectRoot !== context.projectRoot) return fail('wrong_project', 'The target belongs to another project.')
  if (!active(target, context.now)) return fail('inactive_target', 'The target must be active and fresh.')
  if (target.sessionId === context.sessionId) return fail('same_session', 'Choose a different session.')
  if (run.handoff) return fail('handoff_pending', 'A handoff is already pending.')
  if (run.nodes.some(node => node.state === 'paused')) return fail('run_paused', 'Resume existing paused work before requesting a handoff.')
  return {
    ok: true,
    value: offerHandoff({
      ...run, handoff: { from: context.sessionId, to: target.sessionId, requestedAt: context.now },
    }, context.now),
  }
}

export function offerHandoff(run: Run, now: number): Run {
  if (!run.handoff) return run
  const nodes: Run['nodes'] = run.nodes.map(node => node.state === 'pending' || node.state === 'scheduled'
    ? { ...node, state: 'paused' satisfies Run['nodes'][number]['state'] } : { ...node })
  const handoff = { ...run.handoff }
  if (nodes.some(node => node.state === 'running')) delete handoff.offeredAt
  else handoff.offeredAt ??= now
  const offered = { ...run, nodes, handoff, updatedAt: now }
  return { ...offered, status: nodes.some(node => node.state === 'running') ? 'running' : deriveStatus(offered) }
}

export function acceptHandoff(run: Run, context: SessionContext, source: SessionRecord | undefined): Result<Run> {
  const handoff = run.handoff
  if (!handoff) return fail('no_handoff', 'There is no pending handoff.')
  if (handoff.to !== context.sessionId || handoff.from !== run.sessionId) return fail('wrong_session', 'Only the addressed target can accept.')
  if (!source || source.sessionId !== handoff.from) return fail('invalid_source', 'The source session must match the owner.')
  if (source.projectRoot !== context.projectRoot) return fail('wrong_project', 'The source belongs to another project.')
  if (handoff.offeredAt === undefined || run.nodes.some(node => node.state === 'running')) {
    return fail('handoff_not_ready', 'Running work must drain before acceptance.')
  }
  const accepted = resumePaused(run, context.sessionId, context.now)
  delete accepted.handoff
  return { ok: true, value: accepted }
}

export function cancelHandoff(run: Run, sessionId: string, now: number): Result<Run> {
  if (run.sessionId !== sessionId || (run.handoff && run.handoff.from !== sessionId)) {
    return fail('not_owner', 'Only the owner can cancel a handoff.')
  }
  if (!run.handoff) return fail('no_handoff', 'There is no pending handoff.')
  const cancelled = resumePaused(run, sessionId, now)
  delete cancelled.handoff
  return { ok: true, value: cancelled }
}
