import { expect, test, type Engine, type Plugin } from 'claude-code/testing'
import { hash } from '../hooks/engine/hash.ts'
import { parseLearningLibrary, parseLearningSession, renderLearnedSkill, type LearnedSkill, type LearningLibrary, type LearningSession } from '../hooks/engine/learning.ts'
import { boot, checkpoint, command, harness, start } from './control-harness.ts'

const HOME = '/home/learner'
const ROOT = `${HOME}/.claude/dag-workflow/learning`
const SKILL = 'dag-learned-event-tests'
const PATH = `${HOME}/.claude/skills/${SKILL}/SKILL.md`
// The harness project is /work; a skill learned now lives in its .claude/dag store.
const DAG = '/work/.claude/dag'
const LOCAL = `${DAG}/skills/${SKILL}/SKILL.md`
const LOCAL_ARCHIVE = `${DAG}/learning-archive/${SKILL}/SKILL.md`
type Harness = ReturnType<typeof harness>

function session(h: Harness): LearningSession {
  const parsed = parseLearningSession(h.files.get(`${ROOT}/sessions/${hash(h.control.sessionId)}.json`) ?? '')
  if (!parsed.ok) throw new Error(parsed.error.message)
  return parsed.value
}

function library(h: Harness): LearningLibrary {
  const parsed = parseLearningLibrary(h.files.get(`${ROOT}/library.json`) ?? '')
  if (!parsed.ok) throw new Error(parsed.error.message)
  return parsed.value
}

async function ask($: Engine, text = 'Use completion signals rather than sleeps in asynchronous tests.') {
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
}

async function complete($: Engine, answer: string, agentId?: string) {
  await $.turn.complete({ turnId: agentId ?? 'main', ...(agentId ? { agentId } : {}), reason: 'answer', isAborted: false, answer, durationMs: 1 })
}

function proposal(h: Harness, overrides: Record<string, unknown> = {}) {
  const batch = session(h).batch
  if (!batch) throw new Error('Missing learning batch')
  return {
    id: SKILL, description: 'Writing asynchronous tests', body: 'Subscribe to completion before triggering work.',
    scope: 'project', reason: 'The user corrected timing-dependent tests.',
    evidence: [batch.events[0]?.id], replaces: [], ...overrides,
  }
}

function seededSkill(scope: 'project' | 'global', projectRoot: string): LearnedSkill {
  return {
    id: SKILL, description: 'Writing asynchronous tests', body: 'Subscribe first.', scope, projectRoot,
    revision: 'seeded', createdAt: 1, updatedAt: 1, opportunities: 0, uses: 0, archived: false,
    history: [{ sessionId: 'seed', at: 1, reason: 'Prior user correction', evidence: ['seed'] }],
  }
}

// A legacy entry, learned before project-local storage: no location, and its file in the home skills folder.
function seed(h: Harness, scope: 'project' | 'global' = 'project', projectRoot = '/work') {
  const skill = seededSkill(scope, projectRoot)
  h.files.set(`${ROOT}/library.json`, JSON.stringify({ schemaVersion: 1, skills: [skill] }))
  h.files.set(PATH, renderLearnedSkill(skill))
}

function homeSkillEntries(h: Harness): string[] {
  const prefix = `${HOME}/.claude/skills/`
  return [...h.files.keys(), ...h.locks].filter(path => path.startsWith(prefix))
}

function signal() {
  const callbacks: { resolve?: () => void } = {}
  const promise = new Promise<void>(resolve => { callbacks.resolve = resolve })
  if (!callbacks.resolve) throw new Error('Signal resolver was not created')
  return { promise, resolve: callbacks.resolve }
}

// While GATE exists, releasing the learning library lock waits a second of mock clock, so a second writer arrives
// mid-update. The plugin runs in its own realm without this module's bindings, hence the literal paths.
const GATE = `${HOME}/lock-gate`
const LOCK_GATE: Plugin = {
  name: 'learning-lock-gate',
  register(on) {
    on('process.run', async ($, e, next) => {
      const releasing = e.argv[0] === 'rmdir' && e.argv[1] === '/home/learner/.claude/dag-workflow/learning/.lock'
      if (releasing && await $.fs.exists('/home/learner/lock-gate')) await $.clock.sleep(1_000)
      return next(e)
    })
  },
}

