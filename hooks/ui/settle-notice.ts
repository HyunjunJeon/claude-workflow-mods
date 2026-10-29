import { deriveStatus } from '../engine/run.ts'
import type { Run } from '../engine/types.ts'
import type { Strings } from './i18n.ts'

// What the settle_notify option allows: nothing, only runs long enough that the person likely looked away, or every run.
export type SettleNotify = 'off' | 'long' | 'always'
export const SETTLE_NOTIFIES: readonly SettleNotify[] = ['off', 'long', 'always']

// A run that settles sooner than this was probably watched in the pane or the band, so `long` stays quiet for it.
export const LONG_RUN_MS = 120_000
export const NOTICE_TITLE = 'dag-workflow'

export type SettleNotice = { text: string; title: string }

// The native notification for a run that has just settled, or undefined when this setting or run gets none. Pure: the caller
// passes the settle time as `now` and the strings table, and raises the notification itself. A cancelled run is the person's
// own doing and another session's run is that session's news, so neither notifies in any mode.
export function settleNotice(run: Run, sessionId: string, mode: SettleNotify, now: number, t: Strings): SettleNotice | undefined {
  if (mode === 'off' || run.sessionId !== sessionId) return undefined
  const status = deriveStatus(run)
  if (status !== 'completed' && status !== 'failed') return undefined
  if (mode === 'long' && now - run.createdAt < LONG_RUN_MS) return undefined
  const done = run.nodes.filter(node => node.state === 'completed').length
  const failed = run.nodes.filter(node => node.state === 'failed').length
  return {
    title: NOTICE_TITLE,
    text: status === 'completed' ? t.notifySettledCompleted(run.name, done, run.nodes.length) : t.notifySettledFailed(run.name, failed, done, run.nodes.length),
  }
}
