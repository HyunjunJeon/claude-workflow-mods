import { expect, test } from 'claude-code/testing'
import {
  appendLearningEvent, applyLearningProposals, archiveUnusedSkills, buildLearningPrompt, eligibleSkills,
  emptyLearningSession, emptyLibrary, learningCatalog, parseLearningLibrary,
  parseLearningProposals, parseLearningSession, parseLearningTransaction, prepareLearningBatch,
  recordSkillOpportunity, recordSkillUse, reserveLearningUsage,
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
  const result = value(applyLearningProposals(input, [proposal()], context))
  const learned = result.skills[0]
  expect(learned?.projectRoot).toBe(root)
  expect(learned?.history).toEqual([{ sessionId: 's', at: 10, reason: proposal().reason, evidence: ['e1', 'e2'] }])
  expect(learned?.createdAt).toBe(10)
  if (!learned) throw new Error('Expected learned skill')
  expect(learned.revision).toBe(hash(JSON.stringify([renderLearnedSkill(learned), 'project', root])))
  expect(value(applyLearningProposals(input, [proposal()], context))).toEqual(result)
  expect(input.skills).toEqual([])
})

test('apply updates content and caps history while preserving origin and use counters', () => {
  const previous = skill({
    scope: 'global', projectRoot: '/origin', opportunities: 3, uses: 2, lastUsedAt: 5,
    history: Array.from({ length: 20 }, (_, i) => ({ sessionId: `s${i}`, at: i, reason: 'Correction', evidence: [`e${i}`] })),
  })
  const result = value(applyLearningProposals(library(previous), [proposal({ scope: 'global' })], context)).skills[0]
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
  const result = value(applyLearningProposals(library(previous), [proposal({ id: 'dag-learned-merged', replaces: [previous.id] })], context))
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
  ]) expect(applyLearningProposals(input, proposals, context).ok).toBe(false)
  expect(applyLearningProposals(input, [proposal()], { ...context, sessionId: 'other' }).ok).toBe(false)
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

function learningEvent(n: number, kind: LearningEvent['kind'] = 'tool', text = 'result'): LearningEvent {
  return { id: `s:${n}`, sessionId: 's', projectRoot: root, kind, text, at: n }
}

test('append preserves latest user through count eviction in actual sequence', () => {
  const input = appendLearningEvent(emptyLearningSession(), learningEvent(1, 'user'))
  let session = input
  for (let n = 2; n <= 101; n++) session = appendLearningEvent(session, learningEvent(n))
  expect(session.events.map(event => event.id)).toEqual(['s:1', ...Array.from({ length: 79 }, (_, i) => `s:${i + 23}`)])
  expect(session.nextId).toBe(102)
  expect(session.toolsSinceLearn).toBe(100)
  expect(input.events.map(event => event.id)).toEqual(['s:1'])
  const replaced = appendLearningEvent(session, learningEvent(102, 'user'))
  expect(replaced.events[0]?.id).toBe('s:23')
  expect(replaced.events.at(-1)?.id).toBe('s:102')
  expect(replaced.toolsSinceLearn).toBe(100)
  expect(value(parseLearningSession(JSON.stringify(replaced)))).toEqual(replaced)
})

test('append preserves latest user through 4000 character eviction', () => {
  let session = appendLearningEvent(emptyLearningSession(), learningEvent(1, 'user', 'u'.repeat(4000)))
  for (let n = 2; n <= 30; n++) session = appendLearningEvent(session, learningEvent(n, 'tool', 't'.repeat(4000)))
  expect(session.events.map(event => event.id)).toEqual(['s:1', ...Array.from({ length: 14 }, (_, i) => `s:${i + 17}`)])
  expect(session.events.reduce((sum, event) => sum + event.text.length, 0)).toBe(60_000)
  expect(value(parseLearningSession(JSON.stringify(session)))).toEqual(session)
})

