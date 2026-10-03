import type { ContextRecord } from '../engine/context.ts'
import type { DecisionOutcome, DecisionRecord } from '../engine/decisions.ts'
import { MAX_AUTO_RECOVERIES } from '../engine/recovery.ts'
import { projectSessions, sessionConflicts, type SessionRecord } from '../engine/sessions.ts'
import type { NodeRun, NodeState, Run, RunStatus, VerificationEvidence } from '../engine/types.ts'
import { stringsFor, type Language, type Strings } from './i18n.ts'
import { ACCENT, clean, fit, fitTail, formatDuration, width, type Line, type Segment } from './text.ts'

export type InspectorView = 'decisions' | 'context' | 'sessions'

export type InspectorInput = {
  view: InspectorView
  columns: number
  language: Language
  decisions: readonly DecisionRecord[]
  context: ContextRecord
  contextPath: string
  runs: readonly Run[]
  sessions: readonly SessionRecord[]
  projectRoot: string
  sessionId: string
  now: number
  selectedRunId?: string
  selectedDecisionId?: string
  page: number
  /** Worker agent id -> tool whose permission answer it waits for. */
  waiting?: ReadonlyMap<string, string>
}

export type InspectorAction = { id: string; label: string }
export type InspectorModel = { title: string; lines: Line[]; actions: InspectorAction[] }

export const INSPECTOR_VIEWS: readonly InspectorView[] = ['decisions', 'context', 'sessions']
export const PAGE_SIZE = 8

const ROW_META_MIN_COLUMNS = 48
const LABEL_WIDTH = 32
const ID_CELLS = 9

type Style = Omit<Segment, 'text'>
type Liveness = 'active' | 'stale' | 'closed'
type ProjectedSession = ReturnType<typeof projectSessions>[number]
type Handoff = NonNullable<Run['handoff']>
type Page<T> = { items: readonly T[]; index: number; count: number }

type InspectorStrings = {
  decisions: (count: number) => string
  decision: (id: string) => string
  context: string
  sessions: (count: number) => string
  prevPage: string
  nextPage: string
  pageOf: (index: number, count: number) => string
  back: string
  ago: (elapsed: string) => string
  more: (count: number) => string
  hiddenDecisions: (count: number) => string
  hiddenSessions: (count: number) => string
  noDecisions: string
  decisionMissing: string
  kind: Record<DecisionRecord['kind'], string>
  source: Record<DecisionRecord['source'], string>
  outcome: Record<DecisionOutcome, string>
  field: Record<'subject' | 'proposed' | 'selected' | 'source' | 'outcome' | 'confidence' | 'threshold' | 'ruleset' | 'latency' | 'at' | 'run' | 'stateHash' | 'probabilities', string>
  unreported: string
  foreignContext: string
  objective: string
  noObjective: string
  request: (index: number, count: number) => string
  notes: (count: number) => string
  notesHint: string
  noNotes: string
  scope: string
  noRun: string
  foreignRun: (sessionId: string) => string
  writes: (paths: string) => string
  noWrites: string
  verified: string
  verificationFailed: string
  unverified: string
  noChecks: string
  recovery: (used: number, max: number) => string
  evidence: string
  noEvidence: string
  exit: (code: number) => string
  sources: string
  contextFile: string
  checkpoint: string
  report: (nodeId: string) => string
  check: (nodeId: string) => string
  project: string
  liveness: Record<Liveness, string>
  thisSession: string
  runs: (count: number) => string
  writesCount: (count: number) => string
  conflicts: (count: number) => string
  noConflicts: string
  noSessions: string
  handoff: string
  handoffState: (peer: string, state: string) => string
  offered: string
  draining: string
  selectRun: string
  targets: (count: number) => string
  noTargets: string
  handoffAction: (sessionId: string) => string
  cancelHandoff: string
  accept: (run: string) => string
  outgoing: (count: number) => string
  incoming: (count: number) => string
}

