import { expect, test, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { emptyContext, parseContext } from '../hooks/engine/context.ts'
import { dag, harness, ROOT } from './control-harness.ts'

const SKILL = 'dag-workflow:planning'
const FLOW = {
  key: 'planning-state',
  nodes: [{ id: 'a', prompt: 'TASK: Make a.txt. DELIVERABLE: a.txt. SCOPE: a.txt only. VERIFY: cat a.txt. STOP WHEN: it exists.', verify: [{ kind: 'command', argv: ['check-control'] }] }],
}

// The host's session state ($.state) as a hot reload sees it: it outlives the plugin's code. The kit cannot reload a
// plugin mid-test, but every test loads the plugin fresh with its module variables at their start values, so seeding
// this store before the first session.start puts the plugin where /reload-plugins leaves it: state kept, variables gone.
// The test's own hooks answer $.state beneath the plugin (the kit's bottom takes no seed); a { deny } is how a state call fails.
function hostState(on: On, seed?: boolean) {
  const host = { value: seed, version: seed === undefined ? 0 : 1, writes: [] as boolean[], readError: '', writeError: '' }
  on('state.get', { plugin: 'dag-workflow', key: 'planningLoaded' }, () => {
    if (host.readError) return { deny: host.readError }
    return { value: { value: host.value, version: host.version } }
  })
  on('state.set', { plugin: 'dag-workflow', key: 'planningLoaded' }, (_$, e) => {
    if (host.writeError) return { deny: host.writeError }
    host.value = e.value
    host.version += 1
    host.writes.push(e.value)
    return { value: { isSet: true as const, version: host.version } }
  })
  return host
}

async function sessionStart($: Engine) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
}

async function tryStart($: Engine) {
  return dag($, { action: 'start', definition: FLOW })
}

test('loading the planning skill stores the flag in the host session state', async ($, on) => {
  harness(on)
  const host = hostState(on)
  await sessionStart($)
  expect(host.value).toBe(undefined)
  await $.skill.prompt({ skill: SKILL, text: '# planning' })
  expect(host.value).toBe(true)
})

test('calling the Skill tool for the planning skill stores the flag in the host session state', async ($, on) => {
  harness(on)
  const host = hostState(on)
  await sessionStart($)
  await $.tool.call({ tool: 'Skill', skill: SKILL } as never)
  expect(host.value).toBe(true)
})

test('a reload keeps start allowed under strict when the host still holds the flag', async ($, on) => {
  const h = harness(on)
  hostState(on, true)
  await sessionStart($)
  expect(await tryStart($)).toMatchObject({ reused: false })
  expect(h.spawns).toHaveLength(1)
})

test('a /clear closes the gate again and a later reload does not reopen it', async ($, on) => {
  const h = harness(on)
  const host = hostState(on, true)
  await sessionStart($)
  expect(await tryStart($)).toMatchObject({ reused: false })
  // The real host gives a cleared conversation a new session id; the harness keeps 'source' unless told otherwise.
  h.control.sessionId = 'cleared'
  await $.classic.SessionStart({ source: 'clear' })
  expect(host.value).toBe(false)
  expect(await tryStart($)).toMatchObject({ error: { code: 'planning_skill_required' } })
  // The reload's session.start recovers the run whose worker is gone, so spawns are counted from after it.
  await sessionStart($)
  const spawned = h.spawns.length
  expect(await tryStart($)).toMatchObject({ error: { code: 'planning_skill_required' } })
  expect(h.spawns).toHaveLength(spawned)
})

test('a fresh session with no stored flag still refuses start until the skill is loaded', async ($, on) => {
  const h = harness(on)
  hostState(on)
  await sessionStart($)
  expect(await tryStart($)).toMatchObject({ error: { code: 'planning_skill_required' } })
  expect(h.spawns).toHaveLength(0)
})

