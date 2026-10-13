import { expect, test } from 'claude-code/testing'
import {
  applyLearningProposals, archiveUnusedSkills, buildLearningPrompt, eligibleSkills,
  emptyLearningSession, emptyLibrary, learningCatalog, parseLearningLibrary,
  parseLearningProposals, parseLearningSession, recordSkillOpportunity, recordSkillUse,
  renderLearnedSkill, type LearnedSkill, type LearningEvent, type LearningLibrary,
  type LearningProposal,
} from '../hooks/engine/learning.ts'
import { hash } from '../hooks/engine/hash.ts'
import { parseYaml } from '../hooks/engine/yaml.ts'
import type { Result } from '../hooks/engine/types.ts'

const root = '/project'
const events: LearningEvent[] = [
  { id: 'e1', sessionId: 's', projectRoot: root, kind: 'user', text: 'Use a signal instead of a sleep.', at: 1 },
  { id: 'e2', sessionId: 's', projectRoot: root, kind: 'tool', text: 'Tests passed.', at: 2, agentId: 'worker' },
]
const context = { events, sessionId: 's', projectRoot: root, now: 10 }

function proposal(overrides: Partial<LearningProposal> = {}): LearningProposal {
  return {
    id: 'dag-learned-signals', description: 'Async tests', body: 'Await a subscribed completion signal.',
    scope: 'project', reason: 'Avoid timing luck', evidence: ['e1', 'e2'], replaces: [], ...overrides,
  }
}

function skill(overrides: Partial<LearnedSkill> = {}): LearnedSkill {
  return {
    id: 'dag-learned-signals', description: 'Async tests', body: 'Subscribe first.', scope: 'project',
    projectRoot: root, revision: 'old', createdAt: 1, updatedAt: 2, opportunities: 0, uses: 0,
    archived: false, history: [{ sessionId: 'old', at: 1, reason: 'Correction', evidence: ['old-event'] }],
    ...overrides,
  }
}

function library(...skills: LearnedSkill[]): LearningLibrary {
  return { schemaVersion: 1, skills }
}

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

function parse(proposals: unknown[], existing: LearnedSkill[] = []) {
  return parseLearningProposals(JSON.stringify({ skills: proposals }), events, existing)
}

test('learning library round trips active and archived skill state', () => {
  const input = library(skill({ lastUsedAt: 2 }), skill({ id: 'dag-learned-other', archived: true }))
  const parsed = value(parseLearningLibrary(JSON.stringify(input)))
  expect(parsed).toEqual(input)
  expect(emptyLibrary()).toEqual({ schemaVersion: 1, skills: [] })
})

test('learning library rejects malformed saved fields and unmanaged ids', () => {
  const invalid = [
    { id: '../escape' }, { id: 'custom' }, { scope: 'team' }, { body: '---\nname: other\n---' },
    { revision: '' }, { projectRoot: '' }, { uses: -1 }, { opportunities: 0.5 },
    { createdAt: null }, { updatedAt: 0 }, { archived: 'false' }, { lastUsedAt: null },
    { history: [{}] }, { history: Array.from({ length: 21 }, () => skill().history[0]) },
    { description: 'a'.repeat(501) }, { body: 'b'.repeat(12_001) }, { unexpected: true },
  ]
  for (const change of invalid) expect(parseLearningLibrary(JSON.stringify({ schemaVersion: 1, skills: [{ ...skill(), ...change }] })).ok).toBe(false)
  for (const input of ['no JSON', '{}', '{"schemaVersion":2,"skills":[]}', JSON.stringify(library(skill(), skill())),
    '{"schemaVersion":1,"skills":[],"extra":1}']) expect(parseLearningLibrary(input).ok).toBe(false)
})

test('proposal parser accepts plain JSON and one complete json fence', () => {
  const { replaces, ...input } = proposal()
  const answer = JSON.stringify({ skills: [input] })
  for (const text of [answer, '```json\n' + answer + '\n```']) {
    expect(value(parseLearningProposals(text, events, []))).toEqual([proposal()])
  }
})

test('proposal parser rejects mixed prose fences and extra envelope fields', () => {
  const answer = JSON.stringify({ skills: [proposal()] })
  for (const input of ['Before\n' + answer, '```json\n' + answer + '\n```\nAfter',
    '```\n' + answer + '\n```', '```json\n' + answer + '\n```\n```json\n{}\n```',
    JSON.stringify({ skills: [], extra: true })]) {
    expect(parseLearningProposals(input, events, []).ok).toBe(false)
  }
})

