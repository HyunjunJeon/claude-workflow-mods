import { layers } from '../engine/graph.ts'
import { STATUS_PREFIX } from '../engine/node-prompt.ts'
import type { NodeRun, NodeState, Run, RunStatus } from '../engine/types.ts'
import { isStalled, type Activity } from './activity.ts'
import { DEFAULT_STRINGS, type Strings } from './i18n.ts'

export type Segment = { text: string; color?: string; bold?: true; dim?: true }
export type Line = Segment[]
export type Card = { id: string; expanded: boolean; header: Line; lines: Line[] }
export type PaneModel = { header: Line; layers: Line[]; cards: Card[]; empty?: string }

export type CollapsePrefs = Record<string, Record<string, boolean>>
export type ViewMode = 'dag' | 'tasks'
export type ViewState = { runIndex: number; details: boolean; prefs: CollapsePrefs; mode?: ViewMode }
export type ViewContext = { activity?: ReadonlyMap<string, Activity>; t?: Strings }

export type AgentSummary = { id: string; description: string; type: string; status: string }

const ICON: Record<NodeState, string> = {
  pending: '○',
  blocked: '○',
  scheduled: '◌',
  running: '●',
  paused: '‖',
  completed: '✓',
  failed: '✗',
  cancelled: '■',
  skipped: '⊘',
}

const COLOR: Partial<Record<NodeState | RunStatus, string>> = {
  running: 'yellow',
  scheduled: 'cyan',
  paused: 'magenta',
  completed: 'green',
  failed: 'red',
  cancelled: 'red',
}

const STALLED_COLOR = 'magenta'
const DIM_STATES: ReadonlySet<NodeState> = new Set(['pending', 'blocked', 'skipped'])

function styled(text: string, state: NodeState | RunStatus): Segment {
  const color = COLOR[state]
  if (color) return { text, color }
  return DIM_STATES.has(state as NodeState) ? { text, dim: true } : { text }
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
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

function lastAnswerLine(answer: string | undefined): string | undefined {
  const lines = (answer ?? '').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith(STATUS_PREFIX))
  return lines.at(-1)
}

function elapsed(node: NodeRun, now: number): string | undefined {
  if (node.startedAt === undefined) return undefined
  return formatDuration((node.finishedAt ?? now) - node.startedAt)
}

export function activityLine(activity: Activity, now: number, t: Strings): Line {
  const since = formatDuration(now - activity.since)
  const quiet = formatDuration(now - activity.lastAt)
  const text =
    activity.phase === 'waiting' ? t.waitingModel(since)
      : activity.phase === 'thinking' ? `${t.thinking(since)} · ${quiet}`
        : activity.phase === 'responding' ? t.responding(activity.text ?? '')
          : activity.phase === 'tool-input' ? t.writingTool(activity.tool ?? 'tool')
            : t.runningTool(activity.tool ?? 'tool', since)
  if (isStalled(activity, now)) return [{ text: `${t.stalled} · `, color: STALLED_COLOR }, { text, color: STALLED_COLOR }]
  return [{ text, dim: true }]
}

function progressLine(node: NodeRun, activity: Activity | undefined, now: number, t: Strings): Line {
  if (node.error) return [{ text: node.error, color: 'red' }]
  if (node.state === 'running') return activity ? activityLine(activity, now, t) : [{ text: t.working, dim: true }]
  if (node.state === 'pending') return [{ text: t.waitingDeps, dim: true }]
  if (node.state === 'scheduled') return [{ text: t.waitingSlot, dim: true }]
  const firstOutputLine = node.output?.split('\n').map(l => l.trim()).find(Boolean)
  return [{ text: firstOutputLine ?? lastAnswerLine(node.answer) ?? t.state[node.state], dim: true }]
}

function cardFor(run: Run, node: NodeRun, view: ViewState, now: number, ctx: Required<ViewContext>): Card {
  const { t } = ctx
  const def = run.definition.nodes.find(n => n.id === node.id)
  const deps = def?.dependsOn ?? []
  const activity = node.agentId && node.state === 'running' ? ctx.activity.get(node.agentId) : undefined
  const stalled = activity !== undefined && isStalled(activity, now)
  const header: Line = [
    stalled ? { text: `${ICON[node.state]} `, color: STALLED_COLOR } : styled(`${ICON[node.state]} `, node.state),
    { text: node.id, bold: true },
    ...(node.label !== node.id ? [{ text: ` ${node.label}` }] : []),
    styled(`  ${t.state[node.state]}`, node.state),
    ...(deps.length ? [{ text: `  ← ${deps.join(', ')}`, dim: true as const }] : []),
  ]
  const expanded = isExpanded(run, node, view.prefs)
  if (!expanded) return { id: node.id, expanded, header, lines: [] }

  const who = [
    node.agentId ? `agent ${node.agentId.slice(0, 10)}` : t.notStarted,
    node.model ?? (def?.category ? t.category(def.category) : t.sessionModel),
    ...(def?.agent ? [def.agent] : []),
  ].join(' · ')
  const timing = [t.attempt(Math.max(node.attempt, 1)), elapsed(node, now)].filter(Boolean).join(' · ')
  const lines: Line[] = [
    ...(def?.task_summary || def?.description ? [[{ text: def.task_summary ?? def.description ?? '' }]] : []),
    [{ text: who, dim: true }],
    progressLine(node, activity, now, t),
    [{ text: timing, dim: true }],
  ]
  if (view.details) {
    if (node.agentId) lines.push([{ text: `task ${node.agentId}`, dim: true }])
    if (node.reportPath) lines.push([{ text: `report ${node.reportPath}`, dim: true }])
    const shown = node.output || node.answer
    if (shown) lines.push([{ text: shown.slice(0, 600) }])
  }
  return { id: node.id, expanded, header, lines }
}

export function buildPane(runs: Run[], view: ViewState, now: number, context: ViewContext = {}): PaneModel {
  const ctx: Required<ViewContext> = { activity: context.activity ?? new Map(), t: context.t ?? DEFAULT_STRINGS }
  const { t } = ctx
  if (runs.length === 0) return { header: [{ text: 'DAG', bold: true }], layers: [], cards: [], empty: t.empty }
  const index = clampRunIndex(view.runIndex, runs.length)
  const run = runs[index] as Run
  const done = run.nodes.filter(n => n.state === 'completed').length
  const header: Line = [
    { text: run.name, bold: true },
    styled(`  ${t.state[run.status]}`, run.status),
    { text: `  ${t.done(done, run.nodes.length)}`, dim: true },
    { text: `  ${t.runOf(index + 1, runs.length, run.runId)}`, dim: true },
  ]
  const byId = new Map(run.nodes.map(n => [n.id, n]))
  const edges = run.definition.nodes.flatMap(n => n.dependsOn.map(dep => ({ from: dep, to: n.id })))
  const rows = layers(run.nodes.map(n => n.id), edges)
  const layerLines: Line[] = rows.map((row, i) => [
    { text: `${i + 1} `, dim: true },
    ...row.flatMap((id, j) => {
      const node = byId.get(id) as NodeRun
      return [...(j > 0 ? [{ text: '  ' }] : []), styled(`${ICON[node.state]} ${id}`, node.state)]
    }),
  ])
  const cards = rows.flat().map(id => cardFor(run, byId.get(id) as NodeRun, view, now, ctx))
  return { header, layers: layerLines, cards }
}

const TASK_ICON: Record<string, string> = { running: '●', completed: '✓', failed: '✗', killed: '■' }
const TASK_COLOR: Record<string, string> = { running: 'yellow', completed: 'green', failed: 'red', killed: 'red' }

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
