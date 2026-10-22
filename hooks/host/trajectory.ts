import type { EngineInterface } from 'claude-code'
import { trajectoryOwner, trajectoryPlan, type TrajectoryEntry } from '../engine/retention.ts'
import { isSettled } from '../engine/run.ts'
import { eventFileName, rowsAfter, TRAJECTORY_SUBDIR, trajectoryLine, transcriptRows, type NotesFile, type RowMark, type TrajectoryInput, type Usage } from '../engine/trajectory.ts'
import type { Run } from '../engine/types.ts'
import { readOnlyAbsolutePath } from '../engine/verification.ts'
import { debug, listIfPresent, message, readOrEmpty, removePath, type AgentEnd, type CompletionClaim, type CompletionResult } from './io.ts'

// The trajectory log (engine/trajectory.ts): the state createTrajectory returns and the functions that take it. validate
// refuses $ passed to a method or a callback, so each operation that calls the host is a top-level function taking
// ($, trajectory, ...), and the host gives only what needs no $.
export type TrajectoryHost = {
  sessionId(): string
  projectRoot(): string
  // register.ts's runs; startup pruning keeps the trajectory of each one that has not settled.
  runs(): Iterable<Run>
  // The folder a run works in (register.ts rootOf), where a node's end reads its change.
  rootOf(run: Run): string
}

// The register.ts functions a trajectory operation calls that call the host themselves. They cannot take $ from here, so
// register.ts builds them around its own $ for each call (trajectoryCalls), and validate follows them in register.ts.
export type TrajectoryCalls = {
  // Creates a .claude/dag subdirectory on its first write and, once per session, the .gitignore.
  ensureDir(dir: string): Promise<void>
}

// register.ts parses the options into enabled and the limits, and adds each node agent's token counts from its turn.complete hook.
export type Trajectory = {
  readonly host: TrajectoryHost
  // trajectory_log: without it no event is written.
  enabled: boolean
  // Startup removes trajectories (pruneTrajectories) older than this many days, then the oldest while the folder holds more than
  // this many megabytes; 0 turns each off.
  retentionDays: number
  maxMb: number
  // Its own write queue, so no run step waits on it, a counter that orders events of the same millisecond, where the main
  // conversation's log stopped, and each node agent's token counts until its node ends.
  writes: Promise<unknown>
  seq: number
  mainRows: RowMark | undefined
  readonly agentUsage: Map<string, Usage>
}

