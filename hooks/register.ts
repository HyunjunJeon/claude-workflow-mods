import type { Elements, EngineInterface, On, PluginOptions, RenderInput, RenderSurface, SessionMessage, Timer, ToolCallResult, ToolCheckDecision } from 'claude-code'
import { parseDefinition } from './engine/definition.ts'
import { err, keepAliveMessage, listText, nodeMessage, ok, previewText, runLine, runStartedMessage, settleMessage, splitArgs, statusText, type ToolReply } from './engine/format.ts'
import { buildNodePrompt, extractOutput, hasStatusLine, parseOutcome, spawnTarget, type UpstreamResult } from './engine/node-prompt.ts'
import { isBlockedReportPath, isFinalAudit, lintDefinition, notesNameFor } from './engine/lint.ts'
import { previewDefinition, type Preview } from './engine/preview.ts'
import { answerModeRequest, MODE_CONFIDENCE, modeRequest, PERSON_TOOLS, popupAnswer, modelPrompt, parseChoices, parseModelChoices, permissionRequest, recoveryRequest, routingParts, routingRequest, SURFACE_CONFIDENCE, type JevChoice, type JevContext, type JevEvaluation, type JevOutcome, type JevRequest } from './engine/jev.ts'
import { shareJevCall, type PendingJevCall } from './engine/jev-calls.ts'
import { appendDecisions, JEV_RULESET_VERSION, parseDecisionLog, type DecisionOutcome, type DecisionRecord } from './engine/decisions.ts'
import { addNote, contextSlices, contextSummary, contextUnseen, deliverBlock, deliverRuns, emptyContext, nothingDelivered, parseContext, recordRequest, removeNote } from './engine/context.ts'
import { acceptHandoff, cancelHandoff, offerHandoff, parseSession, projectSessions, requestHandoff, sessionConflicts, type SessionRecord } from './engine/sessions.ts'
import { hash, stableStringify } from './engine/hash.ts'
import { recoverNode, recoveryKind, MAX_AUTO_RECOVERIES, verdictFailure } from './engine/recovery.ts'
import { CHECK_DEFECT, exitProblem, isCheckDefect, missingProgram, textProblem } from './engine/check-eval.ts'
import { DEFAULT_COMMAND_TIMEOUT_MS, projectPath, readOnlyAbsolutePath, timeoutAdvice, verificationProblem } from './engine/verification.ts'
import { commandPrograms, missingProgramsMessage } from './engine/programs.ts'
import { findingSections, reworkPlan, withReworkSkip } from './engine/rework.ts'
import { fixDiffText, isLedgerReviewer, ledgerBlock } from './engine/ledger.ts'
import { isReviewStageNode, lensNotesFile, lensVerifyFolder, parseCandidates, REVIEW_SECURITY_ID, securityLensOf, verifierNodes } from './engine/stages.ts'
import { denyMessage, gatesMainLoop, gatesPlanning, isPlanningSkill, MAIN_LOOP_TOOLS, mainLoopVerdict, PLANNING_SKILL, planningRequired, protocolFor, type Enforcement, type TurnMode, type TurnSurface } from './engine/policy.ts'
import {
  amendRun,
  approveRun,
  awaitingApproval,
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
  rejectRun,
  requestApproval,
  requeueLost,
  resumePaused,
  retryRun,
  reworkRun,
  snapshotOf,
  advance,
  expandNodes,
} from './engine/run.ts'
import { retentionPlan, trajectoryOwner, trajectoryPlan, type RetentionFile, type TrajectoryEntry } from './engine/retention.ts'
import { addedLines, allowedPatterns, familiesOf, RULE_FILES, scanSlop, slopNote } from './engine/slop-scan.ts'
import { killByName, killRefusal } from './engine/kill-guard.ts'
import { addedLinesByFile, applyEdit, kisaRows, lensNotesWithSemgrep, mergeCandidates, owaspCweRows, parseSemgrepReport, SEMGREP_RULES_DIR, semgrepArgv, semgrepCandidates, semgrepNote, semgrepRefusal, semgrepTarget, semgrepVersion, type GuideRows, type SemgrepHit } from './engine/semgrep.ts'
import { addUsage, cut, eventFileName, rowsAfter, settleRecord, TRAJECTORY_SUBDIR, trajectoryLine, transcriptRows, type NotesFile, type RowMark, type TrajectoryInput, type Usage } from './engine/trajectory.ts'
import { failedCheckFingerprint, repeatCheck, REPEAT_CHECK_NOTE, verificationCommand, type RepeatedCheck } from './engine/tool-repeat.ts'
import { parseYaml } from './engine/yaml.ts'
import { appendLearningEvent, applyLearningProposals, archiveUnusedSkills, archivedSkillPath, eligibleSkills, emptyLearningSession, emptyLibrary, learnedSkillPath, learningCatalog, parseLearningLibrary, parseLearningProposals, parseLearningSession, parseLearningTransaction, prepareLearningBatch, recordSkillOpportunity, recordSkillUse, renderLearnedSkill, reserveLearningUsage, type LearnedSkill, type LearningEvent, type LearningLibrary, type LearningTransaction } from './engine/learning.ts'
import { boundInput, capText } from './engine/jev.ts'
import { INPUT_SCHEMA, TOOL_DESCRIPTION } from './engine/tool-spec.ts'
import { applyEdits, boardForModel, diffKey, diffsNeeded, newBoard, parseBoardFile, parseEdits, peekKey, peeksNeeded, traceKey, tracesNeeded, type DiffRequest, type PeekRequest, type TraceRequest } from './engine/board.ts'
import { BOARD_INPUT_SCHEMA, BOARD_TOOL_DESCRIPTION } from './engine/board-spec.ts'
import { boardToMarkdown } from './engine/board-export.ts'
import { chipContext, chipLabel, chipSpans, citedChips } from './engine/board-chips.ts'
import type { Board, BoardEdit, BoardFile } from './engine/board-types.ts'
import { fail, TEXT_FIELDS, type CommandCheck, type Definition, type EngineError, type FileCheck, type NodeDef, type NodeRun, type Result, type Run, type VerificationEvidence, type VerificationOutcome } from './engine/types.ts'
import { chunkArrived, finalReport, fromTranscript, stepStarted, toolStarted, type Activity, type StepChunk, type TranscriptRow } from './ui/activity.ts'
import { approvalPreview } from './ui/approval.ts'
import { BAND_GAP, buildBand, summarizeActive } from './ui/band.ts'
import { stringsFor, type Strings } from './ui/i18n.ts'
import type { ViewKind } from './ui/graph-model.ts'
import { ACCENT } from './ui/text.ts'
import { buildInspector, type InspectorView } from './ui/inspector-model.ts'
import { adjacentBoardId, buildBoardView } from './ui/board-model.ts'
import { viewLines, VIEWS } from './ui/views.ts'
import { BACKGROUND_WAIT_TOOL, buildPane, buildTasks, clampRunIndex, countTasks, isExpanded, nodeOrder, stepSelection, visibleRuns, type CollapsePrefs, type Line, type ViewState } from './ui/view-model.ts'

const TOOL_NAME = 'mcp__dag-workflow__dag'
const DAG_SUBDIR = '.claude/dag'
const RUNS_SUBDIR = `${DAG_SUBDIR}/runs`
const BOARDS_SUBDIR = `${DAG_SUBDIR}/boards`
const USAGE = 'Usage: /dag [list | run <file> | preview <file> | status <run> | cancel <run> | retry <run> [nodes...] | approve <run> | reject <run> [reason] | approval [off|always] | context | note <text> | note rm <number> | decisions [id] | sessions | handoff <run> <session|cancel> | accept <run> | inspect <dag|decisions|context|sessions|board> | enforce [strict|auto|guide|off] | view [auto|graph|lanes|timeline] | learn | learning [status|on|off|prune]]'
const ENFORCEMENTS: readonly Enforcement[] = ['strict', 'auto', 'guide', 'off']
type StartApproval = 'off' | 'always'
const START_APPROVALS: readonly StartApproval[] = ['off', 'always']
const USER_ONLY = 'This action requires a user command or pane control.'
const APPROVAL_NOTE = 'The user must approve this run in the /dag pane or with /dag approve <run_id> before any node starts. Do not poll; you will receive a message when it is approved or rejected.'
const REPORT_LIMIT = 4_000_000
// A headless host waits for a held main turn.complete for 60 000 ms only ("[WARN] headless session: turn events still
// running after 60000ms; the turn ends without them", measured in a live `claude -p` run); it does not abort the hold.
// Past that only live agents and queued prompts keep the session up, which is why a node completion while the turn
// is held submits a keep-alive prompt. This constant now only caps how long one hold loop polls when no completion
// hands it off.
const HOLD_LIMIT_MS = 3_600_000
// How long a node worker that ended its turn with background work pending may stay quiet before its node fails. The host
// stops a background Bash command after its timeout, 1 800 000 ms by default, and caps a Monitor's timeout_ms at
// 1 800 000 ms, so by then the work has ended or been re-armed and its notification has started the worker's next turn.
// On 2026-10-10 a node that ended its turn waiting on a background `bun eval/run.ts` was verified at once and failed; it
// resumed by itself later and passed.
const BACKGROUND_WAIT_MS = 30 * 60_000
const PANE_ID = 'dag'
const PREFS_KEY = 'collapse-prefs'
const VIEW_KEY = 'pane-view'
const FALLBACK_GRAPH_COLUMNS = 60
const JEV_TIMEOUT_MS = 5_000
// Session-model routing requests (1-3 nodes, up to 8 in parallel, Sonnet at low effort) took 1.5-5.3 s in measurements,
// so the model gets about twice the slowest of them, more room than HTTP.
const JEV_MODEL_TIMEOUT_MS = 10_000
const JEV_MODEL_CALLS = 8
// A board edit runs inside serialized(), so a git read that hangs (an index lock, a stalled network disk) would hold spawns and
// ticks behind it. git show and git diff against a local ref took 17-26 ms in this repository (git 2.54), so 10 s leaves room
// for a slow disk and still gives the queue back.
const GIT_READ_TIMEOUT_MS = 10_000
// The whole mode decision under enforcement auto, both backends together: the user's prompt waits for it before it
// enters. HTTP alone may take JEV_TIMEOUT_MS and the model JEV_MODEL_TIMEOUT_MS after it (15 s), while session-model
// routing calls took 1.5-5.3 s, so 8 s covers a slow model answer and runs an unanswered turn directly.
// It bounds the person's wait: the host's 10 s hook budget (HookBudget.ms) counts only the hook's own code, not its
// $ calls, and 8 s stays under it even if the whole wait counted.
const MODE_BUDGET_MS = 8_000
// The reminder after an AskUserQuestion result that turns a direct turn into a dag one; the dag protocol follows it.
const ANSWER_DAG_LINE = '[dag-workflow] This answer selects work that runs as a DAG under enforcement auto, so the main-loop tools are now gated for the rest of this turn: plan it with the dag-workflow:planning skill and start a run.'
// The planning skill's final audit never runs on trivial; the plugin holds it to that whatever the proposal or Jev said.
const FINAL_AUDIT_CATEGORY = 'standard'
// The command a readonly decision keeps in its note: enough to tell which command the host did not mark read-only.
const DECISION_COMMAND_CHARS = 200
const GITIGNORE = '# dag-workflow run checkpoints and node reports\n*\n'
const SAFE_RUN_DIR = /^dag_[A-Za-z0-9_-]+$/
const SAFE_FILE = /^[A-Za-z0-9_.-]+\.json$/

function debug($: EngineInterface, text: string): void {
  $.ui.log(`dag-workflow: ${text}`, { to: 'debug' })
}

// The strict gate must outlive the conversation's process, while the conversation still holds the planning skill.
// `planningLoaded` is the fast in-process copy, and two stores carry it past a restart of the plugin's code:
// - /reload-plugins re-runs register() and starts every module variable over; the host keeps $.state across it.
//   The ref is declared in types/index.d.ts.
// - claude --resume starts a new process under the same session id, and $.state lives only as long as the process, so
//   the per-session context file (persistContext) also carries the flag, as `planningLoaded: true`.
const PLANNING_FLAG = { plugin: 'dag-workflow', key: 'planningLoaded' } as const

// A failed store write is only logged: the in-process flag has already changed and only the stored copy is lost, so a
// later reload or resume can drop it. Only true is written to the context file: the one false call is the /clear
// branch, which runs before the session id changes, so writing there would strip the old session's own flag. The file
// write stays a no-op until the session owns a run or a note (contextWanted); its first write then carries the flag.
async function setPlanningLoaded($: EngineInterface, loaded: boolean): Promise<void> {
  planningLoaded = loaded
  try {
    await $.state.set(PLANNING_FLAG, loaded)
  } catch (error) {
    debug($, `could not store the planning-skill flag: ${message(error)}`)
  }
  if (!loaded || !projectRoot || !sessionId || workflowContext.sessionId !== sessionId) return
  try {
    await persistContext($)
  } catch (error) {
    debug($, `could not store the planning-skill flag in the context file: ${message(error)}`)
  }
}

// Reload: only a true in $.state opens the gate here. Resume: restorePlanningFromContext opens it from the context file.
// A missing, unreadable or unparsable flag in either store keeps the gate closed, as a fresh session has it.
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
let enforcement: Enforcement = 'auto'
// How the current user turn runs under auto. A new process starts at 'dag', the strict rules, until the next user
// prompt is decided: a reload in the middle of a direct turn closes the gate for the rest of that turn.
let turnMode: TurnMode = 'dag'
// Where the current user turn's answer is shown under auto: 'board' only when Jev confidently judged that the user wants to
// understand something with several parts. Reset to 'chat' for each user prompt, kept by a plugin's prompt like the mode.
let turnSurface: TurnSurface = 'chat'
// start_approval from settings, and the /dag approval override that wins over it until the plugin's code reloads.
let startApproval: StartApproval = 'off'
let approvalOverride: StartApproval | undefined
let planningLoaded = false
// Skill tool calls for the planning skill that a node worker has in flight; see the tool.call hook.
let nodePlanningCalls = 0
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
let learningEnabled = true
let learningInterval = 20
let learningMinOpportunities = 50
let learningMaxSkills = 30
let learningMaxInputChars = 60_000
let learningDailyLimit = 20
let learningRetentionDays = 30
let learningRoot = ''
// The home skills folder. Only legacy learned skills (no location) live there; learnedSkillPath sends new ones to their
// project's .claude/dag/skills.
let learnedSkillsDir = ''
let learningSession = emptyLearningSession()
let learningLibrary = emptyLibrary()
const learningAgents = new Set<string>()
let learningTurnRequested = false
let learningSpawning = false
let learningSpawnName: string | undefined
// Numbers temp files of atomicWrite and the names of learning agents, so each is unique within the process.
let writeSequence = 0
let learningQueue: Promise<unknown> = Promise.resolve()

function learningSessionPath(id = sessionId): string {
  return `${learningRoot}/sessions/${hash(id)}.json`
}

async function learningDirectory($: EngineInterface, path: string): Promise<void> {
  const made = await $.process.run(['mkdir', '-p', path])
  if (made.exitCode !== 0) throw new Error(`cannot create learning directory: ${made.stderr.trim()}`)
  const stat = await $.fs.stat(path)
  if (stat.kind !== 'dir' || stat.isLink) throw new Error(`learning directory is not a plain directory: ${path}`)
}

function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/'))
}

// Creates the folder of a learned skill's file and the skills or archive folder above it, each a plain directory, so a
// symlink cannot send the file elsewhere. A project skill's file can be the first one in its project's .claude/dag, so
// that store's .gitignore is ensured before it.
async function prepareSkillFolder($: EngineInterface, skill: LearnedSkill, path: string): Promise<void> {
  const folder = parentOf(path)
  await learningDirectory($, parentOf(folder))
  await learningDirectory($, folder)
  if (skill.location === 'project') await ensureGitignore($, skill.projectRoot)
}

// $.fs.write is not atomic and the host has no rename, so a process exit during a direct write leaves a truncated file.
// The text goes to a temp file beside the target and `mv -f` swaps it in; a failed write or move removes the temp file and
// throws, and the target keeps its earlier text. One `mv -f` of a 50 KB file measured 2.0 ms on 2026-10-22 (100 calls in
// 0.20 s under /usr/bin/time on this Mac, against 1.9 ms for a bare /usr/bin/true), so the move costs one process spawn
// plus the host's call overhead, unmeasured here. `what` names the data in the error.
async function atomicWrite($: EngineInterface, path: string, text: string, what: string): Promise<void> {
  const temp = `${path}.${hash(sessionId)}.${++writeSequence}.tmp`
  try {
    await $.fs.write(temp, text)
    const moved = await $.process.run(['mv', '-f', temp, path])
    if (moved.exitCode !== 0) throw new Error(`could not save ${what}: ${moved.stderr.trim()}`)
  } catch (error) {
    await removePath($, '-f', temp, `remove the temp file of ${what}`)
    throw error
  }
}

function learningWrite($: EngineInterface, path: string, text: string): Promise<void> {
  return atomicWrite($, path, text, 'learning data')
}

async function saveLearningSession($: EngineInterface, id = sessionId): Promise<void> {
  if (!learningRoot) return
  await learningWrite($, learningSessionPath(id), JSON.stringify(learningSession) + '\n')
}

async function readLearningLibrary($: EngineInterface): Promise<LearningLibrary> {
  const path = `${learningRoot}/library.json`
  if (!await $.fs.exists(path)) return emptyLibrary()
  const parsed = parseLearningLibrary(await $.fs.read(path))
  if (!parsed.ok) throw new Error(parsed.error.message)
  return parsed.value
}

// Callers in this session queue here, so the directory lock only ever meets another session's holder. This is not
// serialized(): that queue also holds agent spawns and Jev calls, which a prompt or a worker's Read must not wait
// behind. Nothing on this queue awaits serialized() or another library update, so the two queues cannot deadlock.
function updateLearningLibrary($: EngineInterface, update: (library: LearningLibrary) => LearningLibrary | Promise<LearningLibrary>): Promise<void> {
  const result = learningQueue.then(() => updateLockedLibrary($, update))
  learningQueue = result.catch(() => undefined)
  return result
}

// A directory lock protects read/modify/write across independent sessions, not just this module's queue.
// Contention leaves the session's unlearned evidence intact for its next turn; no hook waits for another session.
async function updateLockedLibrary($: EngineInterface, update: (library: LearningLibrary) => LearningLibrary | Promise<LearningLibrary>): Promise<void> {
  const lock = `${learningRoot}/.lock`
  let acquired = await $.process.run(['mkdir', lock])
  if (acquired.exitCode !== 0 && await $.fs.exists(lock)) {
    const stat = await $.fs.stat(lock)
    if (!stat.isLink && stat.kind === 'dir' && (await $.clock.now()) - stat.mtimeMs > 60_000) {
      const released = await $.process.run(['rmdir', lock])
      if (released.exitCode === 0) acquired = await $.process.run(['mkdir', lock])
    }
  }
  if (acquired.exitCode !== 0) throw new Error('Learning library is busy; retained evidence for the next turn.')
  try {
    const pending = `${learningRoot}/pending.json`
    if (await $.fs.exists(pending)) {
      const parsed = parseLearningTransaction(await $.fs.read(pending))
      if (!parsed.ok) throw new Error(parsed.error.message)
      await publishLearningTransaction($, parsed.value, true)
    }
    const before = await readLearningLibrary($)
    const after = await update(before)
    const changed = after.skills.some(skill => {
      const previous = before.skills.find(item => item.id === skill.id)
      return previous?.revision !== skill.revision || previous.archived !== skill.archived
    })
    if (changed) await publishLearningTransaction($, { schemaVersion: 1, before, after })
    else {
      await learningWrite($, `${learningRoot}/library.json`, JSON.stringify(after) + '\n')
      learningLibrary = after
    }
  } finally {
    const released = await $.process.run(['rmdir', lock])
    if (released.exitCode !== 0) $.ui.log('Could not release the session learning library lock.')
  }
}

async function publishLearningTransaction($: EngineInterface, transaction: LearningTransaction, recovering = false): Promise<void> {
  const current = stableStringify(await readLearningLibrary($))
  if (current !== stableStringify(transaction.before) && current !== stableStringify(transaction.after)) {
    throw new Error('Learning library changed outside the pending publication; preserving both records.')
  }
  const changed = transaction.after.skills.filter(skill => {
    const previous = transaction.before.skills.find(item => item.id === skill.id)
    return previous?.revision !== skill.revision || previous.archived !== skill.archived
  })
  // Validate every destination before publishing the first file. Recovery accepts only the exact before/after text,
  // so a failed index write is distinguishable from an unmanaged file or a person's later edit. Recovery skips such a
  // skill rather than stopping: a pending.json that never clears would fail every later update in every session.
  const preserved = new Set<string>()
  for (const skill of changed) {
    const previous = transaction.before.skills.find(item => item.id === skill.id)
    const active = learnedSkillPath(skill, learnedSkillsDir)
    const archived = archivedSkillPath(skill, learningRoot)
    for (const path of skill.archived ? [active, archived] : [active]) {
      if (!await $.fs.exists(path)) continue
      const stat = await $.fs.stat(path)
      const text = await $.fs.read(path)
      const beforeText = path === active && previous ? renderLearnedSkill(previous) : undefined
      const afterText = recovering ? renderLearnedSkill(skill) : undefined
      if (stat.isLink || stat.kind !== 'file' || (text !== beforeText && text !== afterText)) {
        if (!recovering) throw new Error(`Preserving an unmanaged or manually changed skill: ${path}`)
        preserved.add(skill.id)
        $.ui.log(`Preserving a manually changed skill while finishing a learning publication: ${path}`)
      }
    }
  }
  const pending = `${learningRoot}/pending.json`
  if (!recovering) await learningWrite($, pending, JSON.stringify(transaction) + '\n')
  for (const skill of changed) {
    if (preserved.has(skill.id)) continue
    const path = learnedSkillPath(skill, learnedSkillsDir)
    if (skill.archived) {
      if (await $.fs.exists(path)) {
        const archived = archivedSkillPath(skill, learningRoot)
        await prepareSkillFolder($, skill, archived)
        const moved = await $.process.run(['mv', '-f', path, archived])
        if (moved.exitCode !== 0) throw new Error(`could not archive ${skill.id}`)
        // rmdir removes only an empty folder, so files a person added beside SKILL.md keep it in place.
        await $.process.run(['rmdir', parentOf(path)])
      }
    } else {
      await prepareSkillFolder($, skill, path)
      const wanted = renderLearnedSkill(skill)
      if (!await $.fs.exists(path) || await $.fs.read(path) !== wanted) await learningWrite($, path, wanted)
    }
  }
  await learningWrite($, `${learningRoot}/library.json`, JSON.stringify(transaction.after) + '\n')
  learningLibrary = transaction.after
  const removed = await $.process.run(['rm', '-f', pending])
  if (removed.exitCode !== 0) throw new Error('Could not clear completed learning publication; it will be recovered next time.')
}