test('a non-DAG main turn learns and persists a reusable skill without recursive learning', async ($, on) => {
  const h = harness(on, { home: HOME })
  await boot($, 'off')
  await ask($)
  await complete($, 'The test now subscribes before triggering the operation.')
  const batch = session(h).batch
  expect(h.spawns.length).toBe(1)
  expect(h.spawns[0]?.background).toBe(true)
  if (!batch) throw new Error('Missing learning batch')
  await complete($, JSON.stringify({ skills: [proposal(h)] }), batch.agentId)
  expect(library(h).skills[0]?.history[0]?.sessionId).toBe('source')
  const saved = library(h).skills[0]
  if (!saved) throw new Error('Missing learned skill')
  expect(h.files.get(LOCAL)).toBe(renderLearnedSkill(saved))
  expect(session(h).batch).toBeUndefined()
  expect(h.spawns.length).toBe(1)
})

test('normal non-DAG subagent tool outcomes reach the learning batch', async ($, on) => {
  const h = harness(on, { home: HOME })
  await boot($, 'off')
  await ask($)
  const read = { tool: 'Read', file_path: '/work/test.ts', agentId: 'ordinary-worker' } as const
  await $.tool.call(read)
  await complete($, 'A completion signal fixed the race.', 'ordinary-worker')
  await command($, 'learn')
  const events = session(h).batch?.events ?? []
  expect(events.some(event => event.kind === 'tool' && event.agentId === 'ordinary-worker')).toBe(true)
  expect(events.some(event => event.kind === 'assistant' && event.agentId === 'ordinary-worker')).toBe(true)
})

test('learning agents cannot execute tools and their answers are not collected', async ($, on) => {
  const h = harness(on, { home: HOME })
  await boot($, 'off')
  await ask($)
  await complete($, 'Use subscribed signals.')
  const agentId = session(h).batch?.agentId
  if (!agentId) throw new Error('Missing learner')
  const write = { tool: 'Write', file_path: '/work/unwanted.ts', content: 'unwanted', agentId } as const
  const reply = await $.tool.call(write)
  expect(typeof reply.deny).toBe('string')
  await complete($, '{"skills":[]}', agentId)
  expect(session(h).events.some(event => event.agentId === agentId)).toBe(false)
})

test('invalid evidence cannot create a skill and remains available for relearning', async ($, on) => {
  const h = harness(on, { home: HOME })
  await boot($, 'off')
  await ask($)
  await complete($, 'Fixed.')
  const agentId = session(h).batch?.agentId
  if (!agentId) throw new Error('Missing learner')
  await complete($, JSON.stringify({ skills: [proposal(h, { evidence: ['fabricated'] })] }), agentId)
  expect(h.files.has(LOCAL)).toBe(false)
  expect(session(h).learnedThrough).toBe(0)
  await command($, 'learn')
  expect(h.spawns.length).toBe(2)
})

test('a later session receives learned paths and successful Read records use', async ($, on) => {
  const h = harness(on, { home: HOME })
  seed(h)
  h.control.sessionId = 'later'
  await boot($, 'off')
  await ask($)
  const block = h.submits.at(-1)?.context.find(text => text.includes('"kind":"learned-skills"'))
  expect(block ? JSON.parse(block).skills[0].path : undefined).toBe(PATH)
  await $.tool.call({ tool: 'Read', file_path: PATH })
  expect(library(h).skills[0]?.uses).toBe(1)
  expect(library(h).skills[0]?.opportunities).toBe(0)
})

test('another project receives global skills but not project-scoped ones', async ($, on) => {
  const h = harness(on, { home: HOME })
  seed(h, 'project', '/elsewhere')
  await boot($, 'off')
  await ask($)
  expect(h.submits.at(-1)?.context.some(text => text.includes('"kind":"learned-skills"'))).toBe(false)
  seed(h, 'global', '/elsewhere')
  await ask($)
  const block = h.submits.at(-1)?.context.find(text => text.includes('"kind":"learned-skills"'))
  expect(block ? JSON.parse(block).skills[0].id : undefined).toBe(SKILL)
})