const EN: InspectorStrings = {
  decisions: count => `Decisions (${count})`,
  decision: id => `Decision ${id}`,
  context: 'Context',
  sessions: count => `Sessions (${count})`,
  prevPage: 'prev page',
  nextPage: 'next page',
  pageOf: (index, count) => `page ${index}/${count}`,
  back: 'back',
  ago: elapsed => `${elapsed} ago`,
  more: count => `+${count} more`,
  hiddenDecisions: count => `other sessions: ${count} hidden`,
  hiddenSessions: count => `other projects: ${count} hidden`,
  noDecisions: 'No decisions recorded in this session.',
  decisionMissing: 'That decision is no longer in the log.',
  kind: { routing: 'routing', permission: 'permission', recovery: 'recovery' },
  source: { jev: 'Jev', baseline: 'baseline' },
  outcome: {
    applied: 'applied',
    'low-confidence': 'low confidence',
    ask: 'ask',
    'existing-decision': 'existing decision',
    disabled: 'disabled',
    'missing-key': 'missing key',
    timeout: 'timeout',
    'http-error': 'HTTP error',
    'invalid-response': 'invalid response',
    'transport-error': 'transport error',
  },
  field: {
    subject: 'subject', proposed: 'proposed', selected: 'selected', source: 'source', outcome: 'outcome',
    confidence: 'confidence', threshold: 'threshold', ruleset: 'ruleset', latency: 'latency', at: 'at',
    run: 'run', stateHash: 'state hash', probabilities: 'probabilities',
  },
  unreported: 'not reported',
  foreignContext: 'The context record belongs to another session or project and is not shown.',
  objective: 'Objective',
  noObjective: 'No objective recorded yet. The next request is captured automatically.',
  request: (index, count) => `request ${index}/${count}`,
  notes: count => `Notes (${count})`,
  notesHint: '/dag note',
  noNotes: 'No pinned notes. Pin one with /dag note <text>.',
  scope: 'Run scope',
  noRun: 'No run owned by this session.',
  foreignRun: sessionId => `Selected run belongs to session ${sessionId}`,
  writes: paths => `writes ${paths}`,
  noWrites: 'no declared writes',
  verified: 'verified',
  verificationFailed: 'verification failed',
  unverified: 'unverified',
  noChecks: 'no checks declared',
  recovery: (used, max) => `recovery ${used}/${max}`,
  evidence: 'Evidence',
  noEvidence: 'No verification evidence recorded.',
  exit: code => `exit ${code}`,
  sources: 'Sources',
  contextFile: 'context',
  checkpoint: 'checkpoint',
  report: nodeId => `report ${nodeId}`,
  check: nodeId => `check ${nodeId}`,
  project: 'project',
  liveness: { active: 'active', stale: 'stale', closed: 'closed' },
  thisSession: 'this session',
  runs: count => `${count} run${count === 1 ? '' : 's'}`,
  writesCount: count => `${count} write${count === 1 ? '' : 's'}`,
  conflicts: count => `write conflicts (${count})`,
  noConflicts: 'no write conflicts',
  noSessions: 'No session records for this project yet.',
  handoff: 'Handoff',
  handoffState: (peer, state) => `handoff ${peer} · ${state}`,
  offered: 'offered',
  draining: 'draining running work',
  selectRun: 'Select a run to hand off.',
  targets: count => `${count} active target${count === 1 ? '' : 's'} on this page`,
  noTargets: 'No active session to hand off to.',
  handoffAction: sessionId => `hand off → ${sessionId}`,
  cancelHandoff: 'cancel handoff',
  accept: run => `accept ${run}`,
  outgoing: count => `Outgoing (${count})`,
  incoming: count => `Incoming (${count})`,
}