async function pruneLearningData($: EngineInterface): Promise<void> {
  if (!learningRoot || learningRetentionDays === 0) return
  const cutoff = (await $.clock.now()) - learningRetentionDays * 86_400_000
  await updateLearningLibrary($, async library => {
    const skills: LearningLibrary['skills'] = []
    for (const skill of library.skills) {
      if (!skill.archived || skill.updatedAt >= cutoff) {
        skills.push(skill)
        continue
      }
      const path = archivedSkillPath(skill, learningRoot)
      if (await $.fs.exists(path)) {
        const stat = await $.fs.stat(path)
        if (stat.isLink || stat.kind !== 'file' || await $.fs.read(path) !== renderLearnedSkill(skill)) {
          skills.push(skill)
          $.ui.log(`Preserving a manually changed archived skill: ${path}`)
          continue
        }
        const removed = await $.process.run(['rm', '-f', path])
        if (removed.exitCode !== 0) {
          skills.push(skill)
          $.ui.log(`Could not remove expired archived skill: ${path}`)
          continue
        }
        await $.process.run(['rmdir', parentOf(path)])
      }
      // An active file created at this name since archival is not ours to remove.
      if (await $.fs.exists(learnedSkillPath(skill, learnedSkillsDir))) skills.push(skill)
    }
    return { ...library, skills }
  })
  for (const entry of await $.fs.list(`${learningRoot}/sessions`)) {
    if (entry.kind !== 'file' || entry.isLink || !/^[a-f0-9]+\.json$/.test(entry.name) || entry.mtimeMs >= cutoff) continue
    const path = `${learningRoot}/sessions/${entry.name}`
    if (path === learningSessionPath()) continue
    try {
      const parsed = parseLearningSession(await $.fs.read(path))
      if (!parsed.ok || parsed.value.batch || parsed.value.events.some(event => event.at >= cutoff)) continue
      const removed = await $.process.run(['rm', '-f', path])
      if (removed.exitCode !== 0) $.ui.log(`Could not remove expired learning session: ${path}`)
    } catch (error) {
      $.ui.log(`Could not inspect expired learning session ${path}: ${message(error)}`)
    }
  }
}

async function initializeLearning($: EngineInterface): Promise<void> {
  if (!learningEnabled) return
  const home = await $.env.get('HOME')
  if (!home || !home.startsWith('/')) {
    $.ui.log('Session learning unavailable: HOME is not an absolute directory.')
    return
  }
  learningRoot = `${home.replace(/\/$/, '')}/.claude/dag-workflow/learning`
  learnedSkillsDir = `${home.replace(/\/$/, '')}/.claude/skills`
  await learningDirectory($, `${learningRoot}/sessions`)
  await learningDirectory($, learnedSkillsDir)
  await updateLearningLibrary($, library => library)
  const path = learningSessionPath()
  learningSession = emptyLearningSession()
  if (await $.fs.exists(path)) {
    const parsed = parseLearningSession(await $.fs.read(path))
    if (!parsed.ok) throw new Error(parsed.error.message)
    learningSession = parsed.value
    if (learningSession.batch) {
      const active = (await $.agent.list()).some(agent => agent.id === learningSession.batch?.agentId && agent.status === 'running')
      if (active) learningAgents.add(learningSession.batch.agentId)
      else {
        learningSession = { ...learningSession, batch: undefined }
        await saveLearningSession($)
      }
    }
  }
  await pruneLearningData($)
}

async function collectLearning($: EngineInterface, kind: LearningEvent['kind'], text: string, agentId?: string): Promise<void> {
  if (!learningEnabled || !learningRoot || (agentId && learningAgents.has(agentId)) || !text.trim()) return
  const at = await $.clock.now()
  const id = `${hash(sessionId)}:${learningSession.nextId}`
  const event: LearningEvent = { id, sessionId, projectRoot, kind, text: capText(text, 3_900).replace(/\0/g, '').slice(0, 4_000), at, ...(agentId ? { agentId } : {}) }
  learningSession = appendLearningEvent(learningSession, event)
}

async function startLearning($: EngineInterface, force = false, manual = false): Promise<string> {
  if (!learningEnabled || !learningRoot) return 'Session learning is off or unavailable.'
  if (learningSession.batch || learningSpawning) return 'Session learning is already running.'
  if (!force && learningSession.toolsSinceLearn < learningInterval) return 'Session learning will run after more tool calls.'
  if (!learningSession.events.some(event => event.kind === 'user')) return 'No new user-session experience to learn.'
  if (!learningSession.events.some(event => Number(event.id.split(':').at(-1)) > learningSession.learnedThrough)) return 'No new user-session experience to learn.'
  const now = await $.clock.now()
  let limit: string | undefined
  await updateLearningLibrary($, library => {
    if (manual) return library
    const reserved = reserveLearningUsage(library, now, learningDailyLimit)
    if (!reserved.ok) {
      limit = reserved.error.message
      return library
    }
    return reserved.value
  })
  if (limit) return limit
  const prepared = prepareLearningBatch(learningSession, learningLibrary, projectRoot, learningMaxInputChars)
  if (!prepared.ok) return prepared.error.message
  const snapshot = prepared.value
  learningSpawning = true
  learningSpawnName = `dag-learning-${hash(sessionId)}-${++writeSequence}`
  try {
    const spawned = await $.agent.spawn({
      prompt: snapshot.prompt, name: learningSpawnName,
      description: 'Learn reusable skills from this user session',
      subagentType: 'general-purpose', model: 'sonnet',
    })
    if (!spawned.agentId) return `Could not start session learning: ${spawned.deny ?? 'no agent id'}`
    learningAgents.add(spawned.agentId)
    learningSession = {
      ...learningSession,
      batch: { agentId: spawned.agentId, events: snapshot.events, baseline: snapshot.baseline, through: snapshot.through, editableIds: snapshot.editableIds },
    }
    await saveLearningSession($)
    return 'Session learning started in the background.'
  } finally {
    learningSpawning = false
    learningSpawnName = undefined
  }
}

async function finishLearning($: EngineInterface, end: AgentEnd): Promise<void> {
  const batch = learningSession.batch
  if (!batch || batch.agentId !== end.agentId) return
  try {
    if (!learningEnabled || end.isAborted || end.reason !== 'answer') return
    const answer = end.answer || await recoverReport($, end.agentId)
    const parsed = parseLearningProposals(answer, batch.events, batch.baseline)
    if (!parsed.ok) throw new Error(parsed.error.message)
    if (batch.editableIds && parsed.value.some(proposal => [proposal.id, ...proposal.replaces]
      .some(id => batch.baseline.some(skill => skill.id === id) && !batch.editableIds?.includes(id)))) {
      throw new Error('A proposed update needs the complete existing skill body; retained evidence for relearning.')
    }
    const now = await $.clock.now()
    await updateLearningLibrary($, library => {
      for (const proposal of parsed.value) {
        for (const id of [proposal.id, ...proposal.replaces]) {
          const expected = batch.baseline.find(skill => skill.id === id)
          const current = library.skills.find(skill => skill.id === id)
          if (current?.revision !== expected?.revision || current?.archived !== expected?.archived) {
            throw new Error(`Skill ${id} changed in another session; retained evidence for relearning.`)
          }
        }
      }
      const applied = applyLearningProposals(library, parsed.value, { events: batch.events, sessionId, projectRoot, now })
      if (!applied.ok) throw new Error(`${applied.error.message} Retained evidence for relearning.`)
      return applied.value
    })
    learningSession = { ...learningSession, learnedThrough: batch.through }
    $.ui.log(`Session learning saved ${parsed.value.length} skill proposal(s).`)
  } finally {
    // A failed batch keeps its evidence, but only tool calls made after it count toward the next automatic batch;
    // otherwise a persistent failure spawns a learner at every turn boundary until the daily limit.
    learningSession = {
      ...learningSession, batch: undefined,
      toolsSinceLearn: learningSession.events.filter(event => event.kind === 'tool' && Number(event.id.split(':').at(-1)) > batch.through).length,
    }
    await saveLearningSession($)
  }
  if (learningTurnRequested && !mainTurnBusy) {
    learningTurnRequested = false
    await startLearning($, true)
  }
}

async function observeLearnedSkill($: EngineInterface, tool: string, input: Readonly<Record<string, unknown>>): Promise<void> {
  if (!learningEnabled || !learningRoot) return
  const id = tool === 'Skill' && typeof input.skill === 'string' ? input.skill.split(':').at(-1)
    : tool === 'Read' && typeof input.file_path === 'string'
      ? eligibleSkills(learningLibrary, projectRoot).find(skill => input.file_path === learnedSkillPath(skill, learnedSkillsDir))?.id
      : undefined
  if (!id || !eligibleSkills(learningLibrary, projectRoot).some(skill => skill.id === id)) return
  const now = await $.clock.now()
  await updateLearningLibrary($, library => recordSkillUse(library, id, projectRoot, now))
}
let antiSlopScan = true
let antiSlopSkip: ReadonlySet<string> = new Set()
let secureScan = true
// The semgrep version a session found on its first scan, '' when there is none; undefined until it asks.
let semgrepFound: string | undefined
let guideRowsRead: Promise<GuideRows> | undefined
// The Semgrep hits of a run's change, keyed by the run and the change, so the lenses of one review share one scan.
const changeScans = new Map<string, Promise<Result<SemgrepHit[]>>>()
// The patterns the repository's rule files allow, read once per session; undefined until then or after one of them is edited.
let repositoryAllows: ReadonlySet<string> | undefined
// The trajectory log (trajectory.ts): its own write queue, so no run step waits on it, a counter that orders events of the same
// millisecond, where the main conversation's log stopped, and each node agent's token counts until its node ends.
let trajectoryLog = false
// Startup removes trajectories (pruneTrajectories) older than this many days, then the oldest while the folder holds more than
// this many megabytes; 0 turns each off.
let trajectoryRetentionDays = 90
let trajectoryMaxMb = 1024
let trajectoryWrites: Promise<unknown> = Promise.resolve()
let trajectorySeq = 0
let mainRows: RowMark | undefined
const agentUsage = new Map<string, Usage>()
// The review ledger (ledger.ts): the review-fix round keeps the findings it sends and the producers' files before the fix, and
// the rerun review-spec and review-standards get both.
let reviewLedger = true
const dirsMade = new Set<string>()
let gitignoreChecked = false
let contextOnDisk = false
let jevPermissionScope: 'all' | 'dag' = 'dag'
const activity = new Map<string, Activity>()
const agentEventSources = new Set<string>()
const handbacks = new Map<string, string>()
const transcriptErrors = new Set<string>()
const toolContexts = new Map<string, JevContext>()
// Node workers' calls in flight (tool_use_id -> agent) and the workers waiting for a permission answer, in memory only.
const openCalls = new Map<string, { agentId: string; tool: string }>()
// One last failed check per execution subject, bounded and never persisted. Epochs discard comparisons across possible
// writes and overlapping calls. An unlinked background launch suspends observation until clear or a new session: its
// completion is not proven by an unrelated tool result or progress message.
const repeatedChecks = new Map<string, RepeatedCheck>()
const repeatCalls = new Set<string>()
let repeatEpoch = 0
let repeatSuspended = false
const waiting = new Map<string, { tool: string; toolUseId?: string; since: number }>()
// Node workers that started work which runs on after its tool call returns (a background command or subagent, or a Monitor),
// by agent id: each attempt spawns its own agent, so this is per attempt. In memory only, like openCalls: after a reload
// the worker's next turn end finishes the node as it did before this guard.
const backgroundAgents = new Set<string>()
// Workers whose turn ended with that work pending and no status line: the answer they gave and the timer that fails the
// node if no next turn starts within BACKGROUND_WAIT_MS.
const backgroundWaits = new Map<string, { answer: string; timer: Timer }>()
// Per run and node, the tools already explained in a non-interactive session for the node's current attempt, in
// first-seen order: a retried call adds no second line, and the settle summary lists them. A new attempt starts over.
const askedTools = new Map<string, Map<string, { attempt: number; tools: string[] }>>()
let userRequest = ''
let jevEnabled = true
let jevMaxCalls = 100
let jevCallsUsed = 0
let jevLimitNoted = false
let jevConfidence = 0.9
// Session-model routing answers measured 0.60-0.97 confident with every choice correct, so they apply from a lower bar.
let jevModelRoutingConfidence = 0.8
let jevModelFallback = true
let jevApiKey: string | undefined
let ticks = 0
let workflowContext = emptyContext('', '', 0)
// The restoration block is up to 8,000 characters (SUMMARY_CAP) and used to go on every submitted prompt, each node's
// progress note and settle summary included. It now goes on a user prompt only when the run and note state differs
// from the state the model last received, recorded here per run and for the notes: by prompt.context, a compaction
// message, an earlier injection (each records every slice), or the plugin's own run news (only the run it describes).
// Empty in a new process, so after /reload-plugins the first user prompt carries the block once more; that costs one
// block per reload. `captures` orders the snapshots, so a message that waited in the host's queue never overwrites a
// newer delivery.
let captures = 0
let delivered = nothingDelivered(0)
let decisionRecords: DecisionRecord[] = []
let peerSessions: SessionRecord[] = []
let metadataWrites: Promise<unknown> = Promise.resolve()
let decisionSequence = 0
let sessionClosed = false
let autoRecovery = true
let inspectorView: 'dag' | 'board' | InspectorView = 'dag'
let inspectorPage = 0
let inspectorColumns = FALLBACK_GRAPH_COLUMNS
let selectedDecisionId: string | undefined
// This session's boards in creation order, which is the Board section's order, and the one it shows; unset, it shows the
// board updated last.
let boards: Board[] = []
let selectedBoardId: string | undefined
// The chips the person put into the prompt box from the Board section, by label, oldest first. The next user prompt gets the
// content of the ones it carries, and all are forgotten. A label holds no board id, so a later chip with the same label wins.
const chips = new Map<string, { boardId: string; blockId: string }>()
// More chips than a person cites in one prompt; the oldest beyond it are dropped.
const MAX_CHIPS = 20
const CHIP_PAINT = { bold: true, color: ACCENT }
let language: 'en' | 'ko' = 'en'
let pinnedStatus: string | undefined
const settleToasts = new Set<string>()
// Node ids that already raised their own failure toast, per run; the settle toast skips them.
const failureToasts = new Map<string, Set<string>>()
const ATTENTION_TOAST_MS = 12_000
let lastPaneAgentId: string | undefined

const pendingJevCalls = new Map<string, PendingJevCall>()

// Count physical requests, including failed HTTP calls and every fallback part. In-flight joiners cost nothing.
function takeJevCall($: EngineInterface): boolean {
  if (jevCallsUsed < jevMaxCalls) {
    jevCallsUsed++
    return true
  }
  if (!jevLimitNoted) {
    jevLimitNoted = true
    $.ui.log(`Jev call limit reached (${jevMaxCalls}); keeping baseline decisions for this session.`)
  }
  return false
}

function jevLimit(): JevEvaluation {
  return { choices: new Map(), outcome: 'disabled', latencyMs: 0, note: 'budget-exhausted: session Jev call limit reached' }
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
  const key = stableStringify({ sessionId, projectRoot, userRequest, request, modelParts })
  return shareJevCall(pendingJevCalls, key, sharedSignal => evaluateJevShared($, request, modelParts, sharedSignal), signal)
}

async function evaluateJevShared($: EngineInterface, request: JevRequest, modelParts: readonly JevRequest[], signal: AbortSignal): Promise<JevEvaluation> {
  const startedAt = await $.clock.now()
  if (signal.aborted) return { choices: new Map(), outcome: 'timeout', latencyMs: 0 }
  if (jevApiKey) {
    const http = await evaluateJevHttp($, request, jevApiKey, startedAt)
    if (!jevModelFallback || (http.outcome !== 'http-error' && http.outcome !== 'timeout' && http.outcome !== 'transport-error')) return http
  }
  if (signal.aborted) return { choices: new Map(), outcome: 'timeout', latencyMs: 0 }
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
  const limitNote = results.find(result => result.note?.startsWith('budget-exhausted'))?.note
  return { choices, outcome, latencyMs: Math.max(0, ...latencies.values()), backend: 'model', outcomes, latencies, ...(limitNote ? { note: limitNote } : {}) }
}

async function completeJevPart($: EngineInterface, request: JevRequest, startedAt: number, signal?: AbortSignal): Promise<ModelPart> {
  if (signal?.aborted) return { choices: new Map(), outcome: 'timeout', latencyMs: 0 }
  if (!takeJevCall($)) return jevLimit()
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
  if (!takeJevCall($)) return jevLimit()
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
  await ensureGitignore($, projectRoot)
  gitignoreChecked = true
}

// Writes the `*` .gitignore of root's .claude/dag store if it is missing; the store folder must already exist.
async function ensureGitignore($: EngineInterface, root: string): Promise<void> {
  const path = `${root}/${DAG_SUBDIR}/.gitignore`
  if (!(await $.fs.exists(path))) await $.fs.write(path, GITIGNORE)
}

// `report` takes a write failure: a record that is the session's own evidence is logged in the transcript, one written on
// every tool call (the read-only shadow) goes to the debug log so a full disk does not add a line per call.
async function persistDecisions($: EngineInterface, records: DecisionRecord[], report: (text: string) => void = text => $.ui.log(text)): Promise<void> {
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
    report(`could not persist decision history: ${message(error)}`)
  }
  $.ui.invalidate('ui.render')
}

// `evaluation` is what Jev answered; a record no Jev call is behind passes `{}`.
function decisionRecord(input: Omit<DecisionRecord, 'id' | 'sessionId' | 'ruleset' | 'threshold' | 'backend'>, evaluation: Pick<JevEvaluation, 'note' | 'backend'>, threshold = jevConfidence): DecisionRecord {
  const note = [input.note, evaluation.note].filter(Boolean).join('; ')
  return { ...input, ...(note ? { note } : {}), ...(evaluation.backend ? { backend: evaluation.backend } : {}), id: `${input.at.toString(36)}-${++decisionSequence}`, sessionId, ruleset: JEV_RULESET_VERSION, threshold }
}

