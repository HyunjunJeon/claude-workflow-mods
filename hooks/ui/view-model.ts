import { layers } from '../engine/graph.ts'
import { STATUS_PREFIX } from '../engine/node-prompt.ts'
import { awaitingApproval } from '../engine/run.ts'
import type { NodeRun, NodeState, Run, RunStatus } from '../engine/types.ts'
import { isStalled, type Activity } from './activity.ts'
import type { GraphModel, GraphNode, ViewKind } from './graph-model.ts'
import { ACCENT, formatDuration, type Line, type Segment } from './text.ts'
import { DEFAULT_STRINGS, type Strings } from './i18n.ts'

export type { Line, Segment } from './text.ts'
export { formatDuration } from './text.ts'
export type Card = { id: string; expanded: boolean; selected: boolean; header: Line; lines: Line[] }
export type RunRow = { index: number; selected: boolean; line: Line }
export type RunSelector = { heading: Line; rows: RunRow[]; completed: Line | null }
export type PaneModel = {
  header: Line[]
  runs: RunSelector | null
  graph: GraphModel | null
  dependencies: Line[]
  cards: Card[]
  errors: Line[]
  empty?: string
}

export type CollapsePrefs = Record<string, Record<string, boolean>>
export type ViewMode = 'dag' | 'tasks'
export type ViewState = {
  runIndex: number
  details: boolean
  prefs: CollapsePrefs
  mode?: ViewMode
  selected?: string
  showCompleted?: boolean
  graphView?: ViewKind
  unfold?: boolean
}
/** `waiting` maps a worker's agent id to the tool whose permission answer it waits for. */
export type ViewContext = { activity?: ReadonlyMap<string, Activity>; waiting?: ReadonlyMap<string, string>; t?: Strings; taskCount?: number }

export type AgentSummary = { id: string; description: string; type: string; status: string }

const ICON: Record<NodeState, string> = {
  pending: '○',
  blocked: '◌',
  scheduled: '◷',
  running: '●',
  paused: 'Ⅱ',
  completed: '✓',
  failed: '×',
  cancelled: '−',
  skipped: '·',
}

const COLOR: Partial<Record<NodeState | RunStatus, string>> = {
  running: ACCENT,
  scheduled: ACCENT,
  blocked: 'yellow',
  paused: 'yellow',
  completed: 'green',
  failed: 'red',
}

const STALLED_COLOR = 'yellow'
const WAITING_COLOR = 'yellow'
const DIM_STATES: ReadonlySet<NodeState> = new Set(['pending', 'skipped'])
const SETTLED_NODES: ReadonlySet<NodeState> = new Set(['completed', 'failed', 'cancelled', 'skipped'])
const SELECTOR_LIMIT = 5

function styled(text: string, state: NodeState | RunStatus): Segment {
  const color = COLOR[state]
  if (color) return { text, color }
  return DIM_STATES.has(state as NodeState) ? { text, dim: true } : { text }
}

export function visibleRuns(all: Run[], sessionId: string): Run[] {
  const newestFirst = [...all].sort((a, b) => b.createdAt - a.createdAt)
  const own = newestFirst.filter(r => r.sessionId === sessionId)
  return own.length > 0 ? own : newestFirst.slice(0, 10)
}

export function isExpanded(run: Run, node: NodeRun, prefs: CollapsePrefs): boolean {
  return prefs[run.runId]?.[node.id] ?? node.state === 'running'
}

export function clampRunIndex(index: number, count: number): number {
  if (count === 0) return 0
  return ((index % count) + count) % count
}

function edgesOf(run: Run): { from: string; to: string }[] {
  return run.definition.nodes.flatMap(n => n.dependsOn.map(dep => ({ from: dep, to: n.id })))
}

export function nodeOrder(run: Run): string[] {
  return layers(run.nodes.map(n => n.id), edgesOf(run)).flat()
}

export function stepSelection(order: string[], current: string | undefined, step: 1 | -1): string | undefined {
  if (order.length === 0) return undefined
  const at = current === undefined ? -1 : order.indexOf(current)
  if (at === -1) return step === 1 ? order[0] : order[order.length - 1]
  return order[(at + step + order.length) % order.length]
}

function lastAnswerLine(answer: string | undefined): string | undefined {
  const lines = (answer ?? '').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith(STATUS_PREFIX))
  return lines.at(-1)
}

