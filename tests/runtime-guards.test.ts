import { expect, test, type Engine, type Mounted, type Plugin } from 'claude-code/testing'
import { parseDefinition } from '../hooks/engine/definition.ts'
import { createRun, rejectRun, requestApproval } from '../hooks/engine/run.ts'
import type { VerificationCheck } from '../hooks/engine/types.ts'
import { boot, checkpoint, command, dag, finish, harness, ROOT, start } from './control-harness.ts'

// Two guards: a node that left background work running when its turn ended waits for its next turn instead of being
// verified at once, and a run the user rejected cannot be retried, amended or restarted by the model.

const CHECK: VerificationCheck[] = [{ kind: 'command', argv: ['check-control'] }]
const node = (id: string, dependsOn: string[] = []) => ({ id, prompt: `Write ${id}`, dependsOn, verify: CHECK })
const CHAIN = { key: 'chain', name: 'Chain', nodes: [node('a'), node('b', ['a'])] }
const NO_RECOVERY = { options: { auto_recovery: false } } as const
// The spec's numbers, independent of the constant: 30 minutes and the failure text.
const THIRTY_MINUTES = 30 * 60_000
const NOT_RESUMED = 'ended its turn with background work pending and was not resumed'
const WAITING_LOG = 'Chain › a: waiting on background work'
const FOREGROUND_RULE = 'Run commands in the foreground. Do not end your turn while a background task, monitor or background subagent you started is still running: wait for it to finish, then report.'
const WAITING_ANSWER = 'The eval runs in the background with a monitor; I will report when it finishes.'
const PANE = {
  plugin: 'dag-workflow', component: 'Pane', requestId: 'dag', surface: 'terminal', viewport: { columns: 140, rows: 40 },
  props: { title: 'DAG', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

// A tool call made inside node a's worker (agent-1), as the host reports it to the plugin's hooks.
async function workerCall($: Engine, call: Record<string, unknown>, id = 'call-1') {
  await $.tool.call({ ...call, agentId: 'agent-1', tool_use_id: id } as never)
}

async function endTurn($: Engine, h: ReturnType<typeof harness>, answer: string, turn = 1) {
  await $.turn.complete({ turnId: `turn-agent-1-${turn}`, agentId: 'agent-1', reason: 'answer', isAborted: false, answer, durationMs: 1 })
  await h.clock.settle()
}

function verifyRuns(h: ReturnType<typeof harness>): number {
  return h.processes.filter(run => run.argv[0] === 'check-control').length
}

test('a node that started a background command and ended its turn without a status line keeps running, then completes on its next turn end', async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = await start($, CHAIN)
  await workerCall($, { tool: 'Bash', command: 'bun eval/run.ts', run_in_background: true })
  await endTurn($, h, WAITING_ANSWER)

  expect(checkpoint(h, runId).nodes[0]).toMatchObject({ id: 'a', state: 'running', agentId: 'agent-1' })
  expect(verifyRuns(h)).toBe(0)
  expect(h.spawns).toHaveLength(1)
  expect(h.logs).toContain(WAITING_LOG)

  await h.clock.advance(10 * 60_000)
  expect(checkpoint(h, runId).nodes[0]?.state).toBe('running')

  await finish($, h, 'agent-1')
  expect(checkpoint(h, runId).nodes[0]).toMatchObject({ state: 'completed', verification: { status: 'passed' } })
  expect(h.spawns.map(spawn => spawn.description)).toEqual(['Chain: a', 'Chain: b'])
})

test('a waiting node with no next turn fails after 30 minutes with the reason, and a late turn end changes nothing', NO_RECOVERY, async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = await start($, CHAIN)
  await workerCall($, { tool: 'Bash', command: 'bun eval/run.ts', run_in_background: true })
  await endTurn($, h, WAITING_ANSWER)

  await h.clock.advance(THIRTY_MINUTES - 1_000)
  expect(checkpoint(h, runId).nodes[0]?.state).toBe('running')
  await h.clock.advance(1_000)

  const saved = checkpoint(h, runId)
  expect(saved.nodes[0]).toMatchObject({ state: 'failed' })
  expect(saved.nodes[0]?.error).toContain(NOT_RESUMED)
  expect(saved.nodes[1]?.state).toBe('skipped')
  expect(saved.status).toBe('failed')
  expect(verifyRuns(h)).toBe(0)

  await finish($, h, 'agent-1')
  expect(checkpoint(h, runId).nodes[0]?.state).toBe('failed')
  expect(h.spawns).toHaveLength(1)
})

