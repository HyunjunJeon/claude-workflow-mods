import { expect, test, type Engine } from 'claude-code/testing'
import { boot, checkpoint, command, finish, folder, harness, ROOT, start } from './control-harness.ts'
import { hash } from '../hooks/engine/hash.ts'
import type { VerificationCheck } from '../hooks/engine/types.ts'

// A run keeps the folder the session worked in when it started ($.session.root(), a git worktree after EnterWorktree): its
// nodes spawn there and its checks run there, while its record stays in the store of the folder the session started in.

const WORKTREE = '/work/.claude/worktrees/x'
// A worktree folder holds a .git file; the harness answers fs.exists for a path only when a file or lock is at or under it.
const WORKTREE_FILES = { '.git': 'gitdir: /work/.git/worktrees/x' }
const CHECKS: VerificationCheck[] = [
  { kind: 'command', argv: ['check-control'] },
  { kind: 'file', path: 'out.md', contains: 'done' },
]
const RUN = { key: 'root', name: 'Root', nodes: [{ id: 'a', prompt: 'TASK: Write out.md. STOP WHEN: done.', writes: ['out.md'], verify: CHECKS }] }

test('a run started in a worktree spawns its node there and runs its checks there, and its record stays in the session store', async ($, on) => {
  const h = harness(on)
  h.control.root = WORKTREE
  folder(h, WORKTREE, WORKTREE_FILES)
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
  folder(h, WORKTREE, WORKTREE_FILES)
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
  folder(h, WORKTREE, WORKTREE_FILES)
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
  folder(h, WORKTREE, WORKTREE_FILES)
  await boot($)
  await start($, RUN)
  const own = [...h.store.values()].find((value): value is { sessionId: string; writes: string[] } =>
    typeof value === 'object' && value !== null && 'sessionId' in value && value.sessionId === 'source' && 'writes' in value)
  expect(own?.writes).toEqual([`${WORKTREE}/out.md`])
})

// The worktree a run started in can be removed while the run is active (git worktree remove, or ExitWorktree remove). Its next
// node then stops with one error that says what to do, instead of the process errors a missing cwd gives, and no automatic
// recovery follows: a retry cannot start anywhere until the worktree is back.
const GONE = `The run's folder no longer exists: ${WORKTREE}. Its git worktree was removed while the run was active. Recreate the worktree at that path (git worktree add) and retry the node, or cancel the run.`

function removeFolder(h: ReturnType<typeof harness>, path: string): void {
  for (const file of h.files.keys()) if (file.startsWith(`${path}/`)) h.files.delete(file)
  for (const lock of h.locks) if (lock === path || lock.startsWith(`${path}/`)) h.locks.delete(lock)
}

test('a node whose run\'s worktree was removed before it starts fails with the folder error, spawns no agent and asks for no recovery', async ($, on) => {
  // The worktree goes while node a's check runs, the window in which a removal reaches a run with a node still to start.
  on('process.run', { argv: 'remove-worktree' }, () => {
    removeFolder(h, WORKTREE)
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const h = harness(on)
  h.control.root = WORKTREE
  folder(h, WORKTREE, WORKTREE_FILES)
  await boot($)
  const runId = await start($, { key: 'gone', name: 'Gone', nodes: [
    { id: 'a', prompt: 'TASK: Do a. STOP WHEN: done.', verify: [{ kind: 'command', argv: ['remove-worktree'] }] },
    { id: 'b', prompt: 'TASK: Do b. STOP WHEN: done.', dependsOn: ['a'], verify: [{ kind: 'command', argv: ['check-control'] }] },
  ] })
  await finish($, h)
  const run = checkpoint(h, runId)
  expect(run.nodes.map(node => node.state)).toEqual(['completed', 'failed'])
  expect(run.nodes[1]?.error).toBe(GONE)
  expect(h.spawns).toHaveLength(1)
  expect(h.requests.filter(request => 'recovery' in request.questions)).toEqual([])
})

test('a node whose run\'s worktree was removed before its checks fails with the folder error as its verification error, and no check runs', async ($, on) => {
  const h = harness(on)
  h.control.root = WORKTREE
  folder(h, WORKTREE, WORKTREE_FILES)
  await boot($)
  const runId = await start($, RUN)
  expect(h.spawns).toHaveLength(1)
  // The node did its work, then the worktree was removed before the plugin ran its checks.
  h.files.set(`${WORKTREE}/out.md`, 'done')
  removeFolder(h, WORKTREE)
  await finish($, h)
  const node = checkpoint(h, runId).nodes[0]
  expect(node?.state).toBe('failed')
  expect(node?.verification).toMatchObject({ status: 'failed', evidence: [], error: GONE })
  expect(node?.error).toBe(GONE)
  expect(h.processes.filter(run => run.argv[0] === 'check-control')).toEqual([])
  expect(h.requests.filter(request => 'recovery' in request.questions)).toEqual([])
})

// A handoff drains the run at a node boundary, then tells the target session. The message names the folder the run works in
// when that is a worktree: the target session may work in another folder, and the run keeps working where it started.
const CHAIN = { key: 'chain', name: 'Chain', nodes: [
  { id: 'a', prompt: 'TASK: Write out.md. STOP WHEN: done.', writes: ['out.md'], verify: CHECKS },
  { id: 'b', prompt: 'TASK: Check out.md. STOP WHEN: done.', dependsOn: ['a'], verify: [{ kind: 'command', argv: ['check-control'] }] },
] }

// Starts CHAIN in the session's current folder, hands it to a second session of the same project and lets node a finish,
// which drains the run and sends the handoff message. Returns the run id and what the target session was sent.
async function handedOff(h: ReturnType<typeof harness>, $: Engine, runFolder: string): Promise<{ runId: string; messages: string[] }> {
  h.store.set(`dag-session:${hash('/work')}:target`, { schemaVersion: 1, sessionId: 'target', projectRoot: '/work', updatedAt: 1_000, status: 'active', runIds: [], writes: [] })
  await boot($)
  const runId = await start($, CHAIN)
  await command($, `handoff ${runId} target`)
  h.files.set(`${runFolder}/out.md`, 'done')
  await finish($, h)
  return { runId, messages: h.sends.map(sent => sent.text).filter(text => text.startsWith('[dag-handoff]')) }
}

test('the handoff message of a run started in a worktree says the run works in that worktree', async ($, on) => {
  const h = harness(on)
  h.control.root = WORKTREE
  folder(h, WORKTREE, WORKTREE_FILES)
  const { runId, messages } = await handedOff(h, $, WORKTREE)
  expect(messages).toEqual([
    `[dag-handoff] Run ${runId} is ready for manual acceptance in /work. The run works in ${WORKTREE}. Use /dag accept ${runId} or the Sessions pane. Do not accept or start work automatically.`,
  ])
})

test('the handoff message of a run started where the session started names no worktree', async ($, on) => {
  const h = harness(on)
  const { runId, messages } = await handedOff(h, $, '/work')
  expect(messages).toEqual([
    `[dag-handoff] Run ${runId} is ready for manual acceptance in /work. Use /dag accept ${runId} or the Sessions pane. Do not accept or start work automatically.`,
  ])
})
