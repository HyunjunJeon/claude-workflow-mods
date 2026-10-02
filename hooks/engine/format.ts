import { truncate } from './node-prompt.ts'
import { snapshotOf } from './run.ts'
import type { EngineError, Run } from './types.ts'

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

const SETTLE_OUTPUT_CHARS = 1_200
const SETTLE_TOTAL_CHARS = 12_000
const NOTE_OUTPUT_CHARS = 500

function indent(text: string): string {
  return text.split('\n').map(line => `    ${line}`).join('\n')
}

export function nodeMessage(run: Run, nodeId: string, output = ''): string {
  const node = run.nodes.find(n => n.id === nodeId)
  const ended = new Set(['completed', 'failed', 'cancelled', 'skipped'])
  const finished = run.nodes.filter(n => n.id === nodeId || ended.has(n.state)).length
  const state = node && node.state !== 'running' ? ` as ${node.state}` : ''
  return [
    `Node "${nodeId}" of DAG run "${run.name}" (${run.runId}) finished${state}; ${finished}/${run.nodes.length} nodes have finished.`,
    ...(output ? ['Output excerpt:', indent(truncate(output, NOTE_OUTPUT_CHARS))] : []),
    'dag-workflow passes the node\'s output to the nodes that depend on it and keeps its full report. The run continues in the background and you will get one summary when it settles.',
    'Do not verify or act on partial results now; use the dag tool\'s send action only if a running node needs steering.',
  ].join('\n')
}

export function settleMessage(run: Run, toolName: string): string {
  let budget = SETTLE_TOTAL_CHARS
  const nodes = run.nodes.map(n => {
    const head = `- ${n.id}: ${n.state}${n.error ? ` (${n.error})` : ''}${n.reportPath ? ` — full report: ${n.reportPath}` : ''}`
    if (!n.output || budget <= 0) return head
    const excerpt = truncate(n.output, Math.min(SETTLE_OUTPUT_CHARS, budget))
    budget -= excerpt.length
    return `${head}\n${indent(excerpt)}`
  })
  return [
    `DAG run "${run.name}" (${run.runId}) settled: ${run.status}.`,
    ...(run.definition.goal ? [`Goal: ${run.definition.goal}`] : []),
    'Node results (outputs as each node reported them):',
    ...nodes,
    ...(budget <= 0 ? ['(Some outputs were left out to keep this message short; read the full reports or the run snapshot.)'] : []),
    '',
    'TREAT EVERY NODE COMPLETION CLAIM AS FALSE UNTIL YOU PROVE IT: check the real files, test output or command results each node was responsible for before you report success.',
    `Call ${toolName} with {"action":"snapshot","run_id":"${run.runId}"} for every node's output; use "retry" or "amend" to recover failed or wrong nodes, or start a follow-up run.`,
  ].join('\n')
}
