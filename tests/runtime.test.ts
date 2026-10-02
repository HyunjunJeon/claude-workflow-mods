import { expect, mock, test } from 'claude-code/testing'

const TOOL = 'mcp__dag-workflow__dag'
const RUNS = '/work/.claude/dag/runs'

const FAN_IN = {
  key: 'fan-in',
  name: 'Fan in',
  nodes: [
    { id: 'a', prompt: 'Write a.txt' },
    { id: 'b', prompt: 'Write b.txt', category: 'quick' },
    { id: 'c', prompt: 'Merge a.txt and b.txt', dependsOn: ['a', 'b'] },
  ],
}

const CHAIN = {
  key: 'chain',
  nodes: [
    { id: 'a', prompt: 'Step A' },
    { id: 'b', prompt: 'Step B', dependsOn: ['a'] },
  ],
}

type Spawn = { prompt: string; subagent_type: string; model?: string; description: string }

const COMMAND_CONTEXT = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as const

function harness(on: any, seed: Record<string, string> = {}, now = 1_000, agents: unknown[] = []) {
  const clock = mock.clock(on, { now })
  const files = new Map<string, string>(Object.entries(seed))
  const spawns: Spawn[] = []
  const submitted: string[] = []
  const stopped: string[] = []
  const store = new Map<string, unknown>()
  const opened: Record<string, unknown>[] = []
  on('session.start', () => ({ cwd: '/work' }))
  on('store.get', ($: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', ($: any, e: any) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('ui.open', ($: any, e: any) => {
    opened.push(e)
    return { value: { isPlaced: true } }
  })
  on('session.id', () => ({ value: 'session-1' }))
  on('session.cwd', () => ({ value: '/work' }))
  const ran: string[][] = []
  on('process.run', ($: any, e: any) => {
    ran.push(e.argv)
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('fs.list', () => ({
    value: [...files.keys()]
      .filter(path => path.startsWith(RUNS + '/'))
      .map(path => ({ name: path.slice(RUNS.length + 1), kind: 'file', size: 1, mtimeMs: 0, isLink: false })),
  }))
  on('fs.write', ($: any, e: any) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', ($: any, e: any) => ({ value: files.get(e.path.startsWith('/') ? e.path : `/work/${e.path}`) ?? '' }))
  on('agent.list', () => ({ value: agents }))
  on('agent.spawn', ($: any, e: any) => {
    spawns.push(e)
    const agentId = `agent-${spawns.length}`
    return { model: e.model ?? 'session-model', agentId, result: { status: 'async_launched', agentId } }
  })
  on('tool.register', () => ({ value: { tool: TOOL } }))
  on('command.register', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  const contexts: unknown[] = []
  on('prompt.submit', ($: any, e: any) => {
    submitted.push(e.text)
    contexts.push(e.context)
    return { text: e.text }
  })
  const delivered: string[] = []
  on('tool.call', ($: any, e: any) => {
    if (e.tool === 'TaskStop') stopped.push(e.task_id)
    if (e.tool === 'SubagentHandback') {
      delivered.push(e.message)
      return { result: { success: true, message: 'Report delivered to your caller.' } }
    }
    return { result: 'stopped' }
  })
  on('turn.complete', () => ({ text: '' }))
  on('skill.prompt', ($: any, e: any) => ({ text: e.text }))
  on('classic.SessionStart', () => ({}))
  return { clock, files, spawns, submitted, contexts, stopped, store, opened, ran, delivered }
}

const PANE = {
  plugin: 'dag-workflow',
  component: 'Pane',
  requestId: 'dag',
  surface: 'terminal',
  viewport: { columns: 140, rows: 40 },
  props: { title: 'DAG', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

async function boot($: any, withPlanningSkill = true) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  if (withPlanningSkill) await $.skill.prompt({ skill: 'dag-workflow:dag-planning', text: '# dag-planning' })
}

async function callDag($: any, input: Record<string, unknown>) {
  const reply = await $.tool.call({ tool: TOOL, ...input })
  return { ...reply, value: JSON.parse(reply.result) }
}

async function finishAgent($: any, h: ReturnType<typeof harness>, agentId: string, answer: string, reason = 'answer') {
  await $.turn.complete({ turnId: 't-' + agentId, agentId, answer, durationMs: 5, isAborted: reason === 'aborted', reason, usage: null })
  await h.clock.settle()
}

function checkpoint(h: ReturnType<typeof harness>, runId: string) {
  return JSON.parse(h.files.get(`${RUNS}/${runId}.json`) ?? 'null')
}

function nodeStates(snapshot: { nodes: { id: string; state: string }[] }) {
  return Object.fromEntries(snapshot.nodes.map(n => [n.id, n.state]))
}

test('a fan-in DAG runs in waves, checkpoints every change and announces when it settles', async ($, on) => {
  const h = harness(on)
  await boot($)

  const started = await callDag($, { action: 'start', definition: FAN_IN })
  const runId = started.value.run_id
  expect(started.value.reused).toBe(false)
  expect(h.spawns.map(s => s.description)).toEqual(['Fan in: a', 'Fan in: b'])
  expect(h.spawns[1]).toMatchObject({ subagent_type: 'general-purpose', model: 'haiku', run_in_background: true })
  expect(h.spawns[0]?.prompt).toContain('Write a.txt')
  expect(checkpoint(h, runId).nodes.map((n: { state: string }) => n.state)).toEqual(['running', 'running', 'pending'])

  await finishAgent($, h, 'agent-1', 'wrote a.txt\nDAG_NODE_STATUS: completed')
  expect(nodeStates((await callDag($, { action: 'snapshot', run_id: runId })).value)).toEqual({ a: 'completed', b: 'running', c: 'pending' })
  expect(h.spawns.length).toBe(2)

  await finishAgent($, h, 'agent-2', 'wrote b.txt')
  const afterB = (await callDag($, { action: 'snapshot', run_id: runId })).value
  expect(nodeStates(afterB)).toEqual({ a: 'completed', b: 'completed', c: 'running' })
  expect(h.spawns[2]?.prompt).toContain('Merge a.txt and b.txt')
  expect(h.submitted.length).toBe(0)

  await finishAgent($, h, 'agent-3', 'merged\nDAG_NODE_STATUS: completed')
  const settled = (await callDag($, { action: 'wait', run_id: runId })).value
  expect(settled.status).toBe('completed')
  expect(settled.note).toBe('The run has settled.')
  expect(h.submitted.length).toBe(1)
  expect(h.submitted[0]).toContain('settled: completed')
  expect(checkpoint(h, runId)).toMatchObject({ status: 'completed', settledNotified: true })
})

test('a failed node skips its dependents, settles as failed, and retry runs it again', async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = (await callDag($, { action: 'start', definition: CHAIN })).value.run_id

  await finishAgent($, h, 'agent-1', 'could not\nDAG_NODE_STATUS: failed: missing input')
  const failed = (await callDag($, { action: 'snapshot', run_id: runId })).value
  expect(failed.status).toBe('failed')
  expect(nodeStates(failed)).toEqual({ a: 'failed', b: 'skipped' })
  expect(failed.nodes[0].last_error.message).toBe('missing input')
  expect(h.submitted[0]).toContain('settled: failed')

  const retried = await callDag($, { action: 'retry', run_id: runId, node_id: 'a', prompt: 'Step A, but create the input first' })
  expect(retried.isError).toBe(undefined)
  expect(nodeStates(retried.value)).toEqual({ a: 'running', b: 'pending' })
  expect(h.spawns[1]?.prompt).toContain('create the input first')
  expect(h.spawns[1]?.prompt).toContain('attempt 2')
})

test('start is idempotent per key and refuses a different definition under the same key', async ($, on) => {
  const h = harness(on)
  await boot($)
  const first = await callDag($, { action: 'start', definition: CHAIN })
  const again = await callDag($, { action: 'start', definition: CHAIN })
  expect(again.value).toMatchObject({ reused: true, run_id: first.value.run_id })
  expect(h.spawns.length).toBe(1)

  const conflict = await callDag($, { action: 'start', definition: { ...CHAIN, nodes: [{ id: 'z', prompt: 'other' }] } })
  expect(conflict.isError).toBe(true)
  expect(conflict.value.error.code).toBe('definition_conflict')
  const invalid = await callDag($, { action: 'start', definition: { key: 'bad', nodes: [{ id: 'a', prompt: 'x', dependsOn: ['a'] }] } })
  expect(invalid.value.error.code).toBe('invalid_dependency')
})

test('cancel stops running node agents and the run settles as cancelled', async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = (await callDag($, { action: 'start', definition: FAN_IN })).value.run_id

  const cancelled = (await callDag($, { action: 'cancel', run_id: runId, reason: 'plan changed' })).value
  expect(h.stopped).toEqual(['agent-1', 'agent-2'])
  expect(nodeStates(cancelled)).toEqual({ a: 'running', b: 'running', c: 'cancelled' })

  await finishAgent($, h, 'agent-1', '', 'aborted')
  await finishAgent($, h, 'agent-2', '', 'aborted')
  const settled = (await callDag($, { action: 'snapshot', run_id: runId })).value
  expect(settled.status).toBe('cancelled')
  expect(h.submitted[0]).toContain('settled: cancelled')
})

test('send steers a running node and refuses a finished one', async ($, on) => {
  const h = harness(on)
  const sent: { to: string; text: string }[] = []
  on('session.send', ($: any, e: any) => {
    sent.push({ to: e.to, text: e.text })
    return { isDelivered: true }
  })
  await boot($)
  const runId = (await callDag($, { action: 'start', definition: CHAIN })).value.run_id

  const ok = await callDag($, { action: 'send', run_id: runId, node_id: 'a', message: 'Skip the vendored dir' })
  expect(ok.value).toEqual({ delivered: true, node_id: 'a' })
  expect(sent[0]?.text).toBe('Skip the vendored dir')
  const refused = await callDag($, { action: 'send', run_id: runId, node_id: 'b', message: 'hi' })
  expect(refused.value.error.code).toBe('node_not_continuable')
  expect(h.spawns.length).toBe(1)
})

test('/dag run starts a definition file and /dag status prints its nodes', async ($, on) => {
  const h = harness(on, { '/work/flows/fan.json': JSON.stringify(FAN_IN) })
  await boot($)

  const out = await $.command.run({ command: 'dag', args: 'run flows/fan.json', ...COMMAND_CONTEXT })
  expect(out.text).toContain('Fan in')
  expect(out.text).toContain('running    a')
  expect(h.spawns.length).toBe(2)

  const list = await $.command.run({ command: 'dag', args: 'list', ...COMMAND_CONTEXT })
  expect(list.text).toContain('running')
  const bad = await $.command.run({ command: 'dag', args: 'status nope', ...COMMAND_CONTEXT })
  expect(bad.text).toContain('Unknown run "nope"')
})

test('a node hand-back reaches the main session as a short note and still decides the node outcome', async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = (await callDag($, { action: 'start', definition: CHAIN })).value.run_id

  await $.tool.call({ tool: 'SubagentHandback', agentId: 'agent-1', message: 'a very long report body\n## Output\ninput.csv was missing\nDAG_NODE_STATUS: failed: input missing' } as any)
  expect(h.delivered[0]).toContain(`Node "a" of DAG run "chain" (${runId}) finished; 1/2 nodes have finished.`)
  expect(h.delivered[0]).toContain('input.csv was missing')
  expect(h.delivered[0]).not.toContain('a very long report body')

  await finishAgent($, h, 'agent-1', '')
  const snap = (await callDag($, { action: 'snapshot', run_id: runId })).value
  expect(nodeStates(snap)).toEqual({ a: 'failed', b: 'skipped' })
  expect(snap.nodes[0].last_error.message).toBe('input missing')
  expect(snap.nodes[0].answer).toContain('a very long report body')
  expect(snap.nodes[0].output).toBe('input.csv was missing')

  await $.tool.call({ tool: 'SubagentHandback', agentId: 'not-a-node', message: 'keep me' } as any)
  expect(h.delivered[1]).toBe('keep me')
})

test('a node whose report only reached its transcript still gets its outcome from that report', async ($, on) => {
  const h = harness(on)
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'task', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'h', tool: 'SubagentHandback', input: { message: 'tried\nDAG_NODE_STATUS: failed: disk full' }, result: { success: true } }] },
    ],
  }))
  await boot($)
  const runId = (await callDag($, { action: 'start', definition: CHAIN })).value.run_id
  await finishAgent($, h, 'agent-1', '')
  const snap = (await callDag($, { action: 'snapshot', run_id: runId })).value
  expect(nodeStates(snap)).toEqual({ a: 'failed', b: 'skipped' })
  expect(snap.nodes[0].last_error.message).toBe('disk full')
})