test('a node that started no background work finishes and verifies at once, even without a status line', async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = await start($, CHAIN)
  await workerCall($, { tool: 'Bash', command: 'bun test' })
  await workerCall($, { tool: 'Agent', description: 'Look', prompt: 'Look around', run_in_background: false }, 'call-2')
  await endTurn($, h, 'Done; the tests pass.')

  expect(checkpoint(h, runId).nodes[0]).toMatchObject({ state: 'completed', verification: { status: 'passed' } })
  expect(h.spawns).toHaveLength(2)
  expect(h.logs).not.toContain(WAITING_LOG)
})

test('a node with background work whose answer ends with a status line finishes at once', async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = await start($, CHAIN)
  await workerCall($, { tool: 'Bash', command: 'bun eval/run.ts', run_in_background: true })
  await endTurn($, h, 'The eval passed.\nDAG_NODE_STATUS: completed')

  expect(checkpoint(h, runId).nodes[0]).toMatchObject({ state: 'completed', verification: { status: 'passed' } })
  expect(h.spawns).toHaveLength(2)
})

// A status line is the last line of the answer, which is where parseOutcome reads it. A sentence that only names the line
// is not one: a worker that said it would end with the status and then ended its turn has not finished.
const MENTION = 'I will end with DAG_NODE_STATUS: completed once it finishes.'

test('a background node whose text only mentions the status line keeps running, and its next turn with a real final status line completes it', async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = await start($, CHAIN)
  await workerCall($, { tool: 'Bash', command: 'bun eval/run.ts', run_in_background: true })
  await endTurn($, h, `The eval runs in the background.\n${MENTION}\nWaiting for the monitor now.`)

  expect(checkpoint(h, runId).nodes[0]).toMatchObject({ id: 'a', state: 'running', agentId: 'agent-1' })
  expect(verifyRuns(h)).toBe(0)
  expect(h.spawns).toHaveLength(1)
  expect(h.logs).toContain(WAITING_LOG)

  await endTurn($, h, 'The eval passed.\nDAG_NODE_STATUS: completed', 2)
  expect(checkpoint(h, runId).nodes[0]).toMatchObject({ state: 'completed', verification: { status: 'passed' } })
  expect(h.spawns.map(spawn => spawn.description)).toEqual(['Chain: a', 'Chain: b'])
})

for (const [what, answer] of [
  ['the status line closes a report that also mentions it earlier', `${MENTION}\nThe eval passed.\nDAG_NODE_STATUS: completed`],
  ['blank lines follow the status line', 'The eval passed.\nDAG_NODE_STATUS: completed\n\n  \n'],
] as const) {
  test(`a background node finishes at once when ${what}`, async ($, on) => {
    const h = harness(on)
    await boot($)
    const runId = await start($, CHAIN)
    await workerCall($, { tool: 'Bash', command: 'bun eval/run.ts', run_in_background: true })
    await endTurn($, h, answer)

    expect(checkpoint(h, runId).nodes[0]).toMatchObject({ state: 'completed', verification: { status: 'passed' } })
    expect(h.spawns).toHaveLength(2)
    expect(h.logs).not.toContain(WAITING_LOG)
  })
}

for (const [what, call] of [
  ['a Monitor', { tool: 'Monitor', description: 'eval output', timeout_ms: 1_800_000, command: 'tail -f eval.log' }],
  ['an Agent call left in the background by default', { tool: 'Agent', description: 'Run the eval', prompt: 'Run the eval' }],
  ['a background Task call', { tool: 'Task', description: 'Run the eval', prompt: 'Run the eval', run_in_background: true }],
] as const) {
  test(`${what} counts as background work`, async ($, on) => {
    const h = harness(on)
    await boot($)
    const runId = await start($, CHAIN)
    await workerCall($, call)
    await endTurn($, h, WAITING_ANSWER)
    expect(checkpoint(h, runId).nodes[0]?.state).toBe('running')
    expect(h.logs).toContain(WAITING_LOG)
  })
}

