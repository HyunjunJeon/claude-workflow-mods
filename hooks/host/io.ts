import type { EngineInterface } from 'claude-code'
import { hash } from '../engine/hash.ts'
import type { parseOutcome } from '../engine/node-prompt.ts'
import type { NodeDef, NodeRun, Run } from '../engine/types.ts'
import { finalReport, type TranscriptRow } from '../ui/activity.ts'

// The host helpers that register.ts and the host/ modules call with $, and the constants and types they share. validate
// follows $ only into top-level functions of the module's own files, and refuses $ passed to a method or a callback, so a
// helper two files need lives here.

export const DAG_SUBDIR = '.claude/dag'
const GITIGNORE = '# dag-workflow run checkpoints and node reports\n*\n'
export const SAFE_RUN_DIR = /^dag_[A-Za-z0-9_-]+$/
export const ATTENTION_TOAST_MS = 12_000
// A board edit runs inside serialized(), so a git read that hangs (an index lock, a stalled network disk) would hold spawns and
// ticks behind it. git show and git diff against a local ref took 17-26 ms in this repository (git 2.54), so 10 s leaves room
// for a slow disk and still gives the queue back.
export const GIT_READ_TIMEOUT_MS = 10_000

export type ToolInput = Readonly<Record<string, unknown>>

export type AgentEnd = { agentId: string; reason?: string; isAborted: boolean; answer?: string }

// A node agent's end as register.ts claims it (claimCompletion) and what processing it produced, which trajectory.ts records
// (recordNodeEnd) before register.ts applies it (applyCompletion).
export type CompletionClaim = {
  readonly run: Run
  readonly node: NodeRun
  readonly report: string | undefined
}
export type CompletionResult = {
  readonly outcome: ReturnType<typeof parseOutcome>
  readonly verification?: NodeRun['verification']
  // The verifier nodes a security lens's candidates expand into, built once the lens passed verification.
  readonly expansion?: NodeDef[]
}

export function debug($: EngineInterface, text: string): void {
  $.ui.log(`dag-workflow: ${text}`, { to: 'debug' })
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// The folder the session works in now. $.session.root() follows /cd and EnterWorktree, while projectRoot stays where the
// session started and holds its run store.
export async function workingRoot($: EngineInterface, projectRoot: string): Promise<string> {
  try {
    // Spelled as projectRoot is, without a trailing slash, so the same folder never reads as a worktree.
    return (await $.session.root()).replace(/\/+$/, '') || projectRoot
  } catch (error) {
    // A host or a test harness without the call: every run works in the session's own folder, as before runs had a root.
    debug($, `session.root unavailable: ${message(error)}`)
    return projectRoot
  }
}

// Writes the `*` .gitignore of root's .claude/dag store if it is missing; the store folder must already exist.
export async function ensureGitignore($: EngineInterface, root: string): Promise<void> {
  const path = `${root}/${DAG_SUBDIR}/.gitignore`
  if (!(await $.fs.exists(path))) await $.fs.write(path, GITIGNORE)
}

export async function removePath($: EngineInterface, flag: '-f' | '-rf', path: string, purpose = 'prune'): Promise<boolean> {
  try {
    const removed = await $.process.run(['rm', flag, path])
    if (removed.exitCode === 0) return true
    debug($, `could not ${purpose} ${path}: ${removed.stderr.trim() || `exit ${removed.exitCode}`}`)
  } catch (error) {
    debug($, `could not ${purpose} ${path}: ${message(error)}`)
  }
  return false
}

// A file the plugin reads (an edited file for the scans, a rule or guide file, a new file for the trajectory log); a file
// that does not exist yet reads as empty.
export async function readOrEmpty($: EngineInterface, path: string): Promise<string> {
  try {
    return await $.fs.read(path)
  } catch {
    return ''
  }
}

export async function listIfPresent($: EngineInterface, dir: string): Promise<Awaited<ReturnType<EngineInterface['fs']['list']>>> {
  try {
    return (await $.fs.exists(dir)) ? await $.fs.list(dir) : []
  } catch (error) {
    debug($, `could not list ${dir} for retention: ${message(error)}`)
    return []
  }
}

// $.fs.write is not atomic and the host has no rename, so a process exit during a direct write leaves a truncated file.
// The text goes to a temp file beside the target and `mv -f` swaps it in; a failed write or move removes the temp file and
// throws, and the target keeps its earlier text. One `mv -f` of a 50 KB file measured 2.0 ms on 2026-10-22 (100 calls in
// 0.20 s under /usr/bin/time on this Mac, against 1.9 ms for a bare /usr/bin/true), so the move costs one process spawn
// plus the host's call overhead, unmeasured here. `what` names the data in the error. The temp file's name carries the
// writing session and `sequence`, the next number of register.ts's writeSequence, so it is unique within the process.
export async function atomicWrite($: EngineInterface, path: string, text: string, what: string, sessionId: string, sequence: number): Promise<void> {
  const temp = `${path}.${hash(sessionId)}.${sequence}.tmp`
  try {
    await $.fs.write(temp, text)
    const moved = await $.process.run(['mv', '-f', temp, path])
    if (moved.exitCode !== 0) throw new Error(`could not save ${what}: ${moved.stderr.trim()}`)
  } catch (error) {
    await removePath($, '-f', temp, `remove the temp file of ${what}`)
    throw error
  }
}

export async function recoverReport($: EngineInterface, agentId: string): Promise<string> {
  const rows = await $.session.messages({ agentId })
  if (!Array.isArray(rows)) {
    $.ui.log(`cannot read the final report of agent ${agentId}: ${rows.deny}`)
    return ''
  }
  return finalReport(rows as TranscriptRow[])
}