test('strict enforcement refuses work tools in the main conversation and lets nodes and the plugin through', async ($, on) => {
  const h = harness(on)
  await boot($)

  const edit = await $.tool.call({ tool: 'Edit', file_path: '/work/a.ts', old_string: 'a', new_string: 'b' } as any)
  expect(edit.deny).toContain('dag-workflow refused Edit in the main conversation')
  expect(edit.deny).toContain('mcp__dag-workflow__dag')
  const mutate = await $.tool.call({ tool: 'Bash', command: 'npm install left-pad' } as any)
  expect(mutate.deny).toContain('not read-only')
  const look = await $.tool.call({ tool: 'Bash', command: 'git status && ls src | head' } as any)
  expect(look.deny).toBe(undefined)
  const read = await $.tool.call({ tool: 'Read', file_path: '/work/a.ts' } as any)
  expect(read.deny).toBe(undefined)
  const inNode = await $.tool.call({ tool: 'Edit', agentId: 'agent-9', file_path: '/work/a.ts', old_string: 'a', new_string: 'b' } as any)
  expect(inNode.deny).toBe(undefined)

  const runId = (await callDag($, { action: 'start', definition: CHAIN })).value.run_id
  expect(h.spawns.length).toBe(1)
  await callDag($, { action: 'cancel', run_id: runId })
  expect(h.stopped).toEqual(['agent-1'])

  const relaxed = await $.command.run({ command: 'dag', args: 'enforce guide', ...COMMAND_CONTEXT })
  expect(relaxed.text).toBe('DAG enforcement: guide')
  const allowed = await $.tool.call({ tool: 'Edit', file_path: '/work/a.ts', old_string: 'a', new_string: 'b' } as any)
  expect(allowed.deny).toBe(undefined)
  const bad = await $.command.run({ command: 'dag', args: 'enforce loose', ...COMMAND_CONTEXT })
  expect(bad.text).toContain('Unknown enforcement level')
})