const KO: InspectorStrings = {
  decisions: count => `결정 (${count})`,
  decision: id => `결정 ${id}`,
  context: '컨텍스트',
  sessions: count => `세션 (${count})`,
  prevPage: '이전 페이지',
  nextPage: '다음 페이지',
  pageOf: (index, count) => `${index}/${count} 페이지`,
  back: '뒤로',
  ago: elapsed => `${elapsed} 전`,
  more: count => `+${count}개 더`,
  hiddenDecisions: count => `다른 세션의 결정 ${count}개 숨김`,
  hiddenSessions: count => `다른 프로젝트의 세션 ${count}개 숨김`,
  noDecisions: '이 세션에 기록된 결정이 없습니다.',
  decisionMissing: '해당 결정은 더 이상 로그에 없습니다.',
  kind: { routing: '라우팅', permission: '권한', recovery: '복구' },
  source: { jev: 'Jev', baseline: '기본 규칙' },
  outcome: {
    applied: '적용',
    'low-confidence': '낮은 확신도',
    ask: '질문',
    'existing-decision': '기존 결정',
    disabled: '비활성',
    'missing-key': '키 없음',
    timeout: '시간 초과',
    'http-error': 'HTTP 오류',
    'invalid-response': '잘못된 응답',
    'transport-error': '전송 오류',
  },
  field: {
    subject: '대상', proposed: '제안', selected: '선택', source: '출처', outcome: '결과',
    confidence: '확신도', threshold: '임계값', ruleset: '규칙 버전', latency: '지연', at: '시각',
    run: '실행', stateHash: '상태 해시', probabilities: '확률',
  },
  unreported: '미보고',
  foreignContext: '컨텍스트 기록이 다른 세션 또는 프로젝트의 것이라 표시하지 않습니다.',
  objective: '목표',
  noObjective: '아직 기록된 목표가 없습니다. 다음 요청이 자동으로 기록됩니다.',
  request: (index, count) => `요청 ${index}/${count}`,
  notes: count => `메모 (${count})`,
  notesHint: '/dag note',
  noNotes: '고정된 메모가 없습니다. /dag note <텍스트>로 추가하세요.',
  scope: '실행 범위',
  noRun: '이 세션이 소유한 실행이 없습니다.',
  foreignRun: sessionId => `선택한 실행은 세션 ${sessionId} 소유입니다.`,
  writes: paths => `쓰기 ${paths}`,
  noWrites: '선언된 쓰기 범위 없음',
  verified: '검증됨',
  verificationFailed: '검증 실패',
  unverified: '미검증',
  noChecks: '검증 항목 없음',
  recovery: (used, max) => `복구 ${used}/${max}`,
  evidence: '증거',
  noEvidence: '기록된 검증 증거가 없습니다.',
  exit: code => `종료 코드 ${code}`,
  sources: '출처',
  contextFile: '컨텍스트',
  checkpoint: '체크포인트',
  report: nodeId => `보고서 ${nodeId}`,
  check: nodeId => `검증 ${nodeId}`,
  project: '프로젝트',
  liveness: { active: '활성', stale: '오래됨', closed: '종료' },
  thisSession: '현재 세션',
  runs: count => `실행 ${count}`,
  writesCount: count => `쓰기 ${count}`,
  conflicts: count => `쓰기 충돌 (${count})`,
  noConflicts: '쓰기 충돌 없음',
  noSessions: '이 프로젝트의 세션 기록이 아직 없습니다.',
  handoff: '인계',
  handoffState: (peer, state) => `인계 ${peer} · ${state}`,
  offered: '제안됨',
  draining: '실행 중 작업 정리 중',
  selectRun: '인계할 실행을 선택하세요.',
  targets: count => `이 페이지의 활성 대상 ${count}개`,
  noTargets: '인계할 활성 세션이 없습니다.',
  handoffAction: sessionId => `인계 → ${sessionId}`,
  cancelHandoff: '인계 취소',
  accept: run => `${run} 수락`,
  outgoing: count => `보낸 인계 (${count})`,
  incoming: count => `받은 인계 (${count})`,
}

const ICON: Record<NodeState, string> = {
  pending: '○', blocked: '◌', scheduled: '◷', running: '●', paused: 'Ⅱ',
  completed: '✓', failed: '×', cancelled: '−', skipped: '·',
}
const COLOR: Partial<Record<NodeState | RunStatus, string>> = {
  running: ACCENT, scheduled: ACCENT, blocked: 'yellow', paused: 'yellow', completed: 'green', failed: 'red',
}
const DIM_STATES: ReadonlySet<string> = new Set(['pending', 'skipped'])
const NODE_PRIORITY: Record<NodeState, number> = {
  failed: 0, running: 1, paused: 2, blocked: 3, scheduled: 4, pending: 5, completed: 6, cancelled: 7, skipped: 8,
}
const LIVENESS_RANK: Record<Liveness, number> = { active: 0, stale: 1, closed: 2 }
const LIVENESS_STYLE: Record<Liveness, { icon: string; style: Style }> = {
  active: { icon: '●', style: { color: ACCENT } },
  stale: { icon: '◌', style: { color: 'yellow' } },
  closed: { icon: '−', style: { dim: true } },
}
const OUTCOME_STYLE: Record<DecisionOutcome, { icon: string; style: Style }> = {
  applied: { icon: '✓', style: { color: 'green' } },
  ask: { icon: '?', style: { color: 'yellow' } },
  'low-confidence': { icon: '◌', style: { color: 'yellow' } },
  'existing-decision': { icon: '=', style: { dim: true } },
  disabled: { icon: '−', style: { dim: true } },
  'missing-key': { icon: '−', style: { dim: true } },
  timeout: { icon: '×', style: { color: 'red' } },
  'http-error': { icon: '×', style: { color: 'red' } },
  'invalid-response': { icon: '×', style: { color: 'red' } },
  'transport-error': { icon: '×', style: { color: 'red' } },
}
const CHOSEN: Style = { color: ACCENT, bold: true }
const WARN: Style = { color: 'yellow' }

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