test('a failing state read leaves the gate closed and does not break session start', async ($, on) => {
  const h = harness(on)
  const host = hostState(on, true)
  host.readError = 'state unavailable'
  await sessionStart($)
  expect(await tryStart($)).toMatchObject({ error: { code: 'planning_skill_required' } })
  expect(h.logs.some((line, index) => line.includes('planning') && line.includes('state unavailable') && h.logOptions[index]?.to === 'debug')).toBe(true)
  expect(h.spawns).toHaveLength(0)
  // The tool is still registered and the gate opens normally once the skill is loaded.
  await $.skill.prompt({ skill: SKILL, text: '# planning' })
  expect(await tryStart($)).toMatchObject({ reused: false })
})

test('a failing state write still opens the gate for this load', async ($, on) => {
  const h = harness(on)
  const host = hostState(on)
  host.writeError = 'state is read-only'
  await sessionStart($)
  await $.skill.prompt({ skill: SKILL, text: '# planning' })
  expect(await tryStart($)).toMatchObject({ reused: false })
  expect(h.spawns).toHaveLength(1)
  expect(h.logs.some((line, index) => line.includes('planning') && line.includes('state is read-only') && h.logOptions[index]?.to === 'debug')).toBe(true)
})

// A new process (claude --resume keeps the session id) starts with an empty $.state; the context file is what is left.
function contextFile(h: ReturnType<typeof harness>, sessionId: string, extra: Record<string, unknown>) {
  h.files.set(`${ROOT}/context/${sessionId}.json`, JSON.stringify({ ...emptyContext('/work', sessionId, 1_000), ...extra }))
}

function storedFlag(h: ReturnType<typeof harness>, sessionId: string) {
  const text = h.files.get(`${ROOT}/context/${sessionId}.json`)
  return text === undefined ? undefined : parseContext(JSON.parse(text), '/work', sessionId)?.planningLoaded
}

test('a resumed process reopens the gate from the context file', async ($, on) => {
  const h = harness(on)
  const host = hostState(on)
  contextFile(h, 'source', { planningLoaded: true })
  await sessionStart($)
  expect(await tryStart($)).toMatchObject({ reused: false })
  expect(h.spawns).toHaveLength(1)
  expect(host.value).toBe(true)
})

test('loading the skill and starting a run stores the flag in the context file', async ($, on) => {
  const h = harness(on)
  hostState(on)
  await sessionStart($)
  await $.skill.prompt({ skill: SKILL, text: '# planning' })
  expect(await tryStart($)).toMatchObject({ reused: false })
  expect(storedFlag(h, 'source')).toBe(true)
})

test('a plain conversation that loads the skill writes no context file', async ($, on) => {
  const h = harness(on)
  hostState(on)
  await sessionStart($)
  await $.prompt.submit({ text: 'Explain this repository', wait: false, origin: { kind: 'composer' } })
  await $.skill.prompt({ skill: SKILL, text: '# planning' })
  await $.prompt.submit({ text: 'And the tests?', wait: false, origin: { kind: 'composer' } })
  expect([...h.files.keys()].filter(path => path.startsWith(`${ROOT}/context/`))).toEqual([])
})

test("a /clear leaves the new session's context file without the flag", async ($, on) => {
  const h = harness(on)
  hostState(on)
  contextFile(h, 'source', { planningLoaded: true })
  await sessionStart($)
  expect(await tryStart($)).toMatchObject({ reused: false })
  h.control.sessionId = 'cleared'
  await $.classic.SessionStart({ source: 'clear' })
  // The clear carries the run, and so the context, into the new id; the old session keeps its own flag.
  expect(h.files.has(`${ROOT}/context/cleared.json`)).toBe(true)
  expect(storedFlag(h, 'cleared')).toBe(undefined)
  expect(storedFlag(h, 'source')).toBe(true)
  await sessionStart($)
  expect(await tryStart($)).toMatchObject({ error: { code: 'planning_skill_required' } })
  expect(storedFlag(h, 'cleared')).toBe(undefined)
})

for (const [label, extra] of [
  ['planningLoaded false', { planningLoaded: false }],
  ["the string 'true'", { planningLoaded: 'true' }],
  ['no planningLoaded field', {}],
] as const) {
  test(`a context file without a true flag keeps the gate closed: ${label}`, async ($, on) => {
    const h = harness(on)
    const host = hostState(on)
    contextFile(h, 'source', extra)
    await sessionStart($)
    expect(await tryStart($)).toMatchObject({ error: { code: 'planning_skill_required' } })
    expect(h.spawns).toHaveLength(0)
    expect(host.value).toBe(undefined)
  })
}

