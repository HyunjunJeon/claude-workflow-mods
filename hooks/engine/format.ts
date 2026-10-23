import { cutOutput, rulingLines } from './node-prompt.ts'
import { evidenceOutcome, VERIFICATION_GUIDANCE } from './check-eval.ts'
import { BOARD_TOOL } from './policy.ts'
import type { Preview, WriteConflict } from './preview.ts'
import { fullOutput, snapshotOf } from './run.ts'
import type { EngineError, NodeRun, Run } from './types.ts'

export type ToolReply = { result: string; isError?: true }

export function ok(value: unknown): ToolReply {
  return { result: JSON.stringify(value, null, 2) }
}

export function err(error: EngineError): ToolReply {
  return { result: JSON.stringify({ error }, null, 2), isError: true }
}

export function splitArgs(args: string): string[] {
  return args.trim().split(/\s+/).filter(Boolean)
}

function counts(run: Run): string {
  const done = run.nodes.filter(n => n.state === 'completed').length
  const failed = run.nodes.filter(n => n.state === 'failed').length
  const running = run.nodes.filter(n => n.state === 'running').length
  return [`${done}/${run.nodes.length} completed`, running ? `${running} running` : '', failed ? `${failed} failed` : '']
    .filter(Boolean)
    .join(', ')
}

export function runLine(run: Run, currentSession: string): string {
  const owner = run.sessionId === currentSession ? '' : ` [session ${run.sessionId.slice(0, 8)}]`
  return `${run.runId}  ${run.status.padEnd(9)}  ${run.name} (${counts(run)})${owner}`
}

export function listText(runs: Run[], currentSession: string): string {
  if (runs.length === 0) return 'No DAG runs in this project yet. Start one with /dag run <file.json> or ask Claude to use the dag tool.'
  return [...runs].sort((a, b) => b.createdAt - a.createdAt).map(r => runLine(r, currentSession)).join('\n')
}