const seg = (text: string, style: Style = {}): Segment => ({ text, ...style })
const dim = (text: string): Segment => ({ text, dim: true })
const bold = (text: string): Segment => ({ text, bold: true })
const heading = (text: string): Segment => ({ text, color: ACCENT, bold: true })
const indented = (...segments: Segment[]): Line => [seg('  '), ...segments]

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function pad(text: string, cells: number): string {
  return text + ' '.repeat(Math.max(0, cells - width(text)))
}

function lineWidth(line: Line): number {
  return line.reduce((cells, segment) => cells + width(segment.text), 0)
}

function short(id: string): string {
  return fit(id, ID_CELLS)
}

function since(now: number, at: number, t: InspectorStrings): string {
  return t.ago(formatDuration(Math.max(0, now - at)))
}

function stateStyle(state: NodeState | RunStatus): Style {
  const color = COLOR[state]
  if (color) return { color }
  return DIM_STATES.has(state) ? { dim: true } : {}
}

// Security boundary: strips control characters and bounds display width for every rendered line.
function clip(line: Line, columns: number): Line {
  const out: Line = []
  let used = 0
  for (const segment of line) {
    const text = clean(segment.text)
    if (!text) continue
    const size = width(text)
    if (used + size <= columns) {
      out.push({ ...segment, text })
      used += size
      continue
    }
    const cut = fit(text, columns - used)
    if (cut) out.push({ ...segment, text: cut })
    break
  }
  return out
}

function wrap(text: string, columns: number, maxLines: number): string[] {
  if (columns <= 0 || maxLines <= 0) return []
  if (columns < 2) return [fit(text, columns)]
  const lines: string[] = []
  let current = ''
  for (const word of clean(text).split(/\s+/).filter(Boolean)) {
    const joined = current ? `${current} ${word}` : word
    if (width(joined) <= columns) {
      current = joined
      continue
    }
    if (current) lines.push(current)
    current = ''
    for (const { segment } of graphemes.segment(word)) {
      if (width(current + segment) > columns) {
        lines.push(current)
        current = ''
      }
      current += segment
    }
  }
  if (current) lines.push(current)
  if (lines.length <= maxLines) return lines
  return [...lines.slice(0, maxLines - 1), fit(lines.slice(maxLines - 1).join(' '), columns)]
}

function paginate<T>(all: readonly T[], page: number): Page<T> {
  const count = Math.max(1, Math.ceil(all.length / PAGE_SIZE))
  const index = Math.min(Math.max(Number.isFinite(page) ? Math.trunc(page) : 0, 0), count - 1)
  return { items: all.slice(index * PAGE_SIZE, (index + 1) * PAGE_SIZE), index, count }
}

function pageFooter(page: Page<unknown>, t: InspectorStrings): Line[] {
  return page.count > 1 ? [[dim(t.pageOf(page.index + 1, page.count))]] : []
}

function pageActions(page: Page<unknown>, t: InspectorStrings): InspectorAction[] {
  return [
    ...(page.index > 0 ? [{ id: 'page:prev', label: t.prevPage }] : []),
    ...(page.index < page.count - 1 ? [{ id: 'page:next', label: t.nextPage }] : []),
  ]
}

function field(label: string, value: string, labelWidth: number, columns: number, style: Style = {}): Line[] {
  const head = `${pad(label, labelWidth)}  `
  if (width(head) + width(value) <= columns) return [[dim(head), seg(value, style)]]
  return [[dim(label)], ...wrap(value, columns - 2, 3).map(part => indented(seg(part, style)))]
}

function sourceLine(label: string, path: string, columns: number): Line {
  return indented(dim(`${label} `), seg(fitTail(path, columns - 3 - width(label))))
}

function runLine(run: Run, s: Strings): Line {
  return indented(bold(run.name), seg(' · '), seg(s.state[run.status], stateStyle(run.status)), dim(` · ${run.runId}`))
}

