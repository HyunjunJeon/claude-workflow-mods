import type { Elements, EngineInterface, On, PluginOptions, RenderInput, RenderSurface } from 'claude-code'
import { parseDefinition } from './engine/definition.ts'
import { err, keepAliveMessage, listText, nodeMessage, ok, settleMessage, splitArgs, statusText, type ToolReply } from './engine/format.ts'
import { buildNodePrompt, extractOutput, parseOutcome, spawnTarget, type UpstreamResult } from './engine/node-prompt.ts'
import { isBlockedReportPath, isFinalAudit, lintDefinition } from './engine/lint.ts'
import { modelPrompt, parseChoices, parseModelChoices, permissionRequest, recoveryRequest, routingParts, routingRequest, type JevChoice, type JevContext, type JevRequest } from './engine/jev.ts'
import { appendDecisions, JEV_RULESET_VERSION, parseDecisionLog, type DecisionOutcome, type DecisionRecord } from './engine/decisions.ts'
import { addNote, contextSummary, emptyContext, parseContext, recordRequest, removeNote } from './engine/context.ts'
import { acceptHandoff, cancelHandoff, offerHandoff, parseSession, projectSessions, requestHandoff, sessionConflicts, type SessionRecord } from './engine/sessions.ts'
import { hash, stableStringify } from './engine/hash.ts'
import { recoverNode, recoveryKind, MAX_AUTO_RECOVERIES } from './engine/recovery.ts'
import { projectPath, verificationProblem } from './engine/verification.ts'
import { denyMessage, isPlanningSkill, MAIN_LOOP_TOOLS, mainLoopVerdict, PLANNING_SKILL, planningRequired, protocolFor, type Enforcement } from './engine/policy.ts'
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
import { retentionPlan, type RetentionFile } from './engine/retention.ts'
import { parseYaml } from './engine/yaml.ts'
import { INPUT_SCHEMA, TOOL_DESCRIPTION } from './engine/tool-spec.ts'
import { fail, type NodeRun, type RecoveryKind, type Result, type Run, type VerificationEvidence } from './engine/types.ts'
import { chunkArrived, finalReport, fromTranscript, stepStarted, toolStarted, type Activity, type StepChunk, type TranscriptRow } from './ui/activity.ts'
import { BAND_GAP, buildBand, summarizeActive } from './ui/band.ts'
import { stringsFor, type Strings } from './ui/i18n.ts'
import type { ViewKind } from './ui/graph-model.ts'
import { ACCENT } from './ui/text.ts'
import { buildInspector, type InspectorInput, type InspectorView } from './ui/inspector-model.ts'
import { viewLines, VIEWS } from './ui/views.ts'
import { buildPane, buildTasks, clampRunIndex, countTasks, isExpanded, nodeOrder, stepSelection, visibleRuns, type CollapsePrefs, type Line, type ViewState } from './ui/view-model.ts'

const TOOL_NAME = 'mcp__dag-workflow__dag'
const DAG_SUBDIR = '.claude/dag'
const RUNS_SUBDIR = `${DAG_SUBDIR}/runs`
const USAGE = 'Usage: /dag [list | run <file> | status <run> | cancel <run> | retry <run> [nodes...] | context | note <text> | note rm <number> | decisions [id] | sessions | handoff <run> <session|cancel> | accept <run> | inspect <dag|decisions|context|sessions> | enforce [strict|guide|off] | view [auto|graph|lanes|timeline]]'
const ENFORCEMENTS: readonly Enforcement[] = ['strict', 'guide', 'off']
const REPORT_LIMIT = 4_000_000
// A headless host waits for a held main turn.complete for 60 000 ms only ("[WARN] headless session: turn events still
// running after 60000ms; the turn ends without them", measured in a live `claude -p` run); it does not abort the hold.
// Past that only live agents and queued prompts keep the session up, which is why a node completion while the turn
// is held submits a keep-alive prompt. This constant now only caps how long one hold loop polls when no completion
// hands it off.
const HOLD_LIMIT_MS = 3_600_000
const PANE_ID = 'dag'
const PREFS_KEY = 'collapse-prefs'
const VIEW_KEY = 'pane-view'
const FALLBACK_GRAPH_COLUMNS = 60
const JEV_TIMEOUT_MS = 5_000
// Session-model routing requests (1-3 nodes, up to 8 in parallel, Sonnet at low effort) took 1.5-5.3 s in measurements,
// so the model gets about twice the slowest of them, more room than HTTP.
const JEV_MODEL_TIMEOUT_MS = 10_000
const JEV_MODEL_CALLS = 8
// The planning skill's final audit never runs on quick; the plugin holds it to that whatever the proposal or Jev said.
const FINAL_AUDIT_CATEGORY = 'unspecified-low'
const GITIGNORE = '# dag-workflow run checkpoints and node reports\n*\n'
const SAFE_RUN_DIR = /^dag_[A-Za-z0-9_-]+$/
const SAFE_FILE = /^[A-Za-z0-9_.-]+\.json$/

function debug($: EngineInterface, text: string): void {
  $.ui.log(`dag-workflow: ${text}`, { to: 'debug' })
}

// The strict gate must outlive /reload-plugins: a reload re-runs register() and starts every module variable over, while
// the conversation still holds the planning skill. The host keeps $.state across a reload, so the flag is written there
// too; `planningLoaded` stays the fast in-process copy. The ref is declared in types/index.d.ts.
const PLANNING_FLAG = { plugin: 'dag-workflow', key: 'planningLoaded' } as const

// A failed state call is only logged. set: the in-process flag has already changed and only the stored copy is lost, so a
// later reload can drop it. restore (below): a failed or missing read leaves the gate as it is.
async function setPlanningLoaded($: EngineInterface, loaded: boolean): Promise<void> {
  planningLoaded = loaded
  try {
    await $.state.set(PLANNING_FLAG, loaded)
  } catch (error) {
    debug($, `could not store the planning-skill flag: ${message(error)}`)
  }
}

// Only a stored true opens the gate here; a missing or unreadable flag keeps it closed, as a fresh session has it.
async function restorePlanningLoaded($: EngineInterface): Promise<void> {
  try {
    if ((await $.state.get(PLANNING_FLAG)).value === true) planningLoaded = true
  } catch (error) {
    debug($, `could not read the planning-skill flag: ${message(error)}`)
  }
}

type ToolInput = Readonly<Record<string, unknown>>
type RenderEvent = RenderInput<'Pane'>
type AgentEnd = { agentId: string; reason?: string; isAborted: boolean; answer?: string }

const runs = new Map<string, Run>()
const agentRuns = new Map<string, string>()
let sessionId = ''
let runsDir = ''
let projectRoot = ''
let queue: Promise<unknown> = Promise.resolve()
let view: ViewState = { runIndex: 0, details: false, prefs: {}, mode: 'dag' }
let paneClosedByUser = false
let paneWaitReason: string | undefined
let maxConcurrent = 8
let retentionDays = 14
let t: Strings = stringsFor('en')
let nodeMessages: 'compact' | 'full' = 'compact'
let enforcement: Enforcement = 'strict'
let planningLoaded = false
let interactive = true
// A non-interactive main turn held open by holdUntilSettled. Each hold takes a new generation and returns once its
// generation is stale, so a hold handed off to a keep-alive prompt, or replaced by a newer hold, stops spinning.
let mainHeld = false
let holdGeneration = 0
// A keep-alive prompt is with the host and its turn has not started yet; it covers every completion until then.
let keepAliveQueued = false
// Only the terminal and desktop surfaces draw the pane and band; elsewhere progress goes out as text.
let paneSurface = true
// A /dag run|retry typed during a main model turn is persisted pending and started when that turn ends.
let mainTurnBusy = false
let deferStarts = false
const pendingStarts: string[] = []
let extraAllowed: ReadonlySet<string> = new Set()
const dirsMade = new Set<string>()
let gitignoreChecked = false
let contextOnDisk = false
let jevPermissionScope: 'all' | 'dag' = 'all'
const activity = new Map<string, Activity>()
const agentEventSources = new Set<string>()
const handbacks = new Map<string, string>()
const transcriptErrors = new Set<string>()
const toolContexts = new Map<string, JevContext>()
// Node workers' calls in flight (tool_use_id -> agent) and the workers waiting for a permission answer, in memory only.
const openCalls = new Map<string, { agentId: string; tool: string }>()
const waiting = new Map<string, { tool: string; toolUseId?: string; since: number }>()
// Per run and node, the tools already explained in a non-interactive session for the node's current attempt, in
// first-seen order: a retried call adds no second line, and the settle summary lists them. A new attempt starts over.
const askedTools = new Map<string, Map<string, { attempt: number; tools: string[] }>>()
let userRequest = ''
let jevEnabled = true
let jevConfidence = 0.9
// Session-model routing answers measured 0.60-0.97 confident with every choice correct, so they apply from a lower bar.
let jevModelRoutingConfidence = 0.8
let jevModelFallback = true
let jevApiKey: string | undefined
let ticks = 0
let workflowContext = emptyContext('', '', 0)
let decisionRecords: DecisionRecord[] = []
let peerSessions: SessionRecord[] = []
let metadataWrites: Promise<unknown> = Promise.resolve()
let decisionSequence = 0
let sessionClosed = false
let autoRecovery = true
let inspectorView: 'dag' | InspectorView = 'dag'
let inspectorPage = 0
let inspectorColumns = FALLBACK_GRAPH_COLUMNS
let selectedDecisionId: string | undefined
let language: 'en' | 'ko' = 'en'
let pinnedStatus: string | undefined
const settleToasts = new Set<string>()
// Node ids that already raised their own failure toast, per run; the settle toast skips them.
const failureToasts = new Map<string, Set<string>>()
const ATTENTION_TOAST_MS = 12_000
let lastPaneAgentId: string | undefined

type JevOutcome = Exclude<DecisionOutcome, 'applied' | 'low-confidence' | 'ask' | 'existing-decision'> | 'answered'

type JevEvaluation = {
  choices: ReadonlyMap<string, JevChoice>
  outcome: JevOutcome
  latencyMs: number
  backend?: 'http' | 'model'
  // Per question, when the questions were asked in separate requests.
  outcomes?: ReadonlyMap<string, JevOutcome>
  latencies?: ReadonlyMap<string, number>
}