test('unused managed skills are archived while unrelated user skills remain', { options: { learning_min_opportunities: 1 } }, async ($, on) => {
  const h = harness(on, { home: HOME })
  seed(h)
  const custom = `${HOME}/.claude/skills/custom/SKILL.md`
  h.files.set(custom, 'Custom user instructions')
  await boot($, 'off')
  await ask($)
  await ask($)
  expect(library(h).skills[0]?.archived).toBe(true)
  expect(h.files.has(PATH)).toBe(false)
  expect(h.files.has(`${ROOT}/archive/${SKILL}/SKILL.md`)).toBe(true)
  expect(h.files.get(custom)).toBe('Custom user instructions')
})

test('bounded turn evidence and the completed learning cursor survive session resume', async ($, on) => {
  const h = harness(on, { home: HOME })
  seed(h)
  await boot($, 'off')
  await ask($, 'x'.repeat(10_000))
  await complete($, 'Use signals.')
  const saved = session(h)
  expect(saved.events.every(event => event.text.length <= 4000)).toBe(true)
  expect(saved.batch?.baseline.length).toBe(1)
  const agentId = saved.batch?.agentId
  if (!agentId) throw new Error('Missing learner')
  await complete($, JSON.stringify({ skills: [proposal(h)] }), agentId)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(session(h).learnedThrough).toBeGreaterThan(0)
  expect(h.spawns.length).toBe(1)
})

test('a conflicting concurrent update preserves the latest skill and relearning evidence', async ($, on) => {
  const h = harness(on, { home: HOME })
  seed(h)
  await boot($, 'off')
  await ask($)
  await complete($, 'Use a signal.')
  const incoming = proposal(h)
  const current = library(h)
  const changed = current.skills[0]
  if (!changed) throw new Error('Missing skill')
  changed.body = 'New instruction from another session.'
  changed.revision = 'concurrent-revision'
  h.files.set(`${ROOT}/library.json`, JSON.stringify(current))
  h.files.set(PATH, renderLearnedSkill(changed))
  const agentId = session(h).batch?.agentId
  if (!agentId) throw new Error('Missing learner')
  await complete($, JSON.stringify({ skills: [incoming] }), agentId)
  expect(library(h).skills[0]?.revision).toBe('concurrent-revision')
  expect(session(h).learnedThrough).toBe(0)
})

test('manual edits to managed skills are preserved rather than overwritten', async ($, on) => {
  const h = harness(on, { home: HOME })
  seed(h)
  await boot($, 'off')
  await ask($)
  await complete($, 'Use signals.')
  h.files.set(PATH, 'Manually revised skill')
  const agentId = session(h).batch?.agentId
  if (!agentId) throw new Error('Missing learner')
  await complete($, JSON.stringify({ skills: [proposal(h)] }), agentId)
  expect(h.files.get(PATH)).toBe('Manually revised skill')
  expect(session(h).learnedThrough).toBe(0)
})

test('learning disabled in config collects nothing and starts no agent', { options: { session_learning: false } }, async ($, on) => {
  const h = harness(on, { home: HOME })
  await boot($, 'off')
  await ask($)
  await complete($, 'No learning requested.')
  expect(h.spawns.length).toBe(0)
  expect([...h.files.keys()].some(path => path.startsWith(ROOT))).toBe(false)
})

test('only the user can disable learning and disabling removes reuse context', async ($, on) => {
  const h = harness(on, { home: HOME })
  seed(h)
  await boot($, 'off')
  await $.command.run({ command: 'dag', args: 'learning off', origin: { kind: 'plugin', name: 'test' }, presentation: { isFullscreen: false, columns: 80 } })
  await ask($)
  expect(h.submits.at(-1)?.context.some(text => text.includes('"kind":"learned-skills"'))).toBe(true)
  await command($, 'learning off')
  await ask($)
  expect(h.submits.at(-1)?.context.some(text => text.includes('"kind":"learned-skills"'))).toBe(false)
  await complete($, 'No learning.')
  expect(h.spawns.length).toBe(0)
})

