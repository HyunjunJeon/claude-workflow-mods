export type Phase = 'waiting' | 'thinking' | 'responding' | 'tool-input' | 'tool'

export type Activity = { phase: Phase; since: number; lastAt: number; tool?: string; text?: string; coarse?: true; mark?: string }

export type StepChunk = { kind: string; text?: string; name?: string }

export type TranscriptRow = { role: string; text: string; toolUses: { tool: string; input?: Record<string, unknown>; result?: unknown }[] }

export function finalReport(rows: TranscriptRow[]): string {
  for (const row of [...rows].reverse()) {
    const handback = row.toolUses.find(use => use.tool === 'SubagentHandback')
    const message = handback?.input?.message
    if (typeof message === 'string') return message
    if (row.role === 'assistant' && row.text.trim() !== '') return row.text
  }
  return ''
}

export const STALL_TOKEN_MS = 30_000
export const STALL_WAIT_MS = 90_000
export const STALL_COARSE_MS = 300_000
const TEXT_TAIL = 80

export function stepStarted(now: number): Activity {
  return { phase: 'waiting', since: now, lastAt: now }
}

export function chunkArrived(previous: Activity | undefined, chunk: StepChunk, now: number): Activity | undefined {
  const phase: Phase | undefined =
    chunk.kind === 'text' ? 'responding'
      : chunk.kind === 'thinking' ? 'thinking'
        : chunk.kind === 'tool' || chunk.kind === 'input' ? 'tool-input'
          : undefined
  if (!phase) return previous
  const samePhase = previous?.phase === phase
  const tool = chunk.kind === 'tool' ? chunk.name : samePhase ? previous?.tool : undefined
  const text = phase === 'responding' ? ((samePhase ? previous?.text ?? '' : '') + (chunk.text ?? '')).slice(-TEXT_TAIL) : undefined
  return {
    phase,
    since: samePhase && previous ? previous.since : now,
    lastAt: now,
    ...(tool ? { tool } : {}),
    ...(text !== undefined ? { text } : {}),
  }
}

export function toolStarted(tool: string, now: number): Activity {
  return { phase: 'tool', tool, since: now, lastAt: now }
}

export function fromTranscript(rows: TranscriptRow[], previous: Activity | undefined, now: number): Activity {
  const last = rows.at(-1)
  const pending = last?.role === 'assistant' ? last.toolUses.find(use => use.result === undefined) : undefined
  const phase: Phase = pending ? 'tool' : last?.role === 'assistant' && last.text ? 'responding' : 'waiting'
  const mark = `${rows.length}:${phase}:${pending?.tool ?? ''}`
  if (previous?.coarse && previous.mark === mark) return previous
  return {
    phase,
    since: now,
    lastAt: now,
    coarse: true,
    mark,
    ...(pending ? { tool: pending.tool } : {}),
    ...(phase === 'responding' ? { text: (last?.text ?? '').slice(-TEXT_TAIL) } : {}),
  }
}

export function isStalled(activity: Activity, now: number): boolean {
  if (activity.coarse) return activity.phase === 'waiting' && now - activity.since > STALL_COARSE_MS
  if (activity.phase === 'tool') return false
  if (activity.phase === 'waiting') return now - activity.since > STALL_WAIT_MS
  return now - activity.lastAt > STALL_TOKEN_MS
}
