import { expect, test } from 'claude-code/testing'
import { LINKED_DEFAULT, WORKTREES_DIR, WORKTREE_PREFIX, fileAction, isNodeWorktree, isolatedNode, mergeConflictError, parseNodeIsolation, worktreeName } from '../hooks/engine/isolation.ts'
import type { NodeDef } from '../hooks/engine/types.ts'

function node(over: Partial<NodeDef> = {}): NodeDef {
  return { id: 'build', prompt: 'p', dependsOn: [], ...over }
}

// fileAction: one test per rule, then the order between the rules.

test('a file the node left as it started is left alone, whatever the main tree did', () => {
  expect(fileAction({ base: 'a', current: 'b', node: 'a' })).toBe('none')
})

test('a file absent at the start and absent in the node result is left alone', () => {
  expect(fileAction({ current: 'b' })).toBe('none')
})

test('a file the main tree already holds in the node result is left alone', () => {
  expect(fileAction({ base: 'a', current: 'b', node: 'b' })).toBe('none')
})

test('a file the node changed and the main tree did not is taken from the node', () => {
  expect(fileAction({ base: 'a', current: 'a', node: 'b' })).toBe('take')
})

test('a file the node added and the main tree does not have is taken from the node', () => {
  expect(fileAction({ node: 'b' })).toBe('take')
})

test('a file the node deleted and the main tree did not touch is deleted', () => {
  expect(fileAction({ base: 'a', current: 'a' })).toBe('delete')
})

test('a file added by the node and by the main tree with different content conflicts', () => {
  expect(fileAction({ current: 'x', node: 'y' })).toBe('conflict')
})

test('a file the node deleted and the main tree changed conflicts', () => {
  expect(fileAction({ base: 'a', current: 'b' })).toBe('conflict')
})

test('a file the main tree deleted and the node changed conflicts', () => {
  expect(fileAction({ base: 'a', node: 'c' })).toBe('conflict')
})

test('a file all three versions changed differently is merged', () => {
  expect(fileAction({ base: 'a', current: 'b', node: 'c' })).toBe('merge')
})

test('base absent but the main tree holding the node content is none, not a conflict', () => {
  expect(fileAction({ current: 'x', node: 'x' })).toBe('none')
})

test('a file deleted by both the node and the main tree is none, not a conflict', () => {
  expect(fileAction({ base: 'a' })).toBe('none')
})

test('a file the main tree changed to the node content is none, not a merge', () => {
  expect(fileAction({ base: 'a', current: 'c', node: 'c' })).toBe('none')
})

// isolatedNode

test('mode off isolates no node', () => {
  expect(isolatedNode(node({ writes: ['src'] }), 'off')).toBe(false)
})

test('mode writes isolates a node with a write scope only', () => {
  expect(isolatedNode(node({ writes: ['src'] }), 'writes')).toBe(true)
  expect(isolatedNode(node({ writes: [] }), 'writes')).toBe(false)
  expect(isolatedNode(node(), 'writes')).toBe(false)
})

test('mode all isolates every node except one that declares an empty write scope', () => {
  expect(isolatedNode(node({ writes: ['src'] }), 'all')).toBe(true)
  expect(isolatedNode(node(), 'all')).toBe(true)
  expect(isolatedNode(node({ writes: [] }), 'all')).toBe(false)
})

test('a node declared external is isolated in no mode', () => {
  const external = node({ writes: ['src'], external: true })
  expect(isolatedNode(external, 'off')).toBe(false)
  expect(isolatedNode(external, 'writes')).toBe(false)
  expect(isolatedNode(external, 'all')).toBe(false)
})

test('a node named for outside work is isolated in no mode', () => {
  const deploy = node({ id: 'deploy-site', writes: ['src'] })
  expect(isolatedNode(deploy, 'writes')).toBe(false)
  expect(isolatedNode(deploy, 'all')).toBe(false)
})

test('an outside-work word in the label or summary also keeps a node out', () => {
  expect(isolatedNode(node({ label: 'Commit the change', writes: ['src'] }), 'writes')).toBe(false)
  expect(isolatedNode(node({ task_summary: 'push the branch', writes: ['src'] }), 'all')).toBe(false)
})

test('a word that only contains an outside-work prefix mid-word does not keep a node out', () => {
  expect(isolatedNode(node({ id: 'product-page', writes: ['src'] }), 'writes')).toBe(true)
})