test('a worker boundary starts learning at the interval even without a DAG', { options: { learning_interval: 1 } }, async ($, on) => {
  const h = harness(on, { home: HOME })
  await boot($, 'off')
  await ask($)
  const read = { tool: 'Read', file_path: '/work/test.ts', agentId: 'ordinary-worker' } as const
  await $.tool.call(read)
  await complete($, 'The test passed.', 'ordinary-worker')
  expect(h.spawns.length).toBe(1)
  expect(session(h).batch?.events.some(event => event.agentId === 'ordinary-worker')).toBe(true)
})

test('a user turn completed during learning is learned after the first batch finishes', async ($, on) => {
  const h = harness(on, { home: HOME })
  await boot($, 'off')
  await ask($, 'Use completion signals.')
  await complete($, 'Applied.')
  const first = session(h).batch
  if (!first) throw new Error('Missing first learner')
  await ask($, 'Subscribe before triggering the action.')
  await complete($, 'Applied the ordering correction.')
  expect(h.spawns.length).toBe(1)
  await complete($, '{"skills":[]}', first.agentId)
  expect(h.spawns.length).toBe(2)
  const second = session(h).batch
  expect(second?.events.some(event => event.kind === 'user' && event.text === 'Subscribe before triggering the action.')).toBe(true)
  expect(second?.events.some(event => event.agentId === first.agentId)).toBe(false)
})

test('resuming an active learning batch reuses its agent rather than starting a duplicate', async ($, on) => {
  const h = harness(on, { home: HOME })
  await boot($, 'off')
  await ask($)
  await complete($, 'Use signals.')
  const batch = session(h).batch
  if (!batch) throw new Error('Missing learner')
  h.control.liveAgents = [{ id: batch.agentId, description: 'Session learning', type: 'general-purpose', status: 'running' }]
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await command($, 'learn')
  expect(h.spawns.length).toBe(1)
  expect(session(h).batch?.agentId).toBe(batch.agentId)
})

test('a discovered project-scoped Skill cannot be loaded from another project', async ($, on) => {
  const h = harness(on, { home: HOME })
  seed(h, 'project', '/elsewhere')
  await boot($, 'off')
  const reply = await $.tool.call({ tool: 'Skill', skill: SKILL })
  expect(typeof reply.deny).toBe('string')
  expect(library(h).skills[0]?.uses).toBe(0)
})

test('learning session write failures do not prevent DAG worker completion', async ($, on) => {
  const h = harness(on, { home: HOME })
  await boot($)
  const runId = await start($, { key: 'learning-save-failure', nodes: [{
    id: 'work', prompt: 'Produce the result', verify: [{ kind: 'command', argv: ['check-control'] }],
  }] })
  h.writeErrors.set(`${ROOT}/sessions/${hash(h.control.sessionId)}.json`, 'Learning storage unavailable')
  await complete($, 'DAG_NODE_STATUS: completed', 'agent-1')
  expect(checkpoint(h, runId).status).toBe('completed')
})

test('a failed library publication is recoverable without treating the generated skill as unmanaged', async ($, on) => {
  const h = harness(on, { home: HOME })
  await boot($, 'off')
  await ask($)
  await complete($, 'Subscribe before triggering work.')
  const first = session(h).batch
  if (!first) throw new Error('Missing first learner')
  h.writeErrors.set(`${ROOT}/library.json`, 'Library storage unavailable')
  await complete($, JSON.stringify({ skills: [proposal(h)] }), first.agentId)
  h.writeErrors.clear()
  await command($, 'learn')
  const second = session(h).batch
  if (!second) throw new Error('Missing retry learner')
  await complete($, JSON.stringify({ skills: [proposal(h)] }), second.agentId)
  expect(library(h).skills[0]?.id).toBe(SKILL)
  expect(session(h).learnedThrough).toBeGreaterThan(0)
})

test('a long turn retains the user request after eighty tool calls', async ($, on) => {
  const h = harness(on, { home: HOME })
  await boot($, 'off')
  await ask($)
  for (let i = 0; i < 80; i++) await $.tool.call({ tool: 'Read', file_path: `/work/file-${i}.ts` })
  await complete($, 'The long task completed.')
  expect(h.spawns.length).toBe(1)
  expect(session(h).batch?.events.some(event => event.kind === 'user')).toBe(true)
})