test('proposal parser rejects unsafe ids invalid scope content and limits', () => {
  for (const change of [
    { id: 'dag-learned-../escape' }, { id: 'dag-learned-X' }, { id: 'dag-learned-' },
    { id: 'dag-learned-' + 'a'.repeat(69) }, { scope: 'team' }, { description: '' },
    { description: 'a'.repeat(501) }, { body: 'b'.repeat(12_001) }, { reason: 'r'.repeat(1001) },
    { body: ' \n---\nname: escaped\n---' }, { body: '\0' }, { unexpected: true }, { reason: ' ' },
  ]) expect(parse([{ ...proposal(), ...change }]).ok).toBe(false)
  expect(parse(Array.from({ length: 4 }, (_, i) => proposal({ id: `dag-learned-${i}` }))).ok).toBe(false)
})

test('proposal evidence must be nonempty unique supplied event ids', () => {
  for (const evidence of [[], ['missing'], ['e1', 'missing'], ['e1', 'e1'], [3]]) {
    expect(parse([{ ...proposal(), evidence }]).ok).toBe(false)
  }
  expect(parseLearningProposals(JSON.stringify({ skills: [proposal()] }), [], []).ok).toBe(false)
})

test('proposal parser rejects collisions with foreign archived and differently scoped skills', () => {
  for (const previous of [
    skill({ projectRoot: '/other' }), skill({ archived: true }), skill({ scope: 'global' }),
  ]) expect(parse([proposal()], [previous]).ok).toBe(false)
  expect(parse([proposal({ scope: 'global' })], [skill({ scope: 'global', projectRoot: '/other' })]).ok).toBe(true)
})

test('proposal replacement requires active managed same scope targets', () => {
  const incoming = proposal({ id: 'dag-learned-new', replaces: ['dag-learned-signals'] })
  for (const previous of [skill({ archived: true }), skill({ projectRoot: '/other' }), skill({ scope: 'global' }), skill({ id: 'custom' })]) {
    expect(parse([incoming], [previous]).ok).toBe(false)
  }
  expect(parse([incoming], [skill()]).ok).toBe(true)
  expect(parse([proposal({ replaces: ['unknown'] })], [skill()]).ok).toBe(false)
})

test('proposal batches reject duplicate ids and proposed replacement targets', () => {
  expect(parse([proposal(), proposal()]).ok).toBe(false)
  expect(parse([proposal(), proposal({ id: 'dag-learned-new', replaces: [proposal().id] })], [skill()]).ok).toBe(false)
})

test('apply creates deterministic revision and history without mutating input', () => {
  const input = emptyLibrary()
  const result = applyLearningProposals(input, [proposal()], context)
  const learned = result.skills[0]
  expect(learned?.projectRoot).toBe(root)
  expect(learned?.history).toEqual([{ sessionId: 's', at: 10, reason: proposal().reason, evidence: ['e1', 'e2'] }])
  expect(learned?.createdAt).toBe(10)
  if (!learned) throw new Error('Expected learned skill')
  expect(learned.revision).toBe(hash(JSON.stringify([renderLearnedSkill(learned), 'project', root])))
  expect(applyLearningProposals(input, [proposal()], context)).toEqual(result)
  expect(input.skills).toEqual([])
})

test('apply updates content and caps history while preserving origin and use counters', () => {
  const previous = skill({
    scope: 'global', projectRoot: '/origin', opportunities: 3, uses: 2, lastUsedAt: 5,
    history: Array.from({ length: 20 }, (_, i) => ({ sessionId: `s${i}`, at: i, reason: 'Correction', evidence: [`e${i}`] })),
  })
  const result = applyLearningProposals(library(previous), [proposal({ scope: 'global' })], context).skills[0]
  expect(result?.history.length).toBe(20)
  expect(result?.history[0]?.sessionId).toBe('s1')
  expect(result?.history[19]?.evidence).toEqual(['e1', 'e2'])
  expect(result?.projectRoot).toBe('/origin')
  expect(result?.createdAt).toBe(1)
  expect([result?.opportunities, result?.uses, result?.lastUsedAt]).toEqual([3, 2, 5])
  expect(result?.revision === previous.revision).toBe(false)
  expect(previous.history.length).toBe(20)
})