test('batch packs oldest contiguous pending prefix without advancing to future anchor', () => {
  const pending = Array.from({ length: 8 }, (_, i) => learningEvent(i + 2, 'tool', '\\'.repeat(4000)))
  const anchor = learningEvent(10, 'user', 'Correction')
  const session = { ...emptyLearningSession(), events: [learningEvent(1), ...pending, anchor], nextId: 11, learnedThrough: 1 }
  const batch = value(prepareLearningBatch(session, emptyLibrary(), root, 16_000))
  expect(batch.events.map(event => event.id)).toEqual(['s:2', 's:10'])
  expect(batch.through).toBe(2)
  expect(batch.prompt.length <= 16_000).toBe(true)
  expect(prepareLearningBatch(session, emptyLibrary(), root, batch.prompt.length - 1).ok).toBe(false)
  expect(session.events.length).toBe(10)
})

test('consumed latest user remains context and numeric suffix drives pending cursor', () => {
  const session = { ...emptyLearningSession(),
    events: [learningEvent(1, 'user'), learningEvent(2), learningEvent(9), learningEvent(10)],
    nextId: 11, learnedThrough: 2 }
  const batch = value(prepareLearningBatch(session, emptyLibrary(), root, 16_000))
  expect(batch.events.map(event => event.id)).toEqual(['s:1', 's:9', 's:10'])
  expect(batch.through).toBe(10)
  expect(prepareLearningBatch({ ...session, learnedThrough: 10 }, emptyLibrary(), root, 16_000).ok).toBe(false)
  expect(prepareLearningBatch(session, emptyLibrary(), root, 0).ok).toBe(false)
})

test('batch sends only complete eligible bodies with exact editable allowlist and all baseline records', () => {
  const input = library(
    skill({ id: 'dag-learned-old', body: 'o'.repeat(2500), updatedAt: 2 }),
    skill({ id: 'dag-learned-recent', body: 'r'.repeat(2500), updatedAt: 3 }),
    skill({ id: 'dag-learned-large', body: 'l'.repeat(12_000), updatedAt: 4 }),
    skill({ id: 'dag-learned-foreign', projectRoot: '/other' }),
    skill({ id: 'dag-learned-archived', archived: true }),
  )
  const session = { ...emptyLearningSession(), events: [learningEvent(1, 'user')], nextId: 2 }
  const batch = value(prepareLearningBatch(session, input, root, 16_000))
  const data = JSON.parse(batch.prompt.split('\n').at(-1) ?? '')
  expect(batch.editableIds).toEqual(['dag-learned-recent'])
  expect(data.editableIds).toEqual(batch.editableIds)
  expect(data.existing.map((entry: { id: string; body: string }) => [entry.id, entry.body]))
    .toEqual([['dag-learned-recent', 'r'.repeat(2500)]])
  expect(batch.baseline).toEqual(input.skills)
  batch.baseline[0]?.history[0]?.evidence.push('changed')
  expect(input.skills[0]?.history[0]?.evidence).toEqual(['old-event'])
  expect(batch.prompt.length <= 16_000).toBe(true)
})

test('large libraries obey total prompt cap and retain complete baseline collisions', () => {
  const input = library(...Array.from({ length: 500 }, (_, i) => skill({
    id: `dag-learned-${i}`, body: '"'.repeat(3000), updatedAt: i + 2,
  })))
  const session = { ...emptyLearningSession(), nextId: 31,
    events: [learningEvent(1, 'user'), ...Array.from({ length: 29 }, (_, i) => learningEvent(i + 2, 'tool', '\\'.repeat(2000)))] }
  for (const maxChars of [16_000, 60_000, 120_000]) {
    const batch = value(prepareLearningBatch(session, input, root, maxChars))
    const data = JSON.parse(batch.prompt.split('\n').at(-1) ?? '')
    expect(batch.prompt.length <= maxChars).toBe(true)
    expect(batch.baseline.length).toBe(500)
    expect(data.existing.map((entry: { id: string }) => entry.id)).toEqual(batch.editableIds)
    for (const entry of data.existing) expect(entry.body).toBe('"'.repeat(3000))
    expect(batch.events.length <= 80).toBe(true)
    expect(batch.events.reduce((sum, event) => sum + event.text.length, 0) <= 60_000).toBe(true)
    expect(batch.events.map(event => Number(event.id.split(':').at(-1))))
      .toEqual(Array.from({ length: batch.through }, (_, i) => i + 1))
  }
})

