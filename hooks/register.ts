import type { EngineInterface, On, PluginOptions } from 'claude-code'
import { parseDefinition } from './engine/definition.ts'
import { err, listText, nodeMessage, ok, settleMessage, splitArgs, statusText, type ToolReply } from './engine/format.ts'
import { buildNodePrompt, extractOutput, parseOutcome, spawnTarget, type UpstreamResult } from './engine/node-prompt.ts'
import { lintDefinition } from './engine/lint.ts'
import { denyMessage, isPlanningSkill, mainLoopVerdict, PLANNING_SKILL, planningRequired, protocolFor, type Enforcement } from './engine/policy.ts'
import {
  amendRun,
  cancelRun,
  createRun,
  failToStart,
  findReusable,
  isSettled,
  markFinished,
  markRunning,
  nextToStart,
  nodeForAgent,
  pauseRunning,
  requeueLost,
  resumePaused,
  retryRun,
  snapshotOf,
  advance,
} from './engine/run.ts'
import { expiredRuns } from './engine/retention.ts'
import { parseYaml } from './engine/yaml.ts'
import { INPUT_SCHEMA, TOOL_DESCRIPTION } from './engine/tool-spec.ts'
import type { Run } from './engine/types.ts'
import { chunkArrived, finalReport, fromTranscript, stepStarted, toolStarted, type Activity, type StepChunk, type TranscriptRow } from './ui/activity.ts'
import { stringsFor, type Strings } from './ui/i18n.ts'
import { buildPane, buildTasks, clampRunIndex, visibleRuns, type CollapsePrefs, type Line, type ViewState } from './ui/view-model.ts'

const TOOL_NAME = 'mcp__dag-workflow__dag'
const RUNS_SUBDIR = '.claude/dag/runs'
const USAGE = 'Usage: /dag [list | run <definition.json|.yaml> | status <run_id> | cancel <run_id> | retry <run_id> [node_id...] | enforce [strict|guide|off]]; /dag alone opens the DAG pane.'
const ENFORCEMENTS: readonly Enforcement[] = ['strict', 'guide', 'off']
const REPORT_LIMIT = 4_000_000
const HOLD_LIMIT_MS = 3_600_000
const PANE_ID = 'dag'
const PREFS_KEY = 'collapse-prefs'

type ToolInput = Readonly<Record<string, unknown>>
type RenderEvent = Parameters<EngineInterface['ui']['resolve']>[0]
type AgentEnd = { agentId: string; reason?: string; isAborted: boolean; answer?: string }

const runs = new Map<string, Run>()
const agentRuns = new Map<string, string>()
let sessionId = ''
let runsDir = ''
let queue: Promise<unknown> = Promise.resolve()
let view: ViewState = { runIndex: 0, details: false, prefs: {}, mode: 'dag' }
let paneClosedByUser = false
let maxConcurrent = 8
let retentionDays = 14
let t: Strings = stringsFor('en')
let nodeMessages: 'compact' | 'full' = 'compact'
let enforcement: Enforcement = 'strict'
let planningLoaded = false
let interactive = true
let extraAllowed: ReadonlySet<string> = new Set()
const reportDirsMade = new Set<string>()
const activity = new Map<string, Activity>()
const handbacks = new Map<string, string>()
const transcriptErrors = new Set<string>()
let ticks = 0

function serialized<T>(job: () => Promise<T>): Promise<T> {
  const result = queue.then(job)
  queue = result.catch(() => undefined)
  return result
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function persist($: EngineInterface, run: Run): Promise<void> {
  runs.set(run.runId, run)
  await $.fs.write(`${runsDir}/${run.runId}.json`, JSON.stringify(run, null, 2) + '\n')
}

async function loadRuns($: EngineInterface): Promise<void> {
  runsDir = `${await $.session.cwd()}/${RUNS_SUBDIR}`
  const made = await $.process.run(['mkdir', '-p', runsDir])
  if (made.exitCode !== 0) throw new Error(`cannot create ${runsDir}: ${made.stderr.trim()}`)
  for (const entry of await $.fs.list(runsDir)) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    try {
      const run = JSON.parse(await $.fs.read(`${runsDir}/${entry.name}`)) as Run
      if (run.schemaVersion === 1 && typeof run.runId === 'string') runs.set(run.runId, run)
    } catch (error) {
      $.ui.log(`skipped unreadable checkpoint ${entry.name}: ${message(error)}`)
    }
  }
  for (const run of expiredRuns([...runs.values()], await $.clock.now(), retentionDays, sessionId)) {
    const removed = await $.process.run(['rm', '-f', `${runsDir}/${run.runId}.json`])
    if (removed.exitCode === 0) runs.delete(run.runId)
    else $.ui.log(`could not prune expired checkpoint ${run.runId}: ${removed.stderr.trim()}`)
  }
}