test('apply archives merged skills instead of deleting them', () => {
  const previous = skill()
  const result = applyLearningProposals(library(previous), [proposal({ id: 'dag-learned-merged', replaces: [previous.id] })], context)
  expect(result.skills.length).toBe(2)
  expect(result.skills[0]?.archived).toBe(true)
  expect(result.skills[0]?.history).toEqual(previous.history)
  expect(result.skills[1]?.archived).toBe(false)
  expect(previous.archived).toBe(false)
})

test('apply atomically rejects foreign evidence ownership changes and invalid batches', () => {
  const input = library(skill(), skill({ id: 'dag-learned-foreign', projectRoot: '/other' }))
  for (const proposals of [
    [proposal({ scope: 'global' })], [proposal({ id: 'dag-learned-foreign' })],
    [proposal(), proposal()], [proposal({ replaces: ['dag-learned-foreign'] })],
  ]) expect(applyLearningProposals(input, proposals, context)).toEqual(input)
  expect(applyLearningProposals(input, [proposal()], { ...context, sessionId: 'other' })).toEqual(input)
})

test('eligibility and catalog isolate projects archives and unmanaged skills', () => {
  const input = library(skill(), skill({ id: 'dag-learned-global', scope: 'global', projectRoot: '/other' }),
    skill({ id: 'dag-learned-foreign', projectRoot: '/other' }), skill({ id: 'dag-learned-old', archived: true }), skill({ id: 'custom' }))
  expect(eligibleSkills(input, root).map(skill => skill.id)).toEqual(['dag-learned-signals', 'dag-learned-global'])
  const catalog = JSON.parse(learningCatalog(input, root, '/skills/'))
  expect(catalog).toEqual({
    kind: 'learned-skills', loading: 'Read', skills: [
      { id: 'dag-learned-signals', description: 'Async tests', path: '/skills/dag-learned-signals/SKILL.md' },
      { id: 'dag-learned-global', description: 'Async tests', path: '/skills/dag-learned-global/SKILL.md' },
    ],
  })
})

test('opportunities increment only eligible skills without mutation', () => {
  const input = library(skill(), skill({ id: 'dag-learned-global', scope: 'global' }),
    skill({ id: 'dag-learned-foreign', projectRoot: '/other' }), skill({ id: 'dag-learned-old', archived: true }))
  const result = recordSkillOpportunity(input, root, 20)
  expect(result.skills.map(skill => skill.opportunities)).toEqual([1, 1, 0, 0])
  expect(input.skills.map(skill => skill.opportunities)).toEqual([0, 0, 0, 0])
})

test('use resets exposure and increments only the eligible requested skill', () => {
  const input = library(skill({ opportunities: 4, uses: 2 }))
  const result = recordSkillUse(input, 'dag-learned-signals', root, 20).skills[0]
  expect([result?.opportunities, result?.uses, result?.lastUsedAt]).toEqual([0, 3, 20])
  expect(recordSkillUse(input, 'dag-learned-signals', '/other', 20)).toEqual(input)
  expect(recordSkillUse(input, 'unknown', root, 20)).toEqual(input)
  expect(recordSkillUse(library(skill({ archived: true })), 'dag-learned-signals', root, 20).skills[0]?.uses).toBe(0)
})

test('retention archives threshold skills regardless of prior use and protects fresh foreign skills', () => {
  const input = library(skill({ opportunities: 3, uses: 2 }), skill({ id: 'dag-learned-fresh', opportunities: 0 }),
    skill({ id: 'dag-learned-foreign', projectRoot: '/other', opportunities: 5 }))
  const result = archiveUnusedSkills(input, { projectRoot: root, minOpportunities: 3, maxSkills: 0, now: 20 })
  expect(result.skills.map(skill => skill.archived)).toEqual([true, false, false])
  expect(result.skills[0]?.updatedAt).toBe(20)
  expect(input.skills[0]?.archived).toBe(false)
})

