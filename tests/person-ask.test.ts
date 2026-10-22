import { expect, test, type Engine } from 'claude-code/testing'
import type { DecisionRecord } from '../hooks/engine/decisions.ts'
import { ROOT, boot, checkpoint, harness, start } from './control-harness.ts'

// push is the external node (it changes things outside the project files), build is an ordinary one.
const DEFINITION = {
  key: 'person-ask',
  nodes: [
    { id: 'push', prompt: 'Push the branch', external: true, verify: [{ kind: 'command', argv: ['check-control'] }] },
    { id: 'build', prompt: 'Build the artifact', verify: [{ kind: 'command', argv: ['check-control'] }] },
  ],
}
const PUSH_REASON = "Node push is marked external, so its effects outside the project files need the person's approval"
// The plugin rewords this ask, so on Claude Code 2.1.307 the engine stamps it with the plugin and treats it as a person's.
const PUSH_ASK = { decision: 'ask', reason: PUSH_REASON, plugin: 'dag-workflow' }
const FIX = 'allow it up front with --allowedTools Write or a --permission-mode that covers it'
const NEEDS = 'Write needs approval that this non-interactive session cannot ask for'

// A `claude -p` session: no surface, nobody to answer an ask.
async function bootHeadless($: Engine) {
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  await $.skill.prompt({ skill: 'dag-workflow:planning', text: '# planning' })
}

function agentOf(h: ReturnType<typeof harness>, runId: string, nodeId: string): string {
  const agentId = checkpoint(h, runId).nodes.find(node => node.id === nodeId)?.agentId
  if (!agentId) throw new Error(`Missing agent of node ${nodeId}`)
  return agentId
}

// The host asks tool.check with the worker's agentId. A verdict has no decider on 2.1.307: the engine stamps `plugin` on an
// ask a hook reworded (the external node's) and on none a hook handed up as it heard it.
function workerCheck($: Engine, agentId: string, toolUseId: string, tool = 'Write') {
  return $.tool.check({ tool, input: { file_path: '/work/a', content: 'x' }, tool_use_id: toolUseId, agentId })
}

// A worker's Write through tool.call: the plugin learns the call and the node task it carries before the permission step.
async function workerCall($: Engine, agentId: string, toolUseId: string) {
  const call = { tool: 'Write', file_path: '/work/a', content: 'done', agentId, tool_use_id: toolUseId } as const
  await $.tool.call(call)
}

type Verdict = Awaited<ReturnType<typeof workerCheck>>

// An ask passed through keeps core's own, so it carries no plugin stamp. toEqual alone would accept `plugin: undefined`.
function expectPassedThrough(verdict: Verdict, expected: Verdict) {
  expect(verdict).toEqual(expected)
  expect(verdict).not.toHaveProperty('plugin')
}

function permissionRecords(h: ReturnType<typeof harness>): DecisionRecord[] {
  const text = h.files.get(`${ROOT}/decisions/source.json`)
  const records: DecisionRecord[] = text ? JSON.parse(text).records : []
  return records.filter(record => record.kind === 'permission')
}

function explained(h: ReturnType<typeof harness>): string[] {
  return h.logs.filter(line => line.includes(NEEDS))
}

test("an external node's ask goes to the person, not to Jev, and is recorded as a rule decision", { options: { jev_permission_scope: 'all' } }, async ($, on) => {
  on('tool.check', () => ({ decision: 'ask' }))
  const h = harness(on)
  // Jev would allow this call confidently; the verdict below shows it was never asked.
  h.control.permission = { choice: 'allow', confidence: 0.99 }
  await boot($)
  const runId = await start($, DEFINITION)
  const before = h.requests.length
  expect(await workerCheck($, agentOf(h, runId, 'push'), 'push-check')).toMatchObject(PUSH_ASK)
  expect(h.requests).toHaveLength(before)
  expect(permissionRecords(h)).toMatchObject([{
    kind: 'permission', subject: 'Write', proposed: 'ask', selected: 'ask', source: 'rule', outcome: 'existing-decision',
    runId, nodeId: 'push', note: `Run ${runId}, node push is external: the person decides, Jev not asked`,
  }])
})

test("a non-external node's ask in the same run still goes to Jev and may be allowed", { options: { jev_permission_scope: 'all' } }, async ($, on) => {
  on('tool.check', () => ({ decision: 'ask' }))
  const h = harness(on)
  h.control.permission = { choice: 'allow', confidence: 0.99 }
  await boot($)
  const runId = await start($, DEFINITION)
  const before = h.requests.length
  expect(await workerCheck($, agentOf(h, runId, 'build'), 'build-check')).toMatchObject({ decision: 'allow', reason: 'Jev allow (0.99)' })
  expect(h.requests).toHaveLength(before + 1)
  expect(permissionRecords(h)).toMatchObject([{ source: 'jev', outcome: 'applied', selected: 'allow', runId, nodeId: 'build' }])
})

