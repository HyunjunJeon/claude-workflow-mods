import { expect, test, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { dag, harness } from './control-harness.ts'

const SKILL = 'dag-workflow:dag-planning'
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
