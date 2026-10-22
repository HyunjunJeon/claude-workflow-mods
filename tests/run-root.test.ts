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

test('a run started where the session started records no root and keeps its nodes there after the session moves', async ($, on) => {
  const h = harness(on)
  await boot($)
  const chain = { key: 'chain', name: 'Chain', nodes: [
    { id: 'a', prompt: 'TASK: Write out.md. STOP WHEN: done.', writes: ['out.md'], verify: CHECKS },
    { id: 'b', prompt: 'TASK: Check out.md. STOP WHEN: done.', dependsOn: ['a'], verify: [{ kind: 'command', argv: ['check-control'] }] },
  ] }
  const runId = await start($, chain)
  expect(checkpoint(h, runId)).not.toHaveProperty('root')
  expect(h.spawns[0]?.cwd).toBe('/work')
  // The session enters a worktree while node a runs; node b still starts where the run started.
  h.control.root = WORKTREE
  h.files.set('/work/out.md', 'done')
  await finish($, h)
  expect(h.spawns[1]?.cwd).toBe('/work')
  expect(h.processes.filter(run => run.argv[0] === 'check-control').map(run => run.init?.cwd)).toEqual(['/work'])
  expect(checkpoint(h, runId).nodes[0]?.state).toBe('completed')
})

test('the same definition started again in a worktree is a new run there, not the run of the other folder', async ($, on) => {
  const h = harness(on)
  await boot($)
  const first = await start($, RUN)
  h.control.root = WORKTREE
  const second = await start($, RUN)
  expect(second).not.toBe(first)
  expect(checkpoint(h, second).root).toBe(WORKTREE)
  // Started again in the worktree, it is that run.
  expect(await start($, RUN)).toBe(second)
})

test('a worktree worker\'s permission question names the worktree as the project root', async ($, on) => {
  // Registered before the shared harness: the bottom acts as the host's permission gate, as in headless-ask.test.ts.
  on('tool.check', () => ({ decision: 'ask' }))
  on('tool.call', { tool: 'Write' }, async (_engine, e) => {
    const verdict = await $.tool.check({ tool: e.tool, input: { file_path: e.file_path, content: e.content }, tool_use_id: e.tool_use_id })
    return { deny: verdict.reason ?? verdict.decision }
  })
  const h = harness(on)
  h.control.root = WORKTREE
  await boot($)
  await start($, RUN)
  await $.tool.call({ tool: 'Write', file_path: `${WORKTREE}/out.md`, content: 'done', agentId: 'agent-1', tool_use_id: 'write-1' } as never)
  const asked = h.requests.filter(request => 'permission' in request.questions).at(-1)
  expect(asked?.state).toMatchObject({ projectRoot: WORKTREE })
})

test('a root spelled with a trailing slash is the session\'s own folder, not a worktree', async ($, on) => {
  const h = harness(on)
  h.control.root = '/work/'
  await boot($)
  const runId = await start($, RUN)
  expect(checkpoint(h, runId)).not.toHaveProperty('root')
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