test('capacity eviction orders exposed skills by least used then oldest', () => {
  const input = library(
    skill({ id: 'dag-learned-recent', opportunities: 2, uses: 1, lastUsedAt: 8 }),
    skill({ id: 'dag-learned-old', opportunities: 2, uses: 1, lastUsedAt: 3 }),
    skill({ id: 'dag-learned-used', opportunities: 2, uses: 2 }),
    skill({ id: 'dag-learned-fresh', opportunities: 0 }),
  )
  const result = archiveUnusedSkills(input, { projectRoot: root, minOpportunities: 3, maxSkills: 2, now: 20 })
  expect(result.skills.map(skill => skill.archived)).toEqual([true, true, false, false])
  expect(archiveUnusedSkills(library(...[...input.skills].reverse()), {
    projectRoot: root, minOpportunities: 3, maxSkills: 2, now: 20,
  }).skills.filter(skill => skill.archived).map(skill => skill.id).sort()).toEqual(['dag-learned-old', 'dag-learned-recent'])
})

test('rendering quotes description fields and keeps body outside frontmatter', () => {
  const input = skill({ description: 'Quoted "name": value\nscope: global', body: '# Instructions\n\nDo the work.' })
  const rendered = renderLearnedSkill(input)
  const frontmatter = rendered.split('---\n')[1]
  expect(parseYaml(frontmatter ?? '')).toEqual({ name: input.id, description: input.description })
  expect(rendered.split('---\n')[2]?.trim()).toBe(input.body)
})

test('learning boundaries redact secrets in proposals and prompt data', () => {
  const secret = 'ghp_' + 'a'.repeat(30)
  const result = value(parse([proposal({ body: `Do not use ${secret}`, reason: `Remove ${secret}` })]))
  expect(result[0]?.body.includes(secret)).toBe(false)
  expect(result[0]?.reason.includes(secret)).toBe(false)
  const prompt = buildLearningPrompt([{ id: 'e', sessionId: 's',
    projectRoot: root, kind: 'user', at: 1, text: secret + 'a'.repeat(5000) }], [skill({ body: secret })])
  const data = JSON.parse(prompt.split('\n').slice(-1)[0] ?? '')
  expect(data.events[0].text.includes(secret)).toBe(false)
  expect(data.events[0].text.length < 4200).toBe(true)
  expect(data.existing[0].body.includes(secret)).toBe(false)
})

test('learning session round trips bounded events and an active batch', () => {
  const input = { ...emptyLearningSession(), events, nextId: 3, toolsSinceLearn: 1, learnedThrough: 1,
    batch: { agentId: 'learner', events, baseline: [skill()], through: 2 } }
  expect(value(parseLearningSession(JSON.stringify(input)))).toEqual(input)
  expect(value(parseLearningSession(JSON.stringify(emptyLearningSession())))).toEqual(emptyLearningSession())
})

test('learning session rejects malformed counters events and collection bounds', () => {
  const base = { ...emptyLearningSession(), nextId: 2, events }
  for (const change of [
    { nextId: -1 }, { toolsSinceLearn: 0.5 }, { learnedThrough: 3 }, { schemaVersion: 2 }, { extra: true },
    { events: [events[0], events[0]] }, { events: [{ ...events[0], kind: 'system' }] },
    { events: [{ ...events[0], text: 'a'.repeat(4001) }] }, { events: [{ ...events[0], at: null }] },
    { events: [{ ...events[0], agentId: 4 }] },
    { events: Array.from({ length: 81 }, (_, i) => ({ ...events[0], id: `e${i}` })) },
    { events: Array.from({ length: 16 }, (_, i) => ({ ...events[0], id: `e${i}`, text: 'a'.repeat(4000) })) },
  ]) expect(parseLearningSession(JSON.stringify({ ...base, ...change })).ok).toBe(false)
})

test('learning session rejects invalid active batch snapshots', () => {
  const batch = { agentId: 'a', events, baseline: [skill()], through: 2 }
  const base = { ...emptyLearningSession(), nextId: 3, learnedThrough: 1, events }
  for (const change of [
    { agentId: '' }, { through: 4 }, { through: 0 }, { extra: true },
    { baseline: [skill(), skill()] }, { events: [{ ...events[0], projectRoot: '/other' }] },
  ]) expect(parseLearningSession(JSON.stringify({ ...base, batch: { ...batch, ...change } })).ok).toBe(false)
})

test('active learning snapshots retain archived and cross-project collision records', () => {
  const baseline = Array.from({ length: 65 }, (_, i) => skill({ id: `dag-learned-${i}`, archived: i === 0, projectRoot: '/other' }))
  const input = { ...emptyLearningSession(), events, nextId: 3,
    batch: { agentId: 'learner', events, baseline, through: 2 } }
  expect(value(parseLearningSession(JSON.stringify(input))).batch?.baseline).toEqual(baseline)
})