// The 2026-10-22 GitHub CI run took 11.3 s for the session-learning test against the 5 s default, so these slow tests get 30 s.
test('the character bound retains the user request through large worker reports', { timeoutMs: 30_000 }, async ($, on) => {
  const h = harness(on, { home: HOME })
  await boot($, 'off')
  await ask($)
  for (let i = 0; i < 18; i++) await complete($, 'x'.repeat(5000), `ordinary-${i}`)
  await complete($, 'The long task completed.')
  expect(h.spawns.length).toBe(1)
  expect(session(h).batch?.events.some(event => event.kind === 'user')).toBe(true)
})

test('the batch cursor does not consume a correction received while the learner starts', async ($, on) => {
  const h = harness(on, { home: HOME })
  await boot($, 'off')
  await ask($)
  const entered = signal()
  const released = signal()
  h.control.beforeSpawn = async () => {
    entered.resolve()
    await released.promise
  }
  const finishing = complete($, 'The first task completed.')
  await entered.promise
  await ask($, 'New correction while the learner is starting.')
  released.resolve()
  await finishing
  const batch = session(h).batch
  if (!batch) throw new Error('Missing learner')
  expect(batch.through).toBe(Math.max(...batch.events.map(event => Number(event.id.split(':').at(-1)))))
  expect(session(h).events.some(event => Number(event.id.split(':').at(-1)) > batch.through)).toBe(true)
})

test('an ordinary agent started alongside learning keeps its normal tool access', async ($, on) => {
  const h = harness(on, { home: HOME })
  await boot($, 'off')
  await ask($)
  const entered = signal()
  const released = signal()
  h.control.beforeSpawn = async () => {
    entered.resolve()
    await released.promise
  }
  const finishing = complete($, 'The first task completed.')
  await entered.promise
  h.control.beforeSpawn = undefined
  const ordinary = await $.agent.spawn({
    tool_use_id: 'ordinary-spawn', prompt: 'Ordinary work', description: 'Ordinary worker', subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'sonnet', background: true, fork: false,
  })
  if (!ordinary.agentId) throw new Error('Missing ordinary worker')
  const write = { tool: 'Write', file_path: '/work/ordinary.ts', content: 'export const value = 1', agentId: ordinary.agentId } as const
  const reply = await $.tool.call(write)
  released.resolve()
  await finishing
  expect(reply.deny).toBeUndefined()
  expect(session(h).batch?.agentId).not.toBe(ordinary.agentId)
})

test('a learning completion reaches the underlying host lifecycle', async ($, on) => {
  const h = harness(on, { home: HOME })
  await boot($, 'off')
  await ask($)
  await complete($, 'The task completed.')
  const batch = session(h).batch
  if (!batch) throw new Error('Missing learner')
  await complete($, '{"skills":[]}', batch.agentId)
  expect(h.completedTurns.some(turn => turn.agentId === batch.agentId)).toBe(true)
})

test('automatic limits survive another session while a user command can learn manually', { options: { learning_max_daily_runs: 1 } }, async ($, on) => {
  const h = harness(on, { home: HOME })
  await boot($, 'off')
  await ask($)
  await complete($, 'Applied.')
  const first = session(h).batch
  if (!first) throw new Error('Missing first learner')
  await complete($, '{"skills":[]}', first.agentId)
  h.control.sessionId = 'second-session'
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await ask($)
  await complete($, 'A second session completed.')
  expect(h.spawns.length).toBe(1)
  expect(library(h).usage?.runs).toBe(1)
  await command($, 'learn')
  expect(h.spawns.length).toBe(2)
  expect(library(h).usage?.runs).toBe(1)
})

test('a plugin-origin learning command cannot bypass the shared daily limit', { options: { learning_max_daily_runs: 1 } }, async ($, on) => {
  const h = harness(on, { home: HOME })
  seed(h)
  const existing = library(h)
  h.files.set(`${ROOT}/library.json`, JSON.stringify({ ...existing, usage: { day: 0, runs: 1 } }))
  await boot($, 'off')
  await ask($)
  await $.command.run({ command: 'dag', args: 'learn', origin: { kind: 'plugin', name: 'test' }, presentation: { isFullscreen: false, columns: 80 } })
  expect(h.spawns.length).toBe(0)
  expect(library(h).usage?.runs).toBe(1)
})