function handoffText(handoff: Handoff, input: InspectorInput, t: InspectorStrings): string {
  const peer = handoff.to === input.sessionId ? `← ${short(handoff.from)}` : `→ ${short(handoff.to)}`
  const state = handoff.offeredAt === undefined ? t.draining : `${t.offered} · ${since(input.now, handoff.offeredAt, t)}`
  return t.handoffState(peer, state)
}

function byRelevance(a: Run, b: Run): number {
  const live = (run: Run) => run.status === 'running' || run.status === 'paused'
  return Number(live(b)) - Number(live(a)) || b.updatedAt - a.updatedAt || compare(a.runId, b.runId)
}

function decisionRow(ordinal: number, decision: DecisionRecord, input: InspectorInput, t: InspectorStrings): Line {
  const { icon, style } = OUTCOME_STYLE[decision.outcome]
  const change = decision.proposed === decision.selected ? decision.selected : `${decision.proposed} → ${decision.selected}`
  const confidence = decision.confidence === undefined ? '' : ` ${decision.confidence.toFixed(2)}`
  const meta = [t.kind[decision.kind], t.outcome[decision.outcome], `${t.source[decision.source]}${confidence}`, since(input.now, decision.at, t)].join(' · ')
  return [
    dim(`${ordinal} `),
    seg(`${icon} `, style),
    bold(decision.subject),
    seg(`  ${change}`),
    ...(input.columns >= ROW_META_MIN_COLUMNS ? [dim(`  ${meta}`)] : []),
  ]
}

function decisionDetail(decision: DecisionRecord, input: InspectorInput, t: InspectorStrings): InspectorModel {
  const { columns } = input
  const { icon, style } = OUTCOME_STYLE[decision.outcome]
  const labelWidth = Math.max(...Object.values(t.field).map(label => width(label)))
  const show = (label: string, value: string, valueStyle: Style = {}) => field(label, value, labelWidth, columns, valueStyle)
  const changed = decision.proposed !== decision.selected
  const lines: Line[] = [
    [seg(`${icon} `, style), bold(t.kind[decision.kind]), seg(`  ${t.outcome[decision.outcome]}`, style)],
    ...show(t.field.subject, decision.subject),
    ...show(t.field.proposed, decision.proposed),
    ...show(t.field.selected, decision.selected, changed ? CHOSEN : {}),
    ...show(t.field.source, t.source[decision.source]),
    ...show(t.field.outcome, t.outcome[decision.outcome], style),
    ...show(t.field.confidence, decision.confidence === undefined ? t.unreported : decision.confidence.toFixed(2)),
    ...show(t.field.threshold, decision.threshold.toFixed(2)),
    ...show(t.field.ruleset, decision.ruleset),
    ...show(t.field.latency, `${Math.round(decision.latencyMs)}ms`),
    ...show(t.field.at, since(input.now, decision.at, t)),
    ...(decision.runId === undefined ? [] : show(t.field.run, decision.nodeId === undefined ? decision.runId : `${decision.runId} · ${decision.nodeId}`)),
    ...show(t.field.stateHash, decision.stateHash),
  ]
  const probabilities = Object.entries(decision.probabilities ?? {}).sort((a, b) => b[1] - a[1] || compare(a[0], b[0]))
  if (probabilities.length > 0) {
    lines.push([dim(t.field.probabilities)])
    const keyWidth = Math.min(16, Math.max(...probabilities.map(([key]) => width(key))))
    const barWidth = Math.min(12, columns - keyWidth - 9)
    for (const [key, probability] of probabilities.slice(0, PAGE_SIZE)) {
      const chosen = key === decision.selected
      const bar = barWidth >= 3 ? ` ${'█'.repeat(Math.round(probability * barWidth))}` : ''
      lines.push(indented(
        seg(pad(fit(key, keyWidth), keyWidth), chosen ? CHOSEN : {}),
        seg(` ${probability.toFixed(2)}`),
        seg(bar, chosen ? { color: ACCENT } : { dim: true }),
      ))
    }
    if (probabilities.length > PAGE_SIZE) lines.push(indented(dim(t.more(probabilities.length - PAGE_SIZE))))
  }
  return { title: t.decision(decision.id), lines, actions: [{ id: 'decision:back', label: t.back }] }
}