test('every main-session prompt carries the DAG protocol unless enforcement is off', async ($, on) => {
  const h = harness(on)
  await boot($)
  await $.prompt.submit({ text: 'add a login page' } as any)
  expect(JSON.stringify(h.contexts[0])).toContain('DAG orchestration is mandatory')
  await $.command.run({ command: 'dag', args: 'enforce off', ...COMMAND_CONTEXT })
  await $.prompt.submit({ text: 'and a logout page' } as any)
  expect(JSON.stringify(h.contexts[1] ?? null)).not.toContain('DAG orchestration is mandatory')
})

test('a dependent node receives its dependencies\' outputs and the settle summary carries every output', async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = (await callDag($, { action: 'start', definition: { ...FAN_IN, goal: 'Ship the merged file' } })).value.run_id
  expect(h.spawns[0]?.prompt).toContain('Overall goal of the workflow: Ship the merged file')

  await finishAgent($, h, 'agent-1', 'Long notes about a.\n## Output\na.txt holds TOKEN-ALPHA\nDAG_NODE_STATUS: completed')
  await finishAgent($, h, 'agent-2', 'b done without a section')
  const merge = h.spawns[2]?.prompt ?? ''
  expect(merge).toContain('<upstream_results>')
  expect(merge).toContain(`<result node="a" report="${RUNS}/${runId}/a.md">`)
  expect(merge).toContain('a.txt holds TOKEN-ALPHA')
  expect(merge).not.toContain('Long notes about a.')
  expect(merge).toContain('b done without a section')
  expect(h.files.get(`${RUNS}/${runId}/a.md`)).toContain('Long notes about a.')
  expect(h.ran.some(argv => argv[0] === 'mkdir' && argv[2] === `${RUNS}/${runId}`)).toBe(true)

  await finishAgent($, h, 'agent-3', 'merged\n## Output\nc.txt = TOKEN-ALPHA + b\nDAG_NODE_STATUS: completed')
  await callDag($, { action: 'snapshot', run_id: runId })
  const summary = h.submitted[0] ?? ''
  expect(summary).toContain('Goal: Ship the merged file')
  expect(summary).toContain('a.txt holds TOKEN-ALPHA')
  expect(summary).toContain('c.txt = TOKEN-ALPHA + b')
  expect(summary).toContain(`full report: ${RUNS}/${runId}/c.md`)
})

