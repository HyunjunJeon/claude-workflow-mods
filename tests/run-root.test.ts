import { expect, test } from 'claude-code/testing'
import { boot, checkpoint, finish, harness, ROOT, start } from './control-harness.ts'
import type { VerificationCheck } from '../hooks/engine/types.ts'

// A run keeps the folder the session worked in when it started ($.session.root(), a git worktree after EnterWorktree): its
// nodes spawn there and its checks run there, while its record stays in the store of the folder the session started in.

const WORKTREE = '/work/.claude/worktrees/x'
const CHECKS: VerificationCheck[] = [
  { kind: 'command', argv: ['check-control'] },
  { kind: 'file', path: 'out.md', contains: 'done' },
]
const RUN = { key: 'root', name: 'Root', nodes: [{ id: 'a', prompt: 'TASK: Write out.md. STOP WHEN: done.', writes: ['out.md'], verify: CHECKS }] }

test('a run started in a worktree spawns its node there and runs its checks there, and its record stays in the session store', async ($, on) => {
  const h = harness(on)
  h.control.root = WORKTREE
  await boot($)
  const runId = await start($, RUN)
  expect(checkpoint(h, runId).root).toBe(WORKTREE)
  expect(h.spawns[0]?.cwd).toBe(WORKTREE)
  // The worktree has the deliverable; the folder the session started in does not.
  h.files.set(`${WORKTREE}/out.md`, 'done')
  await finish($, h)
  expect(h.processes.filter(run => run.argv[0] === 'check-control').map(run => run.init?.cwd)).toEqual([WORKTREE])
  const run = checkpoint(h, runId)
  expect(run.nodes[0]?.state).toBe('completed')
  expect(h.files.has(`${ROOT}/runs/${runId}.json`)).toBe(true)
})

test('a run started where the session started records no root and spawns as before', async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = await start($, RUN)
  expect(checkpoint(h, runId)).not.toHaveProperty('root')
  expect(h.spawns[0]).not.toHaveProperty('cwd')
  h.files.set('/work/out.md', 'done')
  await finish($, h)
  expect(h.processes.filter(run => run.argv[0] === 'check-control').map(run => run.init?.cwd)).toEqual(['/work'])
  expect(checkpoint(h, runId).nodes[0]?.state).toBe('completed')
})

test('the writes a worktree run shares with other sessions name the worktree, so another tree\'s run with the same paths does not overlap', async ($, on) => {
  const h = harness(on)
  h.control.root = WORKTREE
  await boot($)
  await start($, RUN)
  const own = [...h.store.values()].find((value): value is { sessionId: string; writes: string[] } =>
    typeof value === 'object' && value !== null && 'sessionId' in value && value.sessionId === 'source' && 'writes' in value)
  expect(own?.writes).toEqual([`${WORKTREE}/out.md`])
})