function serialized<T>(job: () => Promise<T>): Promise<T> {
  const result = queue.then(job)
  queue = result.catch(() => undefined)
  return result
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function seenAgent($: EngineInterface, agentId: string, source: string): void {
  const owner = nodeOfAgent(agentId)
  if (!owner) return
  const key = `${agentId}:${source}`
  if (agentEventSources.has(key)) return
  agentEventSources.add(key)
  debug($, `agent ${agentId} (${owner.run.runId}/${owner.nodeId}) seen via ${source}`)
}

// One episode per worker: the first mark toasts; a later mark only adds the tool_use_id the notice needs.
async function markWaiting($: EngineInterface, agentId: string, tool: string, toolUseId?: string): Promise<void> {
  const since = await $.clock.now()
  const owner = nodeOfAgent(agentId)
  const node = owner?.run.nodes.find(current => current.id === owner.nodeId)
  if (!owner || owner.run.sessionId !== sessionId || node?.state !== 'running') return
  const current = waiting.get(agentId)
  const text = t.toastWaiting(owner.run.name, owner.nodeId)
  if (current) {
    if (current.toolUseId || !toolUseId) return
    waiting.set(agentId, { ...current, toolUseId })
  } else {
    waiting.set(agentId, { tool, since, ...(toolUseId ? { toolUseId } : {}) })
    debug($, `${owner.run.runId}/${owner.nodeId} waits for a permission answer (${tool})`)
    $.ui.toast(text, { timeoutMs: ATTENTION_TOAST_MS })
    updateStatus($)
    $.ui.invalidate('ui.render')
  }
  if (!toolUseId) return
  try {
    // Best effort: host 2.1.288 accepts this call but draws no line under the dialog; toast, status and band carry the wait.
    $.ui.notice(toolUseId, text)
  } catch (error) {
    debug($, `permission notice for ${owner.run.runId}/${owner.nodeId} refused: ${message(error)}`)
  }
}

// A resolved call clears only the mark it belongs to; without a call, any mark of the agent clears.
function clearWaiting($: EngineInterface, agentId: string, call?: { toolUseId: string; tool: string }): void {
  const mark = waiting.get(agentId)
  if (!mark) return
  if (call && (mark.toolUseId ? mark.toolUseId !== call.toolUseId : mark.tool !== call.tool)) return
  waiting.delete(agentId)
  updateStatus($)
  $.ui.invalidate('ui.render')
}

function waitingTools(): Map<string, string> {
  return new Map([...waiting].map(([agentId, mark]) => [agentId, mark.tool]))
}

// HTTP is primary; the session model answers only when the key is missing or the HTTP call fails, times out or is non-2xx.
// The model takes modelParts, the same questions split into requests it answers in parallel.
async function evaluateJev($: EngineInterface, request: JevRequest, signal?: AbortSignal, modelParts: readonly JevRequest[] = [request]): Promise<JevEvaluation> {
  if (!jevEnabled) return { choices: new Map(), outcome: 'disabled', latencyMs: 0 }
  if (!jevApiKey && !jevModelFallback) return { choices: new Map(), outcome: 'missing-key', latencyMs: 0 }
  const startedAt = await $.clock.now()
  if (jevApiKey) {
    const http = await evaluateJevHttp($, request, jevApiKey, startedAt)
    if (!jevModelFallback || (http.outcome !== 'http-error' && http.outcome !== 'timeout' && http.outcome !== 'transport-error')) return http
  }
  return evaluateJevModel($, modelParts, startedAt, signal)
}

type ModelPart = { choices: ReadonlyMap<string, JevChoice>; outcome: JevOutcome; latencyMs: number; note?: string }

async function evaluateJevModel($: EngineInterface, parts: readonly JevRequest[], startedAt: number, signal?: AbortSignal): Promise<JevEvaluation> {
  const total = parts.reduce((sum, part) => sum + Object.keys(part.questions).length, 0)
  debug($, `Jev model fallback started (${total} question(s) in ${parts.length} request(s))`)
  const results = await Promise.all(parts.map(part => completeJevPart($, part, startedAt, signal)))
  const notes = new Map<string, number>()
  for (const result of results) if (result.note) notes.set(result.note, (notes.get(result.note) ?? 0) + 1)
  for (const [note, count] of notes) $.ui.log(parts.length > 1 ? `${note} (${count} of ${parts.length} requests)` : note)
  const choices = new Map<string, JevChoice>()
  const outcomes = new Map<string, JevOutcome>()
  const latencies = new Map<string, number>()
  results.forEach((result, index) => {
    for (const id of Object.keys(parts[index]!.questions)) {
      const choice = result.choices.get(id)
      if (choice) choices.set(id, choice)
      outcomes.set(id, result.outcome === 'answered' && !choice ? 'invalid-response' : result.outcome)
      latencies.set(id, result.latencyMs)
    }
  })
  const outcome = choices.size ? 'answered' : results.find(result => result.outcome !== 'answered')?.outcome ?? 'invalid-response'
  return { choices, outcome, latencyMs: Math.max(0, ...latencies.values()), backend: 'model', outcomes, latencies }
}

async function completeJevPart($: EngineInterface, request: JevRequest, startedAt: number, signal?: AbortSignal): Promise<ModelPart> {
  const ask = modelPrompt(request)
  try {
    const reply = await $.model.complete(
      { model: 'sonnet', system: ask.system, prompt: ask.prompt, maxTokens: ask.maxTokens, effort: 'low', timeoutMs: JEV_MODEL_TIMEOUT_MS },
      signal ? { signal } : undefined,
    )
    const latencyMs = (await $.clock.now()) - startedAt
    if (!reply.isAnswered) {
      const outcome = reply.reason === 'aborted' ? 'timeout' : reply.reason === 'api-error' ? 'http-error' : 'invalid-response'
      return { choices: new Map(), outcome, latencyMs, note: `Jev model fallback unavailable (${reply.reason}); keeping existing decisions` }
    }
    const choices = parseModelChoices(reply.text, request.questions)
    const note = choices.size !== Object.keys(request.questions).length ? 'Jev model fallback returned incomplete decisions; keeping existing decisions for unanswered questions' : undefined
    return { choices, outcome: choices.size ? 'answered' : 'invalid-response', latencyMs, ...(note ? { note } : {}) }
  } catch (error) {
    return { choices: new Map(), outcome: 'transport-error', latencyMs: (await $.clock.now()) - startedAt, note: `Jev model fallback failed (${error instanceof Error ? error.name : 'unknown error'}); keeping existing decisions` }
  }
}

async function evaluateJevHttp($: EngineInterface, request: JevRequest, apiKey: string, startedAt: number): Promise<JevEvaluation> {
  debug($, `Jev request started (${Object.keys(request.questions).length} question(s))`)
  let timeout: ReturnType<EngineInterface['clock']['after']> | undefined
  const deadline = new Promise<undefined>(resolve => {
    timeout = $.clock.after(JEV_TIMEOUT_MS, () => resolve(undefined))
  })
  try {
    const response = await Promise.race([
      $.http.fetch('https://api.typesafe.ai/v1/systemone', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      }),
      deadline,
    ])
    if (!response || !response.ok) {
      $.ui.log(`Jev unavailable (${response ? response.status : 'timeout'}); ${jevModelFallback ? 'asking the session model' : 'keeping existing decisions'}`)
      return { choices: new Map(), outcome: response ? 'http-error' : 'timeout', latencyMs: (await $.clock.now()) - startedAt, backend: 'http' }
    }
    const choices = parseChoices(response.text, request.questions)
    if (choices.size !== Object.keys(request.questions).length) $.ui.log('Jev returned incomplete decisions; keeping existing decisions for unanswered questions')
    return { choices, outcome: choices.size ? 'answered' : 'invalid-response', latencyMs: (await $.clock.now()) - startedAt, backend: 'http' }
  } catch (error) {
    $.ui.log(`Jev request failed (${error instanceof Error ? error.name : 'unknown error'}); ${jevModelFallback ? 'asking the session model' : 'keeping existing decisions'}`)
    return { choices: new Map(), outcome: 'transport-error', latencyMs: (await $.clock.now()) - startedAt, backend: 'http' }
  } finally {
    timeout?.cancel()
    debug($, `Jev request finished in ${(await $.clock.now()) - startedAt} ms`)
  }
}

function decisionOutcome(evaluation: JevEvaluation, choice: JevChoice | undefined, question: string, threshold = jevConfidence): DecisionOutcome {
  const outcome = evaluation.outcomes?.get(question) ?? evaluation.outcome
  if (outcome !== 'answered') return outcome
  if (!choice) return 'invalid-response'
  if (choice.confidence < threshold) return 'low-confidence'
  return choice.choice === 'ask' ? 'ask' : 'applied'
}

// Creates a .claude/dag subdirectory on its first write and, once per session, the .gitignore.
async function ensureDir($: EngineInterface, dir: string): Promise<void> {
  if (dirsMade.has(dir)) return
  const made = await $.process.run(['mkdir', '-p', dir])
  if (made.exitCode !== 0) throw new Error(`cannot create ${dir}: ${made.stderr.trim()}`)
  dirsMade.add(dir)
  if (gitignoreChecked) return
  const path = `${projectRoot}/${DAG_SUBDIR}/.gitignore`
  if (!(await $.fs.exists(path))) await $.fs.write(path, GITIGNORE)
  gitignoreChecked = true
}

async function persistDecisions($: EngineInterface, records: DecisionRecord[]): Promise<void> {
  decisionRecords = appendDecisions(decisionRecords, records)
  const content = JSON.stringify({ schemaVersion: 1, projectRoot, sessionId, records: decisionRecords })
  const dir = `${projectRoot}/${DAG_SUBDIR}/decisions`
  const result = metadataWrites.then(async () => {
    await ensureDir($, dir)
    await $.fs.write(`${dir}/${sessionId}.json`, content)
  })
  metadataWrites = result.catch(() => undefined)
  try {
    await result
  } catch (error) {
    $.ui.log(`could not persist decision history: ${message(error)}`)
  }
  $.ui.invalidate('ui.render')
}

function decisionRecord(input: Omit<DecisionRecord, 'id' | 'sessionId' | 'ruleset' | 'threshold' | 'backend'>, evaluation: JevEvaluation, threshold = jevConfidence): DecisionRecord {
  return { ...input, ...(evaluation.backend ? { backend: evaluation.backend } : {}), id: `${input.at.toString(36)}-${++decisionSequence}`, sessionId, ruleset: JEV_RULESET_VERSION, threshold }
}

async function routeRun($: EngineInterface, run: Run, ids: string[]): Promise<Run> {
  if (ids.length === 0) return run
  const request = routingRequest(run, ids)
  const evaluation = await evaluateJev($, request, undefined, routingParts(run, ids, JEV_MODEL_CALLS))
  const records: DecisionRecord[] = []
  const at = await $.clock.now()
  const threshold = evaluation.backend === 'model' ? jevModelRoutingConfidence : jevConfidence
  const nodes = run.nodes.map(node => {
    if (!ids.includes(node.id)) return node
    const choice = evaluation.choices.get(node.id)
    const def = run.definition.nodes.find(current => current.id === node.id)
    const category = def?.category ?? 'quick'
    const outcome = decisionOutcome(evaluation, choice, node.id, threshold)
    const jevChoice = outcome === 'applied' ? choice : undefined
    const ruled = (jevChoice?.choice ?? category) === 'quick' && def !== undefined && isFinalAudit(run.definition, def)
    records.push(decisionRecord({
      at, kind: 'routing', subject: node.id, runId: run.runId, nodeId: node.id,
      proposed: category, selected: ruled ? FINAL_AUDIT_CATEGORY : jevChoice?.choice ?? category,
      source: ruled ? 'rule' : jevChoice ? 'jev' : 'baseline', outcome,
      latencyMs: evaluation.latencies?.get(node.id) ?? evaluation.latencyMs, stateHash: hash(stableStringify(request.state)),
      ...(choice ? { confidence: choice.confidence, ...(choice.probabilities ? { probabilities: choice.probabilities } : {}) } : {}),
    }, evaluation, threshold))
    if (ruled) {
      debug($, `final-audit rule ${run.runId}/${node.id}: ${FINAL_AUDIT_CATEGORY} instead of quick`)
      return { ...node, routing: { source: 'rule' as const, category: FINAL_AUDIT_CATEGORY } }
    }
    if (jevChoice) {
      debug($, `Jev route ${run.runId}/${node.id}: ${jevChoice.choice} (${jevChoice.confidence})`)
      return { ...node, routing: { source: 'jev' as const, category: jevChoice.choice, confidence: jevChoice.confidence } }
    }
    return { ...node, routing: { source: 'definition' as const, category } }
  })
  await persistDecisions($, records)
  return { ...run, nodes }
}

function contextPath(): string {
  return `${projectRoot}/${DAG_SUBDIR}/context/${sessionId}.json`
}

function restorationContext(): string {
  return contextSummary(workflowContext, [...runs.values()], contextPath())
}