test('a restart completes a pending publication before exposing the skill', async ($, on) => {
  const h = harness(on, { home: HOME })
  await boot($, 'off')
  await ask($)
  await complete($, 'Use signals.')
  const batch = session(h).batch
  if (!batch) throw new Error('Missing learner')
  h.writeErrors.set(`${ROOT}/library.json`, 'Interrupted index write')
  await complete($, JSON.stringify({ skills: [proposal(h)] }), batch.agentId)
  expect(h.files.has(`${ROOT}/pending.json`)).toBe(true)
  h.writeErrors.clear()
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(library(h).skills[0]?.id).toBe(SKILL)
  expect(h.files.has(`${ROOT}/pending.json`)).toBe(false)
  await ask($)
  const block = h.submits.at(-1)?.context.find(text => text.includes('"kind":"learned-skills"'))
  expect(block ? JSON.parse(block).skills[0].path : undefined).toBe(LOCAL)
})

test('publication recovery preserves a manual edit and still finishes so later learning is not blocked', async ($, on) => {
  const h = harness(on, { home: HOME })
  await boot($, 'off')
  await ask($)
  await complete($, 'Use signals.')
  const batch = session(h).batch
  if (!batch) throw new Error('Missing learner')
  h.writeErrors.set(`${ROOT}/library.json`, 'Interrupted index write')
  await complete($, JSON.stringify({ skills: [proposal(h)] }), batch.agentId)
  h.writeErrors.clear()
  h.files.set(LOCAL, 'Manual edit after interrupted publication')
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  expect(h.files.get(LOCAL)).toBe('Manual edit after interrupted publication')
  expect(h.files.has(`${ROOT}/pending.json`)).toBe(false)
  expect(library(h).skills[0]?.id).toBe(SKILL)
  await ask($)
  expect(library(h).skills[0]?.opportunities).toBe(1)
})

test('a failed learning batch waits for new tool calls instead of respawning at every turn boundary', { options: { learning_interval: 1 } }, async ($, on) => {
  const h = harness(on, { home: HOME })
  await boot($, 'off')
  await ask($)
  const read = { tool: 'Read', file_path: '/work/test.ts', agentId: 'ordinary-worker' } as const
  await $.tool.call(read)
  await complete($, 'Use signals.')
  const batch = session(h).batch
  if (!batch) throw new Error('Missing learner')
  await complete($, 'not proposal json', batch.agentId)
  await complete($, 'Worker finished.', 'ordinary-worker')
  expect(h.spawns.length).toBe(1)
  expect(session(h).learnedThrough).toBe(0)
  await $.tool.call(read)
  await complete($, 'Worker finished again.', 'ordinary-worker')
  expect(h.spawns.length).toBe(2)
})

test('a proposal that masking pushes past its length limit keeps its evidence instead of reporting success', async ($, on) => {
  const h = harness(on, { home: HOME })
  await boot($, 'off')
  await ask($)
  await complete($, 'Use signals.')
  const batch = session(h).batch
  if (!batch) throw new Error('Missing learner')
  const description = `${'Use signals. '.repeat(37)}token=abc`
  expect(description.length).toBeLessThanOrEqual(500)
  await complete($, JSON.stringify({ skills: [proposal(h, { description })] }), batch.agentId)
  expect(h.files.has(LOCAL)).toBe(false)
  expect(session(h).learnedThrough).toBe(0)
  expect(h.logs.some(line => line.includes('saved 1 skill proposal'))).toBe(false)
})

test('learning status shows only this project\'s skills and leaves bodies in their files', async ($, on) => {
  const h = harness(on, { home: HOME })
  seed(h, 'project', '/elsewhere')
  await boot($, 'off')
  const status = await $.command.run({ command: 'dag', args: 'learning', origin: { kind: 'plugin', name: 'test' }, presentation: { isFullscreen: false, columns: 80 } })
  const shown = JSON.parse(status.text ?? '{}')
  expect(shown.skills).toEqual([])
  seed(h, 'global', '/elsewhere')
  const global = JSON.parse((await command($, 'learning')).text ?? '{}')
  expect(global.skills.map((skill: { id: string }) => skill.id)).toEqual([SKILL])
  expect(global.skills[0].body).toBeUndefined()
})

