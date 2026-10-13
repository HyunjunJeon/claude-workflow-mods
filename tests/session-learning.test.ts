import { expect, test, type Engine } from 'claude-code/testing'
import { hash } from '../hooks/engine/hash.ts'
import { applyLearningProposals, emptyLibrary, parseLearningLibrary, parseLearningSession, renderLearnedSkill, type LearningLibrary, type LearningSession } from '../hooks/engine/learning.ts'
import { boot, command, harness } from './control-harness.ts'

const HOME = '/home/learner'
const ROOT = `${HOME}/.claude/dag-workflow/learning`
const SKILL = 'dag-learned-event-tests'
const PATH = `${HOME}/.claude/skills/${SKILL}/SKILL.md`
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

function seed(h: Harness, scope: 'project' | 'global' = 'project', projectRoot = '/work') {
  const events = [{ id: 'seed', sessionId: 'seed', projectRoot, kind: 'user' as const, text: 'Await completion signals.', at: 1 }]
  const seeded = applyLearningProposals(emptyLibrary(), [{
    id: SKILL, description: 'Writing asynchronous tests', body: 'Subscribe first.', scope,
    reason: 'Prior user correction', evidence: ['seed'], replaces: [],
  }], { events, sessionId: 'seed', projectRoot, now: 1 })
  h.files.set(`${ROOT}/library.json`, JSON.stringify(seeded))
  const skill = seeded.skills[0]
  if (!skill) throw new Error('Missing seeded skill')
  h.files.set(PATH, renderLearnedSkill(skill))
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
  expect(h.files.get(PATH)).toBe(renderLearnedSkill(saved))
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
  expect(h.files.has(PATH)).toBe(false)
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
