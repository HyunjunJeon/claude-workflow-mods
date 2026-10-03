import { isSettled } from './run.ts'
import { projectSessions, type SessionRecord } from './sessions.ts'
import type { Run } from './types.ts'

const DAY_MS = 86_400_000

export function expiredRuns(runs: Run[], now: number, retentionDays: number, currentSession: string): Run[] {
  if (!(retentionDays > 0)) return []
  const cutoff = now - retentionDays * DAY_MS
  return runs.filter(run => run.sessionId !== currentSession && run.updatedAt < cutoff && (isSettled(run) || run.status === 'paused'))
}

export type RetentionFile = { name: string; mtimeMs: number }

export type RetentionInput = {
  runs: Run[]
  now: number
  retentionDays: number
  currentSession: string
  runDirNames: string[]
  contextFiles: RetentionFile[]
  decisionFiles: RetentionFile[]
  sessionRecords: SessionRecord[]
}

export type RetentionPlan = {
  runs: Run[]
  runDirs: string[]
  contextFiles: string[]
  decisionFiles: string[]
  sessionKeys: string[]
}

const SAFE_ID = /^[A-Za-z0-9_.-]+$/
const ORPHAN_DIR = /^dag_[A-Za-z0-9_-]+$/

function fileSessionId(name: string): string | undefined {
  if (!name.endsWith('.json') || name.includes('..')) return undefined
  const id = name.slice(0, -'.json'.length)
  return id && SAFE_ID.test(id) ? id : undefined
}

export function retentionPlan(input: RetentionInput): RetentionPlan {
  const { runs, now, retentionDays, currentSession } = input
  const empty: RetentionPlan = { runs: [], runDirs: [], contextFiles: [], decisionFiles: [], sessionKeys: [] }
  if (!(retentionDays > 0)) return empty
  const cutoff = now - retentionDays * DAY_MS
  const expired = expiredRuns(runs, now, retentionDays, currentSession)
  const expiredIds = new Set(expired.map(run => run.runId))
  const kept = runs.filter(run => !expiredIds.has(run.runId))
  const knownIds = new Set(runs.map(run => run.runId))
  const keptSessions = new Set(kept.map(run => run.sessionId))

  const runDirs = [...new Set([
    ...expired.map(run => run.runId),
    ...input.runDirNames.filter(name => ORPHAN_DIR.test(name) && !knownIds.has(name)),
  ])]

  const liveSessions = new Set<string>()
  for (const record of input.sessionRecords) {
    if (projectSessions([record], record.projectRoot, now)[0]?.liveness === 'active') liveSessions.add(record.sessionId)
  }
  const removable = (id: string, mtimeMs: number) => id !== currentSession && mtimeMs < cutoff
    && !keptSessions.has(id) && !liveSessions.has(id)
  const pickFiles = (files: RetentionFile[]) => files.flatMap(file => {
    const id = fileSessionId(file.name)
    return id !== undefined && removable(id, file.mtimeMs) ? [file.name] : []
  })

  const sessionKeys = [...new Set(input.sessionRecords
    .filter(record => record.sessionId !== currentSession && record.updatedAt < cutoff
      && !liveSessions.has(record.sessionId))
    .map(record => record.sessionId))]

  return {
    runs: expired, runDirs,
    contextFiles: pickFiles(input.contextFiles),
    decisionFiles: pickFiles(input.decisionFiles),
    sessionKeys,
  }
}
