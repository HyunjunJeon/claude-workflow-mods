import { definitionHash, nodeFingerprint } from './definition.ts'
import { extractOutput } from './node-prompt.ts'
import { VERIFICATION_GUIDANCE } from './check-eval.ts'
import { downstream, edgesOf, upstream, type Edge } from './graph.ts'
import { fail, type Definition, type NodeDef, type NodeRun, type NodeState, type Result, type Run, type RunStatus } from './types.ts'

export const MAX_ANSWER_CHARS = 20_000

const ACTIVE: ReadonlySet<NodeState> = new Set(['pending', 'blocked', 'scheduled', 'running'])
const ENDED_BADLY: ReadonlySet<NodeState> = new Set(['failed', 'cancelled', 'skipped'])

function keepEnds(text: string, limit: number): string {
  if (text.length <= limit) return text
  const head = Math.floor(limit * 0.4)
  return `${text.slice(0, head)}\n… (${text.length - limit} characters omitted)\n${text.slice(text.length - (limit - head))}`
}

function clone(run: Run): Run {
  return JSON.parse(JSON.stringify(run)) as Run
}

function freshNode(id: string, label: string, fingerprint: string, attempt = 0): NodeRun {
  return { id, label, state: 'pending', attempt, fingerprint }
}

function nodeOf(run: Run, id: string): NodeRun {
  const node = run.nodes.find(n => n.id === id)
  if (!node) throw new Error(`Unknown node "${id}" in run ${run.runId}.`)
  return node
}

export function createRun(definition: Definition, ids: { runId: string; sessionId: string; now: number }): Run {
  return advance({
    schemaVersion: 1,
    runId: ids.runId,
    key: definition.key,
    name: definition.name,
    sessionId: ids.sessionId,
    status: 'running',
    createdAt: ids.now,
    updatedAt: ids.now,
    definition,
    definitionHash: definitionHash(definition),
    nodes: definition.nodes.map(n => freshNode(n.id, n.label ?? n.id, nodeFingerprint(n))),
  }, ids.now)
}

export function deriveStatus(run: Run): RunStatus {
  const states = run.nodes.map(n => n.state)
  if (states.includes('paused')) return 'paused'
  if (states.some(s => ACTIVE.has(s))) return 'running'
  if (run.cancelReason !== undefined) return 'cancelled'
  if (states.every(s => s === 'completed')) return 'completed'
  if (states.includes('failed')) return 'failed'
  return 'cancelled'
}

