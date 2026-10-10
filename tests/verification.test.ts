import { expect, test } from 'claude-code/testing'
import { nodeFingerprint, parseDefinition } from '../hooks/engine/definition.ts'
import { lintDefinition } from '../hooks/engine/lint.ts'
import { INPUT_SCHEMA } from '../hooks/engine/tool-spec.ts'
import { TEXT_FIELDS, type VerificationCheck } from '../hooks/engine/types.ts'
import { parseChecks, verificationProblem } from '../hooks/engine/verification.ts'

test('verification accepts only bounded typed checks and project file paths', () => {
  expect(parseChecks([{ kind: 'file', path: 'src/result.txt', contains: 'done' }, { kind: 'command', argv: ['bun', 'test'] }]).ok).toBe(true)
  for (const value of [[], null, [{ kind: 'file', path: '../secret' }], [{ kind: 'file', path: '/outside/../secret' }], [{ kind: 'file', path: '.claude/dag/runs/r.json' }], [{ kind: 'command', argv: [] }], [{ kind: 'command', argv: ['echo', 3] }]]) {
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

const parsedOne = (check: unknown) => parseChecks([check])
const refusal = (check: unknown) => {
  const parsed = parsedOne(check)
  if (parsed.ok) throw new Error(`accepted ${JSON.stringify(check)}`)
  expect(parsed.error.code).toBe('invalid_verification')
  return parsed.error.message
}
const command = (expectation: unknown) => ({ kind: 'command', argv: ['bun', 'test'], expect: expectation })

test('a file check accepts each text expectation alone and all together, and keeps every field', () => {
  const shapes = [
    { kind: 'file', path: 'a.md' },
    { kind: 'file', path: 'a.md', contains: 'x' },
    { kind: 'file', path: 'a.md', absent: 'TODO' },
    { kind: 'file', path: 'a.md', matches: '^## Output$' },
    { kind: 'file', path: 'a.md', lastLine: 'PASS' },
    { kind: 'file', path: 'a.md', equals: 'done' },
    { kind: 'file', path: 'a.md', lastLine: '' },
    { kind: 'file', path: 'a.md', equals: '' },
    { kind: 'file', path: 'src/', contains: 'x', absent: 'y', matches: 'z', lastLine: 'l', equals: 'e' },
  ]
  for (const shape of shapes) {
    const parsed = parsedOne(shape)
    expect({ shape, ok: parsed.ok }).toEqual({ shape, ok: true })
    if (parsed.ok) expect(parsed.value).toEqual([shape])
  }
})

test('a file check refuses empty or non-text expectations', () => {
  for (const [field, value] of [['contains', ''], ['absent', ''], ['matches', ''], ['contains', 3], ['absent', null], ['matches', ['x']], ['lastLine', 1], ['equals', null], ['equals', false]] as const) {
    expect(refusal({ kind: 'file', path: 'a.md', [field]: value })).toContain(field)
  }
})

test('a file check accepts absolute paths outside .claude/dag for read-only checks', () => {
  for (const path of ['/etc/hosts', '/Users/x/.claude/settings.json', '/Users/x/.claude/dagger.json', '/Users/x/dag/.claude', 'C:\\Users\\x\\notes.txt', 'D:/data/x.txt', '/']) {
    expect({ path, ok: parsedOne({ kind: 'file', path, contains: 'x' }).ok }).toEqual({ path, ok: true })
  }
})

test('a file check refuses any path that reaches .claude/dag, climbs with .., or breaks project-relative rules', () => {
  for (const path of [
    '/proj/.claude/dag/runs/r.json',
    '/proj/.claude/dag',
    '/proj/.Claude/DAG/r.json',
    '/proj/.claude//dag/r.json',
    '/proj/.claude/./dag/r.json',
    'C:\\proj\\.claude\\dag\\r.json',
    '/a/../b',
    'C:\\a\\..\\b',
    'C:relative.txt',
    '/a/\0b',
    '../x',
    'src/../../x',
    '.claude/settings.json',
    'a/.claude/x',
    '',
  ]) {
    expect({ path, message: refusal({ kind: 'file', path, contains: 'x' }) }).toEqual({ path, message: expect.stringContaining('path') })
  }
})

test('a relative path reaches .claude in no letter case, since macOS and Windows fold case', () => {
  for (const path of ['.CLAUDE/dag/runs/x.json', '.Claude/settings.json', 'src/.CLAUDE/x', '.\\.cLaUdE\\dag\\r.json']) {
    expect({ path, message: refusal({ kind: 'file', path, contains: 'x' }) }).toEqual({ path, message: expect.stringContaining('path') })
  }
  const node = { id: 'a', prompt: 'Make a', verify: [{ kind: 'command', argv: ['bun', 'test'] }] }
  const writes = parseDefinition({ key: 'k', nodes: [{ ...node, writes: ['.CLAUDE/dag/runs/x.json'] }] })
  expect(writes.ok ? 'accepted' : writes.error.code).toBe('invalid_node')
  expect(parsedOne({ kind: 'file', path: 'src/claude/x.md', contains: 'x' }).ok).toBe(true)
  expect(parsedOne({ kind: 'file', path: '.claudeignore', contains: 'x' }).ok).toBe(true)
})

test('the five text fields are one shared list that the parser, lint and the tool schema all accept', () => {
  expect([...TEXT_FIELDS]).toEqual(['contains', 'absent', 'matches', 'lastLine', 'equals'])
  const verifyItem = INPUT_SCHEMA.properties.definition.properties.nodes.items.properties.verify.items
  const outputs = verifyItem.properties.expect.properties
  for (const field of TEXT_FIELDS) {
    const file = { kind: 'file', path: 'a.md', [field]: 'x' }
    expect({ field, file: parsedOne(file).ok, output: parsedOne(command({ stdout: { [field]: 'x' }, stderr: { [field]: 'x' } })).ok }).toEqual({ field, file: true, output: true })
    expect({ field, warnings: lintDefinition({ key: 'k', name: 'K', goal: 'g', nodes: [{ id: 'a', prompt: 'TASK: a. STOP WHEN: done.', dependsOn: [], verify: [file as VerificationCheck] }] }) }).toEqual({ field, warnings: [] })
  }
  expect(Object.keys(outputs.stdout.properties)).toEqual([...TEXT_FIELDS])
  expect(Object.keys(outputs.stderr.properties)).toEqual([...TEXT_FIELDS])
  expect(TEXT_FIELDS.filter(field => !(field in verifyItem.properties))).toEqual([])
})

test('writes stay project-relative: an absolute write scope is refused', () => {
  const node = { id: 'a', prompt: 'Make a', verify: [{ kind: 'file', path: '/etc/hosts', contains: 'localhost' }] }
  expect(parseDefinition({ key: 'k', nodes: [node] }).ok).toBe(true)
  expect(parseDefinition({ key: 'k', nodes: [{ ...node, writes: ['/etc/hosts'] }] }).ok).toBe(false)
})

test('a command check accepts exit codes 0-255 and output expectations, and keeps every field', () => {
  const shapes = [
    { kind: 'command', argv: ['bun', 'test'] },
    command({ exit: 1 }),
    command({ exit: 0 }),
    command({ exit: 255 }),
    command({ exit: [0, 1] }),
    command({ stdout: { lastLine: 'PASS' } }),
    command({ stderr: { equals: '' } }),
    command({ exit: [1, 2], stdout: { contains: 'a', absent: 'b', matches: '^c$', lastLine: 'd', equals: 'e' }, stderr: { absent: 'warning' } }),
  ]
  for (const shape of shapes) {
    const parsed = parsedOne(shape)
    expect({ shape, ok: parsed.ok }).toEqual({ shape, ok: true })
    if (parsed.ok) expect(parsed.value).toEqual([shape])
  }
})

test('a command check lists several exit codes once each, in ascending order', () => {
  const parsed = parsedOne(command({ exit: [2, 0, 2, 1] }))
  expect(parsed.ok && parsed.value).toEqual([command({ exit: [0, 1, 2] })])
})

test('a command check refuses exit codes outside 0-255 or not integers', () => {
  for (const exit of [256, -1, 1.5, '1', [], [0, 300], [0, '1'], null, true]) {
    expect({ exit, message: refusal(command({ exit })) }).toEqual({ exit, message: expect.stringContaining('expect.exit') })
  }
})

test('a command check refuses an expect or output expectation that checks nothing', () => {
  expect(refusal(command({}))).toContain('expect')
  expect(refusal(command(null))).toContain('expect')
  expect(refusal(command([0]))).toContain('expect')
  expect(refusal(command({ stdout: {} }))).toContain('expect.stdout')
  expect(refusal(command({ stderr: 'warning' }))).toContain('expect.stderr')
  expect(refusal(command({ stdout: { contains: '' } }))).toContain('expect.stdout.contains')
  expect(refusal(command({ stderr: { lastLine: 3 } }))).toContain('expect.stderr.lastLine')
})

test('unknown fields are refused at every level and the message names the field', () => {
  expect(refusal({ kind: 'file', path: 'a.md', contain: 'x' })).toContain('"contain"')
  expect(refusal({ kind: 'file', path: 'a.md', exists: false })).toContain('"exists"')
  expect(refusal({ kind: 'file', path: 'a.md', argv: ['x'] })).toContain('"argv"')
  expect(refusal({ kind: 'command', argv: ['bun'], cwd: 'sub' })).toContain('"cwd"')
  expect(refusal({ kind: 'command', argv: ['bun'], contains: 'x' })).toContain('"contains"')
  expect(refusal(command({ code: 1 }))).toContain('"code"')
  expect(refusal(command({ stdout: { contains: 'x', regex: 'y' } }))).toContain('"regex"')
  expect(refusal(command({ stderr: { exit: 1 } }))).toContain('"exit"')
})

test('a check needs a known kind and a runnable argv', () => {
  expect(refusal({ path: 'a.md', contains: 'x' })).toContain('kind')
  expect(refusal({ kind: 'shell', argv: ['x'] })).toContain('kind')
  for (const argv of [[], ['  '], 'bun test', ['bun', 1], undefined]) {
    expect({ argv, message: refusal({ kind: 'command', argv }) }).toEqual({ argv, message: expect.stringContaining('argv') })
  }
})

test('changing any field of a check changes the node fingerprint', () => {
  const fingerprint = (check: unknown) => {
    const parsed = parseDefinition({ key: 'k', nodes: [{ id: 'a', prompt: 'Make a', verify: [check] }] })
    if (!parsed.ok) throw new Error(parsed.error.message)
    return nodeFingerprint(parsed.value.nodes[0]!)
  }
  const file = { kind: 'file', path: 'a.md', contains: 'x' }
  const base = command({ exit: 1, stdout: { contains: 'x' } })
  const variants = [
    fingerprint(file),
    fingerprint({ ...file, path: '/abs/a.md' }),
    fingerprint({ ...file, contains: 'y' }),
    fingerprint({ ...file, absent: 'z' }),
    fingerprint({ ...file, matches: 'x+' }),
    fingerprint({ ...file, lastLine: 'x' }),
    fingerprint({ ...file, equals: 'x' }),
    fingerprint({ kind: 'command', argv: ['bun', 'test'] }),
    fingerprint(base),
    fingerprint(command({ exit: 2, stdout: { contains: 'x' } })),
    fingerprint(command({ exit: [1, 2], stdout: { contains: 'x' } })),
    fingerprint(command({ exit: 1, stdout: { contains: 'y' } })),
    fingerprint(command({ exit: 1, stdout: { absent: 'x' } })),
    fingerprint(command({ exit: 1, stdout: { matches: 'x' } })),
    fingerprint(command({ exit: 1, stdout: { lastLine: 'x' } })),
    fingerprint(command({ exit: 1, stdout: { equals: 'x' } })),
    fingerprint(command({ exit: 1, stderr: { contains: 'x' } })),
  ]
  expect(new Set(variants).size).toBe(variants.length)
  expect(fingerprint(command({ exit: [2, 1], stdout: { contains: 'x' } }))).toBe(fingerprint(command({ exit: [1, 2], stdout: { contains: 'x' } })))
})