test('a /resume into a session whose context file holds the flag opens the gate', async ($, on) => {
  const h = harness(on)
  const host = hostState(on)
  await sessionStart($)
  expect(await tryStart($)).toMatchObject({ error: { code: 'planning_skill_required' } })
  contextFile(h, 'resumed', { planningLoaded: true })
  h.control.sessionId = 'resumed'
  await $.classic.SessionStart({ source: 'resume' })
  expect(await tryStart($)).toMatchObject({ reused: false })
  expect(host.value).toBe(true)
})

// The host expands a skill's prompt inside the Skill tool call and skill.prompt carries no agent id. The test's own
// tool.call hook, registered before the harness so it sits beneath the plugin, fires skill.prompt from inside the
// call the way the host does, so the plugin sees the event while the node's call is still in flight.
function loadsSkillInsideCall($: Engine, on: On) {
  const calls = { inside: 0 }
  on('tool.call', { tool: 'Skill' }, async (_$, e) => {
    if (e.agentId) {
      await $.skill.prompt({ skill: SKILL, text: '# planning' })
      calls.inside += 1
    }
    return { result: 'loaded' }
  })
  return calls
}

const NODE_SKILL_CALL = { tool: 'Skill', skill: SKILL, agentId: 'agent-1', tool_use_id: 'node-skill' } as never

test('a node loading the planning skill does not open the main gate', async ($, on) => {
  const calls = loadsSkillInsideCall($, on)
  const h = harness(on)
  const host = hostState(on)
  await sessionStart($)
  await $.tool.call(NODE_SKILL_CALL)
  expect(calls.inside).toBe(1)
  expect(host.writes).toEqual([])
  expect(await tryStart($)).toMatchObject({ error: { code: 'planning_skill_required' } })
  expect(h.spawns).toHaveLength(0)
})

test('the planning skill loaded outside a node call still opens the gate', async ($, on) => {
  const calls = loadsSkillInsideCall($, on)
  const h = harness(on)
  const host = hostState(on)
  await sessionStart($)
  // A finished node call leaves nothing in flight behind it.
  await $.tool.call(NODE_SKILL_CALL)
  expect(calls.inside).toBe(1)
  expect(host.value).toBe(undefined)
  await $.skill.prompt({ skill: SKILL, text: '# planning' })
  expect(host.value).toBe(true)
  expect(await tryStart($)).toMatchObject({ reused: false })
  expect(h.spawns).toHaveLength(1)
})

test("the main conversation's own Skill call opens the gate while a node's load is in flight", async ($, on) => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let reached!: () => void
  const inFlight = new Promise<void>(resolve => { reached = resolve })
  // Registered before the harness so it sits beneath the plugin: the node's call stays open until the test releases it.
  on('tool.call', { tool: 'Skill' }, async (_$, e) => {
    if (e.agentId) {
      reached()
      await held
    }
    return { result: 'loaded' }
  })
  const h = harness(on)
  const host = hostState(on)
  await sessionStart($)
  const node = $.tool.call(NODE_SKILL_CALL)
  await inFlight
  await $.tool.call({ tool: 'Skill', skill: SKILL, tool_use_id: 'main-skill' } as never)
  expect(host.value).toBe(true)
  release()
  await node
  expect(await tryStart($)).toMatchObject({ reused: false })
  expect(h.spawns).toHaveLength(1)
})

test('a node planning-skill call that fails leaves nothing in flight', async ($, on) => {
  on('tool.call', { tool: 'Skill' }, async (_$, e) => {
    if (e.agentId) throw new Error('skill unavailable')
    return { result: 'loaded' }
  })
  const h = harness(on)
  const host = hostState(on)
  await sessionStart($)
  await $.tool.call(NODE_SKILL_CALL).catch(() => undefined)
  await $.skill.prompt({ skill: SKILL, text: '# planning' })
  expect(host.value).toBe(true)
  expect(await tryStart($)).toMatchObject({ reused: false })
  expect(h.spawns).toHaveLength(1)
})
