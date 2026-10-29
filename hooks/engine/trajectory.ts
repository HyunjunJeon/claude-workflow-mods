import { maskSecrets } from './jev.ts'
import type { Definition, NodeRun, NodeState, Run } from './types.ts'

// The trajectory log (option trajectory_log, off by default) keeps what each run's nodes were told, what they did and said,
// and how they were judged, so two runs of one definition can be compared. The checkpoint keeps only each node's latest
// attempt, its report file is overwritten by the next attempt, and a reviewer's notes are removed before its next start
// (clearStaleNotes), so none of them can show why a run with a review-fix round ended differently from the one before it.
// The host's fs has no append: every event is one JSON line in its own file, named so that a sorted listing is the order
// they happened in, and a settled run's lines are joined into one <run_id>.jsonl.

export const TRAJECTORY_SUBDIR = '.claude/dag/trajectories'
// A prompt, an answer, a notes file or a diff keeps this much; longer text keeps its head and says how long it was.
export const TRAJECTORY_TEXT_CHARS = 64_000
// A transcript keeps this much of each tool input string and of each tool result the model read.
export const TRAJECTORY_TOOL_CHARS = 4_000
// The host's fs.read refuses a file over 4 MiB, and joining a run reads each event back. One character can take 3 bytes.
export const TRAJECTORY_EVENT_CHARS = 1_000_000
const MAX_DEPTH = 32
// maskSecrets takes time quadratic in a long run of name characters (16k of them took 228 ms), so text is cut before it is
// masked, with this much to spare: a secret that starts inside the kept part also ends inside what is masked, and a PEM
// private key is under 8 KiB.
const SECRET_MARGIN = 8_192

// Token counts of an agent's turns added up, as turn.complete reports them; the model is the last turn's.
export type Usage = {
  model?: string
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

// The parts of a transcript row this log keeps: what was said, each tool call's input and the result the model read.
type ToolUseRow = { tool_use_id?: string; tool: string; input: unknown; text?: string; isError?: boolean }
export type TranscriptRow = { role: 'user' | 'assistant'; text: string; toolUses: readonly ToolUseRow[] }
export type TranscriptEntry = { role: 'user' | 'assistant'; text?: string; toolUses?: { tool: string; input: unknown; result?: string; isError?: true }[] }

// A notes file a node's checks read outside the project (a reviewer's, a lens's, a verifier's), as it was when the node ended.
export type NotesFile = { path: string; text: string }

export type SettleRecord = {
  status: Run['status']
  cancelReason?: string
  reviewFix?: Run['reviewFix']
  nodes: {
    id: string
    state: NodeState
    attempt: number
    model?: string
    category?: string
    startedAt?: number
    finishedAt?: number
    error?: string
    recovery?: { used: number; history: NonNullable<NodeRun['recovery']>['history'] }
    verification?: NonNullable<NodeRun['verification']>['status']
  }[]
}

// loosened: the amend's verify loosened warnings (checkLoosening in verification.ts), present only when there are any.
export type RunAmendEvent = { kind: 'run.amend'; runId: string; rerun: string[]; definition: Definition; loosened?: string[] }

type RunEvent =
  | { kind: 'run.start'; runId: string; by: 'model' | 'user'; key: string; name: string; goal?: string; definition: Definition }
  | { kind: 'run.retry'; runId: string; by: 'model' | 'user'; nodeIds?: string[]; prompt?: string }
  | RunAmendEvent
  | {
    kind: 'node.start'; runId: string; nodeId: string; attempt: number; agentId?: string; model?: string; subagentType?: string
    category?: string; recovery?: NodeRun['recovery']; prompt: string; error?: string
  }
  | {
    kind: 'node.end'; runId: string; nodeId: string; attempt: number; agentId: string; reason?: string; isAborted: boolean
    state: NodeState; error?: string; answer?: string; verification?: NodeRun['verification']; expansion?: string[]
    notes: NotesFile[]; diff?: string; usage?: Usage
  }
  | { kind: 'node.transcript'; runId: string; nodeId: string; attempt: number; agentId: string; rows: TranscriptEntry[]; error?: string }
  | { kind: 'rework'; runId: string; round?: number; reviewers?: string[]; producers?: string[]; note?: string; skip?: string }
  | ({ kind: 'run.settle'; runId: string } & SettleRecord)
type SessionEvent = { kind: 'main.turn'; turnId: string; reason: string; durationMs: number; usage?: Usage; rows: TranscriptEntry[] }

export type TrajectoryEvent = { at: number; sessionId: string } & (RunEvent | SessionEvent)
export type TrajectoryInput = RunEvent | SessionEvent

// `text` masked and cut to `max`, saying how long it was.
export function cut(text: string, max: number): string {
  const masked = maskSecrets(text.slice(0, max + SECRET_MARGIN))
  return masked.length > max || text.length > max + SECRET_MARGIN ? `${masked.slice(0, max)}\n[truncated: original length ${text.length} characters]` : masked
}

// Every string masked and cut to `max`; numbers, booleans and null kept; undefined and anything else dropped.
export function sanitize(value: unknown, max: number, depth = 0): unknown {
  if (typeof value === 'string') return cut(value, max)
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean' || value === null) return value
  if (depth >= MAX_DEPTH) return '[depth limit]'
  if (Array.isArray(value)) return value.map(item => sanitize(item, max, depth + 1) ?? null)
  if (typeof value !== 'object') return undefined
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    const clean = sanitize(item, max, depth + 1)
    return clean === undefined ? [] : [[key, clean]]
  }))
}

