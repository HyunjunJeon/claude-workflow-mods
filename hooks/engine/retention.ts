import { isSettled } from './run.ts'
import type { Run } from './types.ts'

const DAY_MS = 86_400_000

export function expiredRuns(runs: Run[], now: number, retentionDays: number, currentSession: string): Run[] {
  if (!(retentionDays > 0)) return []
  const cutoff = now - retentionDays * DAY_MS
  return runs.filter(run => run.sessionId !== currentSession && run.updatedAt < cutoff && (isSettled(run) || run.status === 'paused'))
}