async function recoverRuns($: EngineInterface): Promise<void> {
  const live = new Set((await $.agent.list()).filter(a => a.status === 'running').map(a => a.id))
  const now = await $.clock.now()
  for (const run of [...runs.values()]) {
    if (run.sessionId !== sessionId || run.status !== 'running') continue
    for (const node of run.nodes) {
      if (node.state === 'running' && node.agentId && live.has(node.agentId)) agentRuns.set(node.agentId, run.runId)
    }
    runs.set(run.runId, requeueLost(run, live, now))
    await tick($, run.runId)
  }
}

async function startNode($: EngineInterface, run: Run, id: string): Promise<Run> {
  const def = run.definition.nodes.find(n => n.id === id)
  const node = run.nodes.find(n => n.id === id)
  if (!def || !node) return run
  const target = spawnTarget(def)
  const upstream: UpstreamResult[] = def.dependsOn.flatMap(depId => {
    const dep = run.nodes.find(n => n.id === depId)
    if (!dep || dep.state !== 'completed') return []
    return [{ id: dep.id, label: dep.label, output: dep.output ?? '', ...(dep.reportPath ? { reportPath: dep.reportPath } : {}) }]
  })
  let spawned: { agentId?: string; model?: string; deny?: string }
  try {
    spawned = await $.agent.spawn({
      prompt: buildNodePrompt(run, def, node, upstream),
      description: `${run.name}: ${def.task_summary ?? def.label ?? def.id}`.slice(0, 80),
      subagentType: target.subagentType,
      ...(target.model ? { model: target.model } : {}),
    })
  } catch (error) {
    spawned = { deny: message(error) }
  }
  const now = await $.clock.now()
  if (spawned.agentId) {
    agentRuns.set(spawned.agentId, run.runId)
    return markRunning(run, id, spawned.agentId, now, spawned.model)
  }
  return failToStart(run, id, `Could not start the node agent: ${spawned.deny ?? 'no agent id was returned'}`, now)
}

async function tick($: EngineInterface, runId: string): Promise<Run | undefined> {
  const current = runs.get(runId)
  if (!current || current.sessionId !== sessionId) return current
  let run = advance(current, await $.clock.now())
  for (const id of nextToStart(run, maxConcurrent)) run = await startNode($, run, id)
  await persist($, run)
  await announce($, run)
  return run
}

async function announce($: EngineInterface, run: Run): Promise<void> {
  $.ui.invalidate('ui.render')
  if (!isSettled(run) || run.settledNotified) return
  const notified = { ...run, settledNotified: true }
  await persist($, notified)
  $.prompt.submit({ text: settleMessage(notified, TOOL_NAME) }).catch(error => {
    $.ui.log(`could not tell the session that ${run.runId} settled: ${message(error)}`)
  })
}

async function stopAgent($: EngineInterface, agentId: string): Promise<string | undefined> {
  try {
    await $.tool.call({ tool: 'TaskStop', task_id: agentId })
    return undefined
  } catch (error) {
    return message(error)
  }
}

async function onAgentDone($: EngineInterface, end: AgentEnd): Promise<void> {
  const runId = agentRuns.get(end.agentId)
  if (!runId) return
  agentRuns.delete(end.agentId)
  const report = handbacks.get(end.agentId)
  handbacks.delete(end.agentId)
  const run = runs.get(runId)
  const node = run && nodeForAgent(run, end.agentId)
  if (!run || !node) return
  const answer = end.answer || report || (end.isAborted ? '' : await recoverReport($, end.agentId))
  const parsed = parseOutcome({ reason: end.reason, isAborted: end.isAborted, answer })
  const reportPath = answer ? await writeReport($, runId, node.id, answer) : undefined
  const outcome = reportPath ? { ...parsed, reportPath } : parsed
  runs.set(runId, markFinished(run, node.id, outcome, await $.clock.now()))
  $.ui.log(`${run.name} › ${node.id}: ${outcome.state}${outcome.error ? ` (${outcome.error})` : ''}`)
  await tick($, runId)
}