// One event as one JSON line under TRAJECTORY_EVENT_CHARS: an event too long at the normal cut is cut harder, and one that
// still does not fit keeps only what names it and says how long it was.
export function trajectoryLine(event: TrajectoryEvent, max = TRAJECTORY_TEXT_CHARS): string {
  let length = 0
  for (let cut = max; cut >= 250; cut = Math.floor(cut / 4)) {
    const line = JSON.stringify(sanitize(event, cut))
    if (line.length <= TRAJECTORY_EVENT_CHARS) return `${line}\n`
    length = line.length
  }
  const name = {
    kind: event.kind, at: event.at, sessionId: event.sessionId,
    runId: 'runId' in event ? event.runId : undefined, nodeId: 'nodeId' in event ? event.nodeId : undefined,
    omitted: `event of ${length} characters`,
  }
  return `${JSON.stringify(sanitize(name, max))}\n`
}

// The event's file: the time, a counter for events in the same millisecond, the kind and the node.
export function eventFileName(at: number, seq: number, kind: string, nodeId?: string): string {
  const node = nodeId ? `-${nodeId.replace(/[^A-Za-z0-9_.-]/g, '_')}` : ''
  return `${String(Math.max(0, Math.floor(at))).padStart(13, '0')}-${String(seq % 1_000_000).padStart(6, '0')}-${kind}${node}.jsonl`
}

// The stored tool record (`result` on the host's row) repeats the result the model read in another shape and can be large,
// so it is left out, as are the user rows that only carry tool results.
export function transcriptRows(rows: readonly TranscriptRow[]): TranscriptEntry[] {
  return rows.flatMap(row => {
    const toolUses = row.toolUses.map(use => ({
      tool: use.tool,
      input: sanitize(use.input, TRAJECTORY_TOOL_CHARS),
      result: use.text === undefined ? undefined : cut(use.text, TRAJECTORY_TOOL_CHARS),
      isError: use.isError ? true as const : undefined,
    }))
    if (row.text === '' && toolUses.length === 0) return []
    return [{ role: row.role, text: row.text === '' ? undefined : row.text, toolUses: toolUses.length > 0 ? toolUses : undefined }]
  })
}

// Where the main conversation's log stopped: how many rows it had and what the last one was. The host returns at most the
// newest 4096 rows and compaction rewrites them, so a count alone could skip or repeat rows.
export type RowMark = { count: number; last: string }

function rowKey(row: TranscriptRow): string {
  return JSON.stringify([row.role, row.text, row.toolUses.map(use => use.tool_use_id ?? use.tool)])
}

// The rows after `mark`, and the mark to keep. Without a mark, or when the marked row is gone, every row is new.
export function rowsAfter<T extends TranscriptRow>(rows: readonly T[], mark: RowMark | undefined): { rows: T[]; mark: RowMark | undefined } {
  const last = rows.at(-1)
  const next = last ? { count: rows.length, last: rowKey(last) } : undefined
  if (!mark) return { rows: [...rows], mark: next }
  const marked = rows[mark.count - 1]
  if (marked && rowKey(marked) === mark.last) return { rows: rows.slice(mark.count), mark: next }
  const at = rows.map(rowKey).lastIndexOf(mark.last)
  return { rows: at >= 0 ? rows.slice(at + 1) : [...rows], mark: next }
}

export function addUsage(total: Usage | undefined, turn: Usage | undefined): Usage | undefined {
  if (!turn) return total
  if (!total) return { ...turn }
  return {
    model: turn.model ?? total.model,
    input_tokens: total.input_tokens + turn.input_tokens,
    output_tokens: total.output_tokens + turn.output_tokens,
    cache_read_input_tokens: total.cache_read_input_tokens + turn.cache_read_input_tokens,
    cache_creation_input_tokens: total.cache_creation_input_tokens + turn.cache_creation_input_tokens,
  }
}

// What a settled run ended with, per node: the state, the attempts, the model, when it ran, why it failed or recovered.
export function settleRecord(run: Run): SettleRecord {
  return {
    status: run.status,
    cancelReason: run.cancelReason,
    reviewFix: run.reviewFix,
    nodes: run.nodes.map(node => ({
      id: node.id,
      state: node.state,
      attempt: node.attempt,
      model: node.model,
      category: node.routing?.category,
      startedAt: node.startedAt,
      finishedAt: node.finishedAt,
      error: node.error,
      recovery: node.recovery ? { used: node.recovery.used, history: node.recovery.history } : undefined,
      verification: node.verification?.status,
    })),
  }
}