test('a model cancel ends a node that waits on background work at once, and the wait never fails it later', async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = await start($, CHAIN)
  await workerCall($, { tool: 'Bash', command: 'bun eval/run.ts', run_in_background: true })
  await endTurn($, h, WAITING_ANSWER)
  await dag($, { action: 'cancel', run_id: runId, reason: 'enough' })
  await h.clock.settle()
  expect(checkpoint(h, runId)).toMatchObject({ status: 'cancelled', nodes: [{ state: 'cancelled' }, { state: 'cancelled' }] })

  await h.clock.advance(THIRTY_MINUTES)
  expect(checkpoint(h, runId).nodes[0]).toMatchObject({ state: 'cancelled', error: 'Cancelled: enough' })
})

test('the worker prompt tells the node to work in the foreground', async ($, on) => {
  const h = harness(on)
  await boot($)
  await start($, CHAIN)
  expect(h.spawns[0]?.prompt).toContain(FOREGROUND_RULE)
})

// The label is a pane string, so it follows the language setting: the Korean pane must not carry the English words.
for (const [language, options, label] of [
  ['English', {}, 'waiting on background work'],
  ['Korean', { options: { language: 'ko' } }, '백그라운드 작업 대기'],
] as const) {
  test(`the pane shows a node that waits on its background work in ${language}`, options, async ($, on) => {
    const h = harness(on)
    await boot($)
    await start($, CHAIN)
    await workerCall($, { tool: 'Bash', command: 'bun eval/run.ts', run_in_background: true })
    await endTurn($, h, WAITING_ANSWER)
    const ui = (await $.ui.mount(PANE)) as Mounted<'terminal', 'Pane'>
    const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text ?? '')
    expect(texts.filter(text => text.startsWith('▶ '))).toEqual([expect.stringContaining(label)])
    expect(texts.join('\n').includes('waiting on background work')).toBe(language === 'English')
    expect(h.logs).toContain(`Chain › a: ${label}`)
    await ui.unmount()
  })
}

test('a waiting worker whose next turn starts is not failed by the wait while that turn runs, and its turn end completes the node', async ($, on) => {
  const h = harness(on)
  on('turn.step', async function* ($: unknown, e: { turnId: string; index: number }) {
    yield { kind: 'text', index: 0, text: 'the eval finished' }
    return { turnId: e.turnId, index: e.index, answer: 'the eval finished', toolUses: [], stopReason: 'end_turn', usage: null }
  } as never)
  await boot($)
  const runId = await start($, CHAIN)
  await workerCall($, { tool: 'Bash', command: 'bun eval/run.ts', run_in_background: true })
  await endTurn($, h, WAITING_ANSWER)
  await h.clock.advance(25 * 60_000)

  // The background command's notification starts the worker's next turn.
  const stream = ($.turn.step as (e: object) => AsyncGenerator)({ turnId: 'turn-agent-1-2', index: 0, model: 'claude-test', messageCount: 3, agentId: 'agent-1' })
  for (let step = await stream.next(); step.done !== true; step = await stream.next());
  await h.clock.advance(10 * 60_000)
  expect(checkpoint(h, runId).nodes[0]?.state).toBe('running')

  await endTurn($, h, 'The eval passed.\nDAG_NODE_STATUS: completed', 2)
  expect(checkpoint(h, runId).nodes[0]).toMatchObject({ state: 'completed', verification: { status: 'passed' } })
})

// ---------------------------------------------------------------------------------------------------------------------
// Rejected runs

const ALWAYS = { options: { start_approval: 'always' } } as const
const SOLO = { key: 'solo', name: 'Solo', nodes: [node('a')] }
const refusal = (runId: string) => ({
  error: {
    code: 'rejected_by_user',
    message: `The user rejected run ${runId} ("Solo"): too broad. Do not retry, amend or restart it. Revise the plan to answer the rejection, give the revised definition a new key, and ask the user before running it again.`,
  },
})

// A model start held for approval, then rejected by the person in the composer.
async function rejected($: Engine, h: ReturnType<typeof harness>): Promise<string> {
  await boot($)
  const runId = await start($, SOLO)
  await command($, `reject ${runId} too broad`)
  await h.clock.settle()
  return runId
}

function sdkCommand($: Engine, args: string) {
  return $.command.run({ command: 'dag', args, origin: { kind: 'sdk' }, presentation: { isFullscreen: false, columns: 80 } })
}

