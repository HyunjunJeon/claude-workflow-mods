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
  boardFiles: RetentionFile[]
  sessionRecords: SessionRecord[]
}

export type RetentionPlan = {
  runs: Run[]
  runDirs: string[]
  contextFiles: string[]
  decisionFiles: string[]
  boardFiles: string[]
  sessionKeys: string[]
}

const SAFE_ID = /^[A-Za-z0-9_.-]+$/
const ORPHAN_DIR = /^dag_[A-Za-z0-9_-]+$/

function fileSessionId(name: string): string | undefined {
  if (!name.endsWith('.json') || name.includes('..')) return undefined
  const id = name.slice(0, -'.json'.length)
  return SAFE_ID.test(id) ? id : undefined
}

export function retentionPlan(input: RetentionInput): RetentionPlan {
  const { runs, now, retentionDays, currentSession } = input
  const empty: RetentionPlan = { runs: [], runDirs: [], contextFiles: [], decisionFiles: [], boardFiles: [], sessionKeys: [] }
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
    boardFiles: pickFiles(input.boardFiles),
    sessionKeys,
  }
}

// What the trajectory log (trajectory.ts) keeps under .claude/dag/trajectories: a folder per run id or per `session-<id>`, and
// a settled run's events joined into <run_id>.jsonl beside it. An entry is the folder and its joined file together. A run's
// folder is named for its run id, which ORPHAN_DIR already matches.
const BYTES_PER_MB = 1024 * 1024
const TRAJECTORY_SESSION = /^session-([A-Za-z0-9_-]+)$/

export type TrajectoryEntry = {
  name: string
  // The newest of the folder's files and the joined file; an entry with no file is 0, the oldest.
  mtimeMs: number
  bytes: number
}

// Which run or session an entry belongs to, undefined for a name the plugin never wrote. This is the safe-name check: neither
// pattern admits a dot or a slash, so a returned name cannot leave the trajectories folder.
export function trajectoryOwner(name: string): { kind: 'run' | 'session'; id: string } | undefined {
  if (ORPHAN_DIR.test(name)) return { kind: 'run', id: name }
  const session = TRAJECTORY_SESSION.exec(name)?.[1]
  return session === undefined ? undefined : { kind: 'session', id: session }
}

export type TrajectoryRetentionInput = {
  entries: TrajectoryEntry[]
  now: number
  // 0 leaves the age limit off.
  retentionDays: number
  // 0 leaves the size cap off.
  maxMb: number
  currentSession: string
  unsettledRunIds: ReadonlySet<string>
}

// The entries to delete, oldest first: every unprotected entry whose newest file is older than retentionDays, then, while the
// rest still add up to more than maxMb, the unprotected entry with the oldest newest file. The current session's entry and an
// unsettled run's are protected, but still count toward the total, so a cap they exceed alone removes every other entry.
export function trajectoryPlan(input: TrajectoryRetentionInput): string[] {
  const { entries, now, retentionDays, maxMb, currentSession, unsettledRunIds } = input
  const removable = entries.filter(entry => {
    const owner = trajectoryOwner(entry.name)
    if (owner === undefined) return false
    return owner.kind === 'run' ? !unsettledRunIds.has(owner.id) : owner.id !== currentSession
  }).sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name))
  const cutoff = now - retentionDays * DAY_MS
  const doomed = new Set(retentionDays > 0 ? removable.filter(entry => entry.mtimeMs < cutoff) : [])
  const maxBytes = maxMb * BYTES_PER_MB
  if (maxBytes > 0) {
    let total = entries.reduce((sum, entry) => doomed.has(entry) ? sum : sum + entry.bytes, 0)
    for (const entry of removable) {
      if (total <= maxBytes) break
      if (doomed.has(entry)) continue
      doomed.add(entry)
      total -= entry.bytes
    }
  }
  return removable.filter(entry => doomed.has(entry)).map(entry => entry.name)
}