function elapsed(node: NodeRun, now: number): string | undefined {
  if (node.startedAt === undefined) return undefined
  return formatDuration((node.finishedAt ?? now) - node.startedAt)
}

// The tool slot of the activity a node shows while it waits on background work it started. It is no host tool: the plugin
// sets it and this module turns it into the localized label, as it does for SubagentHandback.
export const BACKGROUND_WAIT_TOOL = 'dag:background-wait'

function toolName(activity: Activity, t: Strings): string {
  if (activity.tool === 'SubagentHandback') return t.handback
  if (activity.tool === BACKGROUND_WAIT_TOOL) return t.backgroundWait
  return activity.tool ?? 'tool'
}

export function activityLine(activity: Activity, now: number, t: Strings): Line {
  const since = formatDuration(now - activity.since)
  const quiet = formatDuration(now - activity.lastAt)
  const text =
    activity.phase === 'waiting' ? t.waitingModel(since)
      : activity.phase === 'thinking' ? `${t.thinking(since)} · ${quiet}`
        : activity.phase === 'responding' ? t.responding(activity.text ?? '')
          : activity.phase === 'tool-input' ? t.writingTool(toolName(activity, t))
            : t.runningTool(toolName(activity, t), since)
  if (isStalled(activity, now)) return [{ text: `${t.stalled} · `, color: STALLED_COLOR }, { text, color: STALLED_COLOR }]
  return [{ text, dim: true }]
}

export function compactActivity(activity: Activity, now: number, t: Strings): { head: string; tail: string } {
  const since = formatDuration(now - activity.since)
  const gap = now - activity.lastAt
  const ago = gap < 2_000 ? t.now : formatDuration(gap)
  const head =
    activity.phase === 'waiting' ? `… ${since}`
      : activity.phase === 'thinking' ? `✻ ${ago}`
        : activity.phase === 'responding' ? `✎ ${ago}`
          : activity.phase === 'tool-input' ? `⚙ ${toolName(activity, t)}`
            : `▶ ${toolName(activity, t)} ${since}`
  return {
    head: isStalled(activity, now) ? `⚠ ${head}` : head,
    tail: activity.phase === 'responding' ? activity.text ?? '' : '',
  }
}

function progressLine(node: NodeRun, activity: Activity | undefined, now: number, t: Strings): Line {
  if (node.error) return [{ text: node.error, color: 'red' }]
  if (node.state === 'running') return activity ? activityLine(activity, now, t) : [{ text: t.working, dim: true }]
  if (node.state === 'pending') return [{ text: t.waitingDeps, dim: true }]
  if (node.state === 'scheduled') return [{ text: t.waitingSlot, dim: true }]
  const firstOutputLine = node.output?.split('\n').map(l => l.trim()).find(Boolean)
  return [{ text: firstOutputLine ?? lastAnswerLine(node.answer) ?? t.state[node.state], dim: true }]
}

type Ctx = { activity: ReadonlyMap<string, Activity>; waiting: ReadonlyMap<string, string>; t: Strings }

function liveActivity(node: NodeRun, ctx: Ctx): Activity | undefined {
  return node.agentId && node.state === 'running' ? ctx.activity.get(node.agentId) : undefined
}

function waitingBadge(node: NodeRun, ctx: Ctx): string | undefined {
  const tool = node.agentId && node.state === 'running' ? ctx.waiting.get(node.agentId) : undefined
  return tool === undefined ? undefined : ctx.t.waitingPermission(tool)
}

function nodeColor(node: NodeRun, activity: Activity | undefined, now: number, waiting?: string): string {
  if (waiting !== undefined) return WAITING_COLOR
  if (activity !== undefined && isStalled(activity, now)) return STALLED_COLOR
  return COLOR[node.state] ?? ''
}

function graphNode(run: Run, node: NodeRun, view: ViewState, now: number, ctx: Ctx): GraphNode {
  const activity = liveActivity(node, ctx)
  const waiting = waitingBadge(node, ctx)
  const live = waiting ? { head: waiting, tail: '' } : activity ? compactActivity(activity, now, ctx.t) : { head: '', tail: '' }
  return {
    id: node.id,
    label: node.label,
    icon: ICON[node.state],
    state: ctx.t.state[node.state],
    color: nodeColor(node, activity, now, waiting),
    activity: live.head,
    tail: live.tail,
    ...(waiting ? { waiting } : {}),
    incoming: run.definition.nodes.find(n => n.id === node.id)?.dependsOn ?? [],
    selected: view.selected === node.id,
    expanded: isExpanded(run, node, view.prefs),
    startedAt: node.startedAt ?? null,
    finishedAt: node.finishedAt ?? null,
  }
}