async function writeReport($: EngineInterface, runId: string, nodeId: string, report: string): Promise<string | undefined> {
  const dir = `${runsDir}/${runId}`
  try {
    if (!reportDirsMade.has(dir)) {
      const made = await $.process.run(['mkdir', '-p', dir])
      if (made.exitCode !== 0) throw new Error(made.stderr.trim())
      reportDirsMade.add(dir)
    }
    const path = `${dir}/${nodeId}.md`
    await $.fs.write(path, report.slice(0, REPORT_LIMIT))
    return path
  } catch (error) {
    $.ui.log(`could not save the report of node ${nodeId}: ${message(error)}`)
    return undefined
  }
}

async function recoverReport($: EngineInterface, agentId: string): Promise<string> {
  const rows = await $.session.messages({ agentId })
  if (!Array.isArray(rows)) {
    $.ui.log(`cannot read the final report of agent ${agentId}: ${rows.deny}`)
    return ''
  }
  return finalReport(rows as TranscriptRow[])
}

async function startDefinition($: EngineInterface, input: unknown): Promise<ToolReply> {
  const parsed = parseDefinition(input)
  if (!parsed.ok) return err(parsed.error)
  const reusable = findReusable([...runs.values()], parsed.value)
  if (!reusable.ok) return err(reusable.error)
  if (reusable.value) return ok({ reused: true, run_id: reusable.value.runId, snapshot: snapshotOf(reusable.value) })
  const now = await $.clock.now()
  const runId = `dag_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const created = createRun(parsed.value, { runId, sessionId, now })
  runs.set(runId, created)
  view = { ...view, runIndex: 0 }
  const started = (await tick($, runId)) ?? created
  await openPane($, false)
  const warnings = [
    ...lintDefinition(parsed.value),
    ...(planningLoaded || enforcement === 'off' ? [] : [`the ${PLANNING_SKILL} skill is not loaded in this session - load it and follow its node prompt contract.`]),
  ]
  return ok({
    reused: false,
    run_id: runId,
    snapshot: snapshotOf(started, 0),
    warnings,
    note: 'The run continues in the background. You will receive a message when it settles; do not poll. Treat every warning as a defect in the definition.',
  })
}

async function handleTool($: EngineInterface, input: ToolInput): Promise<ToolReply> {
  if (input.action === 'start') return startDefinition($, input.definition)
  if (input.action === 'list') {
    return ok({
      runs: [...runs.values()]
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(r => ({ run_id: r.runId, run_key: r.key, name: r.name, status: r.status, session_id: r.sessionId, owned: r.sessionId === sessionId })),
    })
  }
  const run = typeof input.run_id === 'string' ? runs.get(input.run_id) : undefined
  if (!run) return err({ code: 'unknown_run', message: `No run "${String(input.run_id)}" in this project; use the list action to see runs.` })
  const now = await $.clock.now()

  if (input.action === 'snapshot') return ok(snapshotOf(run))
  if (input.action === 'wait') {
    const note = isSettled(run)
      ? 'The run has settled.'
      : 'wait cannot block inside Claude Code; the run is still active and you will receive a message when it settles.'
    return ok({ ...snapshotOf(run), note })
  }
  if (input.action === 'attach') {
    if (run.sessionId === sessionId) return ok(snapshotOf(run))
    const adopted = resumePaused(pauseRunning(run, now), sessionId, now)
    runs.set(run.runId, adopted)
    return ok({ adopted: true, snapshot: snapshotOf((await tick($, run.runId)) ?? adopted, 0) })
  }
  if (run.sessionId !== sessionId) {
    return err({ code: 'not_owner', message: `Run ${run.runId} belongs to session ${run.sessionId}; attach it first.` })
  }
  if (input.action === 'cancel') {
    const reason = typeof input.reason === 'string' && input.reason ? input.reason : 'cancelled on request'
    const { run: cancelled, stopAgents } = cancelRun(run, reason, now)
    await persist($, cancelled)
    const failures: { agent_id: string; error: string }[] = []
    for (const agentId of stopAgents) {
      const failure = await stopAgent($, agentId)
      if (failure) failures.push({ agent_id: agentId, error: failure })
    }
    await announce($, cancelled)
    return ok({ ...snapshotOf(cancelled, 0), ...(failures.length ? { stop_failures: failures } : {}) })
  }
  if (input.action === 'retry') {
    const nodeIds = Array.isArray(input.node_ids)
      ? input.node_ids.map(String)
      : typeof input.node_id === 'string' ? [input.node_id] : undefined
    const retried = retryRun(run, { ...(nodeIds ? { nodeIds } : {}), ...(typeof input.prompt === 'string' ? { prompt: input.prompt } : {}) }, now)
    if (!retried.ok) return err(retried.error)
    runs.set(run.runId, retried.value)
    return ok(snapshotOf((await tick($, run.runId)) ?? retried.value, 0))
  }
  if (input.action === 'amend') {
    const parsed = parseDefinition(input.definition)
    if (!parsed.ok) return err(parsed.error)
    const amended = amendRun(run, parsed.value, now)
    if (!amended.ok) return err(amended.error)
    runs.set(run.runId, amended.value.run)
    return ok({
      rerun: amended.value.rerun,
      snapshot: snapshotOf((await tick($, run.runId)) ?? amended.value.run, 0),
      warnings: lintDefinition(parsed.value),
    })
  }
  if (input.action === 'send') {
    const node = run.nodes.find(n => n.id === input.node_id)
    if (!node) return err({ code: 'unknown_node', message: `Node "${String(input.node_id)}" is not in run ${run.runId}.` })
    if (node.state !== 'running' || !node.agentId) {
      return err({ code: 'node_not_continuable', message: `Node "${node.id}" is ${node.state}; only a running node can be steered. Use retry with a prompt instead.` })
    }
    if (typeof input.message !== 'string' || input.message.trim() === '') {
      return err({ code: 'invalid_request', message: 'send needs a non-empty message.' })
    }
    const sent = await $.session.send({ to: { agentId: node.agentId }, text: input.message })
    return sent.isDelivered
      ? ok({ delivered: true, node_id: node.id })
      : err({ code: 'not_delivered', message: sent.reason ?? 'The message was not delivered.' })
  }
  return err({ code: 'invalid_request', message: `Unknown action "${String(input.action)}".` })
}

async function runCommand($: EngineInterface, args: string): Promise<{ text?: string }> {
  const [verb = 'open', ...rest] = splitArgs(args)
  if (verb === 'open') {
    await openPane($, true)
    return {}
  }
  if (verb === 'list') return { text: listText([...runs.values()], sessionId) }
  if (verb === 'enforce') {
    const level = rest[0] as Enforcement | undefined
    if (level && !ENFORCEMENTS.includes(level)) return { text: `Unknown enforcement level "${level}". Use strict, guide or off.` }
    if (level) enforcement = level
    return { text: `DAG enforcement: ${enforcement}` }
  }
  if (verb === 'run') {
    const given = rest.join(' ')
    if (!given) return { text: USAGE }
    const path = given.startsWith('/') ? given : `${await $.session.cwd()}/${given}`
    let input: unknown
    try {
      const source = await $.fs.read(path)
      input = /\.ya?ml$/i.test(path) ? parseYaml(source) : JSON.parse(source)
    } catch (error) {
      return { text: `Cannot read a DAG definition from ${path}: ${message(error)}` }
    }
    const reply = await startDefinition($, input)
    if (reply.isError) return { text: `DAG not started:\n${reply.result}` }
    const runId = (JSON.parse(reply.result) as { run_id: string; reused: boolean }).run_id
    const run = runs.get(runId)
    await openPane($, true)
    return { text: run ? statusText(run, sessionId) : reply.result }
  }
  if (verb !== 'status' && verb !== 'cancel' && verb !== 'retry') return { text: USAGE }
  const run = rest[0] ? runs.get(rest[0]) : undefined
  if (!run) return { text: `Unknown run "${rest[0] ?? ''}".\n${USAGE}` }
  if (verb === 'status') return { text: statusText(run, sessionId) }
  const reply = await handleTool($, {
    action: verb,
    run_id: run.runId,
    reason: 'cancelled from /dag',
    ...(verb === 'retry' && rest.length > 1 ? { node_ids: rest.slice(1) } : {}),
  })
  if (reply.isError) return { text: reply.result }
  return { text: statusText(runs.get(run.runId) ?? run, sessionId) }
}

async function openPane($: EngineInterface, byUser: boolean): Promise<void> {
  if (!byUser && paneClosedByUser) return
  if (byUser) paneClosedByUser = false
  try {
    await $.ui.open(byUser ? { id: PANE_ID, title: 'DAG', focus: true, closeOnEscape: true } : { id: PANE_ID, title: 'DAG' })
  } catch (error) {
    $.ui.log(`could not open the DAG pane: ${message(error)}`)
  }
}

async function loadPrefs($: EngineInterface): Promise<void> {
  const saved = await $.store.get(PREFS_KEY)
  if (saved === null || typeof saved !== 'object') return
  const entries = Object.entries(saved as CollapsePrefs)
  const kept = entries.filter(([runId]) => runs.has(runId))
  view = { ...view, prefs: Object.fromEntries(kept) }
  if (kept.length !== entries.length) await $.store.set(PREFS_KEY, view.prefs)
}

function nodeOfAgent(agentId: string): { run: Run; nodeId: string } | undefined {
  for (const run of runs.values()) {
    const node = run.nodes.find(n => n.agentId === agentId)
    if (node) return { run, nodeId: node.id }
  }
  return undefined
}

async function pollTranscripts($: EngineInterface): Promise<void> {
  for (const run of runs.values()) {
    if (run.sessionId !== sessionId) continue
    for (const node of run.nodes) {
      if (node.state !== 'running' || !node.agentId) continue
      const current = activity.get(node.agentId)
      if (current && !current.coarse) continue
      const rows = await $.session.messages({ agentId: node.agentId })
      if (!Array.isArray(rows)) {
        if (!transcriptErrors.has(node.agentId)) $.ui.log(`cannot read the transcript of node ${node.id}: ${rows.deny}`)
        transcriptErrors.add(node.agentId)
        continue
      }
      activity.set(node.agentId, fromTranscript(rows as TranscriptRow[], current, Date.now()))
    }
  }
}

async function holdUntilSettled($: EngineInterface): Promise<void> {
  const deadline = (await $.clock.now()) + HOLD_LIMIT_MS
  while (hasActiveRun()) {
    if ((await $.clock.now()) >= deadline) {
      $.ui.log(`stopped holding the session open after ${HOLD_LIMIT_MS / 60_000} minutes; a DAG run is still active`)
      return
    }
    try {
      await $.process.run(['sleep', '1'])
    } catch (error) {
      $.ui.log(`could not keep the session open for the active DAG run: ${message(error)}`)
      return
    }
  }
}

function hasActiveRun(): boolean {
  return [...runs.values()].some(r => r.sessionId === sessionId && r.status === 'running')
}

async function drawPane($: EngineInterface, e: RenderEvent) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const now = await $.clock.now()
  const redraw = () => $.ui.invalidate('ui.render')
  const line = (segments: Line) =>
    Box({
      flexDirection: 'row',
      children: segments.map(s =>
        Text({
          ...(s.color ? { color: s.color } : {}),
          ...(s.bold ? { bold: true } : {}),
          ...(s.dim ? { dimColor: true } : {}),
          wrap: 'truncate-end',
          children: [s.text],
        }),
      ),
    })
  const shown = visibleRuns([...runs.values()], sessionId)
  const moveRun = (step: number) => {
    view = { ...view, runIndex: clampRunIndex(view.runIndex + step, shown.length) }
    redraw()
  }
  const controls = Box({
    flexDirection: 'row',
    columnGap: 2,
    children: [
      Button({ key: 'prev-run', label: t.prevRun, hotkey: 'h', plain: true, onPress: () => moveRun(-1) }),
      Button({ key: 'next-run', label: t.nextRun, hotkey: 'l', plain: true, onPress: () => moveRun(1) }),
      Button({
        key: 'details',
        label: view.details ? t.compact : t.details,
        hotkey: 'd',
        plain: true,
        onPress: () => {
          view = { ...view, details: !view.details }
          redraw()
        },
      }),
      Button({
        key: 'view-mode',
        label: view.mode === 'tasks' ? t.dagView : t.tasksView,
        hotkey: 't',
        plain: true,
        onPress: () => {
          view = { ...view, mode: view.mode === 'tasks' ? 'dag' : 'tasks' }
          redraw()
        },
      }),
    ],
  })
  const gap = () => Text({ children: [' '] })

  if (view.mode === 'tasks') {
    const dagAgents = new Set([...runs.values()].flatMap(r => r.nodes.flatMap(n => (n.agentId ? [n.agentId] : []))))
    const tasks = buildTasks(await $.agent.list(), dagAgents, now, { activity, t })
    return Box({ flexDirection: 'column', children: [line(tasks.header), controls, gap(), ...tasks.rows.flatMap(rows => rows.map(line))] })
  }

  const model = buildPane(shown, view, now, { activity, t })
  if (model.empty) return Box({ flexDirection: 'column', children: [line(model.header), controls, gap(), Text({ dimColor: true, children: [model.empty] })] })
  const run = shown[clampRunIndex(view.runIndex, shown.length)] as Run
  const cards = model.cards.map(card =>
    Box({
      flexDirection: 'column',
      children: [
        Box({
          flexDirection: 'row',
          columnGap: 1,
          children: [
            Button({
              key: `node-${card.id}`,
              label: card.expanded ? '▾' : '▸',
              plain: true,
              onPress: async () => {
                const runPrefs = { ...(view.prefs[run.runId] ?? {}), [card.id]: !card.expanded }
                view = { ...view, prefs: { ...view.prefs, [run.runId]: runPrefs } }
                redraw()
                await $.store.set(PREFS_KEY, view.prefs)
              },
            }),
            line(card.header),
          ],
        }),
        ...(card.lines.length ? [Box({ flexDirection: 'column', paddingLeft: 4, children: card.lines.map(line) })] : []),
      ],
    }),
  )
  return Box({
    flexDirection: 'column',
    children: [line(model.header), controls, gap(), ...model.layers.map(line), gap(), ...cards],
  })
}

export function register(on: On, options: PluginOptions) {
  t = stringsFor(options.language)
  if (typeof options.max_concurrent === 'number' && options.max_concurrent >= 1) maxConcurrent = Math.floor(options.max_concurrent)
  if (typeof options.retention_days === 'number') retentionDays = options.retention_days
  if (options.node_messages === 'full') nodeMessages = 'full'
  if (ENFORCEMENTS.includes(options.enforcement as Enforcement)) enforcement = options.enforcement as Enforcement
  if (Array.isArray(options.main_allowed_tools)) extraAllowed = new Set(options.main_allowed_tools)

  on('session.start', async ($, e, next) => {
    interactive = e.isInteractive
    sessionId = await $.session.id()
    await $.tool.register({ name: 'dag', description: TOOL_DESCRIPTION, inputSchema: INPUT_SCHEMA })
    try {
      await loadRuns($)
      await serialized(() => recoverRuns($))
    } catch (error) {
      $.ui.log(`could not load DAG checkpoints: ${message(error)}`)
    }
    try {
      await loadPrefs($)
    } catch (error) {
      $.ui.log(`could not load DAG pane preferences: ${message(error)}`)
    }
    $.ui.invalidate('ui.render')
    $.clock.every(1000, () => {
      if (!hasActiveRun()) return
      $.ui.invalidate('ui.render')
      ticks += 1
      if (ticks % 2 === 0) {
        serialized(() => pollTranscripts($)).catch(error => $.ui.log(`could not read node transcripts: ${message(error)}`))
      }
    })
    await $.command.register({ name: 'dag-ping', description: 'Check that the dag-workflow mod is loaded' })
    await $.command.register({
      name: 'dag',
      description: 'Open the DAG pane, or run, list, inspect, cancel or retry DAG workflows, or set enforcement',
      argumentHint: '[list | run <file> | status <run> | cancel <run> | retry <run> [node...] | enforce [strict|guide|off]]',
      immediate: true,
    })
    return next(e)
  })

  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    if (e.source === 'clear') planningLoaded = false
    const previous = sessionId
    sessionId = await $.session.id()
    if (previous && previous !== sessionId) {
      await serialized(async () => {
        for (const run of [...runs.values()]) {
          if (run.sessionId === previous) await persist($, { ...run, sessionId })
        }
      })
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const agentId = e.agentId
    if (!agentId) return yield* next(e)
    activity.set(agentId, stepStarted(Date.now()))
    const stream = next(e)
    let step = await stream.next()
    while (step.done !== true) {
      const updated = chunkArrived(activity.get(agentId), step.value as StepChunk, Date.now())
      if (updated) activity.set(agentId, updated)
      yield step.value
      step = await stream.next()
    }
    return step.value
  })

  on('skill.prompt', async ($, e, next) => {
    if (isPlanningSkill(e.skill)) planningLoaded = true
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (enforcement === 'off') return next(e)
    return next({ ...e, context: [...(e.context ?? []), protocolFor(enforcement)] })
  })

  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    if (!agentId) {
      if (e.tool === 'Skill' && isPlanningSkill((e as { skill?: unknown }).skill)) planningLoaded = true
      if (enforcement !== 'strict' || next.origin.plugin !== 'engine') return next(e)
      const verdict = mainLoopVerdict(e.tool, e as Readonly<Record<string, unknown>>, extraAllowed)
      if (verdict.allowed) return next(e)
      $.ui.log(`refused ${e.tool} in the main conversation; work runs in DAG nodes`)
      return { deny: denyMessage(e.tool, verdict.reason) }
    }
    activity.set(agentId, toolStarted(e.tool, Date.now()))
    try {
      return await next(e)
    } finally {
      if (activity.get(agentId)?.phase === 'tool') activity.set(agentId, stepStarted(Date.now()))
    }
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) activity.delete(e.agentId)
    if (e.agentId && agentRuns.has(e.agentId)) {
      const end: AgentEnd = { agentId: e.agentId, reason: e.reason, isAborted: e.isAborted, answer: e.answer }
      $.clock.after(0, () => {
        serialized(() => onAgentDone($, end)).catch(error => {
          $.ui.log(`could not record the end of agent ${end.agentId}: ${message(error)}`)
        })
      })
    }
    if (!e.agentId && !interactive && hasActiveRun()) await holdUntilSettled($)
    return next(e)
  })

  on('tool.call', { tool: 'mcp__dag-workflow__dag' }, async ($, e) => {
    const opensPlan = e.action === 'start' || e.action === 'amend'
    if (!e.agentId && opensPlan && enforcement === 'strict' && !planningLoaded) return err(planningRequired())
    return serialized(() => handleTool($, e))
  }).catch(async ($, e, next) => {
    return err({ code: `hook_${next.error.kind}`, message: `The dag tool failed: ${next.error.message}` })
  })

  on('command.run', { command: 'dag-ping' }, async () => {
    return { text: 'dag-workflow loaded' }
  })

  on('command.run', { command: 'dag' }, async ($, e) => serialized(() => runCommand($, e.args ?? '')))

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e)
    return drawPane($, e)
  })

  on('tool.call', { tool: /^SubagentHandback$/ }, async ($, e, next) => {
    const agentId = e.agentId
    if (!agentId || !agentRuns.has(agentId)) return next(e)
    const sent = (e as { message?: unknown }).message
    handbacks.set(agentId, typeof sent === 'string' ? sent : '')
    const owner = nodeOfAgent(agentId)
    if (nodeMessages === 'full' || !owner) return next(e)
    const excerpt = typeof sent === 'string' ? extractOutput(sent) : ''
    return next({ ...e, message: nodeMessage(owner.run, owner.nodeId, excerpt) } as typeof e)
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE_ID && e.origin.kind === 'person') paneClosedByUser = true
    return next(e)
  })
}