const COMPLIANT = {
  key: 'compliant',
  nodes: [
    { id: 'make', prompt: 'TASK: Create x.txt. DELIVERABLE: x.txt. SCOPE: write x.txt only. VERIFY: cat x.txt. STOP WHEN: x.txt exists.' },
    { id: 'verify', dependsOn: ['make'], prompt: 'TASK: Check x.txt. DELIVERABLE: a PASS/FAIL line. SCOPE: read only. VERIFY: cat x.txt. STOP WHEN: the line is reported.' },
  ],
}

test('strict mode refuses the first plan until the dag-planning skill is loaded, and /clear resets it', async ($, on) => {
  const h = harness(on)
  await boot($, false)
  const refused = await callDag($, { action: 'start', definition: CHAIN })
  expect(refused.isError).toBe(true)
  expect(refused.value.error.code).toBe('planning_skill_required')
  expect(refused.value.error.message).toContain('dag-workflow:dag-planning')
  expect((await callDag($, { action: 'amend', run_id: 'dag_x', definition: CHAIN })).value.error.code).toBe('planning_skill_required')
  expect((await callDag($, { action: 'list' })).isError).toBe(undefined)
  expect(h.spawns.length).toBe(0)

  await $.tool.call({ tool: 'Skill', skill: 'dag-workflow:dag-planning' } as any)
  const started = await callDag($, { action: 'start', definition: CHAIN })
  expect(started.isError).toBe(undefined)
  expect(h.spawns.length).toBe(1)

  await $.classic.SessionStart({ source: 'clear' } as any)
  expect((await callDag($, { action: 'start', definition: FAN_IN })).value.error.code).toBe('planning_skill_required')
  await $.skill.prompt({ skill: 'dag-workflow:dag-planning', text: '# dag-planning' } as any)
  expect((await callDag($, { action: 'start', definition: FAN_IN })).isError).toBe(undefined)
})

