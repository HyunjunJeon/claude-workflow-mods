import type { BlockInput, BoardEdit, CalloutTone, FlowEdge, FlowNode, FlowNodeKind } from '../engine/board-types.ts'
import { evidenceOutcome } from '../engine/check-eval.ts'
import type { DecisionRecord } from '../engine/decisions.ts'
import type { NodeRun, Run } from '../engine/types.ts'
import { stringsFor, type Language } from './i18n.ts'
import { formatDuration } from './text.ts'

// The result board of a settled run: five fact blocks, drawn at settle and refreshed when the same run settles again. Pure: the
// host (register.ts) applies the edits and remembers which block id holds which slot.

export const RESULT_SLOTS = ['summary', 'nodes', 'graph', 'writes', 'decisions'] as const
export type ResultSlot = (typeof RESULT_SLOTS)[number]
export type ResultFacts = Record<ResultSlot, BlockInput | undefined>

// The limits of hooks/engine/board.ts; a block over one is refused there and the board would not be drawn at all.
const TITLE_MAX = 80
const CALLOUT_TEXT_MAX = 1000
const MAX_ROWS = 30
const CELL_MAX = 80
const MAX_FLOW_NODES = 24
const MAX_FLOW_EDGES = 48
const FLOW_LABEL_MAX = 40
const FLOW_NOTE_MAX = 80
const SEPARATOR = ' · '
// A cell with nothing to show: no checks recorded, no model, no start or finish.
const NONE = '-'

type ResultStrings = {
  titlePrefix: string
  progress: (done: number, total: number) => string
  nodesTitle: string
  nodeColumns: string[]
  moreNodes: (count: number) => string
  graphTitle: string
  // The checks half of a graph node's note, after its state.
  graphChecks: (checks: string) => string
  writesTitle: string
  writeColumns: string[]
  morePaths: (count: number) => string
  decisionsTitle: string
  decisionColumns: string[]
  moreDecisions: (count: number) => string
  // Appended to the number: 45s, 12m, 1h 05m.
  units: { seconds: string; minutes: string; hours: string }
}

const EN: ResultStrings = {
  titlePrefix: 'Result: ',
  progress: (done, total) => `${done} of ${total} ${total === 1 ? 'node' : 'nodes'} done`,
  nodesTitle: 'Nodes',
  nodeColumns: ['Node', 'State', 'Checks', 'Model', 'Time'],
  moreNodes: count => `… ${count} more nodes`,
  graphTitle: 'Run graph',
  graphChecks: checks => `${checks} checks`,
  writesTitle: 'Declared writes',
  writeColumns: ['Path', 'Node'],
  morePaths: count => `… ${count} more paths`,
  decisionsTitle: 'Decisions',
  decisionColumns: ['Kind', 'Subject', 'Picked', 'Outcome'],
  moreDecisions: count => `… ${count} more decisions`,
  units: { seconds: 's', minutes: 'm', hours: 'h' },
}

const KO: ResultStrings = {
  titlePrefix: '결과: ',
  progress: (done, total) => `노드 ${total}개 중 ${done}개 완료`,
  nodesTitle: '노드',
  nodeColumns: ['노드', '상태', '검사', '모델', '시간'],
  moreNodes: count => `… 노드 ${count}개 더`,
  graphTitle: '실행 그래프',
  graphChecks: checks => `검사 ${checks}`,
  writesTitle: '선언된 쓰기 범위',
  writeColumns: ['경로', '노드'],
  morePaths: count => `… 경로 ${count}개 더`,
  decisionsTitle: '결정',
  decisionColumns: ['종류', '대상', '선택', '결과'],
  moreDecisions: count => `… 결정 ${count}개 더`,
  units: { seconds: '초', minutes: '분', hours: '시간' },
}

const stringsOf = (language: Language): ResultStrings => (language === 'ko' ? KO : EN)

// The engine counts UTF-16 units (String.length), not terminal cells, so this cuts by the same measure instead of fit().
function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