test('after /dag reject the model\'s retry, amend and start of the same definition are refused with rejected_by_user and spawn nothing', ALWAYS, async ($, on) => {
  const h = harness(on)
  const runId = await rejected($, h)
  expect(checkpoint(h, runId)).toMatchObject({ status: 'cancelled', rejected: { at: expect.any(Number), reason: 'too broad' } })

  expect(await dag($, { action: 'retry', run_id: runId })).toEqual(refusal(runId))
  expect(await dag($, { action: 'retry', run_id: runId, node_ids: ['a'], prompt: 'Write a, smaller' })).toEqual(refusal(runId))
  expect(await dag($, { action: 'amend', run_id: runId, definition: { ...SOLO, nodes: [{ ...node('a'), prompt: 'Write a, smaller' }] } })).toEqual(refusal(runId))
  expect(await dag($, { action: 'start', definition: SOLO })).toEqual(refusal(runId))
  await h.clock.settle()
  expect(h.spawns).toHaveLength(0)
  expect(checkpoint(h, runId).nodes.map(current => current.state)).toEqual(['cancelled'])
})

test('a model start of a different definition under a rejected key keeps definition_conflict', ALWAYS, async ($, on) => {
  const h = harness(on)
  await rejected($, h)
  expect(await dag($, { action: 'start', definition: { ...SOLO, nodes: [node('b')] } })).toMatchObject({ error: { code: 'definition_conflict' } })
  expect(h.spawns).toHaveLength(0)
})

test('the person\'s own /dag retry runs a rejected run again, while a /dag retry from another origin counts as the model', ALWAYS, async ($, on) => {
  const h = harness(on)
  const runId = await rejected($, h)
  expect((await sdkCommand($, `retry ${runId}`)).text).toContain('"code": "rejected_by_user"')
  await h.clock.settle()
  expect(h.spawns).toHaveLength(0)

  await command($, `retry ${runId}`)
  await h.clock.settle()
  expect(h.spawns.map(spawn => spawn.description)).toEqual(['Solo: a'])
  const saved = checkpoint(h, runId)
  expect(saved.nodes[0]?.state).toBe('running')
  // Their retry is their consent: from here on the model may handle the run like any other.
  expect(saved.rejected).toBeUndefined()
})

test('a reload keeps the rejection: a rejected checkpoint read back from disk still refuses the model', async ($, on) => {
  const h = harness(on)
  const parsed = parseDefinition(SOLO)
  if (!parsed.ok) throw new Error(parsed.error.message)
  const runId = 'dag_rejected_1'
  const held = requestApproval(createRun(parsed.value, { runId, sessionId: 'source', now: 1_000 }), 1_000)
  h.files.set(`${ROOT}/runs/${runId}.json`, JSON.stringify({ ...rejectRun(held, 'too broad', 1_000), settledNotified: true }))

  await boot($)
  expect(await dag($, { action: 'retry', run_id: runId })).toEqual(refusal(runId))
  expect(await dag($, { action: 'start', definition: SOLO })).toEqual(refusal(runId))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await h.clock.settle()
  expect(await dag($, { action: 'amend', run_id: runId, definition: SOLO })).toEqual(refusal(runId))
  expect(checkpoint(h, runId).rejected).toEqual({ at: 1_000, reason: 'too broad' })
  expect(h.spawns).toHaveLength(0)
})

// ---------------------------------------------------------------------------------------------------------------------
// Generated reviewers and their notes files

const NOTES = '/tmp/gate-notes'
const LOCKED = '/tmp/gate-locked'
const STALE_SPEC = '## Request sentences\n1. an earlier run\'s request\n## Findings\nnone\nSpec verdict: PASS'
const STALE_STANDARDS = '## Rule sources\nnone - baseline only\n## Rule breaches\nnone\n## Judgment calls\nnone\nStandards verdict: PASS'
const SPEC_AXIS = 'Gate: Review: spec axis'
const STANDARDS_AXIS = 'Gate: Review: standards axis'
const reviewed = (notes?: string) => ({ key: 'gate', name: 'Gate', nodes: [node('a')], review: { request: 'Add a greeting', ...(notes ? { notes } : {}) } })