// worktreeName, isNodeWorktree

test('a worktree is named dag-run-node-attempt', () => {
  expect(worktreeName('dag_mvk7fcc6_6kamri', 'usage-hold', 2)).toBe('dag-dag_mvk7fcc6_6kamri-usage-hold-2')
})

test('a slash and a space in the node id become dashes', () => {
  expect(worktreeName('r1', 'a/b c', 1)).toBe('dag-r1-a-b-c-1')
})

test('a character outside ASCII becomes a dash', () => {
  expect(worktreeName('r1', 'ab한c', 1)).toBe('dag-r1-ab-c-1')
})

test('a dot, an underscore and a dash stay', () => {
  expect(worktreeName('r.1', 'a_b-c', 3)).toBe('dag-r.1-a_b-c-3')
})

test('a name is cut to 100 characters', () => {
  expect(worktreeName('r1', 'n'.repeat(300), 1)).toHaveLength(100)
})

test('a name of exactly 100 characters is not cut', () => {
  const nodeId = 'n'.repeat(100 - 'dag-r1--1'.length)
  expect(worktreeName('r1', nodeId, 1)).toBe(`dag-r1-${nodeId}-1`)
})

test('two attempts of a node with a very long id get different names', () => {
  const nodeId = 'n'.repeat(300)
  expect(worktreeName('r1', nodeId, 1)).not.toBe(worktreeName('r1', nodeId, 12))
  expect(worktreeName('r1', nodeId, 12)).toHaveLength(100)
  expect(worktreeName('r1', nodeId, 12).endsWith('-12')).toBe(true)
})

test('a name made by worktreeName is a node worktree', () => {
  expect(isNodeWorktree(worktreeName('r1', 'build', 1))).toBe(true)
})

test('a folder the person made by hand is not a node worktree', () => {
  expect(isNodeWorktree('my-feature')).toBe(false)
  expect(isNodeWorktree('Dag-r1-build-1')).toBe(false)
  expect(isNodeWorktree('')).toBe(false)
})

test('worktrees live inside the project under .claude/worktrees', () => {
  expect(WORKTREES_DIR).toBe('.claude/worktrees')
  expect(WORKTREE_PREFIX).toBe('dag-')
})

test('node_modules and .venv are linked into a worktree, not copied', () => {
  expect(LINKED_DEFAULT).toEqual(['node_modules', '.venv'])
})

// parseNodeIsolation

test('writes and all parse to themselves', () => {
  expect(parseNodeIsolation('writes')).toBe('writes')
  expect(parseNodeIsolation('all')).toBe('all')
})

test('off, an unknown word, a number, another case and a missing value parse to off', () => {
  expect(parseNodeIsolation('off')).toBe('off')
  expect(parseNodeIsolation('x')).toBe('off')
  expect(parseNodeIsolation(3)).toBe('off')
  expect(parseNodeIsolation('ALL')).toBe('off')
  expect(parseNodeIsolation(undefined)).toBe('off')
})

// mergeConflictError

test('one conflicting path is named after the merge-conflict prefix', () => {
  expect(mergeConflictError(['src/a.ts'])).toBe('merge-conflict: src/a.ts')
})

test('several conflicting paths are joined with a comma and a space', () => {
  expect(mergeConflictError(['a', 'b', 'c'])).toBe('merge-conflict: a, b, c')
})

test('ten conflicting paths are all named and no more-count follows', () => {
  const paths = Array.from({ length: 10 }, (_, i) => `f${i}`)
  expect(mergeConflictError(paths)).toBe('merge-conflict: f0, f1, f2, f3, f4, f5, f6, f7, f8, f9')
})

test('an eleventh conflicting path is counted, not named', () => {
  const paths = Array.from({ length: 11 }, (_, i) => `f${i}`)
  expect(mergeConflictError(paths)).toBe('merge-conflict: f0, f1, f2, f3, f4, f5, f6, f7, f8, f9 and 1 more')
})

test('thirteen conflicting paths name ten and count three', () => {
  const paths = Array.from({ length: 13 }, (_, i) => `f${i}`)
  expect(mergeConflictError(paths)).toBe('merge-conflict: f0, f1, f2, f3, f4, f5, f6, f7, f8, f9 and 3 more')
})
