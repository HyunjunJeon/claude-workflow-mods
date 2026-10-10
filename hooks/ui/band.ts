import { awaitingApproval, isSettled } from '../engine/run.ts'
import type { NodeRun, NodeState, Run } from '../engine/types.ts'
import type { Strings } from './i18n.ts'
import { ACCENT, fit, width, type Line } from './text.ts'

/** `awaiting` is a run held for start approval: its running count is zero because nothing may start. */
export type RunSummary = { run: Run; done: number; total: number; running: number; failed: number; waiting: number; otherRuns: number; awaiting: boolean }
export type BandButton = { key: string; hotkey: string; label: string; nodeId?: string }
export type BandModel = { summary?: Line; buttons: BandButton[]; notice?: Line }
export type BandInput = {
  summary: RunSummary
  waitingAgents: Pick<ReadonlySet<string>, 'has'>
  columns: number
  rows: number
  t: Strings
  paneWaitReason?: string
}

type Attention = 'failed' | 'waiting' | 'running'
type Urgent = { id: string; label: string }

export const BAND_GAP = 2
const ROW_LIMIT = 3
const NODE_LIMIT = 5
const HOTKEY_CELLS = width('0: ')
const MIN_CUT_LABEL_CELLS = 8
const BY_URGENCY: readonly Attention[] = ['failed', 'waiting', 'running']
// Keep in step with the pane's node icons (view-model.ts) and the inspector's mark for a question left to the person.
const ICON: Record<Attention, string> = { failed: '×', waiting: '?', running: '●' }

export function summarizeActive(runs: Iterable<Run>, sessionId: string, waiting: number): RunSummary | undefined {
  const active = [...runs].filter(run => run.sessionId === sessionId && !isSettled(run))
  const run = active.reduce<Run | undefined>((best, current) => (!best || current.updatedAt >= best.updatedAt ? current : best), undefined)
  if (!run) return undefined
  const count = (state: NodeState) => run.nodes.filter(node => node.state === state).length
  return { run, done: count('completed'), total: run.nodes.length, running: count('running'), failed: count('failed'), waiting, otherRuns: active.length - 1, awaiting: awaitingApproval(run) }
}

function attentionOf(node: NodeRun, waitingAgents: BandInput['waitingAgents']): Attention | undefined {
  if (node.state === 'failed') return 'failed'
  if (node.state !== 'running') return undefined
  return node.agentId !== undefined && waitingAgents.has(node.agentId) ? 'waiting' : 'running'
}

// `fit` keeps every kept character at its offset and ends a cut with one ellipsis, so each segment's slice of the fitted text is that segment as shown.
function fitLine(line: Line, columns: number): Line {
  const fitted = fit(line.map(segment => segment.text).join(''), columns).replace(/[ ·]+…$/, '…')
  let offset = 0
  return line.flatMap(segment => {
    const text = fitted.slice(offset, offset + segment.text.length)
    offset += segment.text.length
    return text ? [{ ...segment, text }] : []
  })
}

// Short labels stay whole and the widest give up cells; when a readable cut still overflows, the least urgent node drops out.
function nodeButtons(urgent: Urgent[], columns: number): BandButton[] {
  for (let count = Math.min(urgent.length, NODE_LIMIT); count > 0; count--) {
    const shown = urgent.slice(0, count)
    const budget = columns - count * (BAND_GAP + HOTKEY_CELLS)
    let cap = Math.max(...shown.map(node => width(node.label)))
    const cells = () => shown.reduce((sum, node) => sum + Math.min(width(node.label), cap), 0)
    while (cap > MIN_CUT_LABEL_CELLS && cells() > budget) cap--
    if (cells() <= budget) return shown.map((node, at) => ({ key: `band-node-${node.id}`, hotkey: String(at + 1), label: fit(node.label, cap), nodeId: node.id }))
  }
  return []
}

export function buildBand(input: BandInput): BandModel | undefined {
  const { summary, columns, t } = input
  const rows = Math.min(ROW_LIMIT, input.rows)
  if (!(rows >= 1) || !(columns > HOTKEY_CELLS)) return undefined
  const open: BandButton = { key: 'band-open', hotkey: '0', label: fit(t.bandOpen, columns - HOTKEY_CELLS) }
  const urgent = BY_URGENCY.flatMap(kind =>
    summary.run.nodes.filter(node => attentionOf(node, input.waitingAgents) === kind).map(node => ({ id: node.id, label: `${ICON[kind]} ${node.id}` })),
  )
  const part = (text: string, style: { color?: string; bold?: true; dim?: true }): Line => [{ text: ' · ', dim: true }, { text, ...style }]
  const line: Line = [
    { text: 'DAG', color: ACCENT, bold: true },
    { text: ` ${summary.run.name}`, bold: true },
    { text: `  ${t.done(summary.done, summary.total)}` },
    ...(summary.failed ? part(`${ICON.failed} ${t.failedCount(summary.failed)}`, { color: 'red' }) : []),
    ...(summary.waiting ? part(`${ICON.waiting} ${t.bandWaiting(summary.waiting)}`, { color: 'yellow', bold: true }) : []),
    ...(summary.awaiting
      ? part(`${ICON.waiting} ${t.awaitingApproval}`, { color: 'yellow', bold: true })
      : part(`${ICON.running} ${t.bandRunning(summary.running)}`, summary.running ? { color: ACCENT } : { dim: true })),
    ...(summary.otherRuns ? part(t.bandOtherRuns(summary.otherRuns), { dim: true }) : []),
  ]
  // One row keeps the buttons: the pinned status line repeats the counts, the hotkeys exist nowhere else.
  return {
    ...(rows >= 2 ? { summary: fitLine(line, columns) } : {}),
    buttons: [open, ...nodeButtons(urgent, columns - HOTKEY_CELLS - width(open.label))],
    ...(rows >= 3 && input.paneWaitReason !== undefined ? { notice: fitLine([{ text: t.bandPaneWaiting(input.paneWaitReason), dim: true }], columns) } : {}),
  }
}