test('guide mode and the user\'s /dag run start without the skill; guide reminds through a warning', async ($, on) => {
  const h = harness(on, { '/work/flow.json': JSON.stringify(COMPLIANT) })
  await boot($, false)
  const ran = await $.command.run({ command: 'dag', args: 'run flow.json', ...COMMAND_CONTEXT })
  expect(ran.text).toContain('compliant')
  expect(h.spawns.length).toBe(1)

  await $.command.run({ command: 'dag', args: 'enforce guide', ...COMMAND_CONTEXT })
  const started = await callDag($, { action: 'start', definition: { ...COMPLIANT, key: 'guided' } })
  expect(started.isError).toBe(undefined)
  expect(started.value.warnings).toEqual(['the dag-workflow:dag-planning skill is not loaded in this session - load it and follow its node prompt contract.'])
})

test('start audits the node prompt contract and asks for a verification node', async ($, on) => {
  harness(on)
  await boot($)
  const loose = await callDag($, { action: 'start', definition: FAN_IN })
  expect(loose.value.warnings.length).toBe(4)
  expect(loose.value.warnings[0]).toContain('node "a": the prompt lacks TASK: and STOP WHEN')
  expect(loose.value.warnings[3]).toContain('no verification node')
  const strictOk = await callDag($, { action: 'start', definition: COMPLIANT })
  expect(strictOk.value.warnings).toEqual([])
})