function decisionsView(input: InspectorInput, t: InspectorStrings): InspectorModel {
  const own = input.decisions.filter(decision => decision.sessionId === input.sessionId)
  const ordered = [...own].sort((a, b) => b.at - a.at || compare(b.id, a.id))
  const selected = ordered.find(decision => decision.id === input.selectedDecisionId)
  if (selected) return decisionDetail(selected, input, t)
  const page = paginate(ordered, input.page)
  const lines: Line[] = []
  const actions: InspectorAction[] = []
  if (input.selectedDecisionId !== undefined) {
    lines.push([seg(t.decisionMissing, WARN)])
    actions.push({ id: 'decision:back', label: t.back })
  }
  if (own.length < input.decisions.length) lines.push([dim(t.hiddenDecisions(input.decisions.length - own.length))])
  if (ordered.length === 0) lines.push([dim(t.noDecisions)])
  page.items.forEach((decision, i) => {
    lines.push(decisionRow(i + 1, decision, input, t))
    actions.push({ id: `decision:${decision.id}`, label: `${i + 1} ${fit(decision.subject, 12)}` })
  })
  lines.push(...pageFooter(page, t))
  actions.push(...pageActions(page, t))
  return { title: t.decisions(ordered.length), lines, actions }
}

function verificationSegment(node: NodeRun, t: InspectorStrings): Segment | undefined {
  const status = node.verification?.status
  if (status === 'passed') return seg(t.verified, { color: 'green' })
  if (status === 'failed') return seg(t.verificationFailed, { color: 'red' })
  if (status === 'missing') return seg(t.noChecks, WARN)
  if (node.state === 'completed') return seg(t.unverified, WARN)
  return undefined
}

function nodeLine(node: NodeRun, t: InspectorStrings, s: Strings, waiting?: ReadonlyMap<string, string>): Line {
  const style = stateStyle(node.state)
  const line = indented(seg(`${ICON[node.state]} `, style), bold(node.id), seg(`  ${s.state[node.state]}`, style))
  const tool = node.state === 'running' && node.agentId ? waiting?.get(node.agentId) : undefined
  if (tool !== undefined) line.push(dim(' · '), seg(s.waitingPermission(tool), { color: 'yellow', bold: true }))
  const verification = verificationSegment(node, t)
  if (verification) line.push(dim(' · '), verification)
  if (node.recovery) line.push(dim(` · ${t.recovery(node.recovery.used, MAX_AUTO_RECOVERIES)}`))
  line.push(dim(` · ${s.attempt(Math.max(node.attempt, 1))}`))
  return line
}

function evidenceLine(node: NodeRun, evidence: VerificationEvidence, now: number, t: InspectorStrings): Line {
  const check = evidence.check.kind === 'file' ? `file ${evidence.check.path}` : `cmd ${evidence.check.argv.join(' ')}`
  const exit = evidence.exitCode === undefined ? '' : `${t.exit(evidence.exitCode)} · `
  return indented(
    seg(evidence.passed ? '✓ ' : '× ', { color: evidence.passed ? 'green' : 'red' }),
    bold(node.id),
    seg(`  ${check}`),
    dim(` · ${exit}${since(now, evidence.checkedAt, t)}`),
  )
}