// The harness answers every `rm` with exit 0 and leaves its files alone, which would hide a missing removal. This makes
// `rm <path>` delete the harness file as the real program does, and records which files existed under `folder` at each
// agent spawn. It wraps the harness's capture arrays, which the harness fills as the host events arrive; the test kit locks
// Array.prototype, so the wrapper goes in with defineProperty, not by assignment.
function watchNotes(h: ReturnType<typeof harness>, folder: string) {
  const atSpawn: { description: string; present: string[] }[] = []
  const pushRun = h.processes.push.bind(h.processes)
  Object.defineProperty(h.processes, 'push', {
    value: (...runs: typeof h.processes) => {
      for (const run of runs) if (run.argv[0] === 'rm') h.files.delete(run.argv.at(-1) ?? '')
      return pushRun(...runs)
    },
  })
  const pushSpawn = h.spawns.push.bind(h.spawns)
  Object.defineProperty(h.spawns, 'push', {
    value: (...spawns: typeof h.spawns) => {
      for (const spawn of spawns) atSpawn.push({ description: String(spawn.description), present: [...h.files.keys()].filter(path => path.startsWith(`${folder}/`)).sort() })
      return pushSpawn(...spawns)
    },
  })
  return atSpawn
}

// A folder whose files `rm` is not allowed to remove.
const NOT_REMOVABLE: Plugin = {
  name: 'runtime-guards-not-removable',
  register(on) {
    on('process.run', ($, e, next) => e.argv[0] === 'rm' && String(e.argv.at(-1)).startsWith('/tmp/gate-locked/')
      ? { value: { exitCode: 1, stdout: '', stderr: 'rm: Operation not permitted', isStdoutTruncated: false, isStderrTruncated: false } }
      : next(e))
  },
}

const noteRemovals = (h: ReturnType<typeof harness>) => h.processes.filter(run => run.argv[0] === 'rm' && run.argv.some(arg => arg.endsWith('-notes.md')))

test('a stale pass in a generated reviewer\'s notes file is removed before the reviewer spawns, so a reviewer that writes nothing fails', NO_RECOVERY, async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = await start($, reviewed())
  // The default notes folder is /tmp/dag-review/<key and hash digits>: read it from the generated checks, then leave an
  // earlier run's passing verdicts in it before the reviewers exist.
  const spec = checkpoint(h, runId).definition.nodes.find(def => def.id === 'review-spec')?.verify?.[0]
  const specNotes = spec?.kind === 'file' ? spec.path : ''
  expect(specNotes).toMatch(/^\/tmp\/dag-review\/gate-[0-9a-f]+\/review-spec-notes\.md$/)
  const folder = specNotes.slice(0, specNotes.lastIndexOf('/'))
  const atSpawn = watchNotes(h, folder)
  h.files.set(specNotes, STALE_SPEC)
  h.files.set(`${folder}/review-standards-notes.md`, STALE_STANDARDS)

  await finish($, h, 'agent-1')
  const present = (description: string) => atSpawn.find(seen => seen.description === description)?.present
  expect(h.spawns.map(spawn => spawn.description)).toEqual(['Gate: a', SPEC_AXIS, STANDARDS_AXIS])
  expect(present(SPEC_AXIS)).not.toContain(specNotes)
  expect(present(STANDARDS_AXIS)).not.toContain(`${folder}/review-standards-notes.md`)

  await finish($, h, 'agent-2')
  await finish($, h, 'agent-3')
  const saved = checkpoint(h, runId)
  expect(saved.nodes.map(current => [current.id, current.state, current.verification?.status])).toEqual([
    ['a', 'completed', 'passed'], ['review-spec', 'failed', 'failed'], ['review-standards', 'failed', 'failed'],
  ])
  expect(saved.nodes[1]?.verification?.evidence[0]).toMatchObject({ check: { kind: 'file', path: specNotes }, passed: false })
})

test('a reviewer that writes its notes still passes: the removal runs before the spawn, not after', async ($, on) => {
  const h = harness(on)
  watchNotes(h, NOTES)
  h.files.set(`${NOTES}/review-spec-notes.md`, STALE_SPEC)
  h.files.set(`${NOTES}/review-standards-notes.md`, STALE_STANDARDS)
  await boot($)
  const runId = await start($, reviewed(NOTES))
  await finish($, h, 'agent-1')
  h.files.set(`${NOTES}/review-spec-notes.md`, '## Request sentences\n## Findings\nnone\nSpec verdict: PASS')
  h.files.set(`${NOTES}/review-standards-notes.md`, '## Rule sources\n## Rule breaches\nnone\n## Judgment calls\nnone\nStandards verdict: PASS')
  await finish($, h, 'agent-2')
  await finish($, h, 'agent-3')
  expect(checkpoint(h, runId).nodes.map(current => [current.id, current.state])).toEqual([['a', 'completed'], ['review-spec', 'completed'], ['review-standards', 'completed']])
})