// A node started once it has an attempt on record or a start time; a rejected run never ran, whatever its nodes say.
export function drawsResult(run: Run): boolean {
  return run.rejected === undefined && run.nodes.some(node => node.attempt > 0 || node.startedAt !== undefined)
}

export function resultTitle(run: Run, language: Language): string {
  return cut(`${stringsOf(language).titlePrefix}${run.name}`, TITLE_MAX)
}

// First node start to last node finish; undefined when the run has no start or no finish on record, so the headline leaves the time out.
function elapsedMs(run: Run): number | undefined {
  const starts = run.nodes.flatMap(node => node.startedAt ?? [])
  const finishes = run.nodes.flatMap(node => node.finishedAt ?? [])
  if (starts.length === 0 || finishes.length === 0) return undefined
  return Math.max(0, Math.max(...finishes) - Math.min(...starts))
}

function elapsedText(ms: number, t: ResultStrings): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}${t.units.seconds}`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}${t.units.minutes}`
  return `${Math.floor(minutes / 60)}${t.units.hours} ${String(minutes % 60).padStart(2, '0')}${t.units.minutes}`
}

function toneOf(run: Run): CalloutTone {
  if (run.status === 'completed') return 'info'
  return run.status === 'failed' ? 'risk' : 'warning'
}

function summaryBlock(run: Run, language: Language, t: ResultStrings): BlockInput {
  const done = run.nodes.filter(node => node.state === 'completed').length
  const parts = [stringsFor(language).state[run.status], t.progress(done, run.nodes.length)]
  const elapsed = elapsedMs(run)
  if (elapsed !== undefined) parts.push(elapsedText(elapsed, t))
  return { type: 'callout', tone: toneOf(run), title: parts.join(SEPARATOR), text: cut(run.definition.goal?.trim() || run.name, CALLOUT_TEXT_MAX) }
}

// passed/total over the evidence of the node's last verification; NONE when it recorded no check.
function checksOf(node: NodeRun): string {
  const evidence = node.verification?.evidence ?? []
  if (evidence.length === 0) return NONE
  return `${evidence.filter(item => evidenceOutcome(item) === 'passed').length}/${evidence.length}`
}

// A table holds MAX_ROWS rows: past that, the last row says how many were left out. `columns` is the width of the row it writes.
function capRows(rows: string[][], columns: number, more: (count: number) => string): string[][] {
  if (rows.length <= MAX_ROWS) return rows
  const kept = rows.slice(0, MAX_ROWS - 1)
  return [...kept, [more(rows.length - kept.length), ...Array<string>(columns - 1).fill('')]]
}

function nodeRow(node: NodeRun, language: Language): string[] {
  const took = node.startedAt !== undefined && node.finishedAt !== undefined ? formatDuration(node.finishedAt - node.startedAt) : NONE
  const model = node.model?.replace(/^claude-/, '') || NONE
  return [node.id, stringsFor(language).state[node.state], checksOf(node), model, took].map(cell => cut(cell, CELL_MAX))
}

function nodesBlock(run: Run, language: Language, t: ResultStrings): BlockInput {
  const rows = run.nodes.map(node => nodeRow(node, language))
  return { type: 'table', title: t.nodesTitle, columns: t.nodeColumns, rows: capRows(rows, t.nodeColumns.length, t.moreNodes) }
}

const flowIdAt = (index: number): string => `n${index + 1}`

const FLOW_KINDS: Partial<Record<NodeRun['state'], FlowNodeKind>> = { completed: 'terminal', failed: 'decision' }

function flowNode(node: NodeRun, flowId: string, language: Language, t: ResultStrings): FlowNode {
  const checks = checksOf(node)
  const state = stringsFor(language).state[node.state]
  return {
    id: flowId,
    label: cut(node.id, FLOW_LABEL_MAX),
    kind: FLOW_KINDS[node.state] ?? 'process',
    note: cut(checks === NONE ? state : `${state}${SEPARATOR}${t.graphChecks(checks)}`, FLOW_NOTE_MAX),
  }
}