test("a non-external node's call carrying its task reaches Jev under the default dag scope", async ($, on) => {
  on('tool.check', () => ({ decision: 'ask' }))
  const h = harness(on)
  h.control.permission = { choice: 'allow', confidence: 0.99 }
  await boot($)
  const runId = await start($, DEFINITION)
  const before = h.requests.length
  await workerCall($, agentOf(h, runId, 'build'), 'build-call')
  expect(h.requests).toHaveLength(before + 1)
  expect(h.requests.at(-1)?.state).toMatchObject({ task: 'Build the artifact' })
  expect(permissionRecords(h)).toMatchObject([{ source: 'jev', runId, nodeId: 'build' }])
})

test('a tool that asks the person keeps its plain ask from an external node', async ($, on) => {
  on('tool.check', () => ({ decision: 'ask', reason: 'baseline reason' }))
  const h = harness(on)
  await boot($)
  const runId = await start($, DEFINITION)
  expectPassedThrough(await workerCheck($, agentOf(h, runId, 'push'), 'question', 'AskUserQuestion'), { decision: 'ask', reason: 'baseline reason' })
  expect(permissionRecords(h)).toEqual([])
})

test("an external node's ask in a non-interactive session is explained once and still goes to the person", async ($, on) => {
  on('tool.check', () => ({ decision: 'ask' }))
  const h = harness(on)
  await bootHeadless($)
  const runId = await start($, DEFINITION)
  const agentId = agentOf(h, runId, 'push')
  expect(await workerCheck($, agentId, 'headless-push')).toMatchObject(PUSH_ASK)
  expect(await workerCheck($, agentId, 'headless-push-again')).toMatchObject(PUSH_ASK)
  expect(explained(h)).toEqual([`${runId}/push: ${NEEDS} (Jev not asked: node push is external and the person decides); ${FIX}`])
})

test('with jev_permission_scope off a node call carrying its task makes no Jev request and stays ask', { options: { jev_permission_scope: 'off' } }, async ($, on) => {
  on('tool.check', () => ({ decision: 'ask' }))
  const h = harness(on)
  h.control.permission = { choice: 'allow', confidence: 0.99 }
  await boot($)
  const runId = await start($, DEFINITION)
  const before = h.requests.length
  await workerCall($, agentOf(h, runId, 'build'), 'off-call')
  expect(h.requests).toHaveLength(before)
  expect(permissionRecords(h)).toEqual([])
  expectPassedThrough(await workerCheck($, agentOf(h, runId, 'build'), 'off-check'), { decision: 'ask' })
  expect(h.requests).toHaveLength(before)
})

test('with jev_permission_scope off a non-interactive node ask is explained by the scope', { options: { jev_permission_scope: 'off' } }, async ($, on) => {
  on('tool.check', () => ({ decision: 'ask' }))
  const h = harness(on)
  await bootHeadless($)
  const runId = await start($, DEFINITION)
  expectPassedThrough(await workerCheck($, agentOf(h, runId, 'build'), 'off-headless'), { decision: 'ask' })
  expect(explained(h)).toEqual([`${runId}/build: ${NEEDS} (Jev not asked: jev_permission_scope is off); ${FIX}`])
})

test("with jev_permission_scope off an external node's ask still goes to the person", { options: { jev_permission_scope: 'off' } }, async ($, on) => {
  on('tool.check', () => ({ decision: 'ask' }))
  const h = harness(on)
  await boot($)
  const runId = await start($, DEFINITION)
  expect(await workerCheck($, agentOf(h, runId, 'push'), 'off-push')).toMatchObject(PUSH_ASK)
  expect(permissionRecords(h)).toMatchObject([{ source: 'rule', nodeId: 'push' }])
})

// Only the exact strings off and all change the scope; anything else is the default dag.
for (const scope of ['Off', 'ALL', 'none', ' off']) {
  test(`jev_permission_scope ${JSON.stringify(scope)} keeps dag: node calls reach Jev, main-conversation asks do not`, { options: { jev_permission_scope: scope } }, async ($, on) => {
    on('tool.check', () => ({ decision: 'ask' }))
    const h = harness(on)
    h.control.permission = { choice: 'allow', confidence: 0.99 }
    await boot($)
    const runId = await start($, DEFINITION)
    const before = h.requests.length
    await workerCall($, agentOf(h, runId, 'build'), 'scope-call')
    expect(h.requests).toHaveLength(before + 1)
    expectPassedThrough(await $.tool.check({ tool: 'Write', input: { file_path: '/work/a', content: 'x' } }), { decision: 'ask' })
    expect(h.requests).toHaveLength(before + 1)
  })
}