function cardFor(run: Run, node: NodeRun, view: ViewState, now: number, ctx: Ctx): Card {
  const { t } = ctx
  const def = run.definition.nodes.find(n => n.id === node.id)
  const deps = def?.dependsOn ?? []
  const activity = liveActivity(node, ctx)
  const waiting = waitingBadge(node, ctx)
  const color = nodeColor(node, activity, now, waiting)
  const selected = view.selected === node.id
  const paint = (text: string): Segment => (color ? { text, color } : DIM_STATES.has(node.state) ? { text, dim: true } : { text })
  const header: Line = [
    ...(selected ? [{ text: '> ', color: ACCENT, bold: true as const }] : []),
    paint(`${ICON[node.state]} `),
    { text: node.id, bold: true },
    ...(node.label !== node.id ? [{ text: ` ${node.label}` }] : []),
    paint(`  ${t.state[node.state]}`),
    ...(waiting ? [{ text: `  ${waiting}`, color: WAITING_COLOR, bold: true as const }] : []),
    ...(deps.length ? [{ text: `  ← ${deps.join(', ')}`, dim: true as const }] : []),
  ]
  const expanded = isExpanded(run, node, view.prefs)
  if (!expanded) return { id: node.id, expanded, selected, header, lines: [] }

  const who = [
    node.agentId ? `agent ${node.agentId.slice(0, 10)}` : t.notStarted,
    node.model ?? (def?.category ? t.category(def.category) : t.sessionModel),
    ...(def?.agent ? [def.agent] : []),
  ].join(' · ')
  const timing = [t.attempt(Math.max(node.attempt, 1)), elapsed(node, now)].filter(Boolean).join(' · ')
  const lines: Line[] = [
    ...(def?.task_summary || def?.description ? [[{ text: def.task_summary ?? def.description ?? '' }]] : []),
    [{ text: who, dim: true }],
    waiting ? [{ text: waiting, color: WAITING_COLOR }] : progressLine(node, activity, now, t),
    [{ text: timing, dim: true }],
  ]
  if (view.details) {
    if (node.agentId) lines.push([{ text: `task ${node.agentId}`, dim: true }])
    if (node.reportPath) lines.push([{ text: `report ${node.reportPath}`, dim: true }])
    const shown = node.output || node.answer
    if (shown) lines.push([{ text: shown.slice(0, 600) }])
  }
  return { id: node.id, expanded, selected, header, lines }
}

function isActive(run: Run): boolean {
  return run.status === 'running' || run.nodes.some(n => n.state === 'running')
}

function runSelector(runs: Run[], index: number, view: ViewState, t: Strings): RunSelector | null {
  if (runs.length < 2) return null
  const all = runs.map((_, i) => i)
  const active = all.filter(i => isActive(runs[i] as Run))
  const settled = all.filter(i => !isActive(runs[i] as Run))
  const showCompleted = view.showCompleted === true || !active.includes(index)
  const listed = [...active, ...(showCompleted ? settled : [])]
  const at = Math.max(0, listed.indexOf(index))
  const start = listed.length <= SELECTOR_LIMIT ? 0 : Math.min(Math.max(0, at - SELECTOR_LIMIT + 1), listed.length - SELECTOR_LIMIT)
  const rows = listed.slice(start, start + SELECTOR_LIMIT).map(i => {
    const run = runs[i] as Run
    const selected = i === index
    const done = run.nodes.filter(n => n.state === 'completed').length
    const running = run.nodes.filter(n => n.state === 'running').length
    const waiting = run.nodes.filter(n => !SETTLED_NODES.has(n.state) && n.state !== 'running').length
    // A held run has started nothing; its nodes are not "waiting" for a slot, so it reads as waiting for the person instead.
    const counts = awaitingApproval(run) ? `${t.done(done, run.nodes.length)} · ${t.awaitingApproval}` : t.runSummary(done, run.nodes.length, running, waiting)
    const text = `${selected ? '>' : ' '} ${run.name}  ${counts}`
    return { index: i, selected, line: [selected ? { text, color: ACCENT, bold: true as const } : { text }] }
  })
  return {
    heading: [{ text: t.activeRuns(active.length), color: ACCENT }],
    rows,
    completed: settled.length ? [{ text: `${t.completedRuns(settled.length)} ${showCompleted ? '[-]' : '[+]'}` }] : null,
  }
}

