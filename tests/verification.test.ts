import { expect, test } from 'claude-code/testing'
import { nodeFingerprint, parseDefinition } from '../hooks/engine/definition.ts'
import { parseChecks, verificationProblem } from '../hooks/engine/verification.ts'

test('verification accepts only bounded typed checks and project file paths', () => {
  expect(parseChecks([{ kind: 'file', path: 'src/result.txt', contains: 'done' }, { kind: 'command', argv: ['bun', 'test'] }]).ok).toBe(true)
  for (const value of [[], null, [{ kind: 'file', path: '../secret' }], [{ kind: 'file', path: '/outside' }], [{ kind: 'file', path: '.claude/dag/runs/r.json' }], [{ kind: 'command', argv: [] }], [{ kind: 'command', argv: ['echo', 3] }]]) {
    expect(parseChecks(value).ok).toBe(false)
  }
})

test('missing verification is a start contract error and changing checks invalidates a node', () => {
  const bare = { id: 'a', prompt: 'Make a', dependsOn: [] }
  expect(verificationProblem({ key: 'k', name: 'K', nodes: [bare] })?.code).toBe('verification_required')
  const parsed = parseDefinition({ key: 'k', nodes: [{ ...bare, verify: [{ kind: 'file', path: 'a.txt' }], writes: ['a.txt'] }] })
  if (!parsed.ok) throw new Error(parsed.error.code)
  expect(verificationProblem(parsed.value)).toBe(undefined)
  const node = parsed.value.nodes[0]
  if (!node) throw new Error('Missing fixture node')
  expect(nodeFingerprint(node)).not.toBe(nodeFingerprint({ ...node, verify: [{ kind: 'file', path: 'b.txt' }] }))
  expect(parseDefinition({ key: 'k', nodes: [{ ...bare, writes: ['../outside'] }] }).ok).toBe(false)
})