test('batch parser accepts legacy snapshots and validates optional editable ids strictly', () => {
  const batch = { agentId: 'a', events, baseline: [skill()], through: 2 }
  const session = { ...emptyLearningSession(), events, nextId: 3, batch }
  expect(value(parseLearningSession(JSON.stringify(session)))).toEqual(session)
  for (const editableIds of [[], ['dag-learned-signals']]) {
    const input = { ...session, batch: { ...batch, editableIds } }
    expect(value(parseLearningSession(JSON.stringify(input)))).toEqual(input)
  }
  for (const editableIds of [null, 'dag-learned-signals', [1], ['missing'], ['dag-learned-signals', 'dag-learned-signals']]) {
    expect(parseLearningSession(JSON.stringify({ ...session, batch: { ...batch, editableIds } })).ok).toBe(false)
  }
})

test('library usage parses strict nonnegative integers without changing schema version', () => {
  const input = { ...emptyLibrary(), usage: { day: 3, runs: 2 } }
  expect(value(parseLearningLibrary(JSON.stringify(input)))).toEqual(input)
  for (const usage of [null, {}, { day: -1, runs: 0 }, { day: 0, runs: 0.5 },
    { day: 0.5, runs: 0 }, { day: 0, runs: -1 }, { day: 0, runs: '1' },
    { day: 0, runs: Number.MAX_SAFE_INTEGER + 1 }, { day: 0, runs: 1, extra: 1 }]) {
    expect(parseLearningLibrary(JSON.stringify({ ...input, usage })).ok).toBe(false)
  }
})

test('usage reservation counts attempts and resets exactly at UTC day boundary', () => {
  const input = library(skill())
  const first = value(reserveLearningUsage(input, 86_399_999, 2))
  const second = value(reserveLearningUsage(first, 86_399_999, 2))
  expect(first.usage).toEqual({ day: 0, runs: 1 })
  expect(second.usage).toEqual({ day: 0, runs: 2 })
  expect(reserveLearningUsage(second, 86_399_999, 2).ok).toBe(false)
  expect(value(reserveLearningUsage(second, 86_400_000, 2)).usage).toEqual({ day: 1, runs: 1 })
  expect(input.usage).toBe(undefined)
  expect(first.usage?.runs).toBe(1)
  expect(reserveLearningUsage(input, 0, 0).ok).toBe(false)
  expect(reserveLearningUsage(input, -1, 2).ok).toBe(false)
  expect(reserveLearningUsage(input, 0, 1.5).ok).toBe(false)
  expect(recordSkillOpportunity(first, root, 20).usage).toEqual(first.usage)
  expect(recordSkillUse(first, skill().id, root, 20).usage).toEqual(first.usage)
  expect(archiveUnusedSkills(first, { projectRoot: root, minOpportunities: 1, maxSkills: 1, now: 20 }).usage).toEqual(first.usage)
  expect(value(applyLearningProposals(first, [proposal()], context)).usage).toEqual(first.usage)
})

test('learning transaction strictly round trips both library indexes without filepaths', () => {
  const before = library(skill())
  const after = { ...library(skill({ body: 'Updated.' })), usage: { day: 1, runs: 1 } }
  const input = { schemaVersion: 1, before, after }
  expect(value(parseLearningTransaction(JSON.stringify(input)))).toEqual(input)
  for (const invalid of [
    null, [], {}, { ...input, schemaVersion: 2 }, { schemaVersion: 1, before },
    { ...input, path: '/skills' }, { ...input, before: { ...before, filepaths: [] } },
    { ...input, after: { ...after, skills: [skill({ id: '../escape' })] } },
    { ...input, before: { ...before, schemaVersion: 2 } },
    { ...input, after: { ...after, usage: { day: 1, runs: -1 } } },
  ]) expect(parseLearningTransaction(JSON.stringify(invalid)).ok).toBe(false)
  expect(parseLearningTransaction('invalid JSON').ok).toBe(false)
})

test('a maximum-length complete skill body remains editable when the input budget has room', () => {
  const existing = skill({ body: 'x'.repeat(12_000) })
  const session = { ...emptyLearningSession(), events, nextId: 3 }
  const prepared = value(prepareLearningBatch(session, library(existing), root, 60_000))
  expect(prepared.editableIds).toEqual([existing.id])
  const input = JSON.parse(prepared.prompt.split('\n').at(-1) ?? '')
  expect(input.existing[0].body).toBe(existing.body)
})