test('/dag run also reads a YAML definition', async ($, on) => {
  const yaml = 'key: yaml-flow\nnodes:\n  - id: one\n    prompt: First\n  - id: two\n    dependsOn: [one]\n    prompt: |\n      Second\n'
  const h = harness(on, { '/work/flow.yaml': yaml, '/work/bad.yml': 'key: x\nnodes: {a: 1}\n' })
  await boot($)
  const out = await $.command.run({ command: 'dag', args: 'run flow.yaml', ...COMMAND_CONTEXT })
  expect(out.text).toContain('yaml-flow')
  expect(h.spawns.length).toBe(1)
  expect(h.spawns[0]?.prompt).toContain('First')
  const bad = await $.command.run({ command: 'dag', args: 'run bad.yml', ...COMMAND_CONTEXT })
  expect(bad.text).toContain('YAML line 2: flow mappings')
})

test('the DAG pane opens with a run, draws its layers, and remembers folded nodes', async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = (await callDag($, { action: 'start', definition: FAN_IN })).value.run_id
  expect(h.opened[0]).toMatchObject({ id: 'dag', title: 'DAG' })
  expect(h.opened[0]?.focus).toBe(undefined)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface } as any)
    expect(await ui.find({ type: 'Text', text: 'Fan in' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '● a' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '○ c' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'waiting for dependencies' })).toBeUndefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount(PANE as any)
  await ui.press({ key: 'node-c' })
  expect(await ui.find({ type: 'Text', text: 'waiting for dependencies' })).toBeDefined()
  expect(h.store.get('collapse-prefs')).toEqual({ [runId]: { c: true } })
  await ui.press({ key: 'details' })
  expect(await ui.find({ key: 'details' })).toMatchObject({ props: { label: 'compact' } })
  await ui.unmount()
})

test('/dag alone opens the pane with focus for the user', async ($, on) => {
  const h = harness(on)
  await boot($)
  const out = await $.command.run({ command: 'dag', args: '', ...COMMAND_CONTEXT })
  expect(out.text).toBe(undefined)
  expect(h.opened[0]).toMatchObject({ id: 'dag', focus: true, closeOnEscape: true })
  const ui = await $.ui.mount(PANE as any)
  expect(await ui.find({ type: 'Text', text: /No DAG runs yet/ })).toBeDefined()
  await ui.unmount()
})

test('amend through the tool re-runs only the changed node and its dependents', async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = (await callDag($, { action: 'start', definition: CHAIN })).value.run_id
  await finishAgent($, h, 'agent-1', 'A done')
  await finishAgent($, h, 'agent-2', 'B done')
  expect((await callDag($, { action: 'snapshot', run_id: runId })).value.status).toBe('completed')

  const edited = { ...CHAIN, nodes: [CHAIN.nodes[0], { ...CHAIN.nodes[1], prompt: 'Step B, version 2' }] }
  const amended = await callDag($, { action: 'amend', run_id: runId, definition: edited })
  expect(amended.value.rerun).toEqual(['b'])
  expect(nodeStates(amended.value.snapshot)).toEqual({ a: 'completed', b: 'running' })
  expect(h.spawns.length).toBe(3)
  expect(h.spawns[2]?.prompt).toContain('Step B, version 2')
})