// Plain conversations keep requests in memory; the file appears once the session uses the DAG.
function contextWanted(): boolean {
  return contextOnDisk || workflowContext.notes.length > 0 || [...runs.values()].some(run => run.sessionId === sessionId)
}

async function persistContext($: EngineInterface): Promise<void> {
  if (!contextWanted()) return
  const path = contextPath()
  const content = JSON.stringify(workflowContext)
  const result = metadataWrites.then(async () => {
    await ensureDir($, `${projectRoot}/${DAG_SUBDIR}/context`)
    await $.fs.write(path, content)
    contextOnDisk = true
  })
  metadataWrites = result.catch(() => undefined)
  await result
}

async function loadMetadata($: EngineInterface): Promise<void> {
  workflowContext = emptyContext(projectRoot, sessionId, await $.clock.now())
  decisionRecords = []
  contextOnDisk = await $.fs.exists(contextPath())
  if (contextOnDisk) {
    workflowContext = parseContext(JSON.parse(await $.fs.read(contextPath())), projectRoot, sessionId) ?? workflowContext
  }
  const decisionsPath = `${projectRoot}/${DAG_SUBDIR}/decisions/${sessionId}.json`
  if (await $.fs.exists(decisionsPath)) {
    decisionRecords = parseDecisionLog(JSON.parse(await $.fs.read(decisionsPath)), projectRoot, sessionId)
  }
  userRequest = workflowContext.requests.at(-1)?.text ?? ''
}

async function refreshSessions($: EngineInterface, closed = false): Promise<void> {
  if (!projectRoot || !sessionId) return
  const now = await $.clock.now()
  const owned = [...runs.values()].filter(run => run.sessionId === sessionId)
  const own: SessionRecord = {
    schemaVersion: 1, sessionId, projectRoot, updatedAt: now, status: closed ? 'closed' : 'active',
    runIds: owned.map(run => run.runId),
    writes: [...new Set(owned.flatMap(run => run.definition.nodes.filter(def => run.nodes.some(node => node.id === def.id && node.state === 'running')).flatMap(node => node.writes ?? [])))],
  }
  const prefix = `dag-session:${hash(projectRoot)}:`
  await $.store.set(`${prefix}${sessionId}`, own)
  if (closed) return
  const records: SessionRecord[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith(prefix)) continue
    const record = parseSession(await $.store.get(key))
    if (record?.projectRoot === projectRoot) records.push(record)
  }
  peerSessions = records
}

async function refreshExternalRuns($: EngineInterface): Promise<void> {
  if (!(await $.fs.exists(runsDir))) return
  for (const entry of await $.fs.list(runsDir)) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    try {
      const loaded = JSON.parse(await $.fs.read(`${runsDir}/${entry.name}`)) as Run
      const current = runs.get(loaded.runId)
      if (loaded.schemaVersion === 1 && loaded.sessionId !== sessionId && typeof loaded.runId === 'string'
        && (!current || loaded.updatedAt > current.updatedAt)) runs.set(loaded.runId, loaded)
    } catch (error) {
      debug($, `could not refresh ${entry.name}: ${message(error)}`)
    }
  }
}

function updateStatus($: EngineInterface): void {
  const active = summarizeActive(runs.values(), sessionId, waiting.size)
  const text = active ? t.statusLine(active.run.name, active.done, active.total, active.running, active.failed, active.otherRuns, active.waiting) : undefined
  if (text === pinnedStatus) return
  pinnedStatus = text
  $.ui.status(text)
}

async function persist($: EngineInterface, run: Run): Promise<void> {
  runs.set(run.runId, run)
  updateStatus($)
  await ensureDir($, runsDir)
  await $.fs.write(`${runsDir}/${run.runId}.json`, JSON.stringify(run, null, 2) + '\n')
  // The session's first owned run makes its in-memory context durable.
  if (run.sessionId === sessionId && !contextOnDisk && workflowContext.sessionId === sessionId) {
    try {
      await persistContext($)
    } catch (error) {
      $.ui.log(`could not persist workflow context: ${message(error)}`)
    }
  }
}

async function loadRuns($: EngineInterface): Promise<void> {
  const root = await $.session.cwd()
  projectRoot = root
  runsDir = `${root}/${RUNS_SUBDIR}`
  dirsMade.clear()
  gitignoreChecked = false
  if (!(await $.fs.exists(runsDir))) return
  for (const entry of await $.fs.list(runsDir)) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    try {
      const run = JSON.parse(await $.fs.read(`${runsDir}/${entry.name}`)) as Run
      if (run.schemaVersion === 1 && typeof run.runId === 'string') runs.set(run.runId, run)
    } catch (error) {
      debug($, `skipped unreadable checkpoint ${entry.name}: ${message(error)}`)
    }
  }
}

async function removePath($: EngineInterface, flag: '-f' | '-rf', path: string): Promise<boolean> {
  try {
    const removed = await $.process.run(['rm', flag, path])
    if (removed.exitCode === 0) return true
    debug($, `could not prune ${path}: ${removed.stderr.trim() || `exit ${removed.exitCode}`}`)
  } catch (error) {
    debug($, `could not prune ${path}: ${message(error)}`)
  }
  return false
}

async function listIfPresent($: EngineInterface, dir: string): Promise<Awaited<ReturnType<EngineInterface['fs']['list']>>> {
  try {
    return (await $.fs.exists(dir)) ? await $.fs.list(dir) : []
  } catch (error) {
    debug($, `could not list ${dir} for retention: ${message(error)}`)
    return []
  }
}

async function pruneArtifacts($: EngineInterface): Promise<void> {
  if (!(retentionDays > 0)) return
  const contextDir = `${projectRoot}/${DAG_SUBDIR}/context`
  const decisionsDir = `${projectRoot}/${DAG_SUBDIR}/decisions`
  const prefix = `dag-session:${hash(projectRoot)}:`
  const files = (entries: Awaited<ReturnType<typeof listIfPresent>>): RetentionFile[] =>
    entries.filter(entry => entry.kind === 'file').map(entry => ({ name: entry.name, mtimeMs: entry.mtimeMs }))
  const sessionRecords: SessionRecord[] = []
  try {
    for (const key of await $.store.keys()) {
      if (!key.startsWith(prefix)) continue
      const record = parseSession(await $.store.get(key))
      if (record?.projectRoot === projectRoot && key === `${prefix}${record.sessionId}`) sessionRecords.push(record)
    }
  } catch (error) {
    debug($, `could not read session records for retention: ${message(error)}`)
  }
  // A directory beside any <name>.json, even an unreadable one, belongs to that checkpoint and is never an orphan.
  const runEntries = await listIfPresent($, runsDir)
  const checkpoints = new Set(runEntries.filter(entry => entry.kind === 'file').map(entry => entry.name))
  const plan = retentionPlan({
    runs: [...runs.values()], now: await $.clock.now(), retentionDays, currentSession: sessionId,
    runDirNames: runEntries.filter(entry => entry.kind !== 'file' && !checkpoints.has(`${entry.name}.json`)).map(entry => entry.name),
    contextFiles: files(await listIfPresent($, contextDir)),
    decisionFiles: files(await listIfPresent($, decisionsDir)),
    sessionRecords,
  })
  for (const run of plan.runs) {
    if (!SAFE_RUN_DIR.test(run.runId)) {
      debug($, `skipped pruning checkpoint with unsafe id ${JSON.stringify(run.runId)}`)
      continue
    }
    if (await removePath($, '-f', `${runsDir}/${run.runId}.json`)) runs.delete(run.runId)
  }
  for (const name of plan.runDirs) {
    if (SAFE_RUN_DIR.test(name)) await removePath($, '-rf', `${runsDir}/${name}`)
    else debug($, `skipped pruning run directory with unsafe name ${JSON.stringify(name)}`)
  }
  for (const [dir, names] of [[contextDir, plan.contextFiles], [decisionsDir, plan.decisionFiles]] as const) {
    for (const name of names) {
      if (SAFE_FILE.test(name) && !name.includes('..')) await removePath($, '-f', `${dir}/${name}`)
    }
  }
  for (const id of plan.sessionKeys) {
    try {
      await $.store.delete(`${prefix}${id}`)
    } catch (error) {
      debug($, `could not prune session record ${id}: ${message(error)}`)
    }
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
  if (def.agent === 'fork') {
    return failToStart(run, id, 'Fork agents cannot enforce the Sonnet worker minimum; amend the node to use a non-fork agent type.', await $.clock.now())
  }
  const target = spawnTarget({ ...def, category: node.routing?.category ?? def.category })
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
      model: node.recovery?.model ?? target.model,
    })
  } catch (error) {
    spawned = { deny: message(error) }
  }
  const now = await $.clock.now()
  if (spawned.agentId) {
    agentRuns.set(spawned.agentId, run.runId)
    return markRunning(run, id, spawned.agentId, now, spawned.model)
  }
  return attemptRecovery($, failToStart(run, id, `Could not start the node agent: ${spawned.deny ?? 'no agent id was returned'}`, now), id)
}

const settleSubmits = new Set<string>()

async function tick($: EngineInterface, runId: string): Promise<Run | undefined> {
  // Drain recovered spawn failures in this hook frame without recursive ticks.
  // Each recovery consumes one of MAX_AUTO_RECOVERIES before rescheduling.
  while (true) {
    const current = runs.get(runId)
    if (!current || current.sessionId !== sessionId) return current
    if (deferStarts) {
      await persist($, current)
      if (!pendingStarts.includes(runId)) pendingStarts.push(runId)
      return current
    }
    let run = advance(current, await $.clock.now())
    if (run.handoff) run = offerHandoff(run, await $.clock.now())
    await persist($, run)
    if (!run.handoff) {
      for (const id of nextToStart(run, maxConcurrent)) {
        run = await startNode($, run, id)
        await persist($, run)
      }
    }
    await refreshSessions($)
    if (run.handoff?.offeredAt !== undefined && current.handoff?.offeredAt === undefined) await notifyHandoff($, run)
    if (!run.handoff && run.nodes.some(node => node.state === 'scheduled') && !run.nodes.some(node => node.state === 'running')) continue
    if (!isSettled(run)) {
      if (settleToasts.delete(runId)) failureToasts.delete(runId)
    } else if (!settleToasts.has(runId)) {
      settleToasts.add(runId)
      const failed = run.nodes.filter(node => node.state === 'failed')
      const toasted = failureToasts.get(runId)
      if (failed.length > 0 && !run.cancelReason && !failed.every(node => toasted?.has(node.id))) {
        $.ui.toast(t.toastSettledFailed(run.name, failed.length), { timeoutMs: ATTENTION_TOAST_MS })
      }
    }
    await announce($, run)
    return run
  }
}