export function createTrajectory(host: TrajectoryHost): Trajectory {
  return { host, enabled: false, retentionDays: 90, maxMb: 1024, writes: Promise.resolve(), seq: 0, mainRows: undefined, agentUsage: new Map() }
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
export async function pruneTrajectories($: EngineInterface, trajectory: Trajectory): Promise<void> {
  const projectRoot = trajectory.host.projectRoot()
  if (!projectRoot || !(trajectory.retentionDays > 0 || trajectory.maxMb > 0)) return
  const dir = `${projectRoot}/${TRAJECTORY_SUBDIR}`
  const plan = trajectoryPlan({
    entries: await trajectoryEntries($, dir), now: await $.clock.now(), retentionDays: trajectory.retentionDays, maxMb: trajectory.maxMb,
    currentSession: trajectory.host.sessionId(), unsettledRunIds: new Set([...trajectory.host.runs()].filter(run => !isSettled(run)).map(run => run.runId)),
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

// A session start forgets the token counts and the main conversation's mark that the process held before it.
export async function startTrajectory($: EngineInterface, trajectory: Trajectory): Promise<void> {
  trajectory.agentUsage.clear()
  trajectory.mainRows = undefined
  if (trajectory.enabled) {
    // A resumed conversation's earlier rows were logged by the process that saw them.
    try {
      const rows = await $.session.messages()
      if (Array.isArray(rows)) trajectory.mainRows = rowsAfter(rows, undefined).mark
    } catch (error) {
      debug($, `could not mark where the main conversation's trajectory starts: ${message(error)}`)
    }
  }
}

// A run's events go to a folder named for it; the main conversation's go to one named for the session.
function trajectoryDir(trajectory: Trajectory, runId?: string): string {
  return `${trajectory.host.projectRoot()}/${TRAJECTORY_SUBDIR}/${runId ?? `session-${trajectory.host.sessionId()}`}`
}

// Queues one trajectory event. Nothing in a run waits on the write: one that fails is logged and the run goes on.
export async function record($: EngineInterface, trajectory: Trajectory, calls: TrajectoryCalls, input: TrajectoryInput): Promise<void> {
  if (!trajectory.enabled || !trajectory.host.projectRoot()) return
  const event = { at: await $.clock.now(), sessionId: trajectory.host.sessionId(), ...input }
  const dir = trajectoryDir(trajectory, 'runId' in input ? input.runId : undefined)
  const path = `${dir}/${eventFileName(event.at, ++trajectory.seq, input.kind, 'nodeId' in input ? input.nodeId : undefined)}`
  trajectory.writes = trajectory.writes.then(async () => {
    await calls.ensureDir(dir)
    await $.fs.write(path, trajectoryLine(event))
  }).catch(error => debug($, `could not record the trajectory event ${input.kind}: ${message(error)}`))
}

// A settled run's events joined into one <run_id>.jsonl beside its folder, once the writes queued before it are done.
export function exportTrajectory($: EngineInterface, trajectory: Trajectory, runId: string): void {
  if (!trajectory.enabled || !trajectory.host.projectRoot()) return
  const dir = trajectoryDir(trajectory, runId)
  trajectory.writes = trajectory.writes.then(async () => {
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
async function endSnapshot($: EngineInterface, trajectory: Trajectory, run: Run, nodeId: string): Promise<{ notes: NotesFile[]; diff?: string }> {
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
  const root = trajectory.host.rootOf(run)
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
export async function recordNodeEnd($: EngineInterface, trajectory: Trajectory, calls: TrajectoryCalls, claim: CompletionClaim, result: CompletionResult, end: AgentEnd): Promise<void> {
  if (!trajectory.enabled) return
  const { run, node } = claim
  const usage = trajectory.agentUsage.get(end.agentId)
  trajectory.agentUsage.delete(end.agentId)
  try {
    const { notes, diff } = await endSnapshot($, trajectory, run, node.id)
    const { state, error, answer } = result.outcome
    await record($, trajectory, calls, {
      kind: 'node.end', runId: run.runId, nodeId: node.id, attempt: node.attempt, agentId: end.agentId, reason: end.reason, isAborted: end.isAborted,
      state, error, answer, verification: result.verification, expansion: result.expansion?.map(def => def.id), notes, diff, usage,
    })
    const rows = await $.session.messages({ agentId: end.agentId })
    await record($, trajectory, calls, Array.isArray(rows)
      ? { kind: 'node.transcript', runId: run.runId, nodeId: node.id, attempt: node.attempt, agentId: end.agentId, rows: transcriptRows(rows) }
      : { kind: 'node.transcript', runId: run.runId, nodeId: node.id, attempt: node.attempt, agentId: end.agentId, rows: [], error: rows.deny })
  } catch (error) {
    debug($, `could not record the end of ${run.runId}/${node.id} in its trajectory: ${message(error)}`)
  }
}

// The main conversation's rows since the last turn it logged.
export async function recordMainTurn($: EngineInterface, trajectory: Trajectory, calls: TrajectoryCalls, turn: { turnId: string; reason: string; durationMs: number; usage?: Usage }): Promise<void> {
  try {
    const rows = await $.session.messages()
    if (!Array.isArray(rows)) return
    const fresh = rowsAfter(rows, trajectory.mainRows)
    trajectory.mainRows = fresh.mark
    await record($, trajectory, calls, { kind: 'main.turn', turnId: turn.turnId, reason: turn.reason, durationMs: turn.durationMs, usage: turn.usage, rows: transcriptRows(fresh.rows) })
  } catch (error) {
    debug($, `could not record the main turn in the trajectory: ${message(error)}`)
  }
}