function contextView(input: InspectorInput, t: InspectorStrings, s: Strings): InspectorModel {
  const { columns, context: record } = input
  const lines: Line[] = []
  const foreign = record.projectRoot !== input.projectRoot || record.sessionId !== input.sessionId
  if (foreign) lines.push([seg(t.foreignContext, WARN)])
  const requests = foreign ? [] : record.requests
  const notes = foreign ? [] : record.notes

  const current = requests.at(-1)
  lines.push([heading(t.objective), ...(current ? [dim(`  ${t.request(requests.length, requests.length)} · ${since(input.now, current.at, t)}`)] : [])])
  if (current) lines.push(...wrap(current.text, columns - 2, 4).map(part => indented(seg(part))))
  else lines.push(indented(dim(t.noObjective)))

  const page = paginate(notes, input.page)
  lines.push([], [heading(t.notes(notes.length)), dim(`  ${t.notesHint}`)])
  if (notes.length === 0) lines.push(indented(dim(t.noNotes)))
  page.items.forEach((note, i) => lines.push(indented(dim(`#${page.index * PAGE_SIZE + i + 1} `), seg(note.text))))
  lines.push(...pageFooter(page, t))

  const owned = input.runs.filter(run => run.sessionId === input.sessionId)
  const selected = owned.find(run => run.runId === input.selectedRunId)
  const run = selected ?? [...owned].sort(byRelevance)[0]
  lines.push([], [heading(t.scope)])
  const other = selected ? undefined : input.runs.find(candidate => candidate.runId === input.selectedRunId)
  if (other) lines.push(indented(dim(t.foreignRun(short(other.sessionId)))))
  if (!run) lines.push(indented(dim(t.noRun)))
  else {
    lines.push(runLine(run, s))
    if (run.handoff) lines.push(indented(seg(handoffText(run.handoff, input, t), WARN)))
    const writes = [...new Set(run.definition.nodes.flatMap(node => node.writes ?? []))]
    lines.push(indented(dim(writes.length ? t.writes(writes.join(', ')) : t.noWrites)))
    const nodes = [...run.nodes].sort((a, b) => NODE_PRIORITY[a.state] - NODE_PRIORITY[b.state])
    for (const node of nodes.slice(0, PAGE_SIZE)) lines.push(nodeLine(node, t, s, input.waiting))
    if (nodes.length > PAGE_SIZE) lines.push(indented(dim(t.more(nodes.length - PAGE_SIZE))))

    lines.push([], [heading(t.evidence)])
    const evidence = run.nodes.flatMap(node => (node.verification?.evidence ?? []).map(entry => ({ node, entry })))
    if (evidence.length === 0) lines.push(indented(dim(t.noEvidence)))
    for (const { node, entry } of evidence.slice(0, PAGE_SIZE)) lines.push(evidenceLine(node, entry, input.now, t))
    if (evidence.length > PAGE_SIZE) lines.push(indented(dim(t.more(evidence.length - PAGE_SIZE))))
  }

  lines.push([], [heading(t.sources)])
  lines.push(sourceLine(t.contextFile, input.contextPath, columns))
  if (run) {
    lines.push(sourceLine(t.checkpoint, `${input.projectRoot}/.claude/dag/runs/${run.runId}.json`, columns))
    const reports = run.nodes.flatMap(node => [
      ...(node.reportPath ? [{ label: t.report(node.id), path: node.reportPath }] : []),
      ...(node.verification?.reportPath ? [{ label: t.check(node.id), path: node.verification.reportPath }] : []),
    ])
    for (const report of reports.slice(0, PAGE_SIZE)) lines.push(sourceLine(report.label, report.path, columns))
    if (reports.length > PAGE_SIZE) lines.push(indented(dim(t.more(reports.length - PAGE_SIZE))))
  }
  return { title: t.context, lines, actions: pageActions(page, t) }
}

function sessionRows(ordinal: number, session: ProjectedSession, conflict: boolean, input: InspectorInput, t: InspectorStrings): Line[] {
  const self = session.sessionId === input.sessionId
  const { icon, style } = LIVENESS_STYLE[session.liveness]
  const head: Line = [dim(`${ordinal} `), seg(`${icon} `, style)]
  const meta = [t.liveness[session.liveness], since(input.now, session.updatedAt, t), t.runs(session.runIds.length), t.writesCount(session.writes.length)].join(' · ')
  const trailer: Line = [
    ...(self ? [seg(` · ${t.thisSession}`, CHOSEN)] : []),
    ...(conflict ? [seg(' ⚠', WARN)] : []),
  ]
  const idStyle: Style = self ? { bold: true } : {}
  const indent = seg(' '.repeat(lineWidth(head)))
  if (width(session.sessionId) + lineWidth(head) + 2 + width(meta) + lineWidth(trailer) <= input.columns) {
    return [[...head, seg(session.sessionId, idStyle), dim(`  ${meta}`), ...trailer]]
  }
  const chunks = wrap(session.sessionId, input.columns - lineWidth(head), 3)
  return [
    [...head, seg(chunks[0] ?? '', idStyle)],
    ...chunks.slice(1).map(chunk => [indent, seg(chunk, idStyle)]),
    [indent, dim(meta), ...trailer],
  ]
}