test('retention removes old inactive evidence and archives but protects current sessions and running batches', async ($, on) => {
  const h = harness(on, { home: HOME, now: 31 * 86_400_000 })
  seed(h)
  const seeded = library(h)
  const old = seeded.skills[0]
  if (!old) throw new Error('Missing seeded skill')
  old.archived = true
  h.files.delete(PATH)
  h.files.set(`${ROOT}/archive/${SKILL}/SKILL.md`, renderLearnedSkill(old))
  h.files.set(`${ROOT}/library.json`, JSON.stringify(seeded))
  const saved = (id: string) => ({
    schemaVersion: 1, events: [{ id: `${hash(id)}:1`, sessionId: id, projectRoot: '/work', kind: 'user', text: 'Previous request', at: 1 }],
    nextId: 2, toolsSinceLearn: 0, learnedThrough: 1,
  })
  const inactive = `${ROOT}/sessions/${hash('inactive')}.json`
  const running = `${ROOT}/sessions/${hash('running')}.json`
  const current = `${ROOT}/sessions/${hash('source')}.json`
  const activeState = saved('running')
  h.files.set(inactive, JSON.stringify(saved('inactive')))
  h.files.set(current, JSON.stringify(saved('source')))
  h.files.set(running, JSON.stringify({ ...activeState, batch: { agentId: 'live-other-session', events: activeState.events, baseline: [], through: 1 } }))
  await boot($, 'off')
  expect(h.files.has(inactive)).toBe(false)
  expect(h.files.has(current)).toBe(true)
  expect(h.files.has(running)).toBe(true)
  expect(h.files.has(`${ROOT}/archive/${SKILL}/SKILL.md`)).toBe(false)
  expect(library(h).skills.length).toBe(0)
})

test('retention keeps manually changed archive files and active skills', async ($, on) => {
  const h = harness(on, { home: HOME, now: 31 * 86_400_000 })
  seed(h)
  const seeded = library(h)
  const active = seeded.skills[0]
  if (!active) throw new Error('Missing seeded skill')
  seeded.skills.push({ ...active, id: 'dag-learned-old-manual', archived: true })
  const archived = `${ROOT}/archive/dag-learned-old-manual/SKILL.md`
  h.files.set(archived, 'Manual archive revision')
  h.files.set(`${ROOT}/library.json`, JSON.stringify(seeded))
  await boot($, 'off')
  expect(h.files.get(archived)).toBe('Manual archive revision')
  expect(h.files.has(PATH)).toBe(true)
  expect(library(h).skills.length).toBe(2)
})

test('a prompt that arrives while this session holds the library lock waits instead of dropping its exposure', { plugins: [LOCK_GATE] }, async ($, on) => {
  const h = harness(on, { home: HOME })
  seed(h)
  await boot($, 'off')
  await ask($)
  h.files.set(GATE, '')
  const learning = command($, 'learn')
  await h.clock.settle()
  expect(h.locks.has(`${ROOT}/.lock`)).toBe(true)
  h.files.delete(GATE)
  const asking = ask($)
  await h.clock.settle()
  await h.clock.advance(1_000)
  await Promise.all([learning, asking])
  expect(h.logs.filter(line => line.includes('busy'))).toEqual([])
  expect(library(h).skills[0]?.opportunities).toBe(2)
})

test('archiving and retention leave no empty skill folders behind', { options: { learning_min_opportunities: 1 } }, async ($, on) => {
  const h = harness(on, { home: HOME, now: 31 * 86_400_000 })
  const folder = LOCAL.slice(0, -'/SKILL.md'.length)
  const archive = LOCAL_ARCHIVE.slice(0, -'/SKILL.md'.length)
  await boot($, 'off')
  await ask($)
  await complete($, 'Use signals.')
  const batch = session(h).batch
  if (!batch) throw new Error('Missing learner')
  await complete($, JSON.stringify({ skills: [proposal(h)] }), batch.agentId)
  expect(h.locks.has(folder)).toBe(true)
  await ask($)
  await ask($)
  expect(library(h).skills[0]?.archived).toBe(true)
  expect(h.locks.has(folder)).toBe(false)
  expect(h.locks.has(archive)).toBe(true)
  const archived = library(h)
  for (const skill of archived.skills) Object.assign(skill, { createdAt: 1, updatedAt: 1 })
  h.files.set(`${ROOT}/library.json`, JSON.stringify(archived))
  await command($, 'learning prune')
  expect(library(h).skills.length).toBe(0)
  expect(h.locks.has(archive)).toBe(false)
})