export function isSettled(run: Run): boolean {
  const status = deriveStatus(run)
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

export function advance(input: Run, now: number): Run {
  const run = clone(input)
  const deps = new Map(run.definition.nodes.map(n => [n.id, n.dependsOn]))
  let changed = true
  while (changed) {
    changed = false
    for (const node of run.nodes) {
      if (node.state !== 'pending') continue
      const depNodes = (deps.get(node.id) ?? []).map(id => nodeOf(run, id))
      const broken = depNodes.find(d => ENDED_BADLY.has(d.state))
      if (broken) {
        node.state = 'skipped'
        node.error = `Skipped: dependency "${broken.id}" ended as ${broken.state}.`
        node.finishedAt = now
        changed = true
      } else if (depNodes.every(d => d.state === 'completed')) {
        node.state = 'scheduled'
        changed = true
      }
    }
  }
  run.status = deriveStatus(run)
  run.updatedAt = now
  return run
}

export function nextToStart(run: Run, maxConcurrent: number): string[] {
  // A run held for approval starts nothing, even if a caller forgets to check.
  if (run.approval) return []
  const running = run.nodes.filter(n => n.state === 'running').length
  const slots = Math.max(0, maxConcurrent - running)
  return run.nodes.filter(n => n.state === 'scheduled').slice(0, slots).map(n => n.id)
}

export function markRunning(input: Run, id: string, agentId: string, now: number, model?: string): Run {
  const run = clone(input)
  const node = nodeOf(run, id)
  node.state = 'running'
  node.agentId = agentId
  if (model) node.model = model
  else delete node.model
  node.attempt += 1
  node.startedAt = now
  delete node.finishedAt
  delete node.error
  delete node.answer
  delete node.output
  delete node.reportPath
  delete node.verification
  return advance(run, now)
}

export type NodeOutcome = { state: 'completed' | 'failed' | 'cancelled'; answer?: string; error?: string; reportPath?: string }

export function markFinished(input: Run, id: string, outcome: NodeOutcome, now: number): Run {
  const run = clone(input)
  const node = nodeOf(run, id)
  if (node.state !== 'running') return input
  node.state = outcome.state
  node.finishedAt = now
  if (outcome.answer !== undefined) {
    node.answer = keepEnds(outcome.answer, MAX_ANSWER_CHARS)
    node.output = extractOutput(outcome.answer)
  }
  if (outcome.reportPath !== undefined) node.reportPath = outcome.reportPath
  if (outcome.error !== undefined) node.error = outcome.error
  return advance(run, now)
}

export function failToStart(input: Run, id: string, error: string, now: number): Run {
  const run = clone(input)
  const node = nodeOf(run, id)
  if (node.state !== 'scheduled') return input
  node.state = 'failed'
  node.error = error
  node.finishedAt = now
  return advance(run, now)
}

export function requeueLost(input: Run, liveAgents: ReadonlySet<string>, now: number): Run {
  const run = clone(input)
  for (const node of run.nodes) {
    if (node.state === 'running' && !(node.agentId && liveAgents.has(node.agentId))) {
      node.state = 'pending'
      delete node.agentId
    }
  }
  return advance(run, now)
}

export function nodeForAgent(run: Run, agentId: string): NodeRun | undefined {
  return run.nodes.find(n => n.agentId === agentId && n.state === 'running')
}

// Ends every node that has not finished and marks the run cancelled. A running node that owns an agent is left for the
// caller to stop (its id comes back in stopAgents); `nodeError` is the text each ended node records.
function endUnfinished(input: Run, reason: string, nodeError: string, now: number): { run: Run; stopAgents: string[] } {
  const run = clone(input)
  run.cancelReason = reason
  const stopAgents: string[] = []
  for (const node of run.nodes) {
    if (node.state === 'running' && node.agentId) stopAgents.push(node.agentId)
    else if (ACTIVE.has(node.state) || node.state === 'paused') {
      node.state = 'cancelled'
      node.error = nodeError
      node.finishedAt = now
    }
  }
  return { run: advance(run, now), stopAgents }
}

export function cancelRun(input: Run, reason: string, now: number): { run: Run; stopAgents: string[] } {
  return endUnfinished(input, reason, `Cancelled: ${reason}`, now)
}

// Holds a run for the user to approve: nextToStart returns nothing until approveRun or rejectRun clears it.
export function requestApproval(input: Run, now: number): Run {
  const run = clone(input)
  run.approval = { requestedAt: now }
  run.updatedAt = now
  return run
}

// Held: approval pending on a run that has not settled. A cancel can end a held run; it then waits for nothing.
export function awaitingApproval(run: Run): boolean {
  return Boolean(run.approval) && !isSettled(run)
}

export function approveRun(input: Run, now: number): Run {
  const run = clone(input)
  delete run.approval
  run.updatedAt = now
  return run
}

// Cancels a held run the way a user cancel does. Nothing runs while an approval is pending, so no agent needs stopping.
// The run's cancelReason is the same text each node records as its error, and `rejected` marks it for good: the model may
// not run it again (register.ts refuses that as rejected_by_user).
export function rejectRun(input: Run, reason: string, now: number): Run {
  const detail = reason.trim()
  const text = detail ? `Rejected by the user: ${detail}` : 'Rejected by the user.'
  const held = clone(input)
  delete held.approval
  held.rejected = { at: now, reason: detail }
  return endUnfinished(held, text, text, now).run
}

export function pauseRunning(input: Run, now: number): Run {
  const run = clone(input)
  for (const node of run.nodes) {
    if (node.state === 'running' || node.state === 'scheduled') node.state = 'paused'
  }
  return advance(run, now)
}

export function resumePaused(input: Run, sessionId: string, now: number): Run {
  const run = clone(input)
  run.sessionId = sessionId
  for (const node of run.nodes) {
    if (node.state === 'paused') {
      node.state = 'pending'
      delete node.agentId
    }
  }
  return advance(run, now)
}

export type RetryOptions = { nodeIds?: string[]; prompt?: string }

export function retryRun(input: Run, options: RetryOptions, now: number): Result<Run> {
  if (deriveStatus(input) === 'running') {
    return fail('run_still_active', 'The run still has pending or running nodes; let it settle before retrying.')
  }
  const run = clone(input)
  const requested = options.nodeIds ?? []
  let targets: string[]
  if (requested.length > 0) {
    const retrySet = new Set(requested)
    for (const id of requested) {
      const node = run.nodes.find(n => n.id === id)
      if (!node) return fail('unknown_node', `Node "${id}" is not in run ${run.runId}.`)
      if (node.state === 'completed') {
        return fail('node_not_retryable', `Node "${id}" completed; use amend to change it and re-run it.`)
      }
      if (node.state === 'skipped') {
        const ancestors = upstream(run.definition.nodes, id)
        const cause = [...ancestors].some(a => retrySet.has(a) && ['failed', 'cancelled'].includes(nodeOf(run, a).state))
        if (!cause) {
          return fail('node_not_retryable', `Skipped node "${id}" has no failed or cancelled ancestor in this retry set.`)
        }
      } else if (node.state !== 'failed' && node.state !== 'cancelled' && node.state !== 'paused') {
        return fail('node_not_retryable', `Node "${id}" is ${node.state}; only failed, cancelled, paused or skipped nodes can be retried.`)
      }
    }
    targets = requested
  } else {
    targets = run.nodes.filter(n => n.state === 'failed' || n.state === 'cancelled' || n.state === 'paused').map(n => n.id)
  }
  if (targets.length === 0) return fail('nothing_to_retry', 'No failed, cancelled or paused node to retry.')
  if (options.prompt !== undefined && targets.length !== 1) {
    return fail('invalid_request', 'A prompt override needs exactly one node id.')
  }

  const reset = new Set(targets)
  for (const id of downstream(run.definition.nodes, targets)) {
    const state = nodeOf(run, id).state
    if (state === 'skipped' || state === 'cancelled') reset.add(id)
  }
  for (const node of run.nodes) {
    if (!reset.has(node.id)) continue
    node.state = 'pending'
    delete node.agentId
    delete node.error
    delete node.answer
    delete node.output
    delete node.reportPath
    delete node.finishedAt
    if (options.prompt !== undefined && targets.includes(node.id)) node.promptOverride = options.prompt
  }
  delete run.cancelReason
  run.settledNotified = false
  return { ok: true, value: advance(run, now) }
}

// Reruns completed producers with a note appended to their prompt, and every node downstream of them, after a reviewer's
// FAIL verdict (rework.ts plans it). Unlike retry it takes completed nodes; unlike amend it changes no definition, so the
// fingerprints stay and a later amend still compares against the declared prompts. The round is recorded on the run.
export function reworkRun(input: Run, producers: string[], note: string, reviewers: string[], now: number): Result<Run> {
  if (deriveStatus(input) === 'running') return fail('run_still_active', 'The run still has pending or running nodes.')
  if (producers.length === 0) return fail('nothing_to_retry', 'No producer to rework.')
  const run = clone(input)
  for (const id of producers) {
    if (nodeOf(run, id).state !== 'completed') return fail('node_not_retryable', `Node "${id}" is ${nodeOf(run, id).state}; only a completed producer is reworked.`)
  }
  const reset = new Set([...producers, ...downstream(run.definition.nodes, producers)])
  for (const node of run.nodes) {
    if (!reset.has(node.id)) continue
    node.state = 'pending'
    delete node.agentId
    delete node.error
    delete node.answer
    delete node.output
    delete node.reportPath
    delete node.finishedAt
    if (producers.includes(node.id)) {
      const declared = run.definition.nodes.find(def => def.id === node.id)?.prompt ?? ''
      node.promptOverride = [node.promptOverride ?? declared, '', note].join('\n')
    }
  }
  const rounds = (run.reviewFix?.rounds ?? 0) + 1
  run.reviewFix = { rounds, history: [...(run.reviewFix?.history ?? []), { at: now, reviewers, producers }] }
  delete run.cancelReason
  run.settledNotified = false
  return { ok: true, value: advance(run, now) }
}

// Adds the nodes a node produced at run time, before it is marked finished: each child records parentId in expandedFrom,
// sits before the gate node in both lists, and the gate waits on it. Children from an earlier expansion of the same parent
// are replaced. markFinished then schedules the children whose dependencies have completed.
// definitionHash stays the declared definition's, so findReusable still matches the definition the model sends again, and
// the gate keeps its declared fingerprint; amendRun reruns the parent rather than keeping children no declaration carries.
export function expandNodes(input: Run, parentId: string, gateId: string, children: NodeDef[]): Result<Run> {
  const previous = new Set(input.definition.nodes.filter(n => n.expandedFrom === parentId).map(n => n.id))
  // Nothing to add and nothing to replace: the parent completes as is, even when the gate has already ended (a smoke run on
  // 2026-10-12 failed a lens with no candidates because a sibling lens had failed and skipped review-security first).
  if (children.length === 0 && previous.size === 0) return { ok: true, value: input }
  const gateNode = input.nodes.find(n => n.id === gateId)
  if (!gateNode) return fail('invalid_expansion', `The gate node "${gateId}" is not in run ${input.runId}.`)
  if (gateNode.state !== 'pending') {
    return fail('invalid_expansion', `${gateId} already ended as ${gateNode.state}, most likely because another node it waits on failed, so it cannot wait on new nodes; retry this node together with that one.`)
  }
  if (!input.definition.nodes.some(n => n.id === parentId)) return fail('invalid_expansion', `Unknown parent node "${parentId}".`)
  const kept = input.definition.nodes.filter(n => !previous.has(n.id))
  const ids = new Set(kept.map(n => n.id))
  for (const child of children) {
    if (ids.has(child.id)) return fail('invalid_expansion', `The new node "${child.id}" clashes with an existing node.`)
    ids.add(child.id)
  }
  const missing = children.flatMap(child => child.dependsOn).find(dep => !ids.has(dep) || dep === gateId)
  if (missing !== undefined) return fail('invalid_expansion', `A new node depends on "${missing}", which it cannot wait on.`)
  const run = clone(input)
  const added = children.map(child => ({ ...child, expandedFrom: parentId }))
  const defs = kept.map(n => n.id === gateId ? { ...n, dependsOn: [...n.dependsOn.filter(dep => !previous.has(dep)), ...added.map(child => child.id)] } : n)
  const at = defs.findIndex(n => n.id === gateId)
  run.definition = { ...run.definition, nodes: [...defs.slice(0, at), ...added, ...defs.slice(at)] }
  const states = run.nodes.filter(n => !previous.has(n.id))
  const stateAt = states.findIndex(n => n.id === gateId)
  run.nodes = [...states.slice(0, stateAt), ...added.map(child => freshNode(child.id, child.label ?? child.id, nodeFingerprint(child))), ...states.slice(stateAt)]
  return { ok: true, value: run }
}

export function amendRun(input: Run, definition: Definition, now: number): Result<{ run: Run; rerun: string[] }> {
  if (definition.key !== input.key) {
    return fail('key_mismatch', `The amended definition's key "${definition.key}" differs from the run's key "${input.key}".`)
  }
  const old = new Map(input.nodes.map(n => [n.id, n]))
  // A declared definition never carries the nodes a parent added at run time, so a kept parent reruns and expands again.
  const declared = new Set(definition.nodes.map(n => n.id))
  const parents = input.definition.nodes.flatMap(n => n.expandedFrom !== undefined && declared.has(n.expandedFrom) ? [n.expandedFrom] : [])
  const changed = [...new Set([
    ...definition.nodes.filter(n => old.get(n.id)?.fingerprint !== nodeFingerprint(n)).map(n => n.id),
    ...parents,
  ])]
  const rerun = new Set([...changed, ...downstream(definition.nodes, changed)])
  const keptIds = new Set(definition.nodes.map(n => n.id))
  for (const node of input.nodes) {
    const replaced = rerun.has(node.id) || !keptIds.has(node.id)
    if (replaced && node.state === 'running') {
      return fail('amend_running_node', `Node "${node.id}" is running and would change; wait for it or cancel the run first.`)
    }
  }

  const run = clone(input)
  run.definition = definition
  run.name = definition.name
  run.definitionHash = definitionHash(definition)
  run.nodes = definition.nodes.map(def => {
    const previous = old.get(def.id)
    const label = def.label ?? def.id
    if (!previous || rerun.has(def.id)) return freshNode(def.id, label, nodeFingerprint(def), previous?.attempt ?? 0)
    return { ...previous, label }
  })
  delete run.cancelReason
  run.settledNotified = false
  return { ok: true, value: { run: advance(run, now), rerun: [...rerun] } }
}

export function findReusable(runs: Run[], definition: Definition): Result<Run | undefined> {
  const existing = runs.filter(r => r.key === definition.key).sort((a, b) => b.createdAt - a.createdAt)[0]
  if (!existing) return { ok: true, value: undefined }
  if (existing.definitionHash !== definitionHash(definition)) {
    return fail('definition_conflict', `Key "${definition.key}" already belongs to run ${existing.runId} with a different definition; use a new key, or amend that run.`)
  }
  return { ok: true, value: existing }
}

export type NodeSnapshot = {
  id: string
  label: string
  state: NodeState
  attempt: number
  task_id?: string
  category?: string
  routing?: NodeRun['routing']
  model?: string
  verification?: NodeRun['verification']
  recovery?: NodeRun['recovery']
  depends_on: string[]
  started_at?: number
  finished_at?: number
  last_error?: { message: string }
  output?: string
  report_path?: string
  answer?: string
}

export type RunSnapshot = {
  run_id: string
  run_key: string
  name: string
  status: RunStatus
  session_id: string
  created_at: number
  updated_at: number
  awaiting_approval?: true
  verification_guidance?: string
  nodes: NodeSnapshot[]
  edges: Edge[]
}

export function snapshotOf(run: Run, answerChars = 2_000): RunSnapshot {
  const defs = new Map(run.definition.nodes.map(n => [n.id, n]))
  return {
    run_id: run.runId,
    run_key: run.key,
    name: run.name,
    status: run.status,
    session_id: run.sessionId,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
    ...(run.nodes.some(node => node.verification) ? { verification_guidance: VERIFICATION_GUIDANCE } : {}),
    ...(run.approval ? { awaiting_approval: true as const } : {}),
    nodes: run.nodes.map(n => ({
      id: n.id,
      label: n.label,
      state: n.state,
      attempt: n.attempt,
      ...(n.agentId ? { task_id: n.agentId } : {}),
      ...(defs.get(n.id)?.category ? { category: defs.get(n.id)?.category } : {}),
      ...(n.routing ? { routing: n.routing } : {}),
      ...(n.model ? { model: n.model } : {}),
      ...(n.verification ? { verification: n.verification } : {}),
      ...(n.recovery ? { recovery: n.recovery } : {}),
      depends_on: defs.get(n.id)?.dependsOn ?? [],
      ...(n.startedAt !== undefined ? { started_at: n.startedAt } : {}),
      ...(n.finishedAt !== undefined ? { finished_at: n.finishedAt } : {}),
      ...(n.error ? { last_error: { message: n.error } } : {}),
      ...(n.output ? { output: n.output } : {}),
      ...(n.reportPath ? { report_path: n.reportPath } : {}),
      ...(n.answer && answerChars > 0 ? { answer: keepEnds(n.answer, answerChars) } : {}),
    })),
    edges: edgesOf(run.definition.nodes),
  }
}