function sessionsView(input: InspectorInput, t: InspectorStrings, s: Strings): InspectorModel {
  const { columns } = input
  const projected = projectSessions(input.sessions, input.projectRoot, input.now)
  const conflicts = sessionConflicts(input.sessions, input.projectRoot, input.now)
  const conflicted = new Set(conflicts.flatMap(conflict => conflict.sessionIds))
  const ordered = [...projected].sort((a, b) =>
    Number(b.sessionId === input.sessionId) - Number(a.sessionId === input.sessionId)
    || LIVENESS_RANK[a.liveness] - LIVENESS_RANK[b.liveness]
    || b.updatedAt - a.updatedAt
    || compare(a.sessionId, b.sessionId))
  const page = paginate(ordered, input.page)
  const lines: Line[] = [[dim(`${t.project} `), seg(fitTail(input.projectRoot, columns - 1 - width(t.project)))]]
  const actions: InspectorAction[] = []
  if (projected.length < input.sessions.length) lines.push([dim(t.hiddenSessions(input.sessions.length - projected.length))])
  if (conflicts.length === 0) lines.push([dim(t.noConflicts)])
  else {
    lines.push([seg(`⚠ ${t.conflicts(conflicts.length)}`, WARN)])
    for (const conflict of conflicts.slice(0, 4)) {
      lines.push(indented(
        dim(`${short(conflict.sessionIds[0] ?? '')} ↔ ${short(conflict.sessionIds[1] ?? '')} · `),
        seg(`${conflict.writes[0] ?? ''} ↔ ${conflict.writes[1] ?? ''}`),
      ))
    }
    if (conflicts.length > 4) lines.push(indented(dim(t.more(conflicts.length - 4))))
  }
  lines.push([])
  if (ordered.length === 0) lines.push([dim(t.noSessions)])
  page.items.forEach((session, i) => lines.push(...sessionRows(i + 1, session, conflicted.has(session.sessionId), input, t)))
  lines.push(...pageFooter(page, t))
  actions.push(...pageActions(page, t))

  lines.push([], [heading(t.handoff)])
  const selected = input.runs.find(run => run.runId === input.selectedRunId)
  if (!selected) lines.push(indented(dim(t.selectRun)))
  else if (selected.sessionId !== input.sessionId) lines.push(indented(dim(t.foreignRun(short(selected.sessionId)))))
  else {
    lines.push(runLine(selected, s))
    if (selected.handoff) {
      lines.push(indented(seg(handoffText(selected.handoff, input, t), WARN)))
      if (selected.handoff.from === input.sessionId) actions.push({ id: `handoff-cancel:${selected.runId}`, label: t.cancelHandoff })
    } else {
      const targets = page.items.filter(session => session.liveness === 'active' && session.sessionId !== input.sessionId)
      lines.push(indented(dim(targets.length ? t.targets(targets.length) : t.noTargets)))
      for (const target of targets) actions.push({ id: `handoff:${target.sessionId}`, label: t.handoffAction(short(target.sessionId)) })
    }
  }

  const outgoing = input.runs.filter(run => run.sessionId === input.sessionId && run.handoff?.from === input.sessionId && run.runId !== selected?.runId)
  if (outgoing.length > 0) {
    lines.push([], [heading(t.outgoing(outgoing.length))])
    for (const run of outgoing.slice(0, PAGE_SIZE)) {
      if (!run.handoff) continue
      lines.push(indented(bold(run.name), dim(` · ${handoffText(run.handoff, input, t)}`)))
      actions.push({ id: `handoff-cancel:${run.runId}`, label: `${t.cancelHandoff} · ${fit(run.name, 12)}` })
    }
    if (outgoing.length > PAGE_SIZE) lines.push(indented(dim(t.more(outgoing.length - PAGE_SIZE))))
  }

  const incoming = input.runs.filter(run => run.handoff?.to === input.sessionId)
  if (incoming.length > 0) {
    lines.push([], [heading(t.incoming(incoming.length))])
    for (const run of incoming.slice(0, PAGE_SIZE)) {
      if (!run.handoff) continue
      lines.push(indented(bold(run.name), dim(` · ${handoffText(run.handoff, input, t)}`)))
      if (run.handoff.offeredAt !== undefined) actions.push({ id: `accept:${run.runId}`, label: t.accept(fit(run.name, 12)) })
    }
    if (incoming.length > PAGE_SIZE) lines.push(indented(dim(t.more(incoming.length - PAGE_SIZE))))
  }
  return { title: t.sessions(projected.length), lines, actions }
}

export function buildInspector(input: InspectorInput): InspectorModel {
  if (!(input.columns > 0)) return { title: '', lines: [], actions: [] }
  const t = input.language === 'ko' ? KO : EN
  const s = stringsFor(input.language)
  const model = input.view === 'decisions' ? decisionsView(input, t)
    : input.view === 'context' ? contextView(input, t, s)
      : sessionsView(input, t, s)
  return {
    title: fit(model.title, input.columns),
    lines: model.lines.map(line => clip(line, input.columns)),
    actions: model.actions.map(action => ({ id: action.id, label: fit(action.label, Math.min(LABEL_WIDTH, input.columns)) })),
  }
}
