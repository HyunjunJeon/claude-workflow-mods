import { externalWord } from './rework.ts'
import type { NodeDef } from './types.ts'

// Which nodes run in their own git worktree, what the worktree is called, and how one file of a node's change merges back.
// Only decisions live here. The git calls that snapshot the tree, create the worktree and write the merge are host work
// (hooks/host/), so every function below is pure.

// off: no node is isolated. writes: a node that declares writes. all: every node except one that declares no writes at all
// (`writes: []` says "reads only"; an absent field says nothing, so the node may write and is isolated).
export type NodeIsolation = 'off' | 'writes' | 'all'

export function parseNodeIsolation(value: unknown): NodeIsolation {
  return value === 'writes' || value === 'all' ? value : 'off'
}

// A node that changes something outside the project files (a push, a deploy, a database) is never isolated: a worktree
// separates project files only, so it cannot keep that change apart. The same word list decides the review-fix round
// (rework.ts), so the two never disagree on "external".
export function isolatedNode(def: NodeDef, mode: NodeIsolation): boolean {
  if (mode === 'off' || def.external || externalWord(def) !== undefined) return false
  if (mode === 'writes') return def.writes !== undefined && def.writes.length > 0
  return def.writes === undefined || def.writes.length > 0
}

// Inside the project on purpose: measured on Claude Code 2.1.308, a worktree under .claude/worktrees/ raises no permission
// prompt for the node's edits, and one outside the project does.
export const WORKTREES_DIR = '.claude/worktrees'
export const WORKTREE_PREFIX = 'dag-'
const WORKTREE_NAME_LIMIT = 100

// The attempt stays at the end and the node id gives way when the name is too long, so two attempts of one node never share
// a worktree. Two node ids of one run that agree on their first ~75 characters would still share a name; real ids are short.
export function worktreeName(runId: string, nodeId: string, attempt: number): string {
  const safe = (text: string) => text.replace(/[^A-Za-z0-9._-]/g, '-')
  const tail = `-${safe(String(attempt))}`
  return `${WORKTREE_PREFIX}${safe(runId)}-${safe(nodeId)}`.slice(0, WORKTREE_NAME_LIMIT - tail.length) + tail
}

// Lets a cleanup pass tell this plugin's worktrees from the ones the person made by hand under the same folder.
export function isNodeWorktree(name: string): boolean {
  return name.startsWith(WORKTREE_PREFIX)
}

// Dependency folders the recipe links into a worktree instead of copying: they are large, gitignored and not what a node edits.
export const LINKED_DEFAULT = ['node_modules', '.venv']

// What to do with one file when the node's change goes back. Each value is a blob or content hash, and undefined means the
// file is absent in that version: base is the snapshot the node started from, current the main tree now, node the node's result.
export type FileAction = 'none' | 'take' | 'delete' | 'merge' | 'conflict'

// The rules run in order, and a later rule relies on the earlier ones: after the first two, node differs from base and from
// current; after the third, current differs from base, so a conflict below means two sides changed the same file differently.
export function fileAction(v: { base?: string; current?: string; node?: string }): FileAction {
  if (v.node === v.base) return 'none'
  if (v.current === v.node) return 'none'
  if (v.current === v.base) return v.node === undefined ? 'delete' : 'take'
  if (v.base === undefined || v.node === undefined || v.current === undefined) return 'conflict'
  return 'merge'
}

const CONFLICT_PATHS_SHOWN = 10

export function mergeConflictError(paths: readonly string[]): string {
  const more = paths.length - CONFLICT_PATHS_SHOWN
  return `merge-conflict: ${paths.slice(0, CONFLICT_PATHS_SHOWN).join(', ')}${more > 0 ? ` and ${more} more` : ''}`
}