export function buildPane(runs: Run[], view: ViewState, now: number, context: ViewContext = {}): PaneModel {
  const ctx: Ctx = { activity: context.activity ?? new Map(), waiting: context.waiting ?? new Map(), t: context.t ?? DEFAULT_STRINGS }
  const { t } = ctx
  const top: Line = [{ text: `DAG ${t.tasksSwitch(context.taskCount ?? 0)}`, color: ACCENT, bold: true }]
  if (runs.length === 0) return { header: [top], runs: null, graph: null, dependencies: [], cards: [], errors: [], empty: t.empty }
  const index = clampRunIndex(view.runIndex, runs.length)
  const run = runs[index] as Run
  const done = run.nodes.filter(n => n.state === 'completed').length
  const failed = run.nodes.filter(n => n.state === 'failed').length
  const header: Line[] = [
    top,
    [{ text: run.name, bold: true }, { text: `  ${t.runOf(index + 1, runs.length, run.runId)}`, dim: true }],
    [
      awaitingApproval(run) ? { text: t.awaitingApproval, color: WAITING_COLOR } : styled(t.state[run.status], run.status),
      { text: ` · ${t.done(done, run.nodes.length)}` },
      ...(failed ? [{ text: ` · ${t.failedCount(failed)}`, color: 'red' }] : []),
    ],
  ]
  const edges = edgesOf(run)
  const byId = new Map(run.nodes.map(n => [n.id, n]))
  return {
    header,
    runs: runSelector(runs, index, view, t),
    graph: {
      nodes: run.nodes.map(node => graphNode(run, node, view, now, ctx)),
      edges,
      view: view.graphView ?? 'auto',
      unfold: view.unfold === true,
      now,
      labels: {
        startNode: t.startNode,
        sameFrontier: t.sameFrontier,
        more: t.more,
        graph: t.viewGraph,
        lanes: t.viewLanes,
        timeline: t.viewTimeline,
        auto: t.viewAuto,
        notStarted: t.timelineEmpty,
        critical: t.critical,
      },
    } satisfies GraphModel,
    dependencies: edges.length ? edges.map(e => [{ text: `  ${e.from} → ${e.to}` }]) : [[{ text: `  ${t.none}`, dim: true }]],
    cards: nodeOrder(run).map(id => cardFor(run, byId.get(id) as NodeRun, view, now, ctx)),
    errors: run.nodes.filter(n => n.error).map(n => [{ text: `× ${n.id}: ${n.error}`, color: 'red' }]),
  }
}

const TASK_ICON: Record<string, string> = { running: '●', completed: '✓', failed: '×', killed: '−' }
const TASK_COLOR: Record<string, string> = { running: ACCENT, completed: 'green', failed: 'red' }

export function buildTasks(agents: AgentSummary[], dagAgents: ReadonlySet<string>, now: number, context: ViewContext = {}): { header: Line; rows: Line[][] } {
  const t = context.t ?? DEFAULT_STRINGS
  const activity = context.activity ?? new Map<string, Activity>()
  const tasks = agents
    .filter(a => !dagAgents.has(a.id))
    .sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running'))
  const header: Line = [{ text: t.tasksHeader(tasks.length), bold: true }]
  if (tasks.length === 0) return { header, rows: [[[{ text: t.noTasks, dim: true }]]] }
  const rows = tasks.map(task => {
    const color = TASK_COLOR[task.status]
    const title: Line = [
      { text: `${TASK_ICON[task.status] ?? '○'} `, ...(color ? { color } : { dim: true as const }) },
      { text: task.description || task.id, bold: true },
      { text: `  ${task.type} · ${task.status}`, dim: true },
    ]
    const live = task.status === 'running' ? activity.get(task.id) : undefined
    return live ? [title, [{ text: '    ' }, ...activityLine(live, now, t)]] : [title]
  })
  return { header, rows }
}

export function countTasks(agents: AgentSummary[], dagAgents: ReadonlySet<string>): number {
  return agents.filter(a => !dagAgents.has(a.id)).length
}
