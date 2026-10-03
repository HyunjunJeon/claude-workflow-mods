import { expect, test } from 'claude-code/testing'
import { parseDefinition } from '../hooks/engine/definition.ts'
import { permissionRequest, parseChoices, routingRequest } from '../hooks/engine/jev.ts'
import { hash } from '../hooks/engine/hash.ts'
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

type PermissionState = { input: Record<string, unknown>; request: string; goal?: string; task?: string }
function permissionState(input: unknown, request = 'Inspect only', extra: { goal?: string; task?: string } = {}) {
  return permissionRequest('Write', input, { request, projectRoot: '/work', ...extra }).state as PermissionState
}

test('Given a 10,000-character Write content, When the permission request is built, Then the content becomes a truncated summary', () => {
  const content = 'x'.repeat(10_000)
  const state = permissionState({ file_path: '/work/a.txt', content })
  expect(state.input.file_path).toBe('/work/a.txt')
  const summary = state.input.content as { truncated: boolean; length: number; hash: string; head: string }
  expect(summary.truncated).toBe(true)
  expect(summary.length).toBe(10_000)
  expect(summary.hash).toMatch(/^[0-9a-f]{16}$/)
  expect(summary.hash).toBe(hash(content))
  expect(summary.head).toBe('x'.repeat(1_000))
})

test('Given a short secret-free nested input, When the permission request is built, Then the output is byte-identical to the raw state', () => {
  const input = { command: 'git push', args: ['a', { n: 1, ok: true, none: null }], text: 'y'.repeat(2_000) }
  const context = { request: 'Inspect only', projectRoot: '/work', goal: 'Review', task: 'Read diff' }
  const request = permissionRequest('Bash', input, context)
  expect(JSON.stringify(request.state)).toBe(JSON.stringify({ tool: 'Bash', input, ...context }))
})

const SECRETS: readonly (readonly [string, string, string])[] = [
  ['private key', '-----BEGIN RSA PRIVATE KEY-----\nMIIEabc123\nXYZ789\n-----END RSA PRIVATE KEY-----', 'private-key'],
  ['bearer token', 'Bearer abcDEF123.ghi-JKL_456', 'bearer-token'],
  ['AWS access key id', 'AKIAABCDEFGHIJKLMNOP', 'aws-access-key'],
  ['GitHub ghp token', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'github-token'],
  ['GitHub fine-grained token', 'github_pat_11ABCDEFG0abcdefghijklmnopqrstuv', 'github-token'],
  ['Slack token', 'xoxb-1234567890-abcdefghij', 'slack-token'],
  ['sk- key', 'sk-abcdefghijklmnopqrstuvwxyz012345', 'api-key'],
  ['sk-ant- key', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz', 'api-key'],
]

for (const [label, secret, kind] of SECRETS) {
  test(`Given a ${label} in nested input and request, When the permission request is built, Then it is masked in both`, () => {
    const text = `before ${secret} after`
    const state = permissionState({ list: [{ deep: text }] }, text, { goal: text, task: text })
    const json = JSON.stringify(state)
    expect(json).not.toContain(secret.split('\n')[1] ?? secret)
    expect(json).not.toContain(secret)
    expect(json).toContain(`[REDACTED:${kind}]`)
    expect(state.request).toBe(`before [REDACTED:${kind}] after`)
    expect(state.goal).toBe(`before [REDACTED:${kind}] after`)
    expect(state.task).toBe(`before [REDACTED:${kind}] after`)
    expect(((state.input.list as { deep: string }[])[0])?.deep).toBe(`before [REDACTED:${kind}] after`)
  })
}

for (const name of ['API_KEY', 'apikey', 'auth_token', 'client_secret', 'DB_PASSWORD', 'passwd']) {
  test(`Given an assignment to ${name}, When the permission request is built, Then the key stays and only the value is masked`, () => {
    const state = permissionState({ command: `export ${name}=hunter2hunter2 && run` }, `set ${name}: "s3cr3tvalue"`)
    expect(state.input.command).toBe(`export ${name}=[REDACTED:assignment] && run`)
    expect(state.request).toBe(`set ${name}: [REDACTED:assignment]`)
  })
}

test('Given a secret straddling the truncation boundary, When the permission request is built, Then masking happens before truncation and hashing', () => {
  const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'
  const content = `${'a'.repeat(900)}${secret} ${'b'.repeat(3_000)}`
  const summary = permissionState({ content }).input.content as { head: string; hash: string; length: number }
  expect(summary.head).not.toContain('ghp_')
  expect(summary.head).toContain('[REDACTED:github-token]')
  expect(summary.length).toBe(content.length)
  expect(summary.hash).toBe(hash(content.replace(secret, '[REDACTED:github-token]')))
})

test('Given a 30,000-character request, When the permission request is built, Then it is capped with a length marker', () => {
  const state = permissionState({}, 'r'.repeat(30_000), { goal: 'g'.repeat(5_000), task: 't'.repeat(5_000) })
  expect(state.request.startsWith('r'.repeat(4_000))).toBe(true)
  expect(state.request).toContain('30000')
  expect(state.request.length).toBeLessThan(4_200)
  expect(state.goal?.startsWith('g'.repeat(2_000))).toBe(true)
  expect(state.goal).toContain('5000')
  expect(state.goal?.length).toBeLessThan(2_200)
  expect(state.task).toContain('5000')
})

test('Given more than 200 keys and items, When the permission request is built, Then extras are dropped and counted', () => {
  const big = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`k${i}`, i]))
  const state = permissionState({ big, list: Array.from({ length: 230 }, (_, i) => i) })
  const bigOut = state.input.big as Record<string, unknown>
  expect(Object.keys(bigOut).filter(key => key.startsWith('k'))).toHaveLength(200)
  expect(bigOut._omitted).toBe(50)
  const list = state.input.list as unknown[]
  expect(list).toHaveLength(201)
  expect(list[200]).toEqual({ omitted: 30 })
})