test('a newly learned skill goes to the project store with its ignore file and nothing to the home skills folder', async ($, on) => {
  const h = harness(on, { home: HOME })
  await boot($, 'off')
  await ask($)
  await complete($, 'The test now subscribes before triggering the operation.')
  const batch = session(h).batch
  if (!batch) throw new Error('Missing learning batch')
  expect(h.files.has(`${DAG}/.gitignore`)).toBe(false)
  await complete($, JSON.stringify({ skills: [proposal(h, { scope: 'global' })] }), batch.agentId)
  const saved = library(h).skills[0]
  if (!saved) throw new Error('Missing learned skill')
  expect([saved.scope, saved.location, saved.projectRoot]).toEqual(['project', 'project', '/work'])
  expect(h.files.get(LOCAL)).toBe(renderLearnedSkill(saved))
  expect(h.files.get(`${DAG}/.gitignore`)).toBe('# dag-workflow run checkpoints and node reports\n*\n')
  expect(homeSkillEntries(h)).toEqual([])
})

test('an archived project skill moves to the project learning archive', { options: { learning_min_opportunities: 1 } }, async ($, on) => {
  const h = harness(on, { home: HOME })
  await boot($, 'off')
  await ask($)
  await complete($, 'Use signals.')
  const batch = session(h).batch
  if (!batch) throw new Error('Missing learner')
  await complete($, JSON.stringify({ skills: [proposal(h)] }), batch.agentId)
  const learned = library(h).skills[0]
  if (!learned) throw new Error('Missing learned skill')
  await ask($)
  await ask($)
  expect(library(h).skills[0]?.archived).toBe(true)
  expect(h.files.has(LOCAL)).toBe(false)
  expect(h.files.get(LOCAL_ARCHIVE)).toBe(renderLearnedSkill(learned))
  expect(h.files.has(`${ROOT}/archive/${SKILL}/SKILL.md`)).toBe(false)
})

test('a legacy skill without location is still updated in the home skills folder', async ($, on) => {
  const h = harness(on, { home: HOME })
  seed(h)
  await boot($, 'off')
  await ask($)
  await complete($, 'Use signals.')
  const batch = session(h).batch
  if (!batch) throw new Error('Missing learner')
  await complete($, JSON.stringify({ skills: [proposal(h, { body: 'Updated legacy instructions.' })] }), batch.agentId)
  const updated = library(h).skills[0]
  if (!updated) throw new Error('Missing updated skill')
  expect(updated.body).toBe('Updated legacy instructions.')
  expect(Object.hasOwn(updated, 'location')).toBe(false)
  expect(h.files.get(PATH)).toBe(renderLearnedSkill(updated))
  expect(h.files.has(LOCAL)).toBe(false)
})

test('a later session receives a project skill path and a Read of it records use', async ($, on) => {
  const h = harness(on, { home: HOME })
  const skill: LearnedSkill = { ...seededSkill('project', '/work'), location: 'project' }
  h.files.set(`${ROOT}/library.json`, JSON.stringify({ schemaVersion: 1, skills: [skill] }))
  h.files.set(LOCAL, renderLearnedSkill(skill))
  h.control.sessionId = 'later'
  await boot($, 'off')
  await ask($)
  const block = h.submits.at(-1)?.context.find(text => text.includes('"kind":"learned-skills"'))
  expect(block ? JSON.parse(block).skills[0].path : undefined).toBe(LOCAL)
  await $.tool.call({ tool: 'Read', file_path: LOCAL })
  expect(library(h).skills[0]?.uses).toBe(1)
})
