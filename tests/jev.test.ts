import { expect, test } from 'claude-code/testing'
import { parseDefinition } from '../hooks/engine/definition.ts'
import { permissionRequest, parseChoices, routingRequest } from '../hooks/engine/jev.ts'
import { createRun } from '../hooks/engine/run.ts'

function run() {
  const parsed = parseDefinition({
    key: 'jev-contract',
    name: 'Contract',
    goal: 'Ship the fix',
    nodes: [
      { id: 'a', prompt: 'Fix A', category: 'writing' },
      { id: 'b', prompt: 'Check B', dependsOn: ['a'] },
    ],
  })
  if (!parsed.ok) throw new Error(parsed.error.message)
  return createRun(parsed.value, { runId: 'r', sessionId: 's', now: 1 })
}

test('routing batches only requested node keys and preserves definition data', () => {
  const original = run()
  const before = JSON.stringify(original)
  const request = routingRequest(original, ['b', 'a', 'missing'])
  expect(request.model).toBe('jev-latest')
  expect(Object.keys(request.questions)).toEqual(['a', 'b'])
  expect(request.state).toEqual({
    goal: 'Ship the fix',
    nodes: [
      { id: 'a', task: 'Fix A', proposedCategory: 'writing', dependsOn: [] },
      { id: 'b', task: 'Check B', proposedCategory: 'quick', dependsOn: ['a'] },
    ],
  })
  for (const question of Object.values(request.questions)) {
    expect(question.type).toBe('choice')
    expect(Object.keys(question.criteria).sort()).toEqual([
      'architect', 'artistry', 'deep-high', 'deep-low', 'quick',
      'ultrabrain', 'unspecified-high', 'unspecified-low', 'visual-engineering', 'writing',
    ])
  }
  expect(JSON.stringify(original)).toBe(before)
})

test('routing uses retry prompt overrides and falls back to the run name for goal', () => {
  const original = run()
  const request = routingRequest({
    ...original,
    definition: { key: original.key, name: original.name, nodes: original.definition.nodes },
    nodes: original.nodes.map(node => node.id === 'a' ? { ...node, promptOverride: 'Retry A' } : node),
  }, ['a'])
  expect(request.state).toEqual({
    goal: 'Contract',
    nodes: [{ id: 'a', task: 'Retry A', proposedCategory: 'writing', dependsOn: [] }],
  })
  expect(routingRequest(original, []).questions).toEqual({})
})

test('permission carries tool arguments and user and node scope as data', () => {
  const input = { command: 'git push' }
  const context = { request: 'Inspect only', projectRoot: '/work', goal: 'Review', task: 'Read diff' }
  const request = permissionRequest('Bash', input, context)
  expect(request.model).toBe('jev-latest')
  expect(request.state).toEqual({ tool: 'Bash', input, ...context })
  expect(Object.keys(request.questions)).toEqual(['permission'])
  expect(request.questions.permission?.type).toBe('choice')
  expect(Object.keys(request.questions.permission?.criteria ?? {}).sort()).toEqual(['allow', 'ask', 'deny'])
})

test('choice parsing accepts only requested keys and includes confidence boundaries', () => {
  const questions = routingRequest(run(), ['a', 'b']).questions
  const parsed = parseChoices(JSON.stringify({ answers: {
    a: { type: 'choice', choice: 'architect', confidence: 0 },
    b: { type: 'choice', choice: 'quick', confidence: 1 },
    extra: { type: 'choice', choice: 'quick', confidence: 1 },
  } }), questions)
  expect([...parsed]).toEqual([
    ['a', { choice: 'architect', confidence: 0 }],
    ['b', { choice: 'quick', confidence: 1 }],
  ])
})

for (const text of ['{', 'null', '[]', '{}', '{"answers":null}', '{"answers":[]}', '{"answers":"wrong"}']) {
  test(`choice parsing falls back for invalid envelope ${text}`, () => {
    expect(parseChoices(text, routingRequest(run(), ['a']).questions).size).toBe(0)
  })
}

const INVALID_ANSWERS: readonly unknown[] = [
  null, [], 'quick', {},
  { choice: 'quick', confidence: 1 },
  { type: 'text', choice: 'quick', confidence: 1 },
  { type: 'choice', choice: 'haiku', confidence: 1 },
  { type: 'choice', choice: 'toString', confidence: 1 },
  { type: 'choice', choice: 1, confidence: 1 },
  { type: 'choice', choice: 'quick' },
  { type: 'choice', choice: 'quick', confidence: '1' },
  { type: 'choice', choice: 'quick', confidence: null },
  { type: 'choice', choice: 'quick', confidence: -0.01 },
  { type: 'choice', choice: 'quick', confidence: 1.01 },
]

INVALID_ANSWERS.forEach((answer, index) => {
  test(`invalid answer ${index} does not discard a valid sibling`, () => {
    const parsed = parseChoices(JSON.stringify({ answers: {
      a: answer, b: { type: 'choice', choice: 'writing', confidence: 0.95 },
    } }), routingRequest(run(), ['a', 'b']).questions)
    expect([...parsed]).toEqual([['b', { choice: 'writing', confidence: 0.95 }]])
  })
})

for (const confidence of ['1e400', '-1e400']) {
  test(`nonfinite JSON confidence ${confidence} falls back`, () => {
    expect(parseChoices(`{"answers":{"permission":{"type":"choice","choice":"allow","confidence":${confidence}}}}`,
      permissionRequest('Read', {}, { request: '', projectRoot: '/work' }).questions).size).toBe(0)
  })
}