// The main-conversation gate lets a Bash call through only when readOnlyBashProblem finds nothing, so a call that reaches
// tool.check there (and Bash is not in main_allowed_tools) was judged read-only by this plugin. When the host's own
// isReadOnly did not hold it too, the two judges differ; this records where, as evidence, and never touches the verdict.
// A failure to record goes to the debug log.
async function recordHostReadOnlyGap($: EngineInterface, input: unknown, verdict: ToolCheckDecision): Promise<void> {
  try {
    const command = typeof input === 'object' && input !== null && 'command' in input && typeof input.command === 'string' ? input.command : ''
    // cut() masks before it cuts and adds a marker after the cut; the marker would take the note past 200 characters.
    const note = cut(command, DECISION_COMMAND_CHARS).slice(0, DECISION_COMMAND_CHARS)
    await persistDecisions($, [decisionRecord({
      at: await $.clock.now(), kind: 'readonly', subject: 'Bash', proposed: 'allow', selected: verdict,
      source: 'baseline', outcome: 'existing-decision', latencyMs: 0, stateHash: hash(note), note,
    }, {}, 0)], text => debug($, text))
  } catch (error) {
    debug($, `could not record a read-only Bash call: ${message(error)}`)
  }
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
    const category = def?.category ?? 'trivial'
    const outcome = decisionOutcome(evaluation, choice, node.id, threshold)
    const jevChoice = outcome === 'applied' ? choice : undefined
    const ruled = (jevChoice?.choice ?? category) === 'trivial' && def !== undefined && isFinalAudit(run.definition, def)
    records.push(decisionRecord({
      at, kind: 'routing', subject: node.id, runId: run.runId, nodeId: node.id,
      proposed: category, selected: ruled ? FINAL_AUDIT_CATEGORY : jevChoice?.choice ?? category,
      source: ruled ? 'rule' : jevChoice ? 'jev' : 'baseline', outcome,
      latencyMs: evaluation.latencies?.get(node.id) ?? evaluation.latencyMs, stateHash: hash(stableStringify(request.state)),
      ...(choice ? { confidence: choice.confidence, ...(choice.probabilities ? { probabilities: choice.probabilities } : {}) } : {}),
    }, evaluation, threshold))
    if (ruled) {
      debug($, `final-audit rule ${run.runId}/${node.id}: ${FINAL_AUDIT_CATEGORY} instead of trivial`)
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

// evaluateJev under one deadline for both backends. At the deadline the model call is aborted and the answer counts as
// a timeout; an HTTP call still in flight ends by its own JEV_TIMEOUT_MS and is no longer awaited.
async function evaluateJevWithin($: EngineInterface, request: JevRequest, budgetMs: number, signal: AbortSignal): Promise<JevEvaluation> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (signal.aborted) abort()
  else signal.addEventListener('abort', abort, { once: true })
  let timer: Timer | undefined
  const deadline = new Promise<JevEvaluation>(resolve => {
    timer = $.clock.after(budgetMs, () => {
      controller.abort()
      resolve({ choices: new Map(), outcome: 'timeout', latencyMs: budgetMs })
    })
  })
  try {
    return await Promise.race([evaluateJev($, request, controller.signal), deadline])
  } finally {
    timer?.cancel()
    signal.removeEventListener('abort', abort)
  }
}

function ownsUnsettledRun(): boolean {
  return [...runs.values()].some(run => run.sessionId === sessionId && !isSettled(run))
}

// The text of the assistant's last reply, where a short answer such as '1' finds the options it picks. A transcript the
// host refuses or cannot read leaves the mode question as it was, without the reply.
async function lastAssistantReply($: EngineInterface): Promise<string | undefined> {
  try {
    // Typed for a main-conversation read, which always resolves to messages; the host's contract still allows a refusal.
    const rows = (await $.session.messages()) as SessionMessage[] | { deny: string }
    if (!Array.isArray(rows)) {
      debug($, `turn mode asked without the last reply: ${rows.deny}`)
      return undefined
    }
    return rows.findLast(row => row.role === 'assistant' && row.text.trim())?.text
  } catch (error) {
    debug($, `turn mode asked without the last reply: ${message(error)}`)
    return undefined
  }
}

// The paths that decide a turn without asking Jev, or undefined when Jev is to be asked. With no Jev to ask the turn
// runs directly, like any turn Jev does not confidently call dag.
function turnModeWithoutJev($: EngineInterface): TurnMode | undefined {
  if (ownsUnsettledRun()) {
    debug($, 'turn mode dag without asking Jev: this session has a run that has not settled, and a direct turn could edit files its nodes write')
    return 'dag'
  }
  if (!jevEnabled || (!jevApiKey && !jevModelFallback)) {
    debug($, `turn mode direct without asking Jev: ${jevEnabled ? 'no Jev backend (no TYPESAFE_API_KEY and jev_model_fallback off)' : 'jev_enabled is off'}`)
    return 'direct'
  }
  return undefined
}

type TurnDecision = { readonly mode: TurnMode; readonly surface: TurnSurface }

// Asks Jev the mode question and records the decision under `subject`: the user's 'request' or the 'answer' to a popup.
// Only a confident Jev 'dag' gives a dag turn, the strict rules; every other outcome (a direct answer, low confidence,
// timeout, error) runs the turn directly. Measured over 10 mode decisions, 4 of the 5 dag turns were fallbacks with no
// confident dag answer, one of them leaning direct at 0.83, so the fallback gated small requests.
// A request that carries the surface question gets it answered from the same call and recorded next to the mode: only a
// confident 'board' puts the answer on a board, and every other outcome answers in chat, as before.
async function judgeTurn($: EngineInterface, request: JevRequest, subject: 'request' | 'answer', signal: AbortSignal): Promise<TurnDecision> {
  const evaluation = await evaluateJevWithin($, request, MODE_BUDGET_MS, signal)
  const choice = evaluation.choices.get('mode')
  const outcome = decisionOutcome(evaluation, choice, 'mode', MODE_CONFIDENCE)
  const applied = outcome === 'applied' && (choice?.choice === 'direct' || choice?.choice === 'dag')
  const mode: TurnMode = applied && choice.choice === 'dag' ? 'dag' : 'direct'
  const at = await $.clock.now()
  const stateHash = hash(stableStringify(request.state))
  const records = [decisionRecord({
    at, kind: 'mode', subject,
    proposed: 'direct', selected: mode, source: applied ? 'jev' : 'baseline', outcome, latencyMs: evaluation.latencyMs,
    stateHash,
    ...(choice ? { confidence: choice.confidence, ...(choice.probabilities ? { probabilities: choice.probabilities } : {}) } : {}),
  }, evaluation, MODE_CONFIDENCE)]
  debug($, `turn mode ${mode}${subject === 'answer' ? ' for the popup answer' : ''}: Jev ${outcome}${choice ? ` (${choice.choice} at ${choice.confidence}, bar ${MODE_CONFIDENCE})` : ''}`)
  let surface: TurnSurface = 'chat'
  if ('surface' in request.questions) {
    const surfaceChoice = evaluation.choices.get('surface')
    const surfaceOutcome = decisionOutcome(evaluation, surfaceChoice, 'surface', SURFACE_CONFIDENCE)
    const surfaceApplied = surfaceOutcome === 'applied' && (surfaceChoice?.choice === 'chat' || surfaceChoice?.choice === 'board')
    if (surfaceApplied && surfaceChoice.choice === 'board') surface = 'board'
    records.push(decisionRecord({
      at, kind: 'surface', subject,
      proposed: 'chat', selected: surface, source: surfaceApplied ? 'jev' : 'baseline', outcome: surfaceOutcome, latencyMs: evaluation.latencyMs,
      stateHash,
      ...(surfaceChoice ? { confidence: surfaceChoice.confidence, ...(surfaceChoice.probabilities ? { probabilities: surfaceChoice.probabilities } : {}) } : {}),
    }, evaluation, SURFACE_CONFIDENCE))
    debug($, `turn surface ${surface}: Jev ${surfaceOutcome}${surfaceChoice ? ` (${surfaceChoice.choice} at ${surfaceChoice.confidence}, bar ${SURFACE_CONFIDENCE})` : ''}`)
  }
  await persistDecisions($, records)
  return { mode, surface }
}

// How a user turn runs under enforcement auto: dag only on a confident Jev 'dag' or while this session has an unsettled
// run; every other path runs it directly. `recent` holds the user's requests before this one, oldest first. The surface
// question is asked only where a board can be shown, an interactive session with the /dag pane, and only when Jev is
// asked at all: a turn decided without Jev answers in chat.
async function decideTurn($: EngineInterface, text: string, recent: readonly string[], signal: AbortSignal): Promise<TurnDecision> {
  const mode = turnModeWithoutJev($)
  if (mode !== undefined) return { mode, surface: 'chat' }
  return judgeTurn($, modeRequest(text, recent, await lastAssistantReply($), interactive && paneSurface), 'request', signal)
}

// An AskUserQuestion answer comes back inside the turn that asked it, so Jev never sees it as a prompt: "what next?" is
// judged small, then the person picks a multi-file task in the popup and it would run with the main-loop gate open.
// Under auto a direct turn is judged again on the answer, toward dag only: a dag turn stays strict, and only an answer
// Jev confidently calls dag closes the gate, as for a prompt. A turn that stays direct returns the
// reply as it came. A failure here leaves the turn as it was, because the person's answer is no place to lose the call.
async function reconsiderAfterAnswer($: EngineInterface, reply: ToolCallResult<'AskUserQuestion'>, signal: AbortSignal): Promise<ToolCallResult<'AskUserQuestion'>> {
  if (reply.deny !== undefined || reply.isError === true) return reply
  const popup = popupAnswer(reply.result)
  if (!popup) return reply
  try {
    const mode = turnModeWithoutJev($) ?? (await judgeTurn($, answerModeRequest(popup.questions, popup.answers, workflowContext.requests.slice(-3).map(entry => entry.text), popup.response), 'answer', signal)).mode
    // The popup stayed open for as long as the person took: the turn may have changed meanwhile.
    if (mode !== 'dag' || enforcement !== 'auto' || turnMode !== 'direct') return reply
    turnMode = 'dag'
    debug($, 'turn mode dag: the popup answer selects work Jev did not call small')
    // Spread, not rebuilt, so core's own messages for the call (ref, text) stay with the result.
    return { ...reply, context: [...(reply.context ?? []), `${ANSWER_DAG_LINE}\n${protocolFor('auto', interactive, 'dag', turnSurface)}`] }
  } catch (error) {
    debug($, `popup answer not judged: ${message(error)}`)
    return reply
  }
}

function contextPath(): string {
  return `${projectRoot}/${DAG_SUBDIR}/context/${sessionId}.json`
}

function restorationContext(): string {
  return contextSummary(workflowContext, [...runs.values()], contextPath())
}

// The block as it goes out now, and the call that records the state it reports as received. Taken together, so a
// change while the block travels (prompt.context and prompt.submit await the hooks beneath) stays unseen.
function restoration(): { text: string; received: () => void } {
  const seq = ++captures
  const slices = contextSlices(workflowContext, [...runs.values()])
  return { text: restorationContext(), received: () => { delivered = deliverBlock(delivered, seq, slices) } }
}

// A cleared, switched or newly resumed conversation has received nothing yet. Captures taken before this are stale.
function forgetDelivered(): void {
  delivered = nothingDelivered(++captures)
}

// The plugin's own prompts (settle summary, node progress, keep-alive) carry the run news themselves, so prompt.submit
// never adds the block to them. Once the host takes one, the model has that one run as it stood when the text was
// written; other runs and the notes are not in the message and stay as last delivered, so a node of another run that
// finished meanwhile, or a note pinned before a settle, still reaches the next user prompt. Recorded here, at the three
// call sites, rather than on origin 'plugin' in prompt.submit: the slice is taken with the text, and a dropped prompt
// delivers nothing.
function submitRunNews($: EngineInterface, run: Run, text: string): ReturnType<EngineInterface['prompt']['submit']> {
  const seq = ++captures
  const slice = contextSlices(workflowContext, [run]).runs
  return $.prompt.submit({ text }).then(result => {
    if (result.drop === undefined) delivered = deliverRuns(delivered, seq, slice)
    return result
  })
}

// Plain conversations keep requests in memory; the file appears once the session uses the DAG.
function contextWanted(): boolean {
  return contextOnDisk || workflowContext.notes.length > 0 || [...runs.values()].some(run => run.sessionId === sessionId)
}

// A file the plugin reads for the anti-slop scan; a file that does not exist yet reads as empty.
async function readOrEmpty($: EngineInterface, path: string): Promise<string> {
  try {
    return await $.fs.read(path)
  } catch {
    return ''
  }
}

// Semgrep is optional. The first scan of a session asks for its version once; without one every scan stays off.
async function semgrepReady($: EngineInterface): Promise<boolean> {
  if (!secureScan) return false
  if (semgrepFound === undefined) {
    try {
      const probe = await $.process.run(['semgrep', '--version'], { timeoutMs: 30_000 })
      semgrepFound = (probe.exitCode === 0 && semgrepVersion(probe.stdout)) || ''
    } catch {
      semgrepFound = ''
    }
    debug($, semgrepFound ? `semgrep ${semgrepFound} runs the secure-coding rules` : 'semgrep is not installed; the secure-coding scan is off')
  }
  return semgrepFound !== ''
}

async function runSemgrep($: EngineInterface, cwd: string, targets: readonly string[]): Promise<Result<SemgrepHit[]>> {
  try {
    const done = await $.process.run(semgrepArgv(`${$.plugin.root}/${SEMGREP_RULES_DIR}`, targets), { cwd, timeoutMs: 120_000 })
    return parseSemgrepReport(done.stdout)
  } catch (error) {
    return fail('semgrep_error', `semgrep could not run (${message(error)}).`)
  }
}

// The names and lenses a hit cites, from the guide references the plugin ships.
function guideRows($: EngineInterface): Promise<GuideRows> {
  const reference = (id: string) => readOrEmpty($, `${$.plugin.root}/skills/secure-coding/references/${id}.md`)
  guideRowsRead ??= Promise.all([reference('kisa'), reference('owasp')]).then(([kisa, owasp]) => ({ kisa: kisaRows(kisa), owasp: owaspCweRows(owasp) }))
  return guideRowsRead
}

// The hits an Edit or Write would add, scanned before it lands. The new text goes to a copy at the same root-relative path
// in a scratch folder, so the rules' path filters (tests/, *Test.java) match as they would in the project. root is the folder
// the edit lands in (editRoot): measured from the session's own folder, every file of a worktree under .claude/ was skipped.
async function scanEdit($: EngineInterface, path: string, before: string, after: string, root: string): Promise<SemgrepHit[]> {
  if (!root || !path.startsWith(`${root}/`) || path.startsWith(`${root}/.claude/`) || !(await semgrepReady($))) return []
  const rel = path.slice(root.length + 1)
  const made = await $.process.run(['mktemp', '-d'], { timeoutMs: 10_000 })
  const scratch = made.stdout.trim()
  if (made.exitCode !== 0 || !scratch.startsWith('/')) return []
  try {
    await $.fs.write(`${scratch}/${rel}`, after)
    const report = await runSemgrep($, scratch, [rel])
    if (!report.ok) {
      $.ui.log(`secure-coding scan skipped ${rel}: ${report.error.message}`)
      return []
    }
    const added = addedLines(before, after)
    return report.value.filter(hit => hit.path === rel && added.has(hit.line))
  } finally {
    await $.process.run(['rm', '-rf', scratch]).catch(() => undefined)
  }
}

// The Semgrep hits on the lines a run's change added, read as the review nodes read the change: tracked files against
// HEAD and untracked files whole. The lenses of one review share one scan; undefined when semgrep is not there.
async function changeHits($: EngineInterface, run: Run): Promise<Result<SemgrepHit[]> | undefined> {
  if (!(await semgrepReady($))) return undefined
  const root = rootOf(run)
  const diff = await $.process.run(['git', '-c', 'core.quotePath=false', 'diff', '-U0', '--no-color', '--relative', 'HEAD'], { cwd: root })
  const untracked = await $.process.run(['git', 'ls-files', '-z', '--others', '--exclude-standard'], { cwd: root })
  if (diff.exitCode !== 0 || untracked.exitCode !== 0) return fail('semgrep_change', `git could not list the change (${(diff.stderr || untracked.stderr).trim()}).`)
  const added = addedLinesByFile(diff.stdout)
  const fresh = new Set(untracked.stdout.split('\0').filter(Boolean))
  const targets = [...new Set([...added.keys(), ...fresh])].filter(path => semgrepTarget(path) && !path.startsWith('.claude/'))
  if (targets.length === 0) return { ok: true, value: [] }
  const key = `${run.runId}\0${hash(`${diff.stdout}\0${untracked.stdout}`)}`
  let scan = changeScans.get(key)
  if (!scan) {
    scan = runSemgrep($, root, targets).then((report): Result<SemgrepHit[]> => report.ok
      ? { ok: true, value: report.value.filter(hit => fresh.has(hit.path) || added.get(hit.path)?.has(hit.line) === true) }
      : report)
    changeScans.set(key, scan)
  }
  return scan
}

async function slopSkips($: EngineInterface): Promise<ReadonlySet<string>> {
  repositoryAllows ??= new Set((await Promise.all(RULE_FILES.map(name => readOrEmpty($, `${projectRoot}/${name}`)))).flatMap(allowedPatterns))
  return new Set([...antiSlopSkip, ...repositoryAllows])
}

async function persistContext($: EngineInterface): Promise<void> {
  if (!contextWanted()) return
  const path = contextPath()
  // The written flag comes from the module variable at every write, never from a value already on workflowContext: a
  // /clear copies the previous session's context into the new one with a spread, and its flag must not come along.
  // The stamped record goes back into workflowContext so the `context` action shows what the file holds.
  const { planningLoaded: _carried, ...record } = workflowContext
  workflowContext = planningLoaded ? { ...record, planningLoaded: true } : record
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

// Called after loadMetadata: a context file of this session that records the planning skill opens the gate.
async function restorePlanningFromContext($: EngineInterface): Promise<void> {
  if (workflowContext.sessionId === sessionId && workflowContext.planningLoaded === true) await setPlanningLoaded($, true)
}

async function refreshSessions($: EngineInterface, closed = false): Promise<void> {
  if (!projectRoot || !sessionId) return
  const now = await $.clock.now()
  const owned = [...runs.values()].filter(run => run.sessionId === sessionId)
  const own: SessionRecord = {
    schemaVersion: 1, sessionId, projectRoot, updatedAt: now, status: closed ? 'closed' : 'active',
    runIds: owned.map(run => run.runId),
    // A run in a worktree names its writes by absolute path (sessions.ts resolves those as they are): the same relative
    // path in another tree is another file.
    writes: [...new Set(owned.flatMap(run => run.definition.nodes.filter(def => run.nodes.some(node => node.id === def.id && node.state === 'running'))
      .flatMap(node => (node.writes ?? []).map(path => run.root ? `${run.root}/${path}` : path))))],
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
  const text = active ? t.statusLine(active.run.name, active.done, active.total, active.running, active.failed, active.otherRuns, active.waiting, active.awaiting) : undefined
  if (text === pinnedStatus) return
  pinnedStatus = text
  $.ui.status(text)
}

async function persist($: EngineInterface, run: Run): Promise<void> {
  runs.set(run.runId, run)
  updateStatus($)
  await ensureDir($, runsDir)
  await atomicWrite($, `${runsDir}/${run.runId}.json`, JSON.stringify(run, null, 2) + '\n', 'run checkpoint')
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

// The folder a run works in: its root when it started in a worktree, otherwise the session's own folder (types.ts Run.root).
function rootOf(run: Run): string {
  return run.root ?? projectRoot
}

// The folder the session works in now. $.session.root() follows /cd and EnterWorktree, while projectRoot stays where the
// session started and holds its run store.
async function workingRoot($: EngineInterface): Promise<string> {
  try {
    // Spelled as projectRoot is, without a trailing slash, so the same folder never reads as a worktree.
    return (await $.session.root()).replace(/\/+$/, '') || projectRoot
  } catch (error) {
    // A host or a test harness without the call: every run works in the session's own folder, as before runs had a root.
    debug($, `session.root unavailable: ${message(error)}`)
    return projectRoot
  }
}

// The folder an Edit or Write lands in: its run's for a node worker, the session's current one otherwise.
async function editRoot($: EngineInterface, agentId: string | undefined): Promise<string> {
  const owner = ownNodeOfAgent(agentId)
  return owner ? rootOf(owner.run) : workingRoot($)
}

async function removePath($: EngineInterface, flag: '-f' | '-rf', path: string, purpose = 'prune'): Promise<boolean> {
  try {
    const removed = await $.process.run(['rm', flag, path])
    if (removed.exitCode === 0) return true
    debug($, `could not ${purpose} ${path}: ${removed.stderr.trim() || `exit ${removed.exitCode}`}`)
  } catch (error) {
    debug($, `could not ${purpose} ${path}: ${message(error)}`)
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
  const boardsDir = `${projectRoot}/${BOARDS_SUBDIR}`
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
    boardFiles: files(await listIfPresent($, boardsDir)),
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
  for (const [dir, names] of [[contextDir, plan.contextFiles], [decisionsDir, plan.decisionFiles], [boardsDir, plan.boardFiles]] as const) {
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

// A trajectory folder holds one file per event, so a long run's can hold thousands. One with more than this many is left alone
// rather than read, and so is never removed.
const TRAJECTORY_FOLDER_FILES = 2000

// The entries under the trajectories folder: each run or session folder together with its joined <run_id>.jsonl, sized by the
// files the host lists and dated by the newest of them. A folder that cannot be listed or holds too many files is left out
// whole, joined file included, so it can never be taken for an empty and old one.
async function trajectoryEntries($: EngineInterface, dir: string): Promise<TrajectoryEntry[]> {
  const found = new Map<string, TrajectoryEntry>()
  const skipped = new Set<string>()
  const join = (name: string, bytes: number, mtimeMs: number) => {
    const entry = found.get(name) ?? { name, mtimeMs: 0, bytes: 0 }
    found.set(name, { name, mtimeMs: Math.max(entry.mtimeMs, mtimeMs), bytes: entry.bytes + bytes })
  }
  for (const item of await listIfPresent($, dir)) {
    if (item.isLink) continue
    if (item.kind === 'file' && item.name.endsWith('.jsonl')) {
      const name = item.name.slice(0, -'.jsonl'.length)
      if (trajectoryOwner(name)) join(name, item.size, item.mtimeMs)
    } else if (item.kind === 'dir' && trajectoryOwner(item.name)) {
      join(item.name, 0, 0)
      try {
        const files = await $.fs.list(`${dir}/${item.name}`)
        if (files.length > TRAJECTORY_FOLDER_FILES) {
          skipped.add(item.name)
          debug($, `skipped trajectory ${item.name}: it holds more than ${TRAJECTORY_FOLDER_FILES} files`)
          continue
        }
        for (const file of files) join(item.name, file.size, file.mtimeMs)
      } catch (error) {
        skipped.add(item.name)
        debug($, `skipped trajectory ${item.name}: could not list it: ${message(error)}`)
      }
    }
  }
  return [...found.values()].filter(entry => !skipped.has(entry.name))
}

// Removes the trajectories (trajectoryPlan) that are older than trajectory_retention_days or over trajectory_max_mb. It does not
// depend on retention_days or on trajectory_log: a log that was turned off still gets cleaned up.
async function pruneTrajectories($: EngineInterface): Promise<void> {
  if (!projectRoot || !(trajectoryRetentionDays > 0 || trajectoryMaxMb > 0)) return
  const dir = `${projectRoot}/${TRAJECTORY_SUBDIR}`
  const plan = trajectoryPlan({
    entries: await trajectoryEntries($, dir), now: await $.clock.now(), retentionDays: trajectoryRetentionDays, maxMb: trajectoryMaxMb,
    currentSession: sessionId, unsettledRunIds: new Set([...runs.values()].filter(run => !isSettled(run)).map(run => run.runId)),
  })
  const removed: string[] = []
  for (const name of plan) {
    // The folder first: a joined file that outlived a failed removal is an entry of its own at the next start.
    if (!(await removePath($, '-rf', `${dir}/${name}`, 'prune the trajectory'))) continue
    await removePath($, '-f', `${dir}/${name}.jsonl`, 'prune the joined trajectory')
    removed.push(name)
  }
  if (removed.length > 0) debug($, `pruned trajectories ${removed.join(', ')}`)
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

// The notes file a generated reviewer will write, found in its own file checks. Only the nodes the definition's review field
// expanded qualify, at parse time or at run time (parseDefinition refuses a user node with such an id next to review), and
// only a file named exactly <id>-notes.md, so nothing a user node verifies is ever returned.
function generatedNotesFiles(run: Run, def: NodeDef): string[] {
  if (run.definition.review === undefined || !isReviewStageNode(run.definition.review, def.id)) return []
  const paths = (def.verify ?? []).flatMap(check => check.kind === 'file' && readOnlyAbsolutePath(check.path) && check.path.endsWith(`/${def.id}-notes.md`) ? [check.path] : [])
  return [...new Set(paths)]
}

// The default notes folder is /tmp/dag-review/<cleaned key>-<6 hex>, shared by every project and run that uses the key, and the
// reviewer's lastLine check cannot tell a verdict written now from one an earlier run or attempt left. Without this, a reviewer that
// ends its turn writing nothing passes on the old verdict and opens the commit gate. So the file is removed before every
// spawn of a generated reviewer. A file that cannot be removed fails the start instead of spawning the reviewer: the check
// is the gate, and spawning against a stale PASS is the hole this closes. `rm -f` succeeds on a missing file, so a failure is
// a real one (another user's file in /tmp, a read-only folder, a directory), where the reviewer could not overwrite it either.
async function clearStaleNotes($: EngineInterface, run: Run, def: NodeDef): Promise<string | undefined> {
  for (const path of generatedNotesFiles(run, def)) {
    try {
      if (!(await $.fs.exists(path))) continue
    } catch (error) {
      return `could not look for stale review notes ${path} (${message(error)}), so the reviewer's verdict check cannot be trusted.`
    }
    if (!(await removePath($, '-f', path, 'remove stale review notes'))) {
      return `could not remove the stale review notes ${path}, so the reviewer's verdict check could pass on an old verdict. Remove the file and retry.`
    }
  }
  // A lens's verifier folder can hold files an earlier run or attempt left, with numbers this run never reaches, and one
  // CONFIRMED line among them fails review-security. The lens empties its own folder; other lenses' folders stay as they are.
  const lens = securityLensOf(run.definition, def.id)
  if (lens !== undefined && run.definition.review) {
    const folder = lensVerifyFolder(run.definition.review, lens)
    if (!(await removePath($, '-rf', folder, 'remove stale verifier notes'))) {
      return `could not remove the stale verifier notes ${folder}, so review-security could fail on an old verdict. Remove the folder and retry.`
    }
  }
  return undefined
}

async function startNode($: EngineInterface, run: Run, id: string): Promise<Run> {
  const def = run.definition.nodes.find(n => n.id === id)
  const node = run.nodes.find(n => n.id === id)
  if (!def || !node) return run
  if (def.agent === 'fork') {
    return failToStart(run, id, 'Fork agents cannot enforce the Sonnet worker minimum; amend the node to use a non-fork agent type.', await $.clock.now())
  }
  const stale = await clearStaleNotes($, run, def)
  if (stale) return attemptRecovery($, failToStart(run, id, `Could not start the node agent: ${stale}`, await $.clock.now()), id)
  const target = spawnTarget({ ...def, category: node.routing?.category ?? def.category })
  const upstream: UpstreamResult[] = def.dependsOn.flatMap(depId => {
    const dep = run.nodes.find(n => n.id === depId)
    if (!dep || dep.state !== 'completed') return []
    return [{ id: dep.id, label: dep.label, output: dep.output ?? '', ...(dep.reportPath ? { reportPath: dep.reportPath } : {}) }]
  })
  // The ledger joins the task text, so the reporting contract stays the prompt's end.
  const ledger = await ledgerSection($, run, def)
  const prompt = buildNodePrompt(run, def, ledger === undefined ? node : { ...node, promptOverride: `${node.promptOverride ?? def.prompt}\n\n${ledger}` }, upstream)
  const model = node.recovery?.model ?? target.model
  let spawned: { agentId?: string; model?: string; deny?: string }
  try {
    spawned = await $.agent.spawn({
      prompt,
      description: `${run.name}: ${def.task_summary ?? def.label ?? def.id}`.slice(0, 80),
      subagentType: target.subagentType,
      model,
      // Without a cwd the worker runs where the session is now, which is not the run's folder once the session moved, also
      // for a run that started in the session's own folder.
      cwd: rootOf(run),
    })
  } catch (error) {
    spawned = { deny: message(error) }
  }
  const now = await $.clock.now()
  const started = { kind: 'node.start', runId: run.runId, nodeId: id, attempt: node.attempt + 1, subagentType: target.subagentType, category: node.routing?.category ?? def.category, recovery: node.recovery, prompt } as const
  if (spawned.agentId) {
    agentRuns.set(spawned.agentId, run.runId)
    await record($, { ...started, agentId: spawned.agentId, model: spawned.model ?? model })
    return markRunning(run, id, spawned.agentId, now, spawned.model)
  }
  await record($, { ...started, model, error: spawned.deny ?? 'no agent id was returned' })
  return attemptRecovery($, failToStart(run, id, `Could not start the node agent: ${spawned.deny ?? 'no agent id was returned'}`, now), id)
}

const settleSubmits = new Set<string>()
// Runs the model started in a turn whose answer the user wants on a board; their settle summary asks for one. Not persisted:
// the turn that wanted the board is over once the session is resumed, and nothing records it, so a resumed session reports
// such a run in chat. A run the user starts with /dag run is not a board answer either.
const boardAnswerRuns = new Set<string>()

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
    // A run that settled only on reviewer FAIL verdicts reruns the producers they point at before anyone is told it settled.
    if (isSettled(run) && run.status === 'failed') {
      const rework = await attemptRework($, run)
      if (rework) {
        run = rework.run
        await persist($, run)
        if (rework.reworked) continue
      }
    }
    // A run held for approval keeps its roots scheduled with nothing running: looping again would never end.
    if (!run.handoff && !run.approval && run.nodes.some(node => node.state === 'scheduled') && !run.nodes.some(node => node.state === 'running')) continue
    if (!isSettled(run)) {
      if (settleToasts.delete(runId)) failureToasts.delete(runId)
    } else if (!settleToasts.has(runId)) {
      settleToasts.add(runId)
      await record($, { kind: 'run.settle', runId, ...settleRecord(run) })
      exportTrajectory($, runId)
      const failed = run.nodes.filter(node => node.state === 'failed')
      const toasted = failureToasts.get(runId)
      if (failed.length > 0 && !run.cancelReason && !failed.every(node => toasted?.has(node.id))) {
        $.ui.toast(t.toastSettledFailed(run.name, failed.length), { timeoutMs: ATTENTION_TOAST_MS })
      }
    }
    announce($, run)
    return run
  }
}

// The host refuses $.prompt.submit from inside a command.run hook ("it would wait on the turn this hook is holding"), so
// news a /dag command causes goes out on the clock, once the hook has returned. The pane buttons share the same path.
function afterHook($: EngineInterface, send: () => void): void {
  $.clock.after(0, send)
}

// `text` replaces the settle summary when the settle has its own news (a rejected run, where nothing ran to summarize);
// `deferred` sends it through afterHook. Nothing is drawn for a settle: the run record is the DAG pane's, and a board holds only
// an answer the user asked to understand. The summary asks the model for that board (answerOnBoard) only for a run in
// boardAnswerRuns.
function announce($: EngineInterface, run: Run, text?: string, deferred = false): void {
  $.ui.invalidate('ui.render')
  if (!isSettled(run) || run.settledNotified || settleSubmits.has(run.runId)) return
  settleSubmits.add(run.runId)
  const send = () => {
    // Plugin submissions run once idle; never await them in the queue.
    submitRunNews($, run, text ?? settleMessage(run, TOOL_NAME, settleAsks(run), boardAnswerRuns.has(run.runId))).then(result => {
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
  if (deferred) afterHook($, send)
  else send()
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
  // The verifier nodes a security lens's candidates expand into, built once the lens passed verification.
  readonly expansion?: NodeDef[]
}

function claimCompletion(end: AgentEnd): CompletionClaim | undefined {
  const runId = agentRuns.get(end.agentId)
  if (!runId) return
  agentRuns.delete(end.agentId)
  backgroundAgents.delete(end.agentId)
  endBackgroundWait(end.agentId)
  const report = handbacks.get(end.agentId)
  handbacks.delete(end.agentId)
  const run = runs.get(runId)
  const node = run && nodeForAgent(run, end.agentId)
  if (!run || !node) return
  return { run, node, report }
}

// `claude -p "/dag run <file>"` runs the command with no main turn, so nothing holds the session: in 5 of 14 real runs on
// 2026-10-19 it closed as the first node ended and the successor failed with "no session is bound in this process". One
// short prompt opens a main turn; the end of that turn is held while the run is active, and keepSessionUp takes over.
// The host refuses a submit from inside the command.run hook, so it goes out on the next tick, while the first node's
// agent keeps the session up.
function openHeldTurn($: EngineInterface): void {
  if (interactive || mainTurnBusy || keepAliveQueued) return
  const run = [...runs.values()].find(current => current.sessionId === sessionId && current.status === 'running')
  if (!run) return
  keepAliveQueued = true
  $.clock.after(0, () => {
    submitRunNews($, run, runStartedMessage(run)).then(result => {
      if ('drop' in result) throw new Error(result.drop)
    }).catch(error => {
      keepAliveQueued = false
      $.ui.log(`could not keep the session open for ${run.runId}: ${message(error)}`)
    })
  })
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
  submitRunNews($, run, keepAliveMessage(run, node.id)).then(result => {
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

// Agent backgrounds by default ("Set to false only when your very next action depends on this agent's result"), so only
// an explicit false keeps it in the foreground. Bash, Task and any other tool count only with run_in_background true.
function startsBackgroundWork(tool: string, input: Readonly<Record<string, unknown>>): boolean {
  if (tool === 'Monitor') return true
  if (tool === 'Agent') return input.run_in_background !== false
  return input.run_in_background === true
}

// Ends a worker's wait for its background work, when it has one: its next turn has started or ended, or its node ended.
function endBackgroundWait(agentId: string): { answer: string } | undefined {
  const wait = backgroundWaits.get(agentId)
  if (!wait) return undefined
  wait.timer.cancel()
  backgroundWaits.delete(agentId)
  return wait
}

// A worker that started background work and ended its turn without a status line has not finished: the work's
// notification starts its next turn. An interrupted, failed or refused turn, or an answer with a status line, finishes as
// before. The answer is found as onAgentDone finds it; a transcript that cannot be read finishes as before too.
async function awaitsBackground($: EngineInterface, end: AgentEnd): Promise<string | undefined> {
  if (!backgroundAgents.has(end.agentId) || end.isAborted || end.reason === 'aborted' || end.reason === 'error' || end.reason === 'refusal') return undefined
  try {
    const answer = end.answer || handbacks.get(end.agentId) || await recoverReport($, end.agentId)
    return hasStatusLine(answer) ? undefined : answer
  } catch {
    return undefined
  }
}

// The node stays running with its agent mapped, so the next turn end comes back through onAgentDone; the pane and the log
// say why. Without a next turn within BACKGROUND_WAIT_MS the node fails. A run being cancelled waits for nothing: false
// sends the turn end on to finish as before.
function waitForBackground($: EngineInterface, agentId: string, answer: string): boolean {
  const run = runs.get(agentRuns.get(agentId) ?? '')
  const node = run && nodeForAgent(run, agentId)
  if (!run || !node || run.cancelReason !== undefined) return false
  activity.set(agentId, toolStarted(BACKGROUND_WAIT_TOOL, Date.now()))
  $.ui.log(`${run.name} › ${node.id}: ${t.backgroundWait}`)
  $.ui.invalidate('ui.render')
  const timer = $.clock.after(BACKGROUND_WAIT_MS, () => {
    serialized(() => backgroundTimedOut($, agentId, timer)).catch(error => {
      $.ui.log(`could not end the background wait of agent ${agentId}: ${message(error)}`)
    })
  })
  backgroundWaits.set(agentId, { answer, timer })
  return true
}

async function backgroundTimedOut($: EngineInterface, agentId: string, timer: Timer): Promise<void> {
  const wait = backgroundWaits.get(agentId)
  if (wait?.timer !== timer) return
  endBackgroundWait(agentId)
  activity.delete(agentId)
  const claim = claimCompletion({ agentId, isAborted: false })
  if (!claim) return
  // Its background work may still be running: stopped first, so a recovery attempt does not share the scope with it.
  const stopFailure = await stopAgent($, agentId)
  if (stopFailure) $.ui.log(`could not stop agent ${agentId} after its background wait: ${stopFailure}`)
  const reportPath = wait.answer ? await writeReport($, claim.run.runId, claim.node.id, wait.answer) : undefined
  const error = `The node agent ended its turn with background work pending and was not resumed within ${BACKGROUND_WAIT_MS / 60_000} minutes.`
  const result: CompletionResult = { outcome: { state: 'failed', error, ...(wait.answer ? { answer: wait.answer } : {}), ...(reportPath ? { reportPath } : {}) } }
  await recordNodeEnd($, claim, result, { agentId, isAborted: false, ...(wait.answer ? { answer: wait.answer } : {}) })
  await applyCompletion($, claim, result)
}

async function onAgentDone($: EngineInterface, end: AgentEnd): Promise<void> {
  endBackgroundWait(end.agentId)
  const pending = await awaitsBackground($, end)
  if (pending !== undefined && await serialized(async () => waitForBackground($, end.agentId, pending))) return
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
    let expansion: NodeDef[] | undefined
    if (parsed.state === 'completed') {
      verification = await verifyNode($, run, node)
      if (verification.status !== 'passed') {
        const detail = verification.error ?? verification.evidence.find(item => !item.passed)?.detail ?? 'Verification checks are missing.'
        const program = verification.evidence.map(missingProgram).find(name => name !== undefined)
        const error = program
          ? `${CHECK_DEFECT}: ${program} is not on the PATH verify commands run with, so this check cannot pass as written; amend the check (the node's work may be right) instead of retrying the node.\n${detail}`
          : detail
        outcome = { ...outcome, state: 'failed', error }
      } else if (securityLensOf(run.definition, node.id) !== undefined) {
        const expanded = await lensExpansion($, run, node.id)
        if (expanded.ok) expansion = expanded.value
        else outcome = { ...outcome, state: 'failed', error: expanded.error.message }
      }
    }
    result = { outcome, verification, ...(expansion ? { expansion } : {}) }
  } catch (error) {
    result = { outcome: { state: 'failed', error: `Completion processing failed: ${message(error)}` } }
  }
  await recordNodeEnd($, claim, result, end)
  await serialized(() => applyCompletion($, claim, result))
}

// A security lens that passed its checks: read its candidates and build one verifier node per candidate, after creating the
// lens's verifier folder, which review-security's folder check needs even when there are no candidates. Any problem fails
// the lens with the reason, so recovery or a retry can redo it; nothing is spawned from a candidates block read in part.
async function lensExpansion($: EngineInterface, run: Run, lensId: string): Promise<Result<NodeDef[]>> {
  const review = run.definition.review
  const lens = securityLensOf(run.definition, lensId)
  if (!review?.security || !lens) return fail('invalid_expansion', `"${lensId}" is not a security lens of this run.`)
  const notes = lensNotesFile(review, lens)
  let text: string
  try {
    text = await $.fs.read(notes)
  } catch (error) {
    return fail('invalid_candidates', `could not read ${notes} (${message(error)}).`)
  }
  const candidates = parseCandidates(text, review.security)
  if (!candidates.ok) return fail('invalid_candidates', `${notes}: ${candidates.error.message}`)
  let all = candidates.value
  // The Semgrep rules cite kisa and owasp rows. Their hits in this lens join the lens's candidates, and the lens notes record
  // them, or the scan's failure, so review-security counts a verifier for each.
  const scan = review.security.some(guide => guide === 'kisa' || guide === 'owasp') ? await changeHits($, run) : undefined
  if (scan) {
    const merged = scan.ok ? mergeCandidates(all, semgrepCandidates(scan.value, lens, review.security, await guideRows($))) : undefined
    all = merged?.all ?? all
    try {
      await $.fs.write(notes, lensNotesWithSemgrep(text, merged?.added ?? [], scan.ok ? undefined : scan.error.message))
    } catch (error) {
      return fail('invalid_expansion', `could not record the Semgrep candidates in ${notes} (${message(error)}).`)
    }
  }
  const folder = lensVerifyFolder(review, lens)
  try {
    const made = await $.process.run(['mkdir', '-p', folder])
    if (made.exitCode !== 0) return fail('invalid_expansion', `could not create ${folder}: ${made.stderr.trim() || `exit ${made.exitCode}`}`)
  } catch (error) {
    return fail('invalid_expansion', `could not create ${folder}: ${message(error)}`)
  }
  return verifierNodes(run.definition, lensId, all)
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
  let { outcome } = result
  const { verification, expansion } = result
  if (verification) {
    prepared = { ...run, nodes: run.nodes.map(current => current.id === node.id ? { ...current, verification } : current) }
  }
  // The verifiers join before the lens is marked finished, so review-security already waits on them when the last lens ends.
  if (expansion) {
    const expanded = expandNodes(prepared, node.id, REVIEW_SECURITY_ID, expansion)
    if (expanded.ok) prepared = expanded.value
    else outcome = { ...outcome, state: 'failed', error: `Could not add the verifier nodes: ${expanded.error.message}` }
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
    submitRunNews($, after, nodeMessage(after, node.id)).catch(error => {
      $.ui.log(`could not announce ${runId}/${node.id}: ${message(error)}`)
    })
  }
}

// What a failed reviewer found, for the producers it sends back: its error, its ## Output, and for a generated reviewer the
// notes file, read now because the reviewer's next start removes it (clearStaleNotes).
async function reviewerFindings($: EngineInterface, run: Run, nodeId: string): Promise<string> {
  const node = run.nodes.find(current => current.id === nodeId)
  const def = run.definition.nodes.find(current => current.id === nodeId)
  const parts = [node?.error ?? '', node?.output ?? '']
  for (const path of def ? generatedNotesFiles(run, def) : []) {
    try {
      parts.push(`From ${path}:\n${findingSections(await $.fs.read(path))}`)
    } catch (error) {
      debug($, `could not read review notes ${path}: ${message(error)}`)
    }
  }
  return parts.filter(part => part.trim() !== '').join('\n\n')
}

// One automatic review-fix round (rework.ts), only with auto_recovery on. reworked: the producers are queued again. Otherwise
// the run may carry why it got no round (work outside the project, findings with no single owner) for its settle message.
async function attemptRework($: EngineInterface, run: Run): Promise<{ run: Run; reworked: boolean } | undefined> {
  if (!autoRecovery || run.sessionId !== sessionId) return undefined
  const findings = new Map<string, string>()
  for (const node of run.nodes) {
    if (node.state === 'failed' && verdictFailure(run, node.id)) findings.set(node.id, await reviewerFindings($, run, node.id))
  }
  const plan = reworkPlan(run, findings, rootOf(run), reviewLedger)
  if (!plan) return undefined
  const now = await $.clock.now()
  if ('skip' in plan) {
    $.ui.log(`No automatic review fix for ${run.runId}: ${plan.skip}`)
    await record($, { kind: 'rework', runId: run.runId, skip: plan.skip })
    return { run: withReworkSkip(run, plan.skip, now), reworked: false }
  }
  const reworked = reworkRun(run, plan.producers, plan.note, plan.reviewers, now, reviewLedger ? plan.findings : undefined)
  if (!reworked.ok) {
    debug($, `review fix for ${run.runId} not applied: ${reworked.error.message}`)
    return undefined
  }
  const round = reworked.value.reviewFix?.rounds
  await record($, { kind: 'rework', runId: run.runId, round, reviewers: plan.reviewers, producers: plan.producers, note: plan.note })
  $.ui.log(`Automatic review fix ${run.runId}: ${plan.reviewers.join(', ')} failed on a FAIL verdict; rerunning ${plan.producers.join(', ')} with the findings, then the reviewers`)
  // Before returning: tick starts the producers right after, and the copy must hold their files as the reviewers judged them.
  if (reviewLedger && round !== undefined) await recordBeforeFix($, reworked.value, round, plan.producers)
  return { run: reworked.value, reworked: true }
}

// The review ledger's copy of the producers' files before a fix holds at most this many, and its diff takes at most this many
// files the fix added. A scope such as '.' lists the whole repository, and every file costs a copy when the round starts and a
// git diff when each ledger reviewer starts.
const LEDGER_FILES = 200

type BeforeFix = { scopes: string[]; files: string[] }

// One round's ledger folder, relative to the session's folder, which holds the run store: git diff --no-index names the
// before-state copies by this path (by its absolute path for a run in a worktree), and fixDiffText strips it from their headers.
function ledgerFolder(runId: string, round: number): string {
  return `${RUNS_SUBDIR}/${runId}/review-fix-${round}`
}

// The files in the given write scopes, tracked or new but not ignored, as paths relative to the run's root.
async function ledgerFiles($: EngineInterface, scopes: readonly string[], root: string): Promise<string[]> {
  const files = new Set<string>()
  for (const scope of scopes) {
    const listed = await $.process.run(['git', '-c', 'core.quotePath=false', 'ls-files', '-z', '-c', '-o', '--exclude-standard', '--', `:(literal)${scope}`], { cwd: root, timeoutMs: GIT_READ_TIMEOUT_MS })
    if (listed.exitCode !== 0) throw new Error(`git ls-files ${scope} exited ${listed.exitCode}: ${listed.stderr.trim()}`)
    for (const path of listed.stdout.split('\0')) if (path !== '') files.add(path)
  }
  return [...files]
}

// A copy of every file in the producers' declared writes under review-fix-<round>/before/, then before.json naming the scopes
// and the files copied. before.json is written last, so its presence means a complete copy; without it the rerun reviewers
// read that the change could not be recorded. A file the host cannot read (a binary, or one over its read limit) is skipped
// alone and left out of before.json, so fixDiff shows it as added since the copy: the whole file counts as changed. A failure
// of the git listing itself drops the whole copy. A failure never stops the round.
async function recordBeforeFix($: EngineInterface, run: Run, round: number, producers: readonly string[]): Promise<void> {
  const folder = `${projectRoot}/${ledgerFolder(run.runId, round)}`
  const root = rootOf(run)
  const scopes = [...new Set(producers.flatMap(id => run.definition.nodes.find(def => def.id === id)?.writes ?? []))]
  try {
    const files: string[] = []
    for (const path of (await ledgerFiles($, scopes, root)).slice(0, LEDGER_FILES)) {
      // ls-files -c still lists a tracked file the producer deleted without git rm. It has no text to keep, and if the fix
      // brings it back, fixDiff shows it as added.
      if (!(await $.fs.exists(`${root}/${path}`))) continue
      try {
        await $.fs.write(`${folder}/before/${path}`, await $.fs.read(`${root}/${path}`))
        files.push(path)
      } catch (error) {
        debug($, `review ledger: left ${path} out of the copy before review fix ${round} of ${run.runId}: ${message(error)}`)
      }
    }
    const before: BeforeFix = { scopes, files }
    await $.fs.write(`${folder}/before.json`, JSON.stringify(before))
  } catch (error) {
    debug($, `review ledger: could not copy the files of ${producers.join(', ')} before review fix ${round} of ${run.runId}: ${message(error)}`)
  }
}

function isBeforeFix(value: unknown): value is BeforeFix {
  const strings = (list: unknown) => Array.isArray(list) && list.every(item => typeof item === 'string')
  return typeof value === 'object' && value !== null && 'scopes' in value && 'files' in value && strings(value.scopes) && strings(value.files)
}

// The fix's diff: each copied file against the same path now, and each file the scopes gained since, as git prints them, with
// the copy's folder stripped from the headers. undefined when the copy was not recorded or before.json cannot be read.
async function fixDiff($: EngineInterface, runId: string, round: number, root: string): Promise<string | undefined> {
  const folder = ledgerFolder(runId, round)
  // git runs in the run's root. A run in a worktree keeps its copy in the session's store, so there the copy is named by its
  // absolute path, which git prints without the leading slash.
  const copies = root === projectRoot ? `${folder}/before` : `${projectRoot}/${folder}/before`
  let before: BeforeFix
  let current: string[]
  try {
    const parsed: unknown = JSON.parse(await $.fs.read(`${projectRoot}/${folder}/before.json`))
    if (!isBeforeFix(parsed)) throw new Error('before.json does not list scopes and files')
    before = parsed
    current = await ledgerFiles($, before.scopes, root)
  } catch (error) {
    debug($, `review ledger: no fix diff for ${runId} round ${round}: ${message(error)}`)
    return undefined
  }
  const copied = new Set(before.files)
  const added = current.filter(path => !copied.has(path)).slice(0, LEDGER_FILES)
  const parts: string[] = []
  for (const path of [...before.files, ...added]) {
    try {
      // The disk decides the after side: git still lists a tracked file the fix deleted without git rm, and git diff --no-index
      // on a missing path prints only an error.
      const sides = [copied.has(path) ? `${copies}/${path}` : '/dev/null', (await $.fs.exists(`${root}/${path}`)) ? path : '/dev/null']
      // git diff --no-index exits 0 when the two sides are equal and 1 when it printed a difference.
      // quotePath off, as in every other git read here: an absolute copy path with non-ASCII letters would come back quoted
      // and escaped, and fixDiffText could not strip it.
      const diff = await $.process.run(['git', '-c', 'core.quotePath=false', 'diff', '--no-index', '--no-color', '--', ...sides], { cwd: root, timeoutMs: GIT_READ_TIMEOUT_MS })
      if (diff.exitCode === 1) parts.push(diff.stdout)
      else if (diff.exitCode !== 0) debug($, `review ledger: git diff of ${path} exited ${diff.exitCode}: ${diff.stderr.trim()}`)
    } catch (error) {
      debug($, `review ledger: could not diff ${path}: ${message(error)}`)
    }
  }
  return fixDiffText(parts, copies.replace(/^\//, ''))
}

// The ledger section a rerun review-spec or review-standards gets after a round that kept its findings; undefined for every
// other start. Lenses, verifiers and review-security keep their prompts.
async function ledgerSection($: EngineInterface, run: Run, def: NodeDef): Promise<string | undefined> {
  const fix = run.reviewFix
  const last = fix?.history.at(-1)
  if (!reviewLedger || !isLedgerReviewer(def.id) || !fix || !last?.findings) return undefined
  return ledgerBlock({ reviewerId: def.id, producers: last.producers, findings: last.findings, fixDiff: await fixDiff($, run.runId, fix.rounds, rootOf(run)) })
}

async function attemptRecovery($: EngineInterface, run: Run, nodeId: string): Promise<Run> {
  const node = run.nodes.find(current => current.id === nodeId)
  if (!autoRecovery || !node || node.state !== 'failed' || run.cancelReason || run.handoff || node.verification?.status === 'missing' || (node.recovery?.used ?? 0) >= MAX_AUTO_RECOVERIES) return run
  // A defect of the check fails every attempt alike, so no Jev call and no retry: the main conversation amends the check.
  if (isCheckDefect(node.error)) {
    debug($, `no automatic recovery for ${run.runId}/${node.id}: ${CHECK_DEFECT}`)
    return run
  }
  // A FAIL verdict repeats on a retry: the work it judged has to change first (see verdictFailure).
  if (verdictFailure(run, node.id)) {
    debug($, `no automatic recovery for ${run.runId}/${node.id}: FAIL verdict`)
    return run
  }
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

// A folder check reads every regular file under the folder, so it is bounded: past either limit it fails and reads nothing.
const FOLDER_CHECK_MAX_FILES = 2_000
const FOLDER_CHECK_MAX_BYTES = 20 * 1024 * 1024
const FOLDER_CHECK_FIELDS = TEXT_FIELDS.filter(field => field !== 'contains' && field !== 'absent')

// The plugin's own checkpoint store, wherever it sits. It keeps every run's definition, so the text of each check, and the
// reports of other nodes: a folder walk that read it would find its own `contains` text and pass with no deliverable. The
// path folds as the parser's does (readOnlyAbsolutePath): backslashes are separators, repeated separators, `.` segments and
// trailing separators vanish, so `/work/.claude/` plus `dag` is `/work/.claude//dag` and still ends at the pair. The case
// folds too, since macOS and Windows open .CLAUDE/DAG as the same folder.
function isCheckpointDir(path: string): boolean {
  const parts = path.replaceAll('\\', '/').split('/').filter(part => part !== '' && part !== '.').map(part => part.toLowerCase())
  return parts.length >= 2 && parts[parts.length - 2] === '.claude' && parts[parts.length - 1] === 'dag'
}

// A relative check path is joined to the run's root without its `.` segments, so `.` is the root itself.
function resolveCheckPath(path: string, root: string): string {
  const parts = path.split('/').filter(part => part !== '' && part !== '.')
  return parts.length ? `${root}/${parts.join('/')}` : root
}

// Every regular file under dir, hidden and ignored ones included, as paths relative to dir in name order. A symbolic link
// is not followed and not listed, since $.fs.list reports it as `other`. A directory that is a checkpoint store (.claude/dag)
// is skipped whole at any depth: nothing below it is read or counted. Past a bound it answers the problem instead.
async function folderFiles($: EngineInterface, dir: string): Promise<{ files: string[] } | { problem: string }> {
  const files: string[] = []
  let bytes = 0
  const bounded = (): string | undefined => files.length > FOLDER_CHECK_MAX_FILES
    ? `the folder holds more than ${FOLDER_CHECK_MAX_FILES} files; point the check at a smaller folder`
    : bytes > FOLDER_CHECK_MAX_BYTES ? `the files in the folder total more than ${FOLDER_CHECK_MAX_BYTES / 1024 / 1024} MB; point the check at a smaller folder` : undefined
  const walk = async (prefix: string): Promise<string | undefined> => {
    const entries = [...await $.fs.list(prefix === '' ? dir : `${dir}/${prefix}`)].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    for (const entry of entries) {
      const relative = `${prefix}${entry.name}`
      if (entry.kind === 'file') {
        files.push(relative)
        bytes += entry.size
        const problem = bounded()
        if (problem) return problem
      } else if (entry.kind === 'dir' && !isCheckpointDir(`${dir}/${relative}`)) {
        const problem = await walk(`${relative}/`)
        if (problem) return problem
      }
    }
    return undefined
  }
  const problem = await walk('')
  return problem ? { problem } : { files }
}

// contains holds when any file under the folder has the text, absent when none does; the first file that breaks absent is named, never quoted.
type CheckResult = { outcome: VerificationOutcome; detail: string; exitCode?: number }

async function folderCheckResult($: EngineInterface, check: FileCheck, dir: string): Promise<CheckResult> {
  const unsupported = FOLDER_CHECK_FIELDS.filter(field => check[field] !== undefined)
  if (unsupported.length) return { outcome: 'unknown', detail: `${check.path} is a folder, and a folder check allows only contains and absent, not ${unsupported.join(', ')}` }
  const listed = await folderFiles($, dir)
  if ('problem' in listed) return { outcome: 'unknown', detail: `${check.path}: ${listed.problem}` }
  const base = check.path.replace(/[\\/]+$/, '')
  let found = check.contains === undefined
  for (const file of listed.files) {
    if (found && check.absent === undefined) break
    const shown = `${base}/${file}`
    let text: string
    try {
      text = await $.fs.read(`${dir}/${file}`)
    } catch (error) {
      return { outcome: 'unknown', detail: `${shown} could not be read (${message(error)}), so the folder check cannot be judged` }
    }
    const problem = check.absent === undefined ? undefined : textProblem(text, { absent: check.absent }, shown)
    if (problem) return { outcome: 'failed', detail: problem }
    if (check.contains !== undefined && text.includes(check.contains)) found = true
  }
  if (!found) return { outcome: 'failed', detail: textProblem('', { contains: check.contains }, `${check.path} (${listed.files.length} files)`) ?? '' }
  return { outcome: 'passed', detail: `Folder verified: ${check.path} (${listed.files.length} files)` }
}

// A file check on a missing or unreadable path fails, absent included: a path that is not there proves nothing.
async function fileCheckResult($: EngineInterface, check: FileCheck, root: string): Promise<CheckResult> {
  if (!projectPath(check.path) && !readOnlyAbsolutePath(check.path)) return { outcome: 'unknown', detail: `Path not allowed: ${check.path}` }
  const path = projectPath(check.path) ? resolveCheckPath(check.path, root) : check.path
  let kind: string
  try {
    kind = (await $.fs.stat(path)).kind
  } catch (error) {
    return { outcome: await $.fs.exists(path) ? 'unknown' : 'failed', detail: `Path is missing or unreadable: ${check.path} (${message(error)})` }
  }
  const hasText = TEXT_FIELDS.some(field => check[field] !== undefined)
  if (kind === 'dir') return hasText ? folderCheckResult($, check, path) : { outcome: 'passed', detail: `Folder verified: ${check.path}` }
  if (kind !== 'file') return { outcome: 'failed', detail: `Expected a file or folder: ${check.path}` }
  const problem = hasText ? textProblem(await $.fs.read(path), check, check.path) : undefined
  return problem ? { outcome: 'failed', detail: problem } : { outcome: 'passed', detail: `File verified: ${check.path}` }
}

// A program that cannot start or runs past its limit makes $.process.run reject, which fails the check whatever expect says.
// The limit is the check's own timeoutMs, or the host's 30 s default without one (the parser keeps it within 1 s to 10 min).
// The host reads a signal exit as code 1, so only a rejection or a missing code is told apart here.
async function commandCheckResult($: EngineInterface, check: CommandCheck, root: string): Promise<CheckResult> {
  const result = await $.process.run(check.argv, { cwd: root, timeoutMs: check.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS })
  const exitCode = typeof result.exitCode === 'number' ? result.exitCode : undefined
  const expectation = check.expect
  const truncated = (stream: 'stdout' | 'stderr') => expectation?.[stream] !== undefined && (stream === 'stdout' ? result.isStdoutTruncated : result.isStderrTruncated)
    ? `${stream} was cut at 4 MiB, so its expectation cannot be judged` : undefined
  const problem = exitProblem(exitCode, expectation) ??
    truncated('stdout') ?? (expectation?.stdout ? textProblem(result.stdout, expectation.stdout, 'stdout') : undefined) ??
    truncated('stderr') ?? (expectation?.stderr ? textProblem(result.stderr, expectation.stderr, 'stderr') : undefined)
  const excerpt = `${JSON.stringify(check.argv)} exited ${result.exitCode}\n${result.stdout}\n${result.stderr}`
  const outcome = exitCode === undefined ? 'unknown'
    : exitProblem(exitCode, expectation) ? 'failed'
    : truncated('stdout') || truncated('stderr') ? 'unknown'
    : problem ? 'failed' : 'passed'
  return { outcome, detail: (problem ? `${problem}\n${excerpt}` : excerpt).slice(0, 4_000), exitCode }
}

async function verifyNode($: EngineInterface, run: Run, node: NodeRun): Promise<NonNullable<NodeRun['verification']>> {
  const checks = run.definition.nodes.find(def => def.id === node.id)?.verify
  if (!checks?.length) return { status: 'missing', evidence: [], error: 'No verification contract was declared; amend this node with verify checks.' }
  const evidence: VerificationEvidence[] = []
  for (const check of checks) {
    let outcome: VerificationOutcome = 'unknown'
    let detail = ''
    let exitCode: number | undefined
    try {
      switch (check.kind) {
        case 'file': {
          ({ outcome, detail } = await fileCheckResult($, check, rootOf(run)))
          break
        }
        case 'command': {
          ({ outcome, detail, exitCode } = await commandCheckResult($, check, rootOf(run)))
          break
        }
        default: {
          const unreachable: never = check
          throw new Error(`Unknown verification check: ${String(unreachable)}`)
        }
      }
    } catch (error) {
      const failure = message(error)
      outcome = check.kind === 'command' ? 'not_run' : 'unknown'
      detail = `Verification could not run: ${failure}`
      const advice = check.kind === 'command' ? timeoutAdvice(failure) : undefined
      if (advice) detail += `\n${advice}`
    }
    const item = { check, passed: outcome === 'passed', outcome, detail, checkedAt: await $.clock.now(), ...(exitCode !== undefined ? { exitCode } : {}) }
    if (missingProgram(item)) item.outcome = 'not_run'
    evidence.push(item)
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

// A run's events go to a folder named for it; the main conversation's go to one named for the session.
function trajectoryDir(runId?: string): string {
  return `${projectRoot}/${TRAJECTORY_SUBDIR}/${runId ?? `session-${sessionId}`}`
}

// Queues one trajectory event. Nothing in a run waits on the write: one that fails is logged and the run goes on.
async function record($: EngineInterface, input: TrajectoryInput): Promise<void> {
  if (!trajectoryLog || !projectRoot) return
  const event = { at: await $.clock.now(), sessionId, ...input }
  const dir = trajectoryDir('runId' in input ? input.runId : undefined)
  const path = `${dir}/${eventFileName(event.at, ++trajectorySeq, input.kind, 'nodeId' in input ? input.nodeId : undefined)}`
  trajectoryWrites = trajectoryWrites.then(async () => {
    await ensureDir($, dir)
    await $.fs.write(path, trajectoryLine(event))
  }).catch(error => debug($, `could not record the trajectory event ${input.kind}: ${message(error)}`))
}

// A settled run's events joined into one <run_id>.jsonl beside its folder, once the writes queued before it are done.
function exportTrajectory($: EngineInterface, runId: string): void {
  if (!trajectoryLog || !projectRoot) return
  const dir = trajectoryDir(runId)
  trajectoryWrites = trajectoryWrites.then(async () => {
    const names = (await $.fs.list(dir)).filter(entry => entry.kind === 'file' && entry.name.endsWith('.jsonl')).map(entry => entry.name).sort()
    const lines: string[] = []
    for (const name of names) lines.push(await $.fs.read(`${dir}/${name}`))
    await $.fs.write(`${dir}.jsonl`, lines.join(''))
  }).catch(error => debug($, `could not join the trajectory of ${runId}: ${message(error)}`))
}

const TRAJECTORY_NEW_FILES = 20

// What a node's end leaves that a later attempt erases: the notes files its checks read outside the project, which
// clearStaleNotes removes before a reviewer's next start, and, for a node that declares writes, their change against HEAD with
// new files in full, which the next attempt overwrites.
async function endSnapshot($: EngineInterface, run: Run, nodeId: string): Promise<{ notes: NotesFile[]; diff?: string }> {
  const def = run.definition.nodes.find(current => current.id === nodeId)
  const notes: NotesFile[] = []
  const paths = new Set((def?.verify ?? []).flatMap(check => check.kind === 'file' && readOnlyAbsolutePath(check.path) ? [check.path] : []))
  for (const path of paths) {
    try {
      if ((await $.fs.stat(path)).kind === 'file') notes.push({ path, text: await $.fs.read(path) })
    } catch (error) {
      debug($, `trajectory: could not read ${path}: ${message(error)}`)
    }
  }
  const writes = (def?.writes ?? []).map(path => `:(literal)${path}`)
  if (writes.length === 0) return { notes }
  const root = rootOf(run)
  try {
    const changed = await $.process.run(['git', '-c', 'core.quotePath=false', 'diff', '--no-color', 'HEAD', '--', ...writes], { cwd: root })
    const untracked = await $.process.run(['git', 'ls-files', '-z', '--others', '--exclude-standard', '--', ...writes], { cwd: root })
    if (changed.exitCode !== 0 || untracked.exitCode !== 0) return { notes }
    const fresh = untracked.stdout.split('\0').filter(Boolean).slice(0, TRAJECTORY_NEW_FILES)
    const added = await Promise.all(fresh.map(async path => `new file ${path}\n${await readOrEmpty($, `${root}/${path}`)}`))
    return { notes, diff: [changed.stdout, ...added].filter(text => text !== '').join('\n') }
  } catch (error) {
    debug($, `trajectory: could not read the change of ${nodeId}: ${message(error)}`)
    return { notes }
  }
}

// The end of one node attempt: its outcome and checks, what it left (endSnapshot), its token counts, and its transcript.
// Awaited before the completion is applied, because applying it can start the attempt that erases the notes.
async function recordNodeEnd($: EngineInterface, claim: CompletionClaim, result: CompletionResult, end: AgentEnd): Promise<void> {
  if (!trajectoryLog) return
  const { run, node } = claim
  const usage = agentUsage.get(end.agentId)
  agentUsage.delete(end.agentId)
  try {
    const { notes, diff } = await endSnapshot($, run, node.id)
    const { state, error, answer } = result.outcome
    await record($, {
      kind: 'node.end', runId: run.runId, nodeId: node.id, attempt: node.attempt, agentId: end.agentId, reason: end.reason, isAborted: end.isAborted,
      state, error, answer, verification: result.verification, expansion: result.expansion?.map(def => def.id), notes, diff, usage,
    })
    const rows = await $.session.messages({ agentId: end.agentId })
    await record($, Array.isArray(rows)
      ? { kind: 'node.transcript', runId: run.runId, nodeId: node.id, attempt: node.attempt, agentId: end.agentId, rows: transcriptRows(rows) }
      : { kind: 'node.transcript', runId: run.runId, nodeId: node.id, attempt: node.attempt, agentId: end.agentId, rows: [], error: rows.deny })
  } catch (error) {
    debug($, `could not record the end of ${run.runId}/${node.id} in its trajectory: ${message(error)}`)
  }
}

// The main conversation's rows since the last turn it logged.
async function recordMainTurn($: EngineInterface, turn: { turnId: string; reason: string; durationMs: number; usage?: Usage }): Promise<void> {
  try {
    const rows = await $.session.messages()
    if (!Array.isArray(rows)) return
    const fresh = rowsAfter(rows, mainRows)
    mainRows = fresh.mark
    await record($, { kind: 'main.turn', turnId: turn.turnId, reason: turn.reason, durationMs: turn.durationMs, usage: turn.usage, rows: transcriptRows(fresh.rows) })
  } catch (error) {
    debug($, `could not record the main turn in the trajectory: ${message(error)}`)
  }
}

// Both start and a dry run say so when the person or the model has not loaded the planning skill (guide mode lets the start through).
function planningWarning(): string[] {
  return planningLoaded || enforcement === 'off' ? [] : [`the ${PLANNING_SKILL} skill is not loaded in this session - load it and follow its node prompt contract.`]
}

// The checks start runs before it creates anything, in start's order: parse, then the key, then verification. A key that already
// holds this same definition comes back as `existing` and skips verification, as start's `reused` reply does. Start and a dry run share this.
// root is the folder the run would work in: only a run of that folder is reused, so the same definition started again in a
// worktree runs there instead of returning the run of the session's own folder.
function screenDefinition(input: unknown, root: string): Result<{ definition: Definition; existing: Run | undefined }> {
  const parsed = parseDefinition(input)
  if (!parsed.ok) return parsed
  const reusable = findReusable([...runs.values()].filter(run => rootOf(run) === root), parsed.value)
  if (!reusable.ok) return reusable
  if (reusable.value) return { ok: true, value: { definition: parsed.value, existing: reusable.value } }
  const problem = verificationProblem(parsed.value)
  if (problem) return { ok: false, error: problem }
  return { ok: true, value: { definition: parsed.value, existing: undefined } }
}

// Verify commands run through $.process.run: the host process's PATH, no shell profile. Programs the model's Bash tool has
// (Claude Code's own rg, profile aliases and functions) can be missing there, and such a check fails however right the
// deliverable is. On 2026-10-09 a 450-file run lost about 140 s that way: all six batch checks piped through rg, every node
// failed verification, then the settle, an amend and a rerun. One sh call reads the names on stdin, so no argv filter on
// process.run mistakes it for a check, and prints those command -v cannot find. When sh cannot start or answers oddly the
// definition goes through unjudged: the verify run reports a missing program anyway, only later.
const PROGRAM_LOOKUP = 'while IFS= read -r p; do command -v "$p" >/dev/null 2>&1 || printf "%s\\n" "$p"; done'

async function missingProgramProblem($: EngineInterface, definition: Definition, root: string): Promise<EngineError | undefined> {
  const uses = commandPrograms(definition)
  const names = [...new Set(uses.map(use => use.program))]
  if (names.length === 0) return undefined
  let missing: Set<string>
  try {
    const result = await $.process.run(['sh', '-c', PROGRAM_LOOKUP], { cwd: root || undefined, stdin: `${names.join('\n')}\n`, timeoutMs: 5_000 })
    if (result.exitCode !== 0) return undefined
    missing = new Set(result.stdout.split('\n').map(line => line.trim()).filter(name => names.includes(name)))
  } catch {
    return undefined
  }
  const absent = uses.filter(use => missing.has(use.program))
  return absent.length > 0 ? { code: 'invalid_verification', message: missingProgramsMessage(absent) } : undefined
}

// A dry run creates, persists and spawns nothing and opens no pane, so it leaves no trace.
async function previewRequest($: EngineInterface, input: unknown): Promise<Result<{ preview: Preview; existing: Run | undefined }>> {
  const root = await workingRoot($)
  const screened = screenDefinition(input, root)
  if (!screened.ok) return screened
  const missing = screened.value.existing ? undefined : await missingProgramProblem($, screened.value.definition, root)
  if (missing) return { ok: false, error: missing }
  return { ok: true, value: { preview: previewDefinition(screened.value.definition, { maxConcurrent }), existing: screened.value.existing } }
}

function effectiveApproval(): StartApproval {
  return approvalOverride ?? startApproval
}

// `by` is who asked: the model's dag tool, or the person's /dag run. Only a model start in an interactive session waits
// for approval; a person who typed /dag run has already chosen, and a non-interactive session has no one to ask.
// `approveHeld` is set when that person typed it in the composer: /dag run of the definition one of their runs holds for
// approval is then their answer to it, and approves it the way /dag approve does. Every other reuse returns the run as is.
async function startDefinition($: EngineInterface, input: unknown, by: 'model' | 'user', approveHeld = false): Promise<ToolReply> {
  // The run keeps the folder the session works in now, so a run started in a worktree runs there to the end, even if the
  // session moves on.
  const root = await workingRoot($)
  const screened = screenDefinition(input, root)
  if (!screened.ok) return err(screened.error)
  const { definition, existing } = screened.value
  if (existing?.rejected && by === 'model') return err(rejectedByUser(existing))
  if (existing && by === 'user' && approveHeld && existing.sessionId === sessionId && awaitingApproval(existing)) {
    await decideApproval($, 'approve', existing.runId)
    return ok({ reused: true, approved: true, run_id: existing.runId, snapshot: snapshotOf(runs.get(existing.runId) ?? existing, 0) })
  }
  if (existing) return ok({ reused: true, run_id: existing.runId, snapshot: snapshotOf(existing) })
  const missing = await missingProgramProblem($, definition, root)
  if (missing) return err(missing)
  const now = await $.clock.now()
  const runId = `dag_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const routed = await routeRun($, createRun(definition, { runId, sessionId, now, ...(root !== projectRoot ? { root } : {}) }), definition.nodes.map(node => node.id))
  const created = by === 'model' && interactive && effectiveApproval() === 'always' ? requestApproval(routed, await $.clock.now()) : routed
  runs.set(runId, created)
  await record($, { kind: 'run.start', runId, by, key: created.key, name: created.name, goal: created.definition.goal, definition: created.definition })
  // Only the model's own start answers the turn's request; a /dag run the person typed is not part of that answer. The
  // enforcement check matters because only auto decides the surface, so a level changed mid-turn leaves an old 'board'.
  if (by === 'model' && enforcement === 'auto' && turnSurface === 'board') boardAnswerRuns.add(runId)
  // The work now belongs to the run's nodes: a direct turn that opens one keeps the main loop off the files they write.
  if (turnMode === 'direct') {
    turnMode = 'dag'
    debug($, `turn mode dag: run ${runId} started in a direct turn`)
  }
  view = { ...view, runIndex: 0 }
  const started = (await tick($, runId)) ?? created
  await openPane($, false)
  const held = awaitingApproval(started)
  if (held) $.ui.toast(t.toastApproval(started.name), { timeoutMs: ATTENTION_TOAST_MS })
  const warnings = [...lintDefinition(definition), ...planningWarning()]
  return ok({
    reused: false,
    run_id: runId,
    ...(held ? { awaiting_approval: true } : {}),
    snapshot: snapshotOf(started, 0),
    warnings,
    note: held
      ? APPROVAL_NOTE
      : 'The run continues in the background. You will receive a message when it settles; do not poll. Treat every warning as a defect in the definition.',
  })
}

// A dry run's definition, kept by preview_id for this session so start {preview_id} runs it without the model writing the
// definition out again. On 2026-10-10 three eval runs spent 11-31 s of output on that second copy (about 4k tokens each).
// Only the newest PREVIEW_LIMIT are kept, and start screens a kept one exactly as it screens a definition sent inline.
const PREVIEW_LIMIT = 8
const previews = new Map<string, unknown>()

function rememberPreview(source: unknown): string {
  const id = `pv_${hash(stableStringify(source))}`
  previews.delete(id)
  previews.set(id, source)
  for (const old of previews.keys()) {
    if (previews.size <= PREVIEW_LIMIT) break
    previews.delete(old)
  }
  return id
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
// With dryRun:true it ends in previewRequest instead: the same reading, parsing and key checks, then a preview and nothing started.
// A dryRun that is present but not a boolean is refused before anything is read: a request meant to start nothing must not start a run.
async function startRequest($: EngineInterface, input: ToolInput): Promise<ToolReply> {
  if (input.dryRun !== undefined && typeof input.dryRun !== 'boolean') return err({ code: 'invalid_request', message: 'dryRun must be true or false.' })
  const source = await requestedDefinition($, input)
  if (!source.ok) return err(source.error)
  if (input.dryRun !== true) return startDefinition($, source.value, 'model')
  const previewed = await previewRequest($, source.value)
  if (!previewed.ok) return err(previewed.error)
  const { preview, existing } = previewed.value
  return ok({
    dry_run: true,
    preview: { ...preview, warnings: [...preview.warnings, ...planningWarning()] },
    ...(existing ? { existing_run_id: existing.runId } : { preview_id: rememberPreview(source.value) }),
  })
}

async function requestedDefinition($: EngineInterface, input: ToolInput): Promise<Result<unknown>> {
  const hasDefinition = input.definition !== undefined && input.definition !== null
  const hasPath = input.path !== undefined && input.path !== null
  const hasPreview = input.preview_id !== undefined && input.preview_id !== null
  const sources = [hasDefinition, hasPath, hasPreview].filter(Boolean).length
  if (sources !== 1) {
    return fail(
      'invalid_request',
      `start takes exactly one of "definition" (the definition object), "path" (a project-relative .yaml, .yml or .json definition file) and "preview_id" (from a dry run in this session); got ${sources === 0 ? 'none' : sources}.`,
    )
  }
  if (hasPreview) {
    const kept = typeof input.preview_id === 'string' ? previews.get(input.preview_id) : undefined
    if (kept === undefined) return fail('unknown_preview', `No dry run in this session returned preview_id ${JSON.stringify(input.preview_id)}; send the definition or path again.`)
    return { ok: true, value: kept }
  }
  if (!hasPath) return { ok: true, value: input.definition }
  const given = input.path
  if (typeof given !== 'string' || given.trim() === '') {
    return fail('invalid_request', '"path" must be a nonempty string naming a project-relative .yaml, .yml or .json definition file.')
  }
  if (!projectPath(given)) {
    return fail('invalid_request', `"path" ${JSON.stringify(given)} must be project-relative: no leading "/", drive letter or ".." segment, and nothing inside .claude.`)
  }
  if (!/\.(ya?ml|json)$/i.test(given)) {
    return fail('invalid_request', `"path" ${JSON.stringify(given)} must end in .yaml, .yml or .json.`)
  }
  return readDefinitionFile($, `${await $.session.cwd()}/${given}`, given)
}

// The answer to the model's retry, amend or same-definition start of a run the user rejected: the user said no to this
// plan, so running it again is the user's call. The user's own /dag retry is not refused.
function rejectedByUser(run: Run): EngineError {
  const reason = run.rejected?.reason.replace(/\.+$/, '') ?? ''
  return {
    code: 'rejected_by_user',
    message: `The user rejected run ${run.runId} ("${run.name}")${reason ? `: ${reason}` : ''}. Do not retry, amend or restart it. Revise the plan to answer the rejection, give the revised definition a new key, and ask the user before running it again.`,
  }
}

// `by` is who asked: the model's dag tool, or a /dag command the person typed in the composer. Only the person may run a
// run they rejected again.
async function handleTool($: EngineInterface, input: ToolInput, by: 'model' | 'user' = 'model'): Promise<ToolReply> {
  // Only start can preview. On amend, retry, cancel and the rest a dryRun would otherwise be ignored and the action would run for real.
  if (input.action !== 'start' && input.dryRun !== undefined) return err({ code: 'invalid_request', message: 'dryRun is for start only.' })
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
        .map(r => ({
          run_id: r.runId, run_key: r.key, name: r.name, status: r.status, session_id: r.sessionId, owned: r.sessionId === sessionId,
          // status stays running for a held run, so this is what tells the model it has not started.
          ...(awaitingApproval(r) ? { awaiting_approval: true } : {}),
        })),
    })
  }
  const run = typeof input.run_id === 'string' ? runs.get(input.run_id) : undefined
  if (!run) return err({ code: 'unknown_run', message: `No run "${String(input.run_id)}" in this project; use the list action to see runs.` })
  const now = await $.clock.now()

  if (input.action === 'snapshot') return ok(snapshotOf(run))
  if (input.action === 'wait') {
    const note = isSettled(run)
      ? 'The run has settled.'
      : awaitingApproval(run)
        ? APPROVAL_NOTE
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
    const { run: ended, stopAgents } = cancelRun(run, reason, now)
    // A cancelled run waits for no approval; cancelRun keeps the field, so it goes here.
    const { approval: _approval, ...rest } = ended
    let cancelled: Run = rest
    // A worker waiting on its background work has no turn for the stop to end, so no turn end would cancel its node.
    for (const node of ended.nodes) {
      if (node.state !== 'running' || !node.agentId || !endBackgroundWait(node.agentId)) continue
      agentRuns.delete(node.agentId)
      backgroundAgents.delete(node.agentId)
      handbacks.delete(node.agentId)
      activity.delete(node.agentId)
      cancelled = markFinished(cancelled, node.id, { state: 'cancelled', error: `Cancelled: ${reason}` }, now)
    }
    for (const node of run.nodes) if (node.agentId) clearWaiting($, node.agentId)
    await persist($, cancelled)
    const failures: { agent_id: string; error: string }[] = []
    for (const agentId of stopAgents) {
      const failure = await stopAgent($, agentId)
      if (failure) failures.push({ agent_id: agentId, error: failure })
    }
    announce($, cancelled)
    return ok({ ...snapshotOf(cancelled, 0), ...(failures.length ? { stop_failures: failures } : {}) })
  }
  if ((input.action === 'retry' || input.action === 'amend') && run.rejected && by === 'model') return err(rejectedByUser(run))
  if (input.action === 'retry') {
    const nodeIds = Array.isArray(input.node_ids)
      ? input.node_ids.map(String)
      : typeof input.node_id === 'string' ? [input.node_id] : undefined
    const retried = retryRun(run, { ...(nodeIds ? { nodeIds } : {}), ...(typeof input.prompt === 'string' ? { prompt: input.prompt } : {}) }, now)
    if (!retried.ok) return err(retried.error)
    // The person's own retry of a run they rejected is their consent to it: from here on it is an ordinary run.
    if (by === 'user') delete retried.value.rejected
    const routed = await routeRun($, retried.value, retried.value.nodes.filter(node => node.state === 'pending' || node.state === 'scheduled').map(node => node.id))
    runs.set(run.runId, routed)
    await record($, { kind: 'run.retry', runId: run.runId, by, nodeIds, prompt: typeof input.prompt === 'string' ? input.prompt : undefined })
    return ok(snapshotOf((await tick($, run.runId)) ?? routed, 0))
  }
  if (input.action === 'amend') {
    const parsed = parseDefinition(input.definition)
    if (!parsed.ok) return err(parsed.error)
    const problem = verificationProblem(parsed.value) ?? await missingProgramProblem($, parsed.value, rootOf(run))
    if (problem) return err(problem)
    const amended = amendRun(run, parsed.value, now)
    if (!amended.ok) return err(amended.error)
    const routed = await routeRun($, amended.value.run, amended.value.rerun)
    runs.set(run.runId, routed)
    await record($, { kind: 'run.amend', runId: run.runId, rerun: amended.value.rerun, definition: routed.definition })
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

function boardsPath(): string {
  return `${projectRoot}/${BOARDS_SUBDIR}/${sessionId}.json`
}

// A missing file is a session without boards. A file that cannot be read or parsed is logged and left on disk: the
// session starts without boards, and its first create writes the file again.
async function loadBoards($: EngineInterface): Promise<void> {
  boards = []
  selectedBoardId = undefined
  if (!projectRoot || !sessionId) return
  const path = boardsPath()
  try {
    if (!(await $.fs.exists(path))) return
    const parsed = parseBoardFile(await $.fs.read(path), sessionId)
    if (parsed.ok) boards = parsed.value.boards
    else $.ui.log(`could not load ${path}: ${parsed.error.message}`)
  } catch (error) {
    $.ui.log(`could not read ${path}: ${message(error)}`)
  }
}

// Memory takes the new list only once the file holds it, so a failed write changes neither.
async function saveBoards($: EngineInterface, next: Board[]): Promise<void> {
  const file: BoardFile = { schemaVersion: 1, sessionId, boards: next }
  await ensureDir($, `${projectRoot}/${BOARDS_SUBDIR}`)
  await $.fs.write(boardsPath(), JSON.stringify(file, null, 2) + '\n')
  boards = next
}

// An accepted handoff brings the source session's boards along: a block's lines were captured when it was drawn, so
// copying is only the board list with each board's sessionId rewritten — parseBoardFile refuses a board that names
// another session, and this session's own file would too. The Board section then shows the board changed last, as it does
// anywhere else. A missing or unparsable source file is a no-op; a failure is logged and never fails the accept.
async function inheritBoards($: EngineInterface, source: string): Promise<void> {
  const path = `${projectRoot}/${BOARDS_SUBDIR}/${source}.json`
  try {
    if (!(await $.fs.exists(path))) return
    const parsed = parseBoardFile(await $.fs.read(path), source)
    if (!parsed.ok) {
      $.ui.log(`could not inherit ${path}: ${parsed.error.message}`)
      return
    }
    const held = new Set(boards.map(board => board.boardId))
    const inherited = parsed.value.boards.filter(board => !held.has(board.boardId)).map(board => ({ ...board, sessionId }))
    if (inherited.length === 0) return
    await saveBoards($, [...boards, ...inherited])
  } catch (error) {
    $.ui.log(`could not inherit ${path}: ${message(error)}`)
  }
}

// A final newline ends the last line; it does not start another.
function textLines(text: string): string[] {
  const lines = text.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

// What git prints for a board quote, run from the project root like a verify command. A git that cannot start or runs past
// GIT_READ_TIMEOUT_MS rejects, and that refuses the edit the same way a non-zero exit does, with git's own complaint.
async function gitOutput($: EngineInterface, args: string[], at: string): Promise<Result<string>> {
  const refused = (reason: string) => fail<string>('invalid_board_edit', `${at}: git ${args[0]} could not read it (${reason})`)
  try {
    const result = await $.process.run(['git', ...args], { cwd: projectRoot, timeoutMs: GIT_READ_TIMEOUT_MS })
    return result.exitCode === 0 ? { ok: true, value: result.stdout } : refused(result.stderr.trim() || `exit ${result.exitCode}`)
  } catch (error) {
    return refused(message(error))
  }
}

// Lines start..end (1-based) of a project file for a code_peek: the worktree file, or with a ref the file as git holds it at
// that ref. The ./ makes git read the path from the project root, which may be a folder inside the repository; a bare
// <ref>:<path> starts at the repository root. peeksNeeded merges a range several edits ask for, so a refusal names the path
// and no edit index.
async function readPeek($: EngineInterface, request: PeekRequest): Promise<Result<string[]>> {
  const at = request.ref ? `code_peek ${request.path}@${request.ref}` : `code_peek ${request.path}`
  let text: string
  if (request.ref) {
    const shown = await gitOutput($, ['show', `${request.ref}:./${request.path}`], at)
    if (!shown.ok) return shown
    text = shown.value
  } else {
    try {
      text = await $.fs.read(`${projectRoot}/${request.path}`)
    } catch (error) {
      return fail('invalid_board_edit', `${at}: cannot read the file (${message(error)})`)
    }
  }
  const lines = textLines(text)
  if (request.end > lines.length) {
    return fail('invalid_board_edit', `${at}: lines ${request.start}-${request.end} reach past the end of the file, which has ${lines.length} lines`)
  }
  return { ok: true, value: lines.slice(request.start - 1, request.end) }
}

// One artifact of one node for a trace block: output, answer and error are NodeRun fields of the run checkpoint, and verification
// is the evidence file verifyNode persisted. tracesNeeded merges a target several edits ask for, so a refusal names the trace, not
// an edit index. The run id is model input, so it must match the checkpoint naming before it reaches a path.
async function readTrace($: EngineInterface, request: TraceRequest): Promise<Result<string[]>> {
  const at = `trace ${request.run} ${request.node} ${request.part}`
  if (!SAFE_RUN_DIR.test(request.run)) return fail('invalid_board_edit', `${at}: no run checkpoint has that name`)
  const runPath = `${runsDir}/${request.run}.json`
  if (!(await $.fs.exists(runPath))) return fail('invalid_board_edit', `${at}: no checkpoint at ${runPath}`)
  let run: Run
  try {
    run = JSON.parse(await $.fs.read(runPath)) as Run
  } catch (error) {
    return fail('invalid_board_edit', `${at}: cannot read the run checkpoint (${message(error)})`)
  }
  // A board is session state, so it may quote only the session's own runs.
  if (run.sessionId !== sessionId) return fail('invalid_board_edit', `${at}: the run belongs to another session`)
  const node = run.nodes.find(candidate => candidate.id === request.node)
  if (node === undefined) return fail('invalid_board_edit', `${at}: the run has no node ${request.node}`)
  if (request.part === 'verification') {
    const reportPath = node.verification?.reportPath
    if (reportPath === undefined) return fail('invalid_board_edit', `${at}: the node ran no verification`)
    let text: string
    try {
      text = await $.fs.read(reportPath)
    } catch (error) {
      return fail('invalid_board_edit', `${at}: cannot read the verification artifact (${message(error)})`)
    }
    return { ok: true, value: text.split(/\r?\n/) }
  }
  const text = request.part === 'output' ? node.output : request.part === 'answer' ? node.answer : node.error
  if (text === undefined) return fail('invalid_board_edit', `${at}: the node recorded no ${request.part}`)
  return { ok: true, value: text.split(/\r?\n/) }
}

// The lines of git diff <ref> [-- <path>] for a diff block; path is project-relative, as a pathspec from the project root is.
// :(literal) makes git read the path as one file name, as the commit stage's checks do (stages.ts): a bare app/[id]/page.ts is
// a pattern that also names app/i/page.ts, and a leading ":" is pathspec magic. --no-color and --no-ext-diff keep a plain
// unified diff when the person's config sets color.ui=always or an external diff tool such as difftastic. An empty diff is no
// read failure: the engine refuses it in the block's own words. diffsNeeded merges a diff several edits ask for, so a refusal
// names the diff, not an edit index.
async function readDiff($: EngineInterface, request: DiffRequest): Promise<Result<string[]>> {
  const at = request.path ? `diff ${request.ref} ${request.path}` : `diff ${request.ref}`
  const shown = await gitOutput($, ['diff', '--no-color', '--no-ext-diff', request.ref, ...(request.path ? ['--', `:(literal)${request.path}`] : [])], at)
  return shown.ok ? { ok: true, value: textLines(shown.value) } : shown
}

async function editBoard($: EngineInterface, board: Board, edits: BoardEdit[]): Promise<ToolReply> {
  const peeks = new Map<string, string[]>()
  for (const request of peeksNeeded(board, edits)) {
    const lines = await readPeek($, request)
    if (!lines.ok) return err(lines.error)
    peeks.set(peekKey(request), lines.value)
  }
  const traces = new Map<string, string[]>()
  for (const request of tracesNeeded(board, edits)) {
    const lines = await readTrace($, request)
    if (!lines.ok) return err(lines.error)
    traces.set(traceKey(request), lines.value)
  }
  const diffs = new Map<string, string[]>()
  for (const request of diffsNeeded(board, edits)) {
    const lines = await readDiff($, request)
    if (!lines.ok) return err(lines.error)
    diffs.set(diffKey(request), lines.value)
  }
  const boardIds = new Set(boards.map(candidate => candidate.boardId))
  const applied = applyEdits(board, edits, { now: await $.clock.now(), peeks, traces, diffs, boardIds })
  if (!applied.ok) return err(applied.error)
  const edited = applied.value.board
  await saveBoards($, boards.map(candidate => (candidate.boardId === edited.boardId ? edited : candidate)))
  selectedBoardId = edited.boardId
  $.ui.invalidate('ui.render')
  return ok({ board_id: edited.boardId, blocks: edited.blocks.map(block => ({ id: block.id, type: block.type })), inserted: applied.value.inserted })
}

// The pane opens as for a run the model starts: without the keyboard, and not over the person's own close. The reply
// says when the board is not on screen, so the model does not point the person at a pane they cannot see. While a run of
// this session has not settled the pane stays on the DAG, which is what the person is watching, and a toast says the
// board changed; the model tells them to press b.
async function openBoard($: EngineInterface, board: Board): Promise<ToolReply> {
  const keepsDag = ownsUnsettledRun()
  selectedBoardId = board.boardId
  if (!keepsDag) inspectorView = 'board'
  inspectorPage = 0
  selectedDecisionId = undefined
  await openPane($, false)
  $.ui.invalidate('ui.render')
  if (!paneSurface) return ok({ board_id: board.boardId, shown: false, hint: 'This surface draws no /dag pane, so the board is saved but not on screen.' })
  if (paneClosedByUser) return ok({ board_id: board.boardId, shown: false, hint: 'The user closed the /dag pane, so it stays closed; they can show the board with /dag inspect board.' })
  if (!keepsDag) return ok({ board_id: board.boardId, shown: true })
  $.ui.toast(t.toastBoardUpdated(board.title), { timeoutMs: ATTENTION_TOAST_MS })
  return ok({ board_id: board.boardId, shown: true, section: 'dag', hint: 'A run is active, so the /dag pane stays on the DAG; tell the user to press b to see the board.' })
}

// The board changed last; a tie goes to the later one in the list.
function latestBoard(candidates: readonly Board[]): Board | undefined {
  return candidates.reduce<Board | undefined>((latest, board) => (latest === undefined || board.updatedAt >= latest.updatedAt ? board : latest), undefined)
}

// The board the Board section shows: the selected one, else the one changed last. The same choice as shownIndex in
// ui/board-model.ts, which that module does not export.
function shownBoard(): Board | undefined {
  return boards.find(board => board.boardId === selectedBoardId) ?? latestBoard(boards)
}

// The title the approval block points at: the board this session changed last.
function latestBoardTitle(): string | undefined {
  return latestBoard(boards)?.title
}

function newBoardId(now: number): string {
  return `board_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

// A block header pressed in the Board section puts the block's chip into the prompt box at the cursor, and the label is kept so
// the user prompt that carries it gets the block's content (prompt.submit).
async function citeBlock($: EngineInterface, blockId: string): Promise<void> {
  const board = shownBoard()
  const block = board?.blocks.find(candidate => candidate.id === blockId)
  // The press raced a change of the shown board, which redraws the pane without that header.
  if (!board || !block) return
  const label = chipLabel(block)
  const filled = await $.prompt.fill({ text: `${label} `, mode: 'insert', decorations: [{ start: 0, end: label.length, ...CHIP_PAINT }] })
  if (!filled.isFilled) {
    $.ui.toast(t.toastChipFailed(filled.refusal ?? 'unknown'), { timeoutMs: ATTENTION_TOAST_MS })
    return
  }
  // Deleted first so a chip pressed again counts as the newest.
  chips.delete(label)
  chips.set(label, { boardId: board.boardId, blockId })
  for (const oldest of chips.keys()) {
    if (chips.size <= MAX_CHIPS) break
    chips.delete(oldest)
  }
}

// The context a user prompt gets for the chips it carries, from the boards as they are now; a chip whose board or block is gone
// adds nothing.
function chipContexts(text: string): string[] {
  return citedChips(text, chips.keys()).flatMap(label => {
    const chip = chips.get(label)
    const board = boards.find(candidate => candidate.boardId === chip?.boardId)
    const block = board?.blocks.find(candidate => candidate.id === chip?.blockId)
    return board && block ? [chipContext(board, block)] : []
  })
}

// The board tool (engine/board-spec.ts): the main conversation draws boards that the pane's Board section shows.
async function handleBoardTool($: EngineInterface, input: ToolInput): Promise<ToolReply> {
  if (input.action === 'list') {
    return ok({ boards: boards.map(board => ({ board_id: board.boardId, title: board.title, blocks: board.blocks.length, updatedAt: board.updatedAt })) })
  }
  if (input.action === 'create') {
    const now = await $.clock.now()
    const boardId = newBoardId(now)
    const created = newBoard({ boardId, sessionId, title: typeof input.title === 'string' ? input.title : '', now })
    if (!created.ok) return err(created.error)
    await saveBoards($, [...boards, created.value])
    selectedBoardId = boardId
    $.ui.invalidate('ui.render')
    return ok({ board_id: boardId })
  }
  if (input.action !== 'edit' && input.action !== 'get' && input.action !== 'open' && input.action !== 'export') {
    return err({ code: 'invalid_request', message: `Unknown action "${String(input.action)}".` })
  }
  const board = boards.find(candidate => candidate.boardId === input.board_id)
  if (!board) return err({ code: 'unknown_board', message: `No board "${String(input.board_id)}" in this session; use the list action to see boards.` })
  if (input.action === 'get') return ok(boardForModel(board))
  if (input.action === 'open') return openBoard($, board)
  if (input.action === 'export') return ok({ board_id: board.boardId, markdown: boardToMarkdown(board) })
  const edits = parseEdits(input.edits)
  return edits.ok ? editBoard($, board, edits.value) : err(edits.error)
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
      await inheritBoards($, run.sessionId)
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

// /dag approve|reject and the pane's Approve and Reject buttons; callers check that a person asked. Approve clears the
// hold and ticks, so the roots start now, or when a busy main turn ends if the caller set deferStarts. Reject cancels
// the run, and its own message to the model stands in for the settle summary (announce marks the run notified).
async function decideApproval($: EngineInterface, decision: 'approve' | 'reject', runId: string, reason = ''): Promise<{ text: string }> {
  const run = runs.get(runId)
  if (!run) return { text: `Unknown run "${runId}".\n${USAGE}` }
  if (run.sessionId !== sessionId) return { text: `Run ${run.runId} belongs to session ${run.sessionId}; only that session can approve or reject it.` }
  if (!awaitingApproval(run)) return { text: `Run ${run.runId} is not awaiting approval.` }
  const now = await $.clock.now()
  if (decision === 'approve') {
    const approved = approveRun(run, now)
    await persist($, approved)
    const started = (await tick($, run.runId)) ?? approved
    // Plugin submissions run once idle; never await them in the queue.
    afterHook($, () => {
      submitRunNews($, started, `DAG run "${run.name}" (${run.runId}) was approved by the user and has started.`).then(result => {
        if ('drop' in result) throw new Error(result.drop)
      }).catch(error => {
        $.ui.log(`could not tell the session that ${run.runId} was approved: ${message(error)}`)
      })
    })
    return { text: runStatusText(started) }
  }
  const rejected = rejectRun(run, reason, now)
  await persist($, rejected)
  const detail = reason.trim().replace(/\.+$/, '')
  announce($, rejected, `DAG run "${run.name}" (${run.runId}) was rejected by the user${detail ? `: ${detail}` : ''}. Nothing ran.`, true)
  return { text: runStatusText(rejected) }
}

// The pane's buttons and keys: a press is the person's own act. Approve defers like a typed /dag approve while the main
// turn is busy.
async function paneApproval($: EngineInterface, decision: 'approve' | 'reject', runId: string): Promise<void> {
  const reply = await serialized(async () => {
    deferStarts = decision === 'approve' && mainTurnBusy
    try {
      return await decideApproval($, decision, runId)
    } finally {
      deferStarts = false
    }
  })
  $.ui.log(reply.text)
  $.ui.invalidate('ui.render')
}

// statusText with the hold spelled out: a waiting run otherwise reads as running with nothing started. It ends with the
// preview of what approving starts, the same text /dag preview gives for the definition.
function runStatusText(run: Run): string {
  const text = statusText(run, sessionId)
  if (!awaitingApproval(run)) return text
  const [head = '', ...rest] = text.split('\n')
  const preview = previewText(previewDefinition(run.definition, { maxConcurrent }), undefined)
  return [head, `  awaiting approval: /dag approve ${run.runId} starts it, /dag reject ${run.runId} [reason] cancels it`, ...rest, preview].join('\n')
}

// listText's lines, newest first, with waiting runs marked.
function runListText(): string {
  const all = [...runs.values()]
  if (all.length === 0) return listText(all, sessionId)
  return all.sort((a, b) => b.createdAt - a.createdAt).map(run => `${runLine(run, sessionId)}${awaitingApproval(run) ? '  [awaiting approval]' : ''}`).join('\n')
}

async function commandFilePath($: EngineInterface, given: string): Promise<string> {
  return given.startsWith('/') ? given : `${await $.session.cwd()}/${given}`
}

// `fromComposer` is whether the person typed the command in the prompt, the only origin that may approve a held run.
async function runCommand($: EngineInterface, args: string, fromComposer = false): Promise<{ text?: string }> {
  const [verb = 'open', ...rest] = splitArgs(args)
  if (verb === 'learn') return { text: await startLearning($, true, fromComposer) }
  if (verb === 'learning') {
    const action = rest[0] ?? 'status'
    if (action === 'on' || action === 'off') {
      if (!fromComposer) return { text: USER_ONLY }
      learningEnabled = action === 'on'
      if (learningEnabled && !learningRoot) await initializeLearning($)
      return { text: `Session learning: ${learningEnabled ? 'on' : 'off'}` }
    }
    if (!learningRoot) return { text: 'Session learning is off or unavailable.' }
    if (action === 'prune') {
      if (!fromComposer) return { text: USER_ONLY }
      const now = await $.clock.now()
      await updateLearningLibrary($, library => archiveUnusedSkills(library, { projectRoot, minOpportunities: learningMinOpportunities, maxSkills: learningMaxSkills, now }))
      await pruneLearningData($)
    } else if (action !== 'status') return { text: 'Usage: /dag learning [status|on|off|prune]' }
    learningLibrary = await readLearningLibrary($)
    // The model can run status too, so it lists only skills this project may use and leaves bodies in their SKILL.md.
    const skills = learningLibrary.skills
      .filter(skill => skill.scope === 'global' || skill.projectRoot === projectRoot)
      .map(({ body, ...skill }) => skill)
    return { text: JSON.stringify({ enabled: learningEnabled, running: learningSession.batch?.agentId, pendingEvents: learningSession.events.filter(event => Number(event.id.split(':').at(-1)) > learningSession.learnedThrough).length, root: learningRoot, usage: learningLibrary.usage, maxDailyRuns: learningDailyLimit, maxInputChars: learningMaxInputChars, retentionDays: learningRetentionDays, skills }, null, 2) }
  }
  if (verb === 'inspect') {
    const choice = rest[0]
    if (choice !== 'dag' && choice !== 'decisions' && choice !== 'context' && choice !== 'sessions' && choice !== 'board') return { text: USAGE }
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
  if (verb === 'list') return { text: runListText() }
  if (verb === 'view') {
    if (!rest[0]) return { text: `DAG view: ${view.graphView ?? 'auto'}` }
    const choice = viewChoice(rest[0])
    if (!choice) return { text: `Unknown view "${rest[0]}". Use auto, graph, lanes or timeline.` }
    await setView($, choice)
    return { text: `DAG view: ${choice}` }
  }
  if (verb === 'enforce') {
    const level = rest[0] as Enforcement | undefined
    if (level && !ENFORCEMENTS.includes(level)) return { text: `Unknown enforcement level "${level}". Use strict, auto, guide or off.` }
    if (level) enforcement = level
    return { text: `DAG enforcement: ${enforcement}${enforcement === 'auto' ? ` (this turn: ${turnMode})` : ''}` }
  }
  if (verb === 'approval') {
    const choice = rest[0] as StartApproval | undefined
    if (choice && !START_APPROVALS.includes(choice)) return { text: `Unknown start approval "${choice}". Use off or always.` }
    if (choice) approvalOverride = choice
    return { text: `DAG start approval: ${effectiveApproval()} (${approvalOverride === undefined ? 'setting' : 'session override'})` }
  }
  if (verb === 'approve' || verb === 'reject') {
    if (!rest[0]) return { text: USAGE }
    return decideApproval($, verb, rest[0], rest.slice(1).join(' '))
  }
  if (verb === 'preview') {
    const given = rest.join(' ')
    if (!given) return { text: USAGE }
    const read = await readDefinitionFile($, await commandFilePath($, given))
    if (!read.ok) return { text: read.error.message }
    const previewed = await previewRequest($, read.value)
    if (!previewed.ok) return { text: `DAG not previewed:\n${JSON.stringify({ error: previewed.error }, null, 2)}` }
    return { text: previewText(previewed.value.preview, previewed.value.existing?.runId) }
  }
  if (verb === 'run') {
    const given = rest.join(' ')
    if (!given) return { text: USAGE }
    const read = await readDefinitionFile($, await commandFilePath($, given))
    if (!read.ok) return { text: read.error.message }
    const reply = await startDefinition($, read.value, 'user', fromComposer)
    if (reply.isError) return { text: `DAG not started:\n${reply.result}` }
    const started = JSON.parse(reply.result) as { run_id: string; reused: boolean; warnings?: string[] }
    const run = runs.get(started.run_id)
    await openPane($, true)
    // /dag run is not gated by the planning skill, so only definition lint reaches the person.
    const warnings = (started.warnings ?? []).filter(warning => !warning.includes(PLANNING_SKILL))
    const text = run ? runStatusText(run) : reply.result
    return { text: warnings.length ? `${text}\nWarnings:\n${warnings.map(warning => `- ${warning}`).join('\n')}` : text }
  }
  if (verb !== 'status' && verb !== 'cancel' && verb !== 'retry') return { text: USAGE }
  const run = rest[0] ? runs.get(rest[0]) : undefined
  if (!run) return { text: `Unknown run "${rest[0] ?? ''}".\n${USAGE}` }
  if (verb === 'status') return { text: runStatusText(run) }
  const reply = await handleTool($, {
    action: verb,
    run_id: run.runId,
    reason: 'cancelled from /dag',
    ...(verb === 'retry' && rest.length > 1 ? { node_ids: rest.slice(1) } : {}),
  }, fromComposer ? 'user' : 'model')
  if (reply.isError) return { text: reply.result }
  return { text: runStatusText(runs.get(run.runId) ?? run) }
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
  else if (action === 'board:prev' || action === 'board:next') {
    selectedBoardId = adjacentBoardId(boards, selectedBoardId, action === 'board:next' ? 1 : -1)
    inspectorPage = 0
  } else if (action.startsWith('board:goto:')) {
    // A board_ref button names a board of this session; a stale or forged id selects nothing.
    const target = action.slice('board:goto:'.length)
    if (boards.some(candidate => candidate.boardId === target)) {
      selectedBoardId = target
      inspectorPage = 0
    }
  } else if (action === 'decision:back') selectedDecisionId = undefined
  else if (action.startsWith('decision:')) selectedDecisionId = action.slice('decision:'.length)
  else if (action.startsWith('chip:')) await citeBlock($, action.slice('chip:'.length))
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
  else if (key === 'a' || key === 'r') {
    // The Approve and Reject hotkeys, posted by the graph client while it holds the keyboard.
    const run = shownRun()
    if (run && run.sessionId === sessionId && awaitingApproval(run)) await paneApproval($, key === 'a' ? 'approve' : 'reject', run.runId)
    return
  } else if (key === ' ' || key === 'space' || key === 'return') {
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
    { id: 'board' as const, label: language === 'ko' ? '보드' : 'Board', key: 'b' },
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
    const inspection = inspectorView === 'board'
      ? buildBoardView({ boards, selectedBoardId, columns: inspectorColumns, language, page: inspectorPage })
      : buildInspector({
        view: inspectorView, columns: inspectorColumns, language,
        decisions: decisionRecords, context: workflowContext, contextPath: contextPath(),
        runs: [...runs.values()], sessions: peerSessions, projectRoot, sessionId, now,
        ...(shownRun() ? { selectedRunId: shownRun()?.runId } : {}),
        ...(selectedDecisionId ? { selectedDecisionId } : {}),
        page: inspectorPage,
        waiting: waitingTools(),
      })
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
  // A run of this session held for approval: say so, show what approving starts, and offer the two answers. Hotkeys a and r are free in this pane.
  const approval = run.sessionId === sessionId && awaitingApproval(run)
    ? [
        line([{ text: t.approvalWaiting, color: ACCENT, bold: true }]),
        ...approvalPreview(previewDefinition(run.definition, { maxConcurrent }), e.props.bodyColumns, t, latestBoardTitle()).map(line),
        Box({
          flexDirection: 'row',
          columnGap: 2,
          children: [
            Button({ key: 'approve', label: t.approve, hotkey: 'a', plain: true, onPress: () => paneApproval($, 'approve', run.runId) }),
            Button({ key: 'reject', label: t.reject, hotkey: 'r', plain: true, onPress: () => paneApproval($, 'reject', run.runId) }),
          ],
        }),
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
      ...approval,
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
  const jevLimitOption = options.jev_max_calls
  if (typeof jevLimitOption === 'number' && Number.isInteger(jevLimitOption) && jevLimitOption >= 1 && jevLimitOption <= 1000) jevMaxCalls = jevLimitOption
  jevModelFallback = options.jev_model_fallback !== false
  if (typeof options.jev_confidence === 'number' && Number.isFinite(options.jev_confidence) && options.jev_confidence >= 0 && options.jev_confidence <= 1) jevConfidence = options.jev_confidence
  const modelRouting = options.jev_model_routing_confidence
  if (typeof modelRouting === 'number' && Number.isFinite(modelRouting) && modelRouting >= 0 && modelRouting <= 1) jevModelRoutingConfidence = modelRouting
  t = stringsFor(options.language)
  if (typeof options.max_concurrent === 'number' && options.max_concurrent >= 1) maxConcurrent = Math.floor(options.max_concurrent)
  if (typeof options.retention_days === 'number') retentionDays = options.retention_days
  if (options.node_messages === 'full') nodeMessages = 'full'
  if (ENFORCEMENTS.includes(options.enforcement as Enforcement)) enforcement = options.enforcement as Enforcement
  if (START_APPROVALS.includes(options.start_approval as StartApproval)) startApproval = options.start_approval as StartApproval
  if (Array.isArray(options.main_allowed_tools)) extraAllowed = new Set(options.main_allowed_tools)
  antiSlopScan = options.anti_slop_scan !== false
  if (Array.isArray(options.anti_slop_skip)) antiSlopSkip = new Set(options.anti_slop_skip)
  secureScan = options.secure_scan !== false
  trajectoryLog = options.trajectory_log === true
  const trajectoryDays = options.trajectory_retention_days
  if (typeof trajectoryDays === 'number' && Number.isInteger(trajectoryDays) && trajectoryDays >= 0 && trajectoryDays <= 3650) trajectoryRetentionDays = trajectoryDays
  const trajectoryMb = options.trajectory_max_mb
  if (typeof trajectoryMb === 'number' && Number.isInteger(trajectoryMb) && trajectoryMb >= 0 && trajectoryMb <= 102_400) trajectoryMaxMb = trajectoryMb
  reviewLedger = options.review_ledger !== false
  jevPermissionScope = options.jev_permission_scope === 'all' ? 'all' : 'dag'
  learningEnabled = options.session_learning !== false
  for (const [key, set] of [
    ['learning_interval', (value: number) => { learningInterval = value }],
    ['learning_min_opportunities', (value: number) => { learningMinOpportunities = value }],
    ['learning_max_skills', (value: number) => { learningMaxSkills = value }],
    ['learning_max_daily_runs', (value: number) => { learningDailyLimit = value }],
  ] as const) {
    const value = options[key]
    if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 1000) set(value)
  }
  const maxInput = options.learning_max_input_chars
  if (typeof maxInput === 'number' && Number.isInteger(maxInput) && maxInput >= 16_000 && maxInput <= 120_000) learningMaxInputChars = maxInput
  const learningDays = options.learning_retention_days
  if (typeof learningDays === 'number' && Number.isInteger(learningDays) && learningDays >= 0 && learningDays <= 3650) learningRetentionDays = learningDays

  on('session.start', async ($, e, next) => {
    for (const pending of pendingJevCalls.values()) pending.controller.abort()
    pendingJevCalls.clear()
    jevCallsUsed = 0
    jevLimitNoted = false
    repeatedChecks.clear()
    repeatCalls.clear()
    repeatEpoch++
    repeatSuspended = false
    interactive = e.isInteractive
    paneSurface = e.surface === null || e.surface === 'terminal' || e.surface === 'desktop'
    sessionClosed = false
    keepAliveQueued = false
    repositoryAllows = undefined
    semgrepFound = undefined
    guideRowsRead = undefined
    changeScans.clear()
    // A new process: the conversation it serves (a resume) has not been told this process's state yet.
    forgetDelivered()
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
    await $.tool.register({ name: 'board', description: BOARD_TOOL_DESCRIPTION, inputSchema: BOARD_INPUT_SCHEMA })
    try {
      await loadRuns($)
    } catch (error) {
      $.ui.log(`could not load DAG checkpoints: ${message(error)}`)
    }
    // After loadRuns, which sets projectRoot.
    await loadBoards($)
    try {
      await pruneArtifacts($)
    } catch (error) {
      $.ui.log(`could not prune expired DAG artifacts: ${message(error)}`)
    }
    try {
      await pruneTrajectories($)
    } catch (error) {
      $.ui.log(`could not prune old trajectories: ${message(error)}`)
    }
    try {
      await loadMetadata($)
    } catch (error) {
      $.ui.log(`could not restore workflow context: ${message(error)}`)
    }
    await restorePlanningFromContext($)
    agentUsage.clear()
    mainRows = undefined
    if (trajectoryLog) {
      // A resumed conversation's earlier rows were logged by the process that saw them.
      try {
        const rows = await $.session.messages()
        if (Array.isArray(rows)) mainRows = rowsAfter(rows, undefined).mark
      } catch (error) {
        debug($, `could not mark where the main conversation's trajectory starts: ${message(error)}`)
      }
    }
    try {
      await initializeLearning($)
    } catch (error) {
      learningRoot = ''
      $.ui.log(`could not initialize session learning: ${message(error)}`)
    }
    try {
      await refreshSessions($)
      await serialized(async () => {
        await recoverRuns($)
        for (const run of runs.values()) {
          if (run.sessionId === sessionId && isSettled(run) && !run.settledNotified) announce($, run)
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
      description: 'Manage DAG workflows and enforcement, or learn and manage reusable skills from the whole session',
      argumentHint: '[list | run <file> | preview <file> | status <run> | cancel <run> | retry <run> [node...] | approve <run> | reject <run> [reason] | approval [off|always] | enforce [strict|auto|guide|off] | learn | learning [status|on|off|prune]]',
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
    if (previous !== sessionId) {
      jevCallsUsed = 0
      jevLimitNoted = false
    }
    if (e.source === 'clear' || previous !== sessionId) {
      for (const pending of pendingJevCalls.values()) pending.controller.abort()
      pendingJevCalls.clear()
      repeatedChecks.clear()
      repeatEpoch++
      repeatSuspended = false
    }
    // A cleared or switched conversation holds no block yet; prompt.context records one again if it re-renders.
    if (e.source === 'clear' || previous !== sessionId) forgetDelivered()
    if (previous && previous !== sessionId) {
      if (learningRoot) {
        try {
          await saveLearningSession($, previous)
          learningSession = emptyLearningSession()
          learningTurnRequested = false
          await initializeLearning($)
        } catch (error) {
          learningRoot = ''
          $.ui.log(`could not switch session learning: ${message(error)}`)
        }
      }
      await serialized(async () => {
        for (const run of [...runs.values()]) {
          if (run.sessionId === previous) await persist($, { ...run, sessionId, ...(run.handoff ? { handoff: { ...run.handoff, from: sessionId } } : {}) })
        }
      })
      await loadMetadata($)
      // A board belongs to the conversation that drew it, and its file is checked against that session id.
      await serialized(() => loadBoards($))
      if (e.source !== 'clear') await restorePlanningFromContext($)
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
    for (const pending of pendingJevCalls.values()) pending.controller.abort()
    pendingJevCalls.clear()
    repeatedChecks.clear()
    repeatEpoch++
    sessionClosed = true
    try {
      if (learningRoot) await saveLearningSession($)
    } catch (error) {
      $.ui.log(`could not save session learning at exit: ${message(error)}`)
    }
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
    const block = restoration()
    const result = await next({ ...e, blocks: [...e.blocks.filter(entry => entry.name !== 'dag-workflow'), { name: 'dag-workflow', text: block.text }] })
    // Received only if it is still there: a hook beneath may drop or rewrite the conversation's blocks.
    if (result.blocks.some(entry => entry.name === 'dag-workflow' && entry.text === block.text)) block.received()
    return result
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
    const block = restoration()
    block.received()
    return {
      ...compacted,
      messages: [...compacted.messages, { role: 'user' as const, text: `[dag-workflow context restoration]\n${block.text}`, toolUses: [] }],
    }
  })

  on('turn.step', async function* ($, e, next) {
    const agentId = e.agentId
    if (!agentId) return yield* next(e)
    seenAgent($, agentId, 'turn.step')
    clearWaiting($, agentId)
    // The worker's next turn has started: it is no longer waiting on its background work, so the wait's timer stops.
    endBackgroundWait(agentId)
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
    if (learningRoot) {
      const id = e.skill.split(':').at(-1)
      const managed = learningLibrary.skills.find(skill => skill.id === id)
      if (managed && !eligibleSkills(learningLibrary, projectRoot).some(skill => skill.id === id)) {
        return { text: 'This learned skill is archived or belongs to another project; do not apply it here.' }
      }
    }
    // Skipped while a node's own planning-skill call is in flight: that load is the node's, not the conversation's.
    if (isPlanningSkill(e.skill) && nodePlanningCalls === 0) await setPlanningLoaded($, true)
    return next(e)
  })

  // A fill's decorations last only until the draft's next change, so every edit paints the remembered chips again. A chip
  // the person typed inside no longer matches and stays plain, which is also how prompt.submit will read it.
  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    if (chips.size === 0) return box
    const painted = chipSpans(box.text, chips.keys()).map(span => ({ ...span, ...CHIP_PAINT }))
    return painted.length === 0 ? box : { ...box, decorations: [...(box.decorations ?? []), ...painted] }
  })

  on('prompt.submit', async ($, e, next) => {
    const userOrigin = e.origin.kind === 'composer' || e.origin.kind === 'bridge' || e.origin.kind === 'sdk'
    if (next.origin.plugin === 'engine' && userOrigin && e.text.trim()) {
      const recent = workflowContext.requests.slice(-3).map(entry => entry.text)
      userRequest = e.text
      workflowContext = recordRequest(workflowContext, { text: e.text, at: await $.clock.now() })
      await persistContext($)
      // Under auto each user prompt is decided anew; a plugin's prompt (settle, keep-alive, progress) keeps the mode and
      // the surface. The strict rules hold while Jev is asked; every answer, none included, then sets the mode, and only
      // a decision that throws leaves the gate closed. The surface starts as chat and is set by the same decision.
      if (enforcement === 'auto') {
        turnMode = 'dag'
        turnSurface = 'chat'
        const decision = await decideTurn($, e.text, recent, next.signal)
        turnMode = decision.mode
        turnSurface = decision.surface
      }
    }
    // The protocol rides on every prompt. The block (up to 8,000 characters) goes only on a user prompt whose run and
    // note state the model has not received yet; a plugin's prompt never gets it, and the plugin's own carry the news.
    // It counts as received only once the prompt entered: a hook beneath that drops it delivers nothing.
    const context = [...(e.context ?? []), ...(enforcement === 'off' ? [] : [protocolFor(enforcement, interactive, turnMode, turnSurface)])]
    if (learningEnabled && learningRoot && userOrigin && next.origin.plugin === 'engine') {
      try {
        const now = await $.clock.now()
        await updateLearningLibrary($, library => archiveUnusedSkills(library, { projectRoot, minOpportunities: learningMinOpportunities, maxSkills: learningMaxSkills, now }))
        const catalog = learningCatalog(learningLibrary, projectRoot, learnedSkillsDir)
        if (eligibleSkills(learningLibrary, projectRoot).length) context.push(catalog)
      } catch (error) {
        $.ui.log(`could not load learned skills: ${message(error)}`)
      }
    }
    if (userOrigin) {
      context.push(...chipContexts(e.text))
      chips.clear()
    }
    const block = userOrigin && contextUnseen(delivered, contextSlices(workflowContext, [...runs.values()])) ? restoration() : undefined
    if (block) context.push(block.text)
    const result = await next({ ...e, context })
    if (block && result.drop === undefined) block.received()
    if (result.drop === undefined && userOrigin && next.origin.plugin === 'engine' && e.text.trim()) {
      learningTurnRequested = true
      await collectLearning($, 'user', e.text)
      if (learningEnabled && learningRoot) {
        try {
          const now = await $.clock.now()
          await updateLearningLibrary($, library => recordSkillOpportunity(library, projectRoot, now))
          await saveLearningSession($)
        } catch (error) {
          $.ui.log(`could not record learned-skill exposure: ${message(error)}`)
        }
      }
    }
    return result
  })

  on('agent.spawn', async ($, e, next) => {
    if (e.parentAgentId && learningAgents.has(e.parentAgentId)) return { deny: 'Session learning returns proposals without spawning agents.' }
    if (learningSpawning && e.name === learningSpawnName) {
      const result = await next({ ...e, background: true })
      if (result.agentId) learningAgents.add(result.agentId)
      return result
    }
    if (!learningEnabled || !learningRoot || eligibleSkills(learningLibrary, projectRoot).length === 0) return next(e)
    return next({ ...e, prompt: `${e.prompt}\n\n${learningCatalog(learningLibrary, projectRoot, learnedSkillsDir)}` })
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
    // Only the model's own main-conversation call went through the main-loop gate: a subagent's call, a plugin's call
    // (origin) and a $.tool.check query (no tool_use_id) did not, and a main_allowed_tools Bash skips the judge.
    if (e.tool === 'Bash' && !e.agentId && e.tool_use_id && e.isReadOnly !== true && next.origin.plugin === 'engine'
      && gatesMainLoop(enforcement, turnMode) && !extraAllowed.has('Bash')) await recordHostReadOnlyGap($, e.input, decided.decision)
    if (decided.decision !== 'ask') return decided
    const call = e.tool_use_id ? openCalls.get(e.tool_use_id) : undefined
    // The host sets agentId on a real call in a subagent loop; openCalls only knows calls whose tool.call reached this plugin.
    const worker = ownNodeOfAgent(e.agentId ?? call?.agentId)
    // The answer stays with the person: mark the node worker that will wait for it.
    const asked = async (why: string) => {
      if (call) await markWaiting($, call.agentId, e.tool, e.tool_use_id)
      if (!interactive && worker && noteAsk(worker.run.runId, worker.nodeId, worker.attempt, e.tool)) {
        $.ui.log(`${worker.run.runId}/${worker.nodeId}: ${headlessAskNote(e.tool, why)}`)
      }
      return decided
    }
    if (PERSON_TOOLS.has(e.tool)) return asked('Jev not asked: the host keeps the dialog of a tool that asks the person')
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
    if (agentId && learningAgents.has(agentId)) return { deny: 'Return learning proposal JSON using the supplied evidence. Learning agents cannot call tools.' }
    if (learningRoot && e.tool === 'Skill') {
      const id = e.skill.split(':').at(-1)
      const managed = learningLibrary.skills.find(skill => skill.id === id)
      if (managed && !eligibleSkills(learningLibrary, projectRoot).some(skill => skill.id === id)) {
        return { deny: 'This learned skill is archived or belongs to another project.' }
      }
    }
    const subject = agentId ?? sessionId
    const observe = next.origin.plugin === 'engine'
    const checkCommand = observe && e.tool === 'Bash' && !e.run_in_background && verificationCommand(e.command)
      ? e.command.trim().replace(/\s+/g, ' ') : undefined
    const readOnlyTool = ['Read', 'Glob', 'Grep'].includes(e.tool)
    const overlaps = repeatCalls.size > 0
    if (observe && !readOnlyTool && checkCommand === undefined) {
      repeatedChecks.clear()
      repeatEpoch++
      if (startsBackgroundWork(e.tool, e as Readonly<Record<string, unknown>>)) repeatSuspended = true
    }
    if (observe && !readOnlyTool) {
      if (overlaps) {
        repeatedChecks.clear()
        repeatEpoch++
      }
      repeatCalls.add(e.tool_use_id)
    }
    const epoch = overlaps ? -1 : repeatEpoch
    const track = async <T extends ToolCallResult>(reply: T): Promise<T> => {
      let repeatWarning = false
      if (observe && !readOnlyTool && checkCommand === undefined) {
        repeatedChecks.clear()
        repeatEpoch++
      }
      if (reply.deny === undefined && next.origin.plugin === 'engine') {
        if (checkCommand !== undefined && epoch === repeatEpoch && !repeatSuspended) {
          const failure = failedCheckFingerprint(reply)
          if (failure) {
            const observed = repeatCheck(repeatedChecks.get(subject), hash(`${checkCommand}\0${failure}`))
            if (!repeatedChecks.has(subject) && repeatedChecks.size >= 64) repeatedChecks.clear()
            repeatedChecks.set(subject, observed.record)
            repeatWarning = observed.warn
          } else {
            repeatedChecks.clear()
            repeatEpoch++
            if (reply.result !== null && typeof reply.result === 'object' && 'backgroundTaskId' in reply.result) repeatSuspended = true
          }
        }
        await collectLearning($, 'tool', JSON.stringify({ input: boundInput(e), outcome: boundInput(reply) }), agentId)
        try {
          await observeLearnedSkill($, e.tool, e as Readonly<Record<string, unknown>>)
        } catch (error) {
          $.ui.log(`could not record learned-skill use: ${message(error)}`)
        }
      }
      return repeatWarning && reply.deny === undefined ? { ...reply, context: [...(reply.context ?? []), REPEAT_CHECK_NOTE] } : reply
    }
    const call = async () => track(await next(e))
    if (agentId) seenAgent($, agentId, 'tool.call')
    const owner = agentId ? nodeOfAgent(agentId) : undefined
    const def = owner?.run.definition.nodes.find(node => node.id === owner.nodeId)
    const node = owner?.run.nodes.find(current => current.id === owner.nodeId)
    const context: JevContext = {
      request: userRequest,
      // A worker of a run in a worktree works there; from the session's own folder its files would all sit under .claude/.
      projectRoot: owner ? rootOf(owner.run) : projectRoot,
      ...(owner ? { goal: owner.run.definition.goal ?? owner.run.name } : {}),
      ...(def ? { task: node?.promptOverride ?? def.prompt } : {}),
    }
    toolContexts.set(e.tool_use_id, context)
    if (agentId && owner) openCalls.set(e.tool_use_id, { agentId, tool: e.tool })
    try {
      if (!agentId) {
        if (e.tool === 'Skill' && isPlanningSkill((e as { skill?: unknown }).skill)) await setPlanningLoaded($, true)
        // A direct turn is judged again on the person's answer to a popup, before the gate below is looked at.
        if (e.tool === 'AskUserQuestion' && enforcement === 'auto' && turnMode === 'direct' && next.origin.plugin === 'engine') {
          return await reconsiderAfterAnswer($, await track(await next(e)), next.signal)
        }
        if (!gatesMainLoop(enforcement, turnMode) || next.origin.plugin !== 'engine') return await call()
        const verdict = mainLoopVerdict(e.tool, e as Readonly<Record<string, unknown>>, extraAllowed)
        if (verdict.allowed) return await call()
        $.ui.log(`refused ${e.tool} in the main conversation; work runs in DAG nodes`)
        return { deny: denyMessage(e.tool, verdict.reason) }
      }
      const target = (e as { file_path?: unknown }).file_path
      if (owner && e.tool === 'Write' && typeof target === 'string' && isBlockedReportPath(target)) {
        return { deny: `Claude Code refuses subagent writes to REPORT*, SUMMARY*, FINDINGS* and ANALYSIS* Markdown files ("Subagents should return findings as text, not write report files"). Put the full file text in ## Output (or write ${notesNameFor(owner.nodeId)}); the main conversation writes the requested file after the run settles. Bash, mv or a rename is no way around it.` }
      }
      activity.set(agentId, toolStarted(e.tool, Date.now()))
      // A node loads its skills with the Skill tool (node-prompt.ts), and skill.prompt carries no agent id, so it cannot
      // tell that load from the conversation's own and would open the main gate. Count the node's planning-skill call
      // while it is in flight and let skill.prompt skip meanwhile. Assumes the host expands the skill's prompt inside
      // the Skill tool call; if skill.prompt fires outside it, the gate opens as it did before. A typed /planning in the
      // main conversation has no such call and still opens the gate; a main-loop Skill call is covered by the branch above.
      const nodeSkillLoad = e.tool === 'Skill' && isPlanningSkill((e as { skill?: unknown }).skill)
      if (nodeSkillLoad) nodePlanningCalls += 1
      // A call means the worker's turn is under way, so a wait for its background work is over.
      endBackgroundWait(agentId)
      try {
        const reply = await call()
        // Recorded once the call is answered: a refused call started nothing.
        if (owner && reply.deny === undefined && startsBackgroundWork(e.tool, e as Readonly<Record<string, unknown>>)) backgroundAgents.add(agentId)
        return reply
      } finally {
        if (nodeSkillLoad) nodePlanningCalls -= 1
        if (activity.get(agentId)?.phase === 'tool') activity.set(agentId, stepStarted(Date.now()))
      }
    } finally {
      repeatCalls.delete(e.tool_use_id)
      toolContexts.delete(e.tool_use_id)
      openCalls.delete(e.tool_use_id)
      if (agentId) clearWaiting($, agentId, { toolUseId: e.tool_use_id, tool: e.tool })
    }
  }).catch(async ($, e, next) => {
    // A failed hook is skipped and the call runs, so a gated turn (strict, or a DAG turn under auto) fails closed here with
    // pure checks only (1 s budget).
    if (e.agentId || !gatesMainLoop(enforcement, turnMode) || next.origin.plugin !== 'engine') return next(e)
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
    if (e.agentId) repeatedChecks.delete(e.agentId)
    if (e.agentId && learningAgents.has(e.agentId)) {
      const agentId = e.agentId
      try {
        await serialized(() => finishLearning($, { agentId, reason: e.reason, isAborted: e.isAborted, answer: e.answer }))
      } catch (error) {
        $.ui.log(`session learning did not save proposals: ${message(error)}`)
      }
      // Let the host finish the agent/query lifecycle; only hide the learning report from the conversation.
      const result = await next(e)
      return { ...result, text: '' }
    }
    if (learningEnabled && learningRoot) {
      try {
        await serialized(async () => {
          await collectLearning($, 'assistant', `${e.reason}: ${e.answer ?? ''}`, e.agentId)
          await saveLearningSession($)
        })
      } catch (error) {
        $.ui.log(`could not persist session learning; continuing turn completion: ${message(error)}`)
      }
    }
    if (e.agentId) seenAgent($, e.agentId, 'turn.complete')
    if (e.agentId) activity.delete(e.agentId)
    if (e.agentId) clearWaiting($, e.agentId)
    if (trajectoryLog && e.agentId && agentRuns.has(e.agentId) && e.usage) agentUsage.set(e.agentId, addUsage(agentUsage.get(e.agentId), e.usage) ?? e.usage)
    if (trajectoryLog && !e.agentId) await recordMainTurn($, e)
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
    if (learningEnabled && learningRoot && !sessionClosed) {
      try {
        const flush = !e.agentId && learningTurnRequested && !e.isAborted && e.reason === 'answer'
        if (flush || learningSession.toolsSinceLearn >= learningInterval) {
          const alreadyRunning = learningSession.batch !== undefined
          await serialized(() => startLearning($, flush))
          if (flush && !alreadyRunning) learningTurnRequested = false
        }
      } catch (error) {
        $.ui.log(`could not start session learning: ${message(error)}`)
      }
    }
    return next(e)
  })

  on('tool.call', { tool: 'mcp__dag-workflow__dag' }, async ($, e) => {
    const opensPlan = e.action === 'start' || e.action === 'amend'
    if (!e.agentId && opensPlan && gatesPlanning(enforcement) && !planningLoaded) return err(planningRequired())
    return serialized(() => handleTool($, e))
  }).catch(async ($, e, next) => {
    return err({ code: `hook_${next.error.kind}`, message: `The dag tool failed: ${next.error.message}` })
  })

  on('tool.call', { tool: 'mcp__dag-workflow__board' }, async ($, e) => {
    return serialized(() => handleBoardTool($, e))
  }).catch(async ($, e, next) => {
    return err({ code: `hook_${next.error.kind}`, message: `The board tool failed: ${next.error.message}` })
  })

  on('command.run', { command: 'dag-ping' }, async () => {
    return { text: 'dag-workflow loaded' }
  })

  on('command.run', { command: 'dag' }, async ($, e) => {
    const [verb, setting] = splitArgs(e.args ?? '')
    // Approving is the person's call: the model could otherwise approve its own run, or switch the gate off.
    const userOnly = verb === 'handoff' || verb === 'accept' || verb === 'note' || verb === 'approve' || verb === 'reject' || (verb === 'approval' && setting !== undefined)
    if (userOnly && e.origin.kind !== 'composer') return { text: USER_ONLY }
    const fromComposer = e.origin.kind === 'composer'
    const starts = verb === 'run' || verb === 'retry' || verb === 'approve'
    if (!mainTurnBusy || !starts) {
      const out = await serialized(() => runCommand($, e.args ?? '', fromComposer))
      if (starts) openHeldTurn($)
      return out
    }
    return serialized(async () => {
      const before = pendingStarts.length
      deferStarts = true
      try {
        const out = await runCommand($, e.args ?? '', fromComposer)
        return pendingStarts.length > before ? { text: `${out.text ?? ''}\n${t.runDeferred}`.trim() } : out
      } finally {
        deferStarts = false
      }
    })
  })

  on('turn.start', async ($, e, next) => {
    // turn.start also fires for subagent turns, which carry agentId; only the main loop's turn is the main turn.
    if (!e.agentId) {
      mainTurnBusy = true
      // The turn a keep-alive prompt asked for has begun; the next completion while that turn's end is held may
      // queue another.
      keepAliveQueued = false
    }
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

  // The deterministic half of the anti-slop skill (engine/slop-scan.ts). Once an Edit or Write is answered, in the main
  // conversation or a node worker, the lines it added are scanned and the hits reach the model as context after the
  // tool's result. No model call. The whole file is compared before and after, not the Edit's strings alone, because a
  // rule may need the lines around the edit (a SAFETY: comment above it, the next catch). The tool has already run by
  // the time the scan does, so a scan that throws returns the tool's answer untouched.
  on('tool.call', { tool: /^(?:Edit|Write)$/ }, async ($, e, next) => {
    if (e.tool !== 'Edit' && e.tool !== 'Write') return next(e)
    if (RULE_FILES.some(name => e.file_path === `${projectRoot}/${name}`)) repositoryAllows = undefined
    if (!antiSlopScan || familiesOf(e.file_path).length === 0) return next(e)
    const request = userRequest
    const before = await readOrEmpty($, e.file_path)
    const reply = await next(e)
    if (reply.deny !== undefined || reply.isError) return reply
    try {
      const after = e.tool === 'Write' ? e.content : await readOrEmpty($, e.file_path)
      const hits = scanSlop(e.file_path, before, after, await slopSkips($), request)
      if (hits.length === 0) return reply
      const shown = projectRoot && e.file_path.startsWith(`${projectRoot}/`) ? e.file_path.slice(projectRoot.length + 1) : e.file_path
      return { ...reply, context: [...(reply.context ?? []), slopNote(shown, hits)] }
    } catch (error) {
      debug($, `anti-slop scan skipped ${e.file_path}: ${message(error)}`)
      return reply
    }
  })

  // A Bash call that stops processes by name or pattern (engine/kill-guard.ts) is refused before it runs while this session's
  // run has not settled, whoever makes it: a node worker, a subagent a worker or the main conversation started, or the main
  // conversation itself. Then other nodes' servers and test runs are live on this machine. Node workers exist only during a
  // run, and outside one the main conversation answers to the person, who sees the command.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.tool !== 'Bash' || !ownsUnsettledRun()) return next(e)
    const form = killByName(e.command)
    return form === undefined ? next(e) : { deny: killRefusal(form) }
  })

  // The secure-coding Semgrep rules (engine/semgrep.ts) on what an Edit or Write adds, in the main conversation or a node
  // worker. Unlike the anti-slop scan this one runs before the tool: a block rule (a hard-coded secret) refuses the call
  // before the value reaches the file, and the other hits come back as context once the call is answered. A scan that
  // cannot run lets the call through.
  on('tool.call', { tool: /^(?:Edit|Write)$/ }, async ($, e, next) => {
    if ((e.tool !== 'Edit' && e.tool !== 'Write') || !secureScan || !semgrepTarget(e.file_path)) return next(e)
    let hits: SemgrepHit[] = []
    let root = projectRoot
    try {
      // The folder the edit is in: the one it works in (a worktree), else the session's own, so a file of either is scanned.
      const working = await editRoot($, e.agentId)
      root = [working, projectRoot].find(candidate => candidate && e.file_path.startsWith(`${candidate}/`) && !e.file_path.startsWith(`${candidate}/.claude/`)) ?? ''
      const before = await readOrEmpty($, e.file_path)
      const after = e.tool === 'Write' ? e.content : applyEdit(before, e.old_string, e.new_string, e.replace_all === true)
      if (after !== undefined) hits = await scanEdit($, e.file_path, before, after, root)
    } catch (error) {
      debug($, `secure-coding scan skipped ${e.file_path}: ${message(error)}`)
    }
    if (hits.length === 0) return next(e)
    const shown = root && e.file_path.startsWith(`${root}/`) ? e.file_path.slice(root.length + 1) : e.file_path
    const { kisa } = await guideRows($)
    const blocking = hits.filter(hit => hit.tier === 'block')
    if (blocking.length > 0) return { deny: semgrepRefusal(shown, blocking, kisa) }
    const reply = await next(e)
    if (reply.deny !== undefined || reply.isError) return reply
    return { ...reply, context: [...(reply.context ?? []), semgrepNote(shown, hits, kisa)] }
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