export function statusText(run: Run, currentSession: string): string {
  const lines = [runLine(run, currentSession)]
  for (const node of snapshotOf(run, 0).nodes) {
    const deps = node.depends_on.length ? ` <- ${node.depends_on.join(', ')}` : ''
    const error = node.last_error ? `  (${node.last_error.message})` : ''
    lines.push(`  ${node.state.padEnd(9)}  ${node.id}${deps}${error}`)
  }
  return lines.join('\n')
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

// `id (category -> model)` for each node of one wave, in the wave's order. The pane's approval block takes these two
// pieces from here too, so /dag preview, /dag status and the pane cannot disagree about which node runs on which model
// or which paths clash.
export function waveEntries(preview: Preview, ids: string[]): string {
  const byId = new Map(preview.nodes.map(node => [node.id, node]))
  return ids.map(id => {
    const node = byId.get(id)
    return node ? `${id} (${node.category} -> ${node.model})` : id
  }).join(', ')
}

export function conflictEntry(conflict: WriteConflict): string {
  return `${conflict.a} <-> ${conflict.b}: ${conflict.paths.join(', ')}`
}

// The text of /dag preview and of /dag status for a held run, plain English like /dag status. previewRequest adds no
// planning-skill warning, since a command is not gated by that skill, so the warnings are the preview's own.
export function previewText(preview: Preview, existingRunId: string | undefined): string {
  const lines = [
    `Preview (nothing started): ${plural(preview.node_count, 'node')}, ${plural(preview.waves.length, 'wave')}, widest wave ${preview.widest_wave}, max concurrent ${preview.max_concurrent}`,
    preview.routing_note,
    ...(existingRunId ? [`This definition is already run ${existingRunId}; /dag run would reuse it.`] : []),
    ...preview.waves.map((ids, index) => `  wave ${index + 1}: ${waveEntries(preview, ids)}`),
    `Critical path: ${preview.critical_path.join(' -> ')}`,
  ]
  if (preview.write_conflicts.length) {
    lines.push('Write conflicts (can run at the same time):')
    for (const conflict of preview.write_conflicts) lines.push(`  ${conflictEntry(conflict)}`)
  }
  if (preview.unchecked_writes.length) lines.push(`unchecked write scope (no writes declared): ${preview.unchecked_writes.join(', ')}`)
  if (preview.warnings.length) lines.push('Warnings:', ...preview.warnings.map(warning => `- ${warning}`))
  return lines.join('\n')
}

const SETTLE_OUTPUT_CHARS = 1_200
const SETTLE_TOTAL_CHARS = 12_000
const NOTE_OUTPUT_CHARS = 500

function indent(text: string): string {
  return text.split('\n').map(line => `    ${line}`).join('\n')
}

// A view of a node's stored output cut to limit, counting against its whole Output (NodeRun.whole) so the cut is never silent.
function outputExcerpt(node: NodeRun, limit: number): string {
  const output = node.output ?? ''
  const whole = node.whole?.outputChars ?? output.length
  if (output.length <= limit && whole <= output.length) return output
  const kept = output.slice(0, limit).trimEnd()
  return `${kept}\n… (${kept.length} of ${whole} characters shown: the full report has the whole output)`
}

// reportPath: where the node's report is being written; the hand-back note arrives before the checkpoint has it.
export function nodeMessage(run: Run, nodeId: string, output = '', reportPath?: string): string {
  const node = run.nodes.find(n => n.id === nodeId)
  const ended = new Set(['completed', 'failed', 'cancelled', 'skipped'])
  const finished = run.nodes.filter(n => n.id === nodeId || ended.has(n.state)).length
  const state = node && node.state !== 'running' ? ` as ${node.state}` : ''
  return [
    `Node "${nodeId}" of DAG run "${run.name}" (${run.runId}) finished${state}; ${finished}/${run.nodes.length} nodes have finished.`,
    ...(output ? ['Output excerpt:', indent(cutOutput(output, NOTE_OUTPUT_CHARS))] : []),
    `dag-workflow passes the node's output, with the path of its full report, to the nodes that depend on it and keeps its full report${reportPath ? ` at ${reportPath}` : ''}. The run continues in the background and you will get one summary when it settles.`,
    'Do not verify or act on partial results now; use the dag tool\'s send action only if a running node needs steering.',
  ].join('\n')
}

// Submitted the moment a node agent stops in a non-interactive session, before its result is verified, so
// it carries no result: its only job is to give the host queued work (a new main turn) while the plugin works.
// The prompt a person's /dag run, retry or approve submits when it starts a run in a non-interactive session with no main
// turn: the turn it opens is the one whose end the plugin holds while the run is active.
export function runStartedMessage(run: Run): string {
  return [
    `DAG run "${run.name}" (${run.runId}) started; dag-workflow runs it in the background.`,
    'Reply with one short line and end your turn without calling any tools. You will get one summary when the run settles.',
  ].join('\n')
}

export function keepAliveMessage(run: Run, nodeId: string): string {
  return [
    `Node "${nodeId}" of DAG run "${run.name}" (${run.runId}) finished; dag-workflow is verifying it and continuing the run in the background.`,
    'Reply with one short line and end your turn without calling any tools. You will get one summary when the run settles.',
  ].join('\n')
}

// Node id -> the tools, in first-seen order, whose calls were left at ask in a non-interactive session during that
// node's current attempt. The log line for such a call may never reach a `claude -p` user, but this message reaches
// the main model, which can relay the fix.
export type SettleAsks = ReadonlyMap<string, readonly string[]>

function approvalHint(tools: readonly string[] | undefined): string {
  if (!tools || tools.length === 0) return ''
  return `; needed approval this non-interactive session cannot give: ${tools.join(', ')} (allow them up front with --allowedTools)`
}

// Says that the automatic review-fix round ran, so neither the main conversation nor the person mistakes the producers' second
// attempt for their first. If the reviewers still fail, the verdicts above are what the fix left, and the main conversation
// amends with them instead of retrying the reviewers or repeating the same fix.
function reviewFixLines(run: Run): string[] {
  const skipped = run.status === 'failed' ? run.reviewFix?.skipped : undefined
  if (skipped) {
    return [`No automatic review fix: ${skipped.reason}. Review the FAIL findings above and settle on the fix; ask the user which direction to take before anything that pushes, deploys or changes data outside the project runs again.`]
  }
  const last = run.reviewFix?.history.at(-1)
  if (!last) return []
  const round = `Automatic review fix: round ${run.reviewFix?.rounds ?? 1} reran ${last.producers.join(', ')} with the findings of ${last.reviewers.join(', ')}`
  return [run.status === 'failed'
    ? `${round}. The verdicts above are what that fix left; amend the producers with them rather than retrying the reviewers.`
    : `${round}; the reviewers then passed.`]
}

// A node that settles a choice its task left open writes "Ruling: <decision> - <why> - <cost if wrong>" in its ## Output
// (node-prompt.ts). The excerpt above keeps 1,200 characters of each Output, so a ruling low in a long Output never reached
// the person. superlite's finish step lists a run's rulings in its closing message for the same reason. They come from the
// whole answer (NodeRun.whole), so a ruling in a part the checkpoint cut is still listed. The block has its own budget, a
// quarter of the excerpts' 12,000 characters, so a wide run of nodes that each record rulings stays readable; what it leaves
// out it counts and names the reports for.
const RULINGS_SHOWN = 20
const RULING_CHARS = 300
const RULINGS_TOTAL_CHARS = 3_000

function rulingBlock(run: Run): string[] {
  const shorten = (text: string) => text.length <= RULING_CHARS ? text : `${text.slice(0, RULING_CHARS)}… (the node's full report has the rest)`
  const rulings = run.nodes.flatMap(node => (node.whole?.rulings ?? rulingLines(fullOutput(node))).map(text => `- ${node.id}: ${shorten(text)}`))
  if (rulings.length === 0) return []
  const shown: string[] = []
  let used = 0
  for (const line of rulings) {
    if (shown.length === RULINGS_SHOWN || used + line.length > RULINGS_TOTAL_CHARS) break
    shown.push(line)
    used += line.length
  }
  const left = rulings.length - shown.length
  return [
    'Decisions the nodes made on their own (Ruling lines). Pass them on to the person in your report:',
    ...shown,
    ...(left > 0 ? [`(${left} more rulings are in the node reports.)`] : []),
  ]
}

// Placed before the closing lines so "prove every claim first" stays the last word; these lines only say what to draw once it is
// proven. Only a run started in a turn whose answer the user wants on a board gets them: the run record itself belongs to the pane.
const BOARD_ANSWER_LINES = [
  `This run answers a request to understand something, and the user wants the answer on a board. After you have verified the result, draw the findings on a board with ${BOARD_TOOL} (load it with ToolSearch query "select:${BOARD_TOOL}" when it is deferred): a section with the conclusion, ONE diagram or table, and the quoted lines that prove it (code_peek, diff, or trace with this run's id). Call open once and keep the chat report short.`,
  'If the tool is unavailable, an edit is refused twice, or open replies shown: false, report the result in chat as before.',
]

export function settleMessage(run: Run, toolName: string, asked: SettleAsks = new Map(), answerOnBoard = false): string {
  let budget = SETTLE_TOTAL_CHARS
  const nodes = run.nodes.map(n => {
    const outcomes = { passed: 0, failed: 0, not_run: 0, unknown: 0 }
    for (const item of n.verification?.evidence ?? []) outcomes[evidenceOutcome(item)]++
    const checks = n.verification ? `; checks: ${Object.entries(outcomes).map(([key, count]) => `${key}=${count}`).join(', ')}` : ''
    const head = `- ${n.id}: ${n.state}${n.error ? ` (${n.error})` : ''}${n.verification ? `; verification: ${n.verification.status}` : '; verification: unrecorded'}${checks}${n.verification?.reportPath ? `; evidence: ${n.verification.reportPath}` : ''}${n.recovery ? `; automatic retries: ${n.recovery.used}/2 (${n.recovery.kind})` : ''}${n.reportPath ? ` — full report: ${n.reportPath}` : ''}${approvalHint(asked.get(n.id))}`
    if (!n.output || budget <= 0) return head
    const excerpt = outputExcerpt(n, Math.min(SETTLE_OUTPUT_CHARS, budget))
    budget -= excerpt.length
    return `${head}\n${indent(excerpt)}`
  })
  return [
    `DAG run "${run.name}" (${run.runId}) settled: ${run.status}.`,
    ...(run.definition.goal ? [`Goal: ${run.definition.goal}`] : []),
    ...(run.nodes.some(node => node.verification) ? [VERIFICATION_GUIDANCE] : []),
    'Node results (outputs as each node reported them):',
    ...nodes,
    ...(budget <= 0 ? ['(Some outputs were left out to keep this message short; each node\'s full report above has its whole output.)'] : []),
    ...rulingBlock(run),
    ...reviewFixLines(run),
    ...(answerOnBoard ? BOARD_ANSWER_LINES : []),
    '',
    'TREAT EVERY NODE COMPLETION CLAIM AS FALSE UNTIL YOU PROVE IT: check the real files, test output or command results each node was responsible for before you report success.',
    `Each node's full report above holds its whole output; the excerpts here are cut where they say so. Call ${toolName} with {"action":"snapshot","run_id":"${run.runId}"} for the current states; use "retry" or "amend" to recover failed or wrong nodes, or start a follow-up run.`,
  ].join('\n')
}