// The flow's node ids are positional (n1, n2, ...): a run node id may be 64 characters where a flow id holds 32, and the label
// already carries the real id. undefined when the run is bigger than the board's flow limits.
function graphBlock(run: Run, language: Language, t: ResultStrings): BlockInput | undefined {
  if (run.nodes.length > MAX_FLOW_NODES) return undefined
  const flowIds = new Map(run.nodes.map((node, index) => [node.id, flowIdAt(index)]))
  const edges = run.definition.nodes.flatMap((def): FlowEdge[] => {
    const to = flowIds.get(def.id)
    if (to === undefined) return []
    return def.dependsOn.flatMap(dependency => {
      const from = flowIds.get(dependency)
      return from === undefined ? [] : [{ from, to }]
    })
  })
  if (edges.length > MAX_FLOW_EDGES) return undefined
  const nodes = run.nodes.map((node, index) => flowNode(node, flowIdAt(index), language, t))
  return { type: 'flow', title: t.graphTitle, nodes, edges }
}

// Path -> the completed nodes that declared it, in run order. Failed and skipped nodes did not write what they declared.
function writesBlock(run: Run, t: ResultStrings): BlockInput | undefined {
  const declared = new Map(run.definition.nodes.map(def => [def.id, def.writes ?? []]))
  const owners = new Map<string, Set<string>>()
  for (const node of run.nodes) {
    if (node.state !== 'completed') continue
    for (const path of declared.get(node.id) ?? []) owners.set(path, (owners.get(path) ?? new Set<string>()).add(node.id))
  }
  if (owners.size === 0) return undefined
  const rows = [...owners].sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, ids]) => [cut(path, CELL_MAX), cut([...ids].join(', '), CELL_MAX)])
  return { type: 'table', title: t.writesTitle, columns: t.writeColumns, rows: capRows(rows, t.writeColumns.length, t.morePaths) }
}

// The run's own decision records, oldest first. The host hands in the session's records; this keeps the ones the run raised.
function decisionsBlock(run: Run, records: readonly DecisionRecord[], t: ResultStrings): BlockInput | undefined {
  const own = records.filter(record => record.runId === run.runId).sort((a, b) => a.at - b.at)
  if (own.length === 0) return undefined
  const rows = own.map(record => [record.kind, cut(record.subject, CELL_MAX), cut(record.selected, CELL_MAX), record.outcome])
  return { type: 'table', title: t.decisionsTitle, columns: t.decisionColumns, rows: capRows(rows, t.decisionColumns.length, t.moreDecisions) }
}

// records defaults to none so a caller that only draws the run's own facts needs no decision log.
export function resultFacts(run: Run, language: Language, records: readonly DecisionRecord[] = []): ResultFacts {
  const t = stringsOf(language)
  return {
    summary: summaryBlock(run, language, t),
    nodes: nodesBlock(run, language, t),
    graph: graphBlock(run, language, t),
    writes: writesBlock(run, t),
    decisions: decisionsBlock(run, records, t),
  }
}

// One edit per slot, in slot order. A block replaces the block its slot held (same id, so a chip or a selection on it survives);
// a slot whose old block is gone from the board is drawn again at the end; a slot with no block any more removes what it held.
// insertedSlots names the slots of the inserts in order, so the caller pairs them with the ids applyEdits hands back.
export function factEdits(facts: ResultFacts, previous: Partial<Record<ResultSlot, string>>, existing: readonly string[]): { edits: BoardEdit[]; insertedSlots: ResultSlot[] } {
  const edits: BoardEdit[] = []
  const insertedSlots: ResultSlot[] = []
  for (const slot of RESULT_SLOTS) {
    const block = facts[slot]
    const held = previous[slot]
    const id = held !== undefined && existing.includes(held) ? held : undefined
    if (block !== undefined && id !== undefined) {
      edits.push({ op: 'replace', id, block })
    } else if (block !== undefined) {
      edits.push({ op: 'insert', block })
      insertedSlots.push(slot)
    } else if (id !== undefined) {
      edits.push({ op: 'remove', id })
    }
  }
  return { edits, insertedSlots }
}