test('every attempt clears the notes: a retried reviewer starts without the verdict its failed attempt left', NO_RECOVERY, async ($, on) => {
  const h = harness(on)
  const atSpawn = watchNotes(h, NOTES)
  await boot($)
  const runId = await start($, reviewed(NOTES))
  await finish($, h, 'agent-1')
  h.files.set(`${NOTES}/review-spec-notes.md`, '## Request sentences\n## Findings\n(c) a wrong-looking behavior\nSpec verdict: FAIL')
  await finish($, h, 'agent-2')
  await finish($, h, 'agent-3')
  expect(checkpoint(h, runId).nodes[1]).toMatchObject({ id: 'review-spec', state: 'failed' })

  await dag($, { action: 'retry', run_id: runId, node_ids: ['review-spec'] })
  await h.clock.settle()
  const second = atSpawn.filter(seen => seen.description === SPEC_AXIS)
  expect(second.map(seen => seen.present)).toEqual([[], []])
  expect(h.files.has(`${NOTES}/review-spec-notes.md`)).toBe(false)
})

test('a folder with no earlier notes needs no removal, and the reviewers spawn', async ($, on) => {
  const h = harness(on)
  await boot($)
  await start($, reviewed(NOTES))
  await finish($, h, 'agent-1')
  expect(h.spawns.map(spawn => spawn.description)).toEqual(['Gate: a', SPEC_AXIS, STANDARDS_AXIS])
  expect(noteRemovals(h)).toEqual([])
})

test('a notes file that cannot be removed fails the reviewer\'s start instead of spawning it against an old verdict', { ...NO_RECOVERY, plugins: [NOT_REMOVABLE] }, async ($, on) => {
  const h = harness(on)
  h.files.set(`${LOCKED}/review-spec-notes.md`, STALE_SPEC)
  h.files.set(`${LOCKED}/review-standards-notes.md`, STALE_STANDARDS)
  await boot($)
  const runId = await start($, reviewed(LOCKED))
  await finish($, h, 'agent-1')
  expect(h.spawns.map(spawn => spawn.description)).toEqual(['Gate: a'])
  const saved = checkpoint(h, runId)
  expect(saved.nodes.map(current => [current.id, current.state])).toEqual([['a', 'completed'], ['review-spec', 'failed'], ['review-standards', 'failed']])
  expect(saved.nodes[1]?.error).toContain(`stale review notes ${LOCKED}/review-spec-notes.md`)
  expect(h.files.get(`${LOCKED}/review-spec-notes.md`)).toBe(STALE_SPEC)
})

test('a user node that happens to be named review-spec keeps its file when the definition declares no review', async ($, on) => {
  const h = harness(on)
  watchNotes(h, NOTES)
  h.files.set(`${NOTES}/review-spec-notes.md`, STALE_SPEC)
  await boot($)
  const runId = await start($, {
    key: 'gate', name: 'Gate',
    nodes: [{ id: 'review-spec', prompt: 'Write the notes', verify: [{ kind: 'file', path: `${NOTES}/review-spec-notes.md`, lastLine: 'Spec verdict: PASS' }] }],
  })
  await finish($, h, 'agent-1')
  expect(noteRemovals(h)).toEqual([])
  expect(h.files.get(`${NOTES}/review-spec-notes.md`)).toBe(STALE_SPEC)
  expect(checkpoint(h, runId).nodes[0]).toMatchObject({ state: 'completed', verification: { status: 'passed' } })
})

test('a user node\'s file in the reviewers\' folder is left alone when the definition declares review', async ($, on) => {
  const h = harness(on)
  watchNotes(h, NOTES)
  const OWN = `${NOTES}/a-notes.md`
  h.files.set(OWN, '## Findings\nnone')
  await boot($)
  const runId = await start($, { ...reviewed(NOTES), nodes: [{ ...node('a'), verify: [{ kind: 'file', path: OWN, contains: '## Findings' }] }] })
  await finish($, h, 'agent-1')
  expect(noteRemovals(h)).toEqual([])
  expect(h.files.get(OWN)).toBe('## Findings\nnone')
  expect(checkpoint(h, runId).nodes[0]).toMatchObject({ id: 'a', state: 'completed', verification: { status: 'passed' } })
})