async function announce($: EngineInterface, run: Run): Promise<void> {
  $.ui.invalidate('ui.render')
  if (!isSettled(run) || run.settledNotified || settleSubmits.has(run.runId)) return
  settleSubmits.add(run.runId)
  // Plugin submissions run once idle; never await them in the queue.
  $.prompt.submit({ text: settleMessage(run, TOOL_NAME, settleAsks(run)) }).then(result => {
    if ('drop' in result) throw new Error(result.drop)
    return serialized(async () => {
      const current = runs.get(run.runId)
      if (current?.sessionId === sessionId && isSettled(current)) {
        await persist($, { ...current, settledNotified: true })
      }
    })
  }).catch(error => {
    $.ui.log(`could not tell the session that ${run.runId} settled: ${message(error)}`)
  }).finally(() => {
    settleSubmits.delete(run.runId)
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

type CompletionClaim = {
  readonly run: Run
  readonly node: NodeRun
  readonly report: string | undefined
}
type CompletionResult = {
  readonly outcome: ReturnType<typeof parseOutcome>
  readonly verification?: NodeRun['verification']
}

function claimCompletion(end: AgentEnd): CompletionClaim | undefined {
  const runId = agentRuns.get(end.agentId)
  if (!runId) return
  agentRuns.delete(end.agentId)
  const report = handbacks.get(end.agentId)
  handbacks.delete(end.agentId)
  const run = runs.get(runId)
  const node = run && nodeForAgent(run, end.agentId)
  if (!run || !node) return
  return { run, node, report }
}

// B6: past the host's 60 s wait for the held turn, a -p session ends 58-440 ms after its last live agent stops unless
// work is queued, which cuts off the verify, checkpoint and successor spawn below. Sessions that survived had a plugin
// prompt enqueued 2-20 ms after that stop, so the prompt goes out first, before the queue or any verify.
function keepSessionUp($: EngineInterface, agentId: string): void {
  if (interactive || !mainHeld || keepAliveQueued) return
  const run = runs.get(agentRuns.get(agentId) ?? '')
  const node = run && nodeForAgent(run, agentId)
  if (!run || !node) return
  keepAliveQueued = true
  const generation = holdGeneration
  debug($, `keep-alive prompt for ${run.runId}/${node.id}`)
  $.prompt.submit({ text: keepAliveMessage(run, node.id) }).then(result => {
    if ('drop' in result) throw new Error(result.drop)
    // The host holds the prompt now: release the hold so its turn can start; that turn ends and holds afresh.
    if (generation === holdGeneration) {
      holdGeneration++
      mainHeld = false
    }
  }).catch(error => {
    keepAliveQueued = false
    $.ui.log(`could not keep the session open for ${run.runId}/${node.id}: ${message(error)}`)
  })
}

async function onAgentDone($: EngineInterface, end: AgentEnd): Promise<void> {
  keepSessionUp($, end.agentId)
  const claim = await serialized(async () => claimCompletion(end))
  if (!claim) return
  const { run, node, report } = claim
  let result: CompletionResult
  try {
    const answer = end.answer || report || (end.isAborted ? '' : await recoverReport($, end.agentId))
    const parsed = parseOutcome({ reason: end.reason, isAborted: end.isAborted, answer })
    const reportPath = answer ? await writeReport($, run.runId, node.id, answer) : undefined
    let outcome = reportPath ? { ...parsed, reportPath } : parsed
    let verification: NodeRun['verification']
    if (parsed.state === 'completed') {
      verification = await verifyNode($, run, node)
      if (verification.status !== 'passed') {
        outcome = { ...outcome, state: 'failed', error: verification.error ?? verification.evidence.find(item => !item.passed)?.detail ?? 'Verification checks are missing.' }
      }
    }
    result = { outcome, verification }
  } catch (error) {
    result = { outcome: { state: 'failed', error: `Completion processing failed: ${message(error)}` } }
  }
  await serialized(() => applyCompletion($, claim, result))
}

async function applyCompletion($: EngineInterface, claim: CompletionClaim, result: CompletionResult): Promise<void> {
  const runId = claim.run.runId
  const run = runs.get(runId)
  const node = run?.nodes.find(current => current.id === claim.node.id)
  if (!run || run.sessionId !== sessionId || !node || node.state !== 'running' || node.agentId !== claim.node.agentId) {
    $.ui.log(`Dropped completion for ${runId}/${claim.node.id}: ownership or running agent changed`)
    return
  }
  let prepared = run
  const { outcome, verification } = result
  if (verification) {
    prepared = { ...run, nodes: run.nodes.map(current => current.id === node.id ? { ...current, verification } : current) }
  }
  const finished = markFinished(prepared, node.id, outcome, await $.clock.now())
  runs.set(runId, outcome.state === 'failed' ? await attemptRecovery($, finished, node.id) : finished)
  if (runs.get(runId)?.nodes.find(current => current.id === node.id)?.state === 'failed') {
    $.ui.toast(verification && verification.status !== 'passed' ? t.toastVerificationFailed(run.name, node.id) : t.toastNodeFailed(run.name, node.id), { timeoutMs: ATTENTION_TOAST_MS })
    failureToasts.set(runId, (failureToasts.get(runId) ?? new Set()).add(node.id))
  }
  $.ui.log(`${run.name} › ${node.id}: ${outcome.state}${outcome.error ? ` (${outcome.error})` : ''}`)
  const after = await tick($, runId)
  if (!paneSurface && after && !isSettled(after)) {
    // No pane to watch: say that a node finished; the settle summary still goes through announce.
    $.prompt.submit({ text: nodeMessage(after, node.id) }).catch(error => {
      $.ui.log(`could not announce ${runId}/${node.id}: ${message(error)}`)
    })
  }
}

async function attemptRecovery($: EngineInterface, run: Run, nodeId: string): Promise<Run> {
  const node = run.nodes.find(current => current.id === nodeId)
  if (!autoRecovery || !node || node.state !== 'failed' || run.cancelReason || run.handoff || node.verification?.status === 'missing' || (node.recovery?.used ?? 0) >= MAX_AUTO_RECOVERIES) return run
  const request = recoveryRequest(run, node)
  const evaluation = await evaluateJev($, request)
  const choice = evaluation.choices.get('recovery')
  const kind = choice ? recoveryKind(choice.choice) : undefined
  const outcome = decisionOutcome(evaluation, choice, 'recovery')
  await persistDecisions($, [decisionRecord({
    at: await $.clock.now(), kind: 'recovery', subject: node.id, runId: run.runId, nodeId: node.id,
    proposed: 'manual', selected: outcome === 'applied' && kind ? kind : 'manual',
    source: outcome === 'applied' ? 'jev' : 'baseline', outcome, latencyMs: evaluation.latencyMs,
    stateHash: hash(stableStringify(request.state)),
    ...(choice ? { confidence: choice.confidence, ...(choice.probabilities ? { probabilities: choice.probabilities } : {}) } : {}),
  }, evaluation)])
  if (outcome !== 'applied' || !kind) return run
  const reason = (node.error ?? 'The node failed.').slice(0, 2_000)
  const prepared: Run = {
    ...run,
    nodes: run.nodes.map(current => current.id === node.id ? {
      ...current,
      recovery: { used: current.recovery?.used ?? 0, kind, reason, history: current.recovery?.history ?? [], ...(current.recovery?.model ? { model: current.recovery.model } : {}) },
    } : current),
  }
  const recovered = recoverNode(prepared, node.id, { kind, reason, now: await $.clock.now() })
  if (!recovered.ok) return prepared
  $.ui.log(`Automatic recovery ${run.runId}/${node.id}: ${kind}, extra attempt ${recovered.value.nodes.find(current => current.id === node.id)?.recovery?.used}/${MAX_AUTO_RECOVERIES}`)
  return recovered.value
}

async function verifyNode($: EngineInterface, run: Run, node: NodeRun): Promise<NonNullable<NodeRun['verification']>> {
  const checks = run.definition.nodes.find(def => def.id === node.id)?.verify
  if (!checks?.length) return { status: 'missing', evidence: [], error: 'No verification contract was declared; amend this node with verify checks.' }
  const evidence: VerificationEvidence[] = []
  for (const check of checks) {
    let passed = false
    let detail = ''
    let exitCode: number | undefined
    try {
      switch (check.kind) {
        case 'file': {
          const path = `${projectRoot}/${check.path}`
          const stat = await $.fs.stat(path)
          if (stat.kind !== 'file') detail = `Expected a file: ${check.path}`
          else if (check.contains !== undefined && !(await $.fs.read(path)).includes(check.contains)) detail = `File exists but required output content is missing: ${check.path}`
          else {
            passed = true
            detail = `File verified: ${check.path}`
          }
          break
        }
        case 'command': {
          const result = await $.process.run(check.argv, { cwd: projectRoot, timeoutMs: 30_000 })
          exitCode = result.exitCode
          passed = result.exitCode === 0
          detail = `${JSON.stringify(check.argv)} exited ${result.exitCode}\n${result.stdout}\n${result.stderr}`.slice(0, 4_000)
          break
        }
        default: {
          const unreachable: never = check
          throw new Error(`Unknown verification check: ${String(unreachable)}`)
        }
      }
    } catch (error) {
      detail = `Verification could not run: ${message(error)}`
    }
    evidence.push({ check, passed, detail, checkedAt: await $.clock.now(), ...(exitCode !== undefined ? { exitCode } : {}) })
  }
  const status = evidence.every(item => item.passed) ? 'passed' : 'failed'
  const dir = `${runsDir}/${run.runId}`
  const reportPath = `${dir}/${node.id}.verification.${node.attempt}.json`
  try {
    await ensureDir($, dir)
    await $.fs.write(reportPath, JSON.stringify({ status, evidence }, null, 2))
    return { status, evidence, reportPath }
  } catch (error) {
    return { status: 'failed', evidence, error: `Could not persist verification evidence: ${message(error)}` }
  }
}

async function writeReport($: EngineInterface, runId: string, nodeId: string, report: string): Promise<string | undefined> {
  const dir = `${runsDir}/${runId}`
  try {
    await ensureDir($, dir)
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
  const problem = verificationProblem(parsed.value)
  if (problem) return err(problem)
  const now = await $.clock.now()
  const runId = `dag_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const created = await routeRun($, createRun(parsed.value, { runId, sessionId, now }), parsed.value.nodes.map(node => node.id))
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

// The one read-and-parse step behind /dag run and start {path}: .yaml/.yml go through the YAML subset, anything else is JSON.
// `shown` is how the failure names the file (the path the caller gave); `path` is where it is read.
async function readDefinitionFile($: EngineInterface, path: string, shown = path): Promise<Result<unknown>> {
  try {
    const source = await $.fs.read(path)
    return { ok: true, value: /\.ya?ml$/i.test(path) ? parseYaml(source) : JSON.parse(source) }
  } catch (error) {
    return fail('definition_unreadable', `Cannot read a DAG definition from ${shown}: ${message(error)}`)
  }
}

// start takes the definition inline or by project-relative file path; either way it ends in startDefinition,
// so the planning gate (in the tool.call hook), lint warnings and key reuse behave identically.
async function startRequest($: EngineInterface, input: ToolInput): Promise<ToolReply> {
  const hasDefinition = input.definition !== undefined && input.definition !== null
  const hasPath = input.path !== undefined && input.path !== null
  if (hasDefinition === hasPath) {
    return err({
      code: 'invalid_request',
      message: `start takes exactly one of "definition" (the definition object) and "path" (a project-relative .yaml, .yml or .json definition file); got ${hasPath ? 'both' : 'neither'}.`,
    })
  }
  if (!hasPath) return startDefinition($, input.definition)
  const given = input.path
  if (typeof given !== 'string' || given.trim() === '') {
    return err({ code: 'invalid_request', message: '"path" must be a nonempty string naming a project-relative .yaml, .yml or .json definition file.' })
  }
  if (!projectPath(given)) {
    return err({ code: 'invalid_request', message: `"path" ${JSON.stringify(given)} must be project-relative: no leading "/", drive letter or ".." segment, and nothing inside .claude.` })
  }
  if (!/\.(ya?ml|json)$/i.test(given)) {
    return err({ code: 'invalid_request', message: `"path" ${JSON.stringify(given)} must end in .yaml, .yml or .json.` })
  }
  const read = await readDefinitionFile($, `${await $.session.cwd()}/${given}`, given)
  return read.ok ? startDefinition($, read.value) : err(read.error)
}

async function handleTool($: EngineInterface, input: ToolInput): Promise<ToolReply> {
  if (input.action === 'context') return ok({ source: contextPath(), context: workflowContext, summary: JSON.parse(restorationContext()) })
  if (input.action === 'decisions') return ok({ decisions: decisionRecords })
  if (input.action === 'sessions') {
    await refreshSessions($)
    return ok({ sessions: projectSessions(peerSessions, projectRoot, await $.clock.now()), conflicts: sessionConflicts(peerSessions, projectRoot, await $.clock.now()) })
  }
  if (input.action === 'start') return startRequest($, input)
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
    if (run.handoff) return err({ code: 'manual_handoff_required', message: 'Use /dag accept for an offered run; accepting a handoff is a user action.' })
    await refreshSessions($)
    if (projectSessions(peerSessions, projectRoot, now).some(record => record.sessionId === run.sessionId && record.liveness === 'active')) {
      return err({ code: 'owner_active', message: 'The owner session is active. Ask its user to offer a manual handoff.' })
    }
    const adopted = resumePaused(pauseRunning(run, now), sessionId, now)
    runs.set(run.runId, adopted)
    return ok({ adopted: true, snapshot: snapshotOf((await tick($, run.runId)) ?? adopted, 0) })
  }
  if (run.sessionId !== sessionId) {
    return err({ code: 'not_owner', message: `Run ${run.runId} belongs to session ${run.sessionId}; attach it first.` })
  }
  if (run.handoff) return err({ code: 'handoff_pending', message: 'A manual handoff is pending. The owner can cancel it with /dag handoff <run> cancel.' })
  if (input.action === 'cancel') {
    const reason = typeof input.reason === 'string' && input.reason ? input.reason : 'cancelled on request'
    const { run: cancelled, stopAgents } = cancelRun(run, reason, now)
    for (const node of run.nodes) if (node.agentId) clearWaiting($, node.agentId)
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
    const routed = await routeRun($, retried.value, retried.value.nodes.filter(node => node.state === 'pending' || node.state === 'scheduled').map(node => node.id))
    runs.set(run.runId, routed)
    return ok(snapshotOf((await tick($, run.runId)) ?? routed, 0))
  }
  if (input.action === 'amend') {
    const parsed = parseDefinition(input.definition)
    if (!parsed.ok) return err(parsed.error)
    const problem = verificationProblem(parsed.value)
    if (problem) return err(problem)
    const amended = amendRun(run, parsed.value, now)
    if (!amended.ok) return err(amended.error)
    const routed = await routeRun($, amended.value.run, amended.value.rerun)
    runs.set(run.runId, routed)
    return ok({
      rerun: amended.value.rerun,
      snapshot: snapshotOf((await tick($, run.runId)) ?? routed, 0),
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

async function notifyHandoff($: EngineInterface, run: Run): Promise<void> {
  if (!run.handoff) return
  const sent = await $.session.send({
    to: { sessionId: run.handoff.to },
    text: `[dag-handoff] Run ${run.runId} is ready for manual acceptance in ${projectRoot}. Use /dag accept ${run.runId} or the Sessions pane. Do not accept or start work automatically.`,
  })
  if (!sent.isDelivered) $.ui.log(`Handoff remains available in Sessions; notification was not delivered: ${sent.reason ?? 'unknown reason'}`)
}

async function handoffAction($: EngineInterface, operation: 'request' | 'accept' | 'cancel', input: { runId: string; target?: string }): Promise<{ text: string }> {
  if (!/^[A-Za-z0-9_.-]+$/.test(input.runId)) return { text: 'Invalid run id.' }
  const lock = `${runsDir}/.${input.runId}.handoff-lock`
  let acquired = await $.process.run(['mkdir', lock])
  if (acquired.exitCode !== 0) {
    try {
      const stat = await $.fs.stat(lock)
      if ((await $.clock.now()) - stat.mtimeMs > 60_000) {
        const removed = await $.process.run(['rmdir', lock])
        if (removed.exitCode === 0) acquired = await $.process.run(['mkdir', lock])
      }
    } catch (error) {
      $.ui.log(`Could not recover handoff lock ${lock}: ${message(error)}`)
    }
  }
  if (acquired.exitCode !== 0) return { text: 'Another handoff operation owns this run. Try again after it finishes.' }
  try {
    await refreshSessions($)
    const run = JSON.parse(await $.fs.read(`${runsDir}/${input.runId}.json`)) as Run
    if (run.schemaVersion !== 1 || run.runId !== input.runId) return { text: 'Invalid run checkpoint.' }
    const context = { projectRoot, sessionId, now: await $.clock.now() }
    const target = peerSessions.find(record => record.sessionId === input.target)
    const result = operation === 'accept'
      ? acceptHandoff(run, context, peerSessions.find(record => record.sessionId === run.sessionId))
      : operation === 'cancel'
        ? cancelHandoff(run, sessionId, context.now)
        : target ? requestHandoff(run, target, context) : { ok: false as const, error: { code: 'unknown_session', message: 'Choose an active session shown by /dag sessions.' } }
    if (!result.ok) return { text: `${result.error.code}: ${result.error.message}` }
    await persist($, result.value)
    const warnings: string[] = []
    if (operation === 'accept') {
      const sourcePath = `${projectRoot}/${DAG_SUBDIR}/context/${run.sessionId}.json`
      try {
        const source = parseContext(JSON.parse(await $.fs.read(sourcePath)), projectRoot, run.sessionId)
        for (const note of source?.notes ?? []) {
          if (!workflowContext.notes.some(existing => existing.text === note.text)) workflowContext = addNote(workflowContext, { text: note.text, at: context.now })
        }
      } catch (error) {
        const warning = `Could not import source context notes: ${message(error)}`
        $.ui.log(warning)
        warnings.push(warning)
      }
      userRequest = `Manual handoff accepted: ${run.runId}. Goal: ${(run.definition.goal ?? run.name).replace(/[.!?]+$/, '')}. Continue only the remaining nodes under their declared scopes.`
      workflowContext = recordRequest(workflowContext, { at: context.now, text: userRequest })
      try {
        await persistContext($)
      } catch (error) {
        const warning = `Could not persist accepted context: ${message(error)}`
        $.ui.log(warning)
        warnings.push(warning)
      }
    }
    if (operation === 'request') {
      if (result.value.handoff?.offeredAt !== undefined) await notifyHandoff($, result.value)
    } else if (!isSettled(result.value)) {
      await tick($, run.runId)
    }
    await refreshSessions($)
    $.ui.invalidate('ui.render')
    const text = operation === 'request' ? `Handoff requested for ${run.runId}. Running nodes drain first; ${input.target} must explicitly accept.` : `${operation === 'accept' ? 'Accepted' : 'Cancelled handoff for'} ${run.runId}.`
    return { text: text + (warnings.length ? ` Warning: ${warnings.join(' ')}` : '') }
  } catch (error) {
    return { text: `Handoff failed: ${message(error)}` }
  } finally {
    try {
      const released = await $.process.run(['rmdir', lock])
      if (released.exitCode !== 0) $.ui.log(`Could not release handoff lock ${lock}: ${released.stderr.trim() || `exit ${released.exitCode}`}`)
    } catch (error) {
      $.ui.log(`Could not release handoff lock ${lock}: ${message(error)}`)
    }
  }
}

async function runCommand($: EngineInterface, args: string): Promise<{ text?: string }> {
  const [verb = 'open', ...rest] = splitArgs(args)
  if (verb === 'inspect') {
    const choice = rest[0]
    if (choice !== 'dag' && choice !== 'decisions' && choice !== 'context' && choice !== 'sessions') return { text: USAGE }
    inspectorView = choice
    inspectorPage = 0
    selectedDecisionId = undefined
    await openPane($, true)
    $.ui.invalidate('ui.render')
    return {}
  }
  if (verb === 'handoff' || verb === 'accept') {
    if (!rest[0] || (verb === 'handoff' && !rest[1])) return { text: USAGE }
    return handoffAction($, verb === 'accept' ? 'accept' : rest[1] === 'cancel' ? 'cancel' : 'request', { runId: rest[0], ...(rest[1] && rest[1] !== 'cancel' ? { target: rest[1] } : {}) })
  }
  if (verb === 'context') return { text: JSON.stringify(JSON.parse(restorationContext()), null, 2) }
  if (verb === 'note') {
    if (rest[0] === 'rm') {
      const index = Number(rest[1]) - 1
      if (!Number.isInteger(index) || index < 0 || index >= workflowContext.notes.length) return { text: 'Choose a note number shown by /dag context.' }
      workflowContext = { ...removeNote(workflowContext, index), updatedAt: await $.clock.now() }
    } else {
      const text = rest.join(' ').trim()
      if (!text || text.length > 4_000 || workflowContext.notes.length >= 50) return { text: 'Use /dag note <text> (1-4000 characters, at most 50 pinned notes); remove old notes explicitly with /dag note rm <number>.' }
      workflowContext = addNote(workflowContext, { text, at: await $.clock.now() })
    }
    await persistContext($)
    $.ui.invalidate('ui.render')
    return { text: `Saved ${workflowContext.notes.length} pinned context notes.` }
  }
  if (verb === 'decisions') {
    const selected = rest[0] ? decisionRecords.find(record => record.id === rest[0]) : decisionRecords.slice(-20)
    return { text: JSON.stringify(selected ?? { error: 'unknown_decision' }, null, 2) }
  }
  if (verb === 'sessions') {
    await refreshSessions($)
    await refreshExternalRuns($)
    const now = await $.clock.now()
    return { text: JSON.stringify({ sessions: projectSessions(peerSessions, projectRoot, now), conflicts: sessionConflicts(peerSessions, projectRoot, now) }, null, 2) }
  }
  if (verb === 'open') {
    await openPane($, true)
    return {}
  }
  if (verb === 'list') return { text: listText([...runs.values()], sessionId) }
  if (verb === 'view') {
    if (!rest[0]) return { text: `DAG view: ${view.graphView ?? 'auto'}` }
    const choice = viewChoice(rest[0])
    if (!choice) return { text: `Unknown view "${rest[0]}". Use auto, graph, lanes or timeline.` }
    await setView($, choice)
    return { text: `DAG view: ${choice}` }
  }
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
    const read = await readDefinitionFile($, path)
    if (!read.ok) return { text: read.error.message }
    const reply = await startDefinition($, read.value)
    if (reply.isError) return { text: `DAG not started:\n${reply.result}` }
    const started = JSON.parse(reply.result) as { run_id: string; reused: boolean; warnings?: string[] }
    const run = runs.get(started.run_id)
    await openPane($, true)
    // /dag run is not gated by the planning skill, so only definition lint reaches the person.
    const warnings = (started.warnings ?? []).filter(warning => !warning.includes(PLANNING_SKILL))
    const text = run ? statusText(run, sessionId) : reply.result
    return { text: warnings.length ? `${text}\nWarnings:\n${warnings.map(warning => `- ${warning}`).join('\n')}` : text }
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

// While the surface holds the pane undrawn the band stands in for it; one toast per wait says why.
function setPaneWaitReason($: EngineInterface, reason: string | undefined): void {
  if (reason === paneWaitReason) return
  if (reason !== undefined && paneWaitReason === undefined) $.ui.toast(t.toastPaneWaiting(reason), { timeoutMs: ATTENTION_TOAST_MS })
  paneWaitReason = reason
  $.ui.invalidate('ui.render')
}

async function openPane($: EngineInterface, byUser: boolean): Promise<void> {
  if (!paneSurface) return
  if (!byUser && paneClosedByUser) return
  if (byUser) paneClosedByUser = false
  try {
    const opened = await $.ui.open(byUser ? { id: PANE_ID, title: 'DAG', focus: true, closeOnEscape: true } : { id: PANE_ID, title: 'DAG' })
    setPaneWaitReason($, opened.isPlaced ? undefined : opened.reason)
  } catch (error) {
    $.ui.log(`could not open the DAG pane: ${message(error)}`)
  }
}

async function openFromBand($: EngineInterface, runId: string, nodeId: string | undefined): Promise<void> {
  const runIndex = shownRuns().findIndex(run => run.runId === runId)
  if (nodeId !== undefined && runIndex !== -1) {
    inspectorView = 'dag'
    view = { ...view, mode: 'dag', runIndex, selected: nodeId }
  }
  await openPane($, true)
  $.ui.invalidate('ui.render')
}

function scoped(key: string): string {
  return `${key}:${projectRoot}`
}

async function loadPrefs($: EngineInterface): Promise<void> {
  const saved = await $.store.get(scoped(PREFS_KEY))
  if (saved === null || typeof saved !== 'object') return
  const entries = Object.entries(saved as CollapsePrefs)
  const kept = entries.filter(([runId]) => runs.has(runId))
  view = { ...view, prefs: Object.fromEntries(kept) }
  if (kept.length !== entries.length) await $.store.set(scoped(PREFS_KEY), view.prefs)
}

async function loadViewChoice($: EngineInterface): Promise<void> {
  const chosen = await $.store.get(scoped(VIEW_KEY))
  if (VIEWS.includes(chosen as ViewKind)) view = { ...view, graphView: chosen as ViewKind }
}

function viewChoice(value: unknown): ViewKind | 'auto' | undefined {
  return value === 'auto' || VIEWS.includes(value as ViewKind) ? (value as ViewKind | 'auto') : undefined
}

async function setView($: EngineInterface, choice: ViewKind | 'auto'): Promise<void> {
  view = { ...view, graphView: choice === 'auto' ? undefined : choice }
  $.ui.invalidate('ui.render')
  await $.store.set(scoped(VIEW_KEY), choice)
}

async function cycleView($: EngineInterface): Promise<void> {
  const order: (ViewKind | 'auto')[] = ['auto', ...VIEWS]
  await setView($, order[(order.indexOf(view.graphView ?? 'auto') + 1) % order.length] as ViewKind | 'auto')
}

function nodeOfAgent(agentId: string): { run: Run; nodeId: string } | undefined {
  for (const run of runs.values()) {
    const node = run.nodes.find(n => n.agentId === agentId)
    if (node) return { run, nodeId: node.id }
  }
  return undefined
}

// A worker of a run this session owns; a run loaded from another session never gets an explanation from here.
function ownNodeOfAgent(agentId: string | undefined): { run: Run; nodeId: string; attempt: number } | undefined {
  const owner = agentId ? nodeOfAgent(agentId) : undefined
  if (!owner || owner.run.sessionId !== sessionId) return undefined
  return { ...owner, attempt: owner.run.nodes.find(n => n.id === owner.nodeId)?.attempt ?? 0 }
}

// Records that a tool was left at ask for this node attempt; true the first time, so the caller logs once.
function noteAsk(runId: string, nodeId: string, attempt: number, tool: string): boolean {
  let nodes = askedTools.get(runId)
  if (!nodes) askedTools.set(runId, nodes = new Map())
  const entry = nodes.get(nodeId)
  if (!entry || entry.attempt !== attempt) {
    nodes.set(nodeId, { attempt, tools: [tool] })
    return true
  }
  if (entry.tools.includes(tool)) return false
  entry.tools.push(tool)
  return true
}

// Only the node's current attempt counts: an earlier attempt's asks say nothing about why this result is as it is.
function settleAsks(run: Run): Map<string, string[]> {
  const asked = new Map<string, string[]>()
  const nodes = askedTools.get(run.runId)
  for (const node of run.nodes) {
    const entry = nodes?.get(node.id)
    if (entry && entry.attempt === node.attempt) asked.set(node.id, [...entry.tools])
  }
  return asked
}

// claude -p cannot put an ask to anyone, so the host refuses the call; this says why it was left at ask.
function headlessAskNote(tool: string, why: string): string {
  return `${tool} needs approval that this non-interactive session cannot ask for (${why}); allow it up front with --allowedTools ${tool} or a --permission-mode that covers it`
}

async function pollTranscripts($: EngineInterface): Promise<void> {
  for (const run of runs.values()) {
    if (run.sessionId !== sessionId) continue
    for (const node of run.nodes) {
      if (node.state !== 'running' || !node.agentId) continue
      const current = activity.get(node.agentId)
      if (current && !current.coarse) continue
      const rows = await $.session.messages({ agentId: node.agentId })
      seenAgent($, node.agentId, 'transcript poll')
      if (!Array.isArray(rows)) {
        if (!transcriptErrors.has(node.agentId)) $.ui.log(`cannot read the transcript of node ${node.id}: ${rows.deny}`)
        transcriptErrors.add(node.agentId)
        continue
      }
      activity.set(node.agentId, fromTranscript(rows as TranscriptRow[], current, Date.now()))
    }
  }
}

async function holdUntilSettled($: EngineInterface, signal: AbortSignal): Promise<void> {
  const generation = ++holdGeneration
  mainHeld = true
  try {
    const deadline = (await $.clock.now()) + HOLD_LIMIT_MS
    await holdWhileActive(signal, hasActiveRun, async () => {
      if (generation !== holdGeneration) {
        debug($, 'stopped holding: handed off to a newer main turn')
        return false
      }
      if ((await $.clock.now()) >= deadline) {
        $.ui.log(`stopped holding the session open after ${HOLD_LIMIT_MS / 60_000} minutes; a DAG run is still active`)
        return false
      }
      try {
        await $.process.run(['sleep', '1'])
        return true
      } catch (error) {
        $.ui.log(`could not keep the session open for the active DAG run: ${message(error)}`)
        return false
      }
    }, async () => {
      await persistActiveRuns($)
      debug($, 'stopped holding: aborted')
    })
  } finally {
    if (generation === holdGeneration) mainHeld = false
  }
}

export async function holdWhileActive(
  signal: AbortSignal,
  active: () => boolean,
  wait: () => Promise<boolean>,
  onAbort: () => Promise<void>,
): Promise<void> {
  while (active()) {
    if (signal.aborted) {
      await onAbort()
      return
    }
    if (!(await wait())) return
    if (signal.aborted) {
      await onAbort()
      return
    }
  }
}

async function persistActiveRuns($: EngineInterface): Promise<void> {
  for (const run of runs.values()) {
    if (run.sessionId === sessionId && run.status === 'running') await persist($, run)
  }
}

function hasActiveRun(): boolean {
  return [...runs.values()].some(r => r.sessionId === sessionId && r.status === 'running')
}

function shownRuns(): Run[] {
  return visibleRuns([...runs.values()], sessionId)
}

function shownRun(): Run | undefined {
  const shown = shownRuns()
  return shown[clampRunIndex(view.runIndex, shown.length)]
}

function selectNode(step: 1 | -1): void {
  const run = shownRun()
  if (run) view = { ...view, selected: stepSelection(nodeOrder(run), view.selected, step) }
}

function moveRun(step: 1 | -1): void {
  view = { ...view, runIndex: clampRunIndex(view.runIndex + step, shownRuns().length), selected: undefined }
}

async function inspectorAction($: EngineInterface, action: string): Promise<void> {
  if (action === 'page:prev') inspectorPage = Math.max(0, inspectorPage - 1)
  else if (action === 'page:next') inspectorPage += 1
  else if (action === 'decision:back') selectedDecisionId = undefined
  else if (action.startsWith('decision:')) selectedDecisionId = action.slice('decision:'.length)
  else {
    let reply: { text: string } | undefined
    if (action.startsWith('handoff-cancel:')) {
      reply = await serialized(() => handoffAction($, 'cancel', { runId: action.slice('handoff-cancel:'.length) }))
    } else if (action.startsWith('accept:')) {
      reply = await serialized(() => handoffAction($, 'accept', { runId: action.slice('accept:'.length) }))
    } else if (action.startsWith('handoff:')) {
      const run = shownRun()
      if (run) reply = await serialized(() => handoffAction($, 'request', { runId: run.runId, target: action.slice('handoff:'.length) }))
    }
    if (reply) $.ui.log(reply.text)
  }
  $.ui.invalidate('ui.render')
}

async function toggleFold($: EngineInterface, run: Run, nodeId: string): Promise<void> {
  const node = run.nodes.find(n => n.id === nodeId)
  if (!node) return
  const runPrefs = { ...(view.prefs[run.runId] ?? {}), [nodeId]: !isExpanded(run, node, view.prefs) }
  view = { ...view, prefs: { ...view.prefs, [run.runId]: runPrefs } }
  $.ui.invalidate('ui.render')
  await $.store.set(scoped(PREFS_KEY), view.prefs)
}

async function handlePaneKey($: EngineInterface, key: string, shift: boolean): Promise<void> {
  if (key === 'tab' || key === 'n' || key === 'p') selectNode(key === 'p' || (key === 'tab' && shift) ? -1 : 1)
  else if (key === 'left' || key === 'right') moveRun(key === 'left' ? -1 : 1)
  else if (key === 'd') view = { ...view, details: !view.details }
  else if (key === 't') view = { ...view, mode: view.mode === 'tasks' ? 'dag' : 'tasks' }
  else if (key === 'c') view = { ...view, showCompleted: !view.showCompleted }
  else if (key === 'f') view = { ...view, unfold: !view.unfold }
  else if (key === 'v') return cycleView($)
  else if (key === ' ' || key === 'space' || key === 'return') {
    const run = shownRun()
    if (run && view.selected) await toggleFold($, run, view.selected)
    return
  } else return
  $.ui.invalidate('ui.render')
}

function drawLine({ Box, Text }: Pick<Elements[RenderSurface], 'Box' | 'Text'>, segments: Line) {
  return Box({
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
}

async function drawPane($: EngineInterface, e: RenderEvent) {
  const agentId = e.props.view?.agentId
  if (agentId !== lastPaneAgentId) {
    lastPaneAgentId = agentId
    const owner = agentId ? nodeOfAgent(agentId) : undefined
    if (owner && shownRuns().some(run => run.runId === owner.run.runId)) {
      view = { ...view, runIndex: shownRuns().findIndex(run => run.runId === owner.run.runId), selected: owner.nodeId }
    }
  }
  const elements = $.ui.resolve(e)
  const { Box, Text, Button } = elements
  const Client = (elements as Partial<Pick<Extract<typeof elements, { Client: unknown }>, 'Client'>>).Client
  const now = await $.clock.now()
  const redraw = () => $.ui.invalidate('ui.render')
  const line = (segments: Line) => drawLine(elements, segments)
  const gap = () => Text({ children: [' '] })
  const sections = [
    { id: 'dag' as const, label: 'DAG', key: 'g' },
    { id: 'decisions' as const, label: language === 'ko' ? '판단' : 'Decisions', key: 'j' },
    { id: 'context' as const, label: language === 'ko' ? '컨텍스트' : 'Context', key: 'x' },
    { id: 'sessions' as const, label: language === 'ko' ? '세션' : 'Sessions', key: 's' },
  ]
  const sectionTabs = Box({
    flexDirection: 'column',
    children: [sections.slice(0, 2), sections.slice(2)].map(group => Box({
      flexDirection: 'row', columnGap: 2,
      children: group.map(section => Button({
        key: `section-${section.id}`, hotkey: section.key, plain: true,
        label: `${inspectorView === section.id ? '> ' : ''}${section.label}`,
        onPress: () => { inspectorView = section.id; inspectorPage = 0; selectedDecisionId = undefined; redraw() },
      })),
    })),
  })
  if (inspectorView !== 'dag') {
    const input: InspectorInput = {
      view: inspectorView, columns: inspectorColumns, language,
      decisions: decisionRecords, context: workflowContext, contextPath: contextPath(),
      runs: [...runs.values()], sessions: peerSessions, projectRoot, sessionId, now,
      ...(shownRun() ? { selectedRunId: shownRun()?.runId } : {}),
      ...(selectedDecisionId ? { selectedDecisionId } : {}),
      page: inspectorPage,
      waiting: waitingTools(),
    }
    const inspection = buildInspector(input)
    const body = Client
      ? Client({ key: 'inspector', module: './ui/inspector-client.ts', props: inspection, width: '100%', height: inspection.lines.length + inspection.actions.length + 3 })
      : Box({
        flexDirection: 'column',
        children: [
          ...inspection.lines.map(line),
          ...inspection.actions.map(action => Button({ key: action.id, label: action.label, plain: true, onPress: () => inspectorAction($, action.id) })),
        ],
      })
    return Box({ flexDirection: 'column', children: [sectionTabs, gap(), body] })
  }
  const shown = shownRuns()
  const dagAgents = new Set([...runs.values()].flatMap(r => r.nodes.flatMap(n => (n.agentId ? [n.agentId] : []))))
  const agents = await $.agent.list()
  const act = (step: () => void) => () => {
    step()
    redraw()
  }
  const footer = [
    gap(),
    Box({
      flexDirection: 'row',
      columnGap: 2,
      children: [
        Button({ key: 'select-next', label: t.nextNode, hotkey: 'n', plain: true, onPress: act(() => selectNode(1)) }),
        Button({ key: 'select-prev', label: t.prevNode, hotkey: 'p', plain: true, onPress: act(() => selectNode(-1)) }),
        Button({ key: 'details', label: view.details ? t.compact : t.details, hotkey: 'd', plain: true, onPress: act(() => (view = { ...view, details: !view.details })) }),
        Button({
          key: 'view-mode',
          label: view.mode === 'tasks' ? t.dagView : t.tasksView,
          hotkey: 't',
          plain: true,
          onPress: act(() => (view = { ...view, mode: view.mode === 'tasks' ? 'dag' : 'tasks' })),
        }),
        Button({ key: 'view-switch', label: t.viewSwitch, hotkey: 'v', plain: true, onPress: () => cycleView($) }),
        Button({ key: 'fold', label: view.unfold ? t.fold : t.unfold, hotkey: 'f', plain: true, onPress: act(() => (view = { ...view, unfold: !view.unfold })) }),
        ...(shown.length > 1
          ? [Button({ key: 'completed-runs', label: t.completedToggle, hotkey: 'c', plain: true, onPress: act(() => (view = { ...view, showCompleted: !view.showCompleted })) })]
          : []),
      ],
    }),
    Text({ dimColor: true, wrap: 'wrap', children: [t.keysHint] }),
  ]

  if (view.mode === 'tasks') {
    const tasks = buildTasks(agents, dagAgents, now, { activity, t })
    return Box({
      flexDirection: 'column',
      children: [sectionTabs, gap(), line([...tasks.header, { text: `  ${t.dagSwitch(shown.length)}`, color: ACCENT }]), gap(), ...tasks.rows.flatMap(rows => rows.map(line)), ...footer],
    })
  }

  const model = buildPane(shown, view, now, { activity, waiting: waitingTools(), t, taskCount: countTasks(agents, dagAgents) })
  if (model.empty || !model.graph) {
    return Box({ flexDirection: 'column', children: [sectionTabs, gap(), ...model.header.map(line), gap(), Text({ dimColor: true, children: [model.empty ?? ''] }), ...footer] })
  }
  const run = shown[clampRunIndex(view.runIndex, shown.length)] as Run
  const selector = model.runs
    ? [
        line(model.runs.heading),
        ...model.runs.rows.map(row =>
          Button({ key: `run-${row.index}`, label: row.line.map(s => s.text).join(''), plain: true, onPress: act(() => (view = { ...view, runIndex: row.index, selected: undefined })) }),
        ),
        ...(model.runs.completed
          ? [Button({ key: 'completed-list', label: model.runs.completed.map(s => s.text).join(''), plain: true, onPress: act(() => (view = { ...view, showCompleted: !view.showCompleted })) })]
          : []),
        gap(),
      ]
    : []
  const graph = Client
    ? Client({ key: 'graph', module: './ui/graph-client.ts', props: model.graph, width: '100%' })
    : Box({ flexDirection: 'column', children: viewLines(model.graph, FALLBACK_GRAPH_COLUMNS).map(line) })
  const cards = model.cards.map(card =>
    Box({
      flexDirection: 'column',
      borderStyle: 'round',
      ...(card.selected ? { borderColor: ACCENT } : { borderDimColor: true }),
      paddingX: 1,
      children: [
        Box({
          flexDirection: 'row',
          columnGap: 1,
          children: [
            Button({ key: `node-${card.id}`, label: card.expanded ? '[-]' : '[+]', plain: true, onPress: () => toggleFold($, run, card.id) }),
            line(card.header),
          ],
        }),
        ...(card.lines.length ? [Box({ flexDirection: 'column', paddingLeft: 4, children: card.lines.map(line) })] : []),
      ],
    }),
  )
  return Box({
    flexDirection: 'column',
    children: [
      sectionTabs,
      gap(),
      ...model.header.map(line),
      gap(),
      ...selector,
      graph,
      gap(),
      line([{ text: t.dependencies, bold: true }]),
      ...model.dependencies.map(line),
      gap(),
      line([{ text: t.nodeDetails, bold: true }]),
      ...cards,
      ...(model.errors.length ? [gap(), ...model.errors.map(line)] : []),
      ...footer,
    ],
  })
}

export function register(on: On, options: PluginOptions) {
  language = options.language === 'ko' ? 'ko' : 'en'
  autoRecovery = options.auto_recovery !== false
  jevEnabled = options.jev_enabled !== false
  jevModelFallback = options.jev_model_fallback !== false
  if (typeof options.jev_confidence === 'number' && Number.isFinite(options.jev_confidence) && options.jev_confidence >= 0 && options.jev_confidence <= 1) jevConfidence = options.jev_confidence
  const modelRouting = options.jev_model_routing_confidence
  if (typeof modelRouting === 'number' && Number.isFinite(modelRouting) && modelRouting >= 0 && modelRouting <= 1) jevModelRoutingConfidence = modelRouting
  t = stringsFor(options.language)
  if (typeof options.max_concurrent === 'number' && options.max_concurrent >= 1) maxConcurrent = Math.floor(options.max_concurrent)
  if (typeof options.retention_days === 'number') retentionDays = options.retention_days
  if (options.node_messages === 'full') nodeMessages = 'full'
  if (ENFORCEMENTS.includes(options.enforcement as Enforcement)) enforcement = options.enforcement as Enforcement
  if (Array.isArray(options.main_allowed_tools)) extraAllowed = new Set(options.main_allowed_tools)
  jevPermissionScope = options.jev_permission_scope === 'dag' ? 'dag' : 'all'

  on('session.start', async ($, e, next) => {
    interactive = e.isInteractive
    paneSurface = e.surface === null || e.surface === 'terminal' || e.surface === 'desktop'
    sessionClosed = false
    keepAliveQueued = false
    await restorePlanningLoaded($)
    if (jevEnabled) {
      try {
        jevApiKey = await $.env.get('TYPESAFE_API_KEY')
      } catch (error) {
        $.ui.log(`Jev credentials unavailable (${error instanceof Error ? error.name : 'unknown error'}); keeping existing decisions`)
      }
      if (!jevApiKey) $.ui.log(jevModelFallback
        ? 'Jev API inactive: TYPESAFE_API_KEY is not set; using the session model, billed to your Claude plan'
        : 'Jev inactive: TYPESAFE_API_KEY is not set; keeping existing decisions')
    }
    sessionId = await $.session.id()
    await $.tool.register({ name: 'dag', description: TOOL_DESCRIPTION, inputSchema: INPUT_SCHEMA })
    try {
      await loadRuns($)
    } catch (error) {
      $.ui.log(`could not load DAG checkpoints: ${message(error)}`)
    }
    try {
      await pruneArtifacts($)
    } catch (error) {
      $.ui.log(`could not prune expired DAG artifacts: ${message(error)}`)
    }
    try {
      await loadMetadata($)
    } catch (error) {
      $.ui.log(`could not restore workflow context: ${message(error)}`)
    }
    try {
      await refreshSessions($)
      await serialized(async () => {
        await recoverRuns($)
        for (const run of runs.values()) {
          if (run.sessionId === sessionId && isSettled(run) && !run.settledNotified) await announce($, run)
        }
      })
    } catch (error) {
      $.ui.log(`could not recover session work: ${message(error)}`)
    }
    try {
      await loadPrefs($)
      await loadViewChoice($)
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
    $.clock.every(10_000, async () => {
      if (sessionClosed) return
      try {
        await refreshSessions($)
        await serialized(() => refreshExternalRuns($))
        $.ui.invalidate('ui.render')
      } catch (error) {
        $.ui.log(`could not refresh project sessions: ${message(error)}`)
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
    const previousContext = workflowContext
    if (e.source === 'clear') {
      await setPlanningLoaded($, false)
      userRequest = ''
    }
    const previous = sessionId
    sessionId = await $.session.id()
    if (previous && previous !== sessionId) {
      await serialized(async () => {
        for (const run of [...runs.values()]) {
          if (run.sessionId === previous) await persist($, { ...run, sessionId, ...(run.handoff ? { handoff: { ...run.handoff, from: sessionId } } : {}) })
        }
      })
      await loadMetadata($)
      if (e.source === 'clear' && workflowContext.requests.length === 0) {
        workflowContext = { ...previousContext, sessionId, updatedAt: await $.clock.now() }
        userRequest = workflowContext.requests.at(-1)?.text ?? ''
        await persistContext($)
      }
    }
    sessionClosed = false
    await refreshSessions($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    sessionClosed = true
    try {
      await refreshSessions($, true)
    } catch (error) {
      $.ui.log(`could not close project session record: ${message(error)}`)
    }
    return next(e)
  })

  on('session.receive', async ($, e, next) => {
    const peer = e.origin.kind === 'peer' || e.origin.kind === 'peer-send-message'
    if (e.agentId || !peer || !/(^|\n)\[dag-handoff\](?:\s|$)/.test(e.text)) return next(e)
    await refreshSessions($)
    await serialized(() => refreshExternalRuns($))
    $.ui.log('A manual handoff is available. Open /dag sessions or the Sessions pane to inspect and accept it.')
    $.ui.toast(t.toastHandoff, { timeoutMs: ATTENTION_TOAST_MS })
    $.ui.invalidate('ui.render')
    return { consumed: 'Manual handoff awaits user action; no work was accepted automatically.' }
  })

  on('prompt.context', async ($, e, next) => {
    if (!projectRoot || !sessionId) return next(e)
    return next({ ...e, blocks: [...e.blocks.filter(block => block.name !== 'dag-workflow'), { name: 'dag-workflow', text: restorationContext() }] })
  })

  on('session.compact', async ($, e, next) => {
    if (e.messages.length === 0) return { skip: 'Not enough messages to compact.' }
    if (e.agentId) return next(e)
    await persistContext($)
    const compacted = await next({
      ...e,
      instructions: [e.instructions, 'Keep the user goal, pinned decisions and unresolved work. Workflow checkpoints and verification evidence, not completion claims, are authoritative.'].filter(Boolean).join('\n'),
    })
    if (compacted.skip !== undefined) return compacted
    return {
      ...compacted,
      messages: [...compacted.messages, { role: 'user' as const, text: `[dag-workflow context restoration]\n${restorationContext()}`, toolUses: [] }],
    }
  })

  on('turn.step', async function* ($, e, next) {
    const agentId = e.agentId
    if (!agentId) return yield* next(e)
    seenAgent($, agentId, 'turn.step')
    clearWaiting($, agentId)
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
    if (isPlanningSkill(e.skill)) await setPlanningLoaded($, true)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const userOrigin = e.origin.kind === 'composer' || e.origin.kind === 'bridge' || e.origin.kind === 'sdk'
    if (next.origin.plugin === 'engine' && userOrigin && e.text.trim()) {
      userRequest = e.text
      workflowContext = recordRequest(workflowContext, { text: e.text, at: await $.clock.now() })
      await persistContext($)
    }
    return next({ ...e, context: [...(e.context ?? []), ...(enforcement === 'off' ? [] : [protocolFor(enforcement, interactive)]), restorationContext()] })
  })

  on('classic.PermissionRequest', async ($, e, next) => {
    const agentId = e.agent_id
    if (agentId && nodeOfAgent(agentId)) {
      seenAgent($, agentId, 'classic.PermissionRequest')
      const toolUseId = [...openCalls].reverse().find(([, call]) => call.agentId === agentId && call.tool === e.tool_name)?.[0]
      await markWaiting($, agentId, e.tool_name, toolUseId)
    }
    return next(e)
  })

  on('tool.check', async ($, e, next) => {
    const decided = await next(e)
    if (decided.decision !== 'ask') return decided
    const call = e.tool_use_id ? openCalls.get(e.tool_use_id) : undefined
    // The host sets agentId on a real call in a subagent loop; openCalls only knows calls whose tool.call reached this plugin.
    const worker = ownNodeOfAgent(e.agentId ?? call?.agentId)
    // The answer stays with the person: mark the node worker that will wait for it.
    const asked = async (why: string) => {
      if (call && e.tool_use_id) await markWaiting($, call.agentId, e.tool, e.tool_use_id)
      if (!interactive && worker && noteAsk(worker.run.runId, worker.nodeId, worker.attempt, e.tool)) {
        $.ui.log(`${worker.run.runId}/${worker.nodeId}: ${headlessAskNote(e.tool, why)}`)
      }
      return decided
    }
    const context = e.tool_use_id ? toolContexts.get(e.tool_use_id) : undefined
    if (jevPermissionScope === 'dag' && context?.task === undefined) return asked('Jev not asked: jev_permission_scope is dag and the call carries no node task')
    const request = permissionRequest(e.tool, e.input, context ?? { request: userRequest, projectRoot })
    const evaluation = await evaluateJev($, request, next.signal)
    const choice = evaluation.choices.get('permission')
    const outcome = decisionOutcome(evaluation, choice, 'permission')
    const applied = outcome === 'applied' && choice && (choice.choice === 'allow' || choice.choice === 'deny')
    const why = choice ? `Jev ${outcome}: ${choice.choice} at ${choice.confidence}, jev_confidence ${jevConfidence}` : `Jev ${outcome}`
    await persistDecisions($, [decisionRecord({
      at: await $.clock.now(), kind: 'permission', subject: e.tool,
      proposed: decided.decision, selected: applied ? choice.choice : decided.decision,
      source: applied ? 'jev' : 'baseline', outcome, latencyMs: evaluation.latencyMs,
      stateHash: hash(stableStringify(request.state)),
      ...(choice ? { confidence: choice.confidence, ...(choice.probabilities ? { probabilities: choice.probabilities } : {}) } : {}),
      ...(worker ? { runId: worker.run.runId, nodeId: worker.nodeId } : {}),
      ...(worker && !applied && !interactive ? { note: headlessAskNote(e.tool, why) } : {}),
    }, evaluation)])
    if (!applied) return asked(why)
    debug($, `Jev permission ${e.tool}: ${choice.choice} (${choice.confidence})`)
    return { decision: choice.choice, reason: `Jev ${choice.choice} (${choice.confidence})` }
  })

  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId) seenAgent($, agentId, 'tool.call')
    const owner = agentId ? nodeOfAgent(agentId) : undefined
    const def = owner?.run.definition.nodes.find(node => node.id === owner.nodeId)
    const node = owner?.run.nodes.find(current => current.id === owner.nodeId)
    const context: JevContext = {
      request: userRequest,
      projectRoot,
      ...(owner ? { goal: owner.run.definition.goal ?? owner.run.name } : {}),
      ...(def ? { task: node?.promptOverride ?? def.prompt } : {}),
    }
    toolContexts.set(e.tool_use_id, context)
    if (agentId && owner) openCalls.set(e.tool_use_id, { agentId, tool: e.tool })
    try {
      if (!agentId) {
        if (e.tool === 'Skill' && isPlanningSkill((e as { skill?: unknown }).skill)) await setPlanningLoaded($, true)
        if (enforcement !== 'strict' || next.origin.plugin !== 'engine') return await next(e)
        const verdict = mainLoopVerdict(e.tool, e as Readonly<Record<string, unknown>>, extraAllowed)
        if (verdict.allowed) return await next(e)
        $.ui.log(`refused ${e.tool} in the main conversation; work runs in DAG nodes`)
        return { deny: denyMessage(e.tool, verdict.reason) }
      }
      const target = (e as { file_path?: unknown }).file_path
      if (owner && e.tool === 'Write' && typeof target === 'string' && isBlockedReportPath(target)) {
        return { deny: `Claude Code refuses subagent writes to REPORT*, SUMMARY*, FINDINGS* and ANALYSIS* Markdown files ("Subagents should return findings as text, not write report files"). Put the full file text in ## Output (or write ${owner.nodeId}-notes.md); the main conversation writes the requested file after the run settles. Bash, mv or a rename is no way around it.` }
      }
      activity.set(agentId, toolStarted(e.tool, Date.now()))
      try {
        return await next(e)
      } finally {
        if (activity.get(agentId)?.phase === 'tool') activity.set(agentId, stepStarted(Date.now()))
      }
    } finally {
      toolContexts.delete(e.tool_use_id)
      openCalls.delete(e.tool_use_id)
      if (agentId) clearWaiting($, agentId, { toolUseId: e.tool_use_id, tool: e.tool })
    }
  }).catch(async ($, e, next) => {
    // A failed hook is skipped and the call runs, so strict enforcement fails closed here with pure checks only (1 s budget).
    if (e.agentId || enforcement !== 'strict' || next.origin.plugin !== 'engine') return next(e)
    let reason: string
    try {
      const verdict = mainLoopVerdict(e.tool, e as Readonly<Record<string, unknown>>, extraAllowed)
      if (verdict.allowed) return next(e)
      reason = verdict.reason
    } catch {
      if (MAIN_LOOP_TOOLS.has(e.tool) || extraAllowed.has(e.tool)) return next(e)
      reason = `${e.tool} could not be classified`
    }
    return { deny: `${denyMessage(e.tool, reason)} (gate failed: ${next.error.kind})` }
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) seenAgent($, e.agentId, 'turn.complete')
    if (e.agentId) activity.delete(e.agentId)
    if (e.agentId) clearWaiting($, e.agentId)
    if (e.agentId && agentRuns.has(e.agentId)) {
      const end: AgentEnd = { agentId: e.agentId, reason: e.reason, isAborted: e.isAborted, answer: e.answer }
      try {
        await onAgentDone($, end)
      } catch (error) {
        $.ui.log(`could not record the end of agent ${end.agentId}: ${message(error)}`)
      }
    }
    if (!e.agentId) {
      mainTurnBusy = false
      // Started here, inside the hook frame, so the workers stay visible to this plugin's own hooks.
      while (pendingStarts.length > 0) {
        const runId = pendingStarts.shift()!
        try {
          await serialized(() => tick($, runId))
        } catch (error) {
          $.ui.log(`could not start deferred run ${runId}: ${message(error)}`)
        }
      }
    }
    if (!e.agentId && !interactive && hasActiveRun()) await holdUntilSettled($, next.signal)
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

  on('command.run', { command: 'dag' }, async ($, e) => {
    const verb = splitArgs(e.args ?? '')[0]
    if ((verb === 'handoff' || verb === 'accept' || verb === 'note') && e.origin.kind !== 'composer') return { text: 'This action requires a user command or pane control.' }
    if (!mainTurnBusy || (verb !== 'run' && verb !== 'retry')) return serialized(() => runCommand($, e.args ?? ''))
    return serialized(async () => {
      const before = pendingStarts.length
      deferStarts = true
      try {
        const out = await runCommand($, e.args ?? '')
        return pendingStarts.length > before ? { text: `${out.text ?? ''}\n${t.runDeferred}`.trim() } : out
      } finally {
        deferStarts = false
      }
    })
  })

  on('turn.start', async ($, e, next) => {
    mainTurnBusy = true
    // The turn a keep-alive prompt asked for has begun (turn.start fires for main turns only); the next completion
    // while that turn's end is held may queue another.
    keepAliveQueued = false
    return next(e)
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e)
    // The host raises no render for a pane it holds undrawn, so this one proves it is placed.
    setPaneWaitReason($, undefined)
    return drawPane($, e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const summary = e.props.hasSurvey ? undefined : summarizeActive(runs.values(), sessionId, waiting.size)
    const band = summary && buildBand({
      summary, waitingAgents: waiting, columns: e.props.bodyColumns, rows: e.props.maxRows, t,
      ...(paneWaitReason === undefined ? {} : { paneWaitReason }),
    })
    if (!summary || !band) return next(e)
    const elements = $.ui.resolve(e)
    const { Box, Button } = elements
    return Box({
      flexDirection: 'column',
      children: [
        ...(band.summary ? [drawLine(elements, band.summary)] : []),
        Box({
          flexDirection: 'row',
          columnGap: BAND_GAP,
          children: band.buttons.map(button => Button({
            key: button.key, label: button.label, hotkey: button.hotkey, plain: true,
            onPress: () => openFromBand($, summary.run.runId, button.nodeId),
          })),
        }),
        ...(band.notice ? [drawLine(elements, band.notice)] : []),
        await next(e),
      ],
    })
  })

  on('tool.call', { tool: /^SubagentHandback$/ }, async ($, e, next) => {
    const agentId = e.agentId
    if (agentId) seenAgent($, agentId, 'tool.call')
    if (!agentId || !agentRuns.has(agentId)) return next(e)
    const sent = (e as { message?: unknown }).message
    handbacks.set(agentId, typeof sent === 'string' ? sent : '')
    const owner = nodeOfAgent(agentId)
    if (nodeMessages === 'full' || !owner) return next(e)
    const excerpt = typeof sent === 'string' ? extractOutput(sent) : ''
    return next({ ...e, message: nodeMessage(owner.run, owner.nodeId, excerpt) } as typeof e)
  })

  on('ui.message', async ($, e, next) => {
    if (e.requestId === PANE_ID && e.element === 'inspector') {
      const data = e.data
      if (data && typeof data === 'object' && 'action' in data && typeof data.action === 'string') await inspectorAction($, data.action)
      if (data && typeof data === 'object' && 'columns' in data && typeof data.columns === 'number' && Number.isFinite(data.columns) && data.columns > 0 && inspectorColumns !== Math.floor(data.columns)) {
        inspectorColumns = Math.floor(data.columns)
        $.ui.invalidate('ui.render')
      }
      return {}
    }
    if (e.requestId !== PANE_ID || e.element !== 'graph') return next(e)
    const data = e.data as { key?: unknown; shift?: unknown; view?: unknown } | null
    const choice = viewChoice(data?.view)
    if (choice) await setView($, choice)
    else if (data && typeof data.key === 'string') await handlePaneKey($, data.key, data.shift === true)
    return {}
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE_ID && e.origin.kind === 'person') paneClosedByUser = true
    return next(e)
  })
}