test('a streaming node agent shows live activity in the pane', async ($, on) => {
  const h = harness(on)
  on('turn.step', async function* ($: any, e: any) {
    yield { kind: 'text', index: 0, text: 'drafting a.txt' }
    return { turnId: e.turnId, index: e.index, answer: 'drafting a.txt', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  await boot($)
  await callDag($, { action: 'start', definition: FAN_IN })
  const stream = ($.turn.step as any)({ turnId: 't', index: 0, model: 'claude-test', messageCount: 1, agentId: 'agent-1' })
  let step = await stream.next()
  while (step.done !== true) step = await stream.next()

  const ui = await $.ui.mount(PANE as any)
  expect(await ui.find({ type: 'Text', text: /drafting a\.txt/ })).toBeDefined()
  await ui.unmount()
  expect(h.spawns.length).toBe(2)
})

test('a node without stream events shows activity read from its transcript', async ($, on) => {
  const h = harness(on)
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'task', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'x', tool: 'Bash', input: {} }] },
    ],
  }))
  await boot($)
  const runId = (await callDag($, { action: 'start', definition: CHAIN })).value.run_id
  await h.clock.advance(2_000)
  await callDag($, { action: 'snapshot', run_id: runId })

  const ui = await $.ui.mount(PANE as any)
  expect(await ui.find({ type: 'Text', text: /▶ Bash running/ })).toBeDefined()
  await ui.unmount()
})

test('the tasks view shows other subagents of the session', async ($, on) => {
  harness(on, {}, 1_000, [{ id: 'other-1', description: 'Explore the auth module', type: 'Explore', status: 'running' }])
  await boot($)
  const ui = await $.ui.mount(PANE as any)
  await ui.press({ key: 'view-mode' })
  expect(await ui.find({ type: 'Text', text: 'Tasks (1)' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Explore the auth module' })).toBeDefined()
  await ui.unmount()
})

test('startup prunes expired checkpoints of other sessions', async ($, on) => {
  const day = 86_400_000
  const old = {
    schemaVersion: 1, runId: 'dag_ancient', key: 'old', name: 'old', sessionId: 'session-0', status: 'completed',
    createdAt: 1, updatedAt: 1, definitionHash: 'h',
    definition: { key: 'old', name: 'old', nodes: [{ id: 'a', prompt: 'A', dependsOn: [] }] },
    nodes: [{ id: 'a', label: 'a', state: 'completed', attempt: 1, fingerprint: 'f' }],
  }
  const h = harness(on, { [`${RUNS}/dag_ancient.json`]: JSON.stringify(old) }, 30 * day)
  await boot($)
  expect(h.ran.some(argv => argv[0] === 'rm' && String(argv[2]).endsWith('dag_ancient.json'))).toBe(true)
  const listed = await callDag($, { action: 'list' })
  expect(listed.value.runs).toEqual([])
})

test('a restarted session re-queues running nodes whose agents are gone', async ($, on) => {
  const stale = {
    schemaVersion: 1,
    runId: 'dag_old',
    key: 'chain',
    name: 'chain',
    sessionId: 'session-1',
    status: 'running',
    createdAt: 1,
    updatedAt: 1,
    definition: { key: 'chain', name: 'chain', nodes: [{ id: 'a', prompt: 'Step A', dependsOn: [] }, { id: 'b', prompt: 'Step B', dependsOn: ['a'] }] },
    definitionHash: 'x',
    nodes: [
      { id: 'a', label: 'a', state: 'running', attempt: 1, fingerprint: 'f', agentId: 'agent-gone' },
      { id: 'b', label: 'b', state: 'pending', attempt: 0, fingerprint: 'g' },
    ],
  }
  const h = harness(on, { [`${RUNS}/dag_old.json`]: JSON.stringify(stale) })
  await boot($)

  expect(h.spawns.length).toBe(1)
  expect(h.spawns[0]?.prompt).toContain('attempt 2')
  expect(checkpoint(h, 'dag_old').nodes[0]).toMatchObject({ state: 'running', agentId: 'agent-1', attempt: 2 })
})
