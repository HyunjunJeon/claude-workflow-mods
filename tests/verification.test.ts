import { expect, test } from 'claude-code/testing'
import { nodeFingerprint, parseDefinition } from '../hooks/engine/definition.ts'
import { lintDefinition } from '../hooks/engine/lint.ts'
import { createRun } from '../hooks/engine/run.ts'
import { INPUT_SCHEMA } from '../hooks/engine/tool-spec.ts'
import { exitProblem, textProblem } from '../hooks/engine/check-eval.ts'
import { TEXT_FIELDS, type Definition, type TextExpect, type VerificationCheck, type VerificationOutcome } from '../hooks/engine/types.ts'
import { checkLoosening, parseChecks, verificationProblem } from '../hooks/engine/verification.ts'

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

test('matches refuses other dialects that JavaScript would read as plain letters, in files and in command output', () => {
  for (const [pattern, named] of [
    ['\\A# Changes\\n', '\\A'],
    ['^done\\Z', '\\Z'],
    ['ok\\z', '\\z'],
    ['\\p{L}+', '\\p'],
    ['\\h+', '\\h'],
    ['[[:digit:]]+', '[:digit:]'],
    ['[^[:space:]]+', '[:space:]'],
    ['[a-z[:digit:]]', '[:digit:]'],
  ] as const) {
    const message = refusal({ kind: 'file', path: 'a.md', matches: pattern })
    expect({ pattern, named: message.includes(named), js: message.includes('JavaScript') }).toEqual({ pattern, named: true, js: true })
    expect(refusal(command({ stdout: { matches: pattern } }))).toContain('expect.stdout.matches')
  }
  expect(refusal({ kind: 'file', path: 'a.md', matches: '\\A#' })).toContain('(?<![\\s\\S])')
  // Escapes JavaScript knows, an escaped backslash before a letter and an escaped bracket all stay accepted.
  for (const pattern of ['^\\d+\\s\\w\\b$', '\\x41\\u0041\\cJ\\t\\n\\r\\f\\v', '(?<n>a)\\k<n>', '\\\\A', '\\[:digit:]', '[a-z]\\1', '(?<![\\s\\S])# x']) {
    expect({ pattern, ok: parsedOne({ kind: 'file', path: 'a.md', matches: pattern }).ok }).toEqual({ pattern, ok: true })
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

const oneNode = (verify: VerificationCheck[] | undefined): Definition =>
  ({ key: 'k', name: 'K', nodes: verify ? [{ id: 'a', prompt: 'Make a', dependsOn: [], verify }] : [{ id: 'other', prompt: 'Other', dependsOn: [], verify: [{ kind: 'file', path: 'o.md' }] }] })

// A run whose node a last verified its checks with the given outcomes, in check order.
function verifiedRun(verify: VerificationCheck[], outcomes: VerificationOutcome[], expandedFrom?: string) {
  const run = createRun(oneNode(verify), { runId: 'r', sessionId: 's', now: 1 })
  const def = run.definition.nodes[0]
  const node = run.nodes[0]
  if (!def || !node) throw new Error('Missing fixture node')
  if (expandedFrom !== undefined) def.expandedFrom = expandedFrom
  node.verification = {
    status: outcomes.every(outcome => outcome === 'passed') ? 'passed' : 'failed',
    evidence: verify.map((check, index) => {
      const outcome = outcomes[index] ?? 'passed'
      return { check, passed: outcome === 'passed', outcome, checkedAt: 1, detail: '' }
    }),
  }
  return run
}

const TESTS: VerificationCheck = { kind: 'command', argv: ['bun', 'test'] }
const DOC: VerificationCheck = { kind: 'file', path: 'doc.md', contains: 'Section done', absent: 'TODO' }
const loosening: { name: string; before: VerificationCheck[]; outcomes: VerificationOutcome[]; after?: VerificationCheck[]; expandedFrom?: string; warnings: string[] }[] = [
  { name: 'a failed check missing from the amended node is removed', before: [DOC, TESTS], outcomes: ['passed', 'failed'], after: [DOC], warnings: ['node "a": verify loosened - check 2 removed'] },
  { name: 'a node missing from the amended definition removes each failed check', before: [DOC, TESTS], outcomes: ['failed', 'failed'], warnings: ['node "a": verify loosened - check 1 removed; check 2 removed'] },
  { name: 'contains shortened to a part of itself', before: [DOC], outcomes: ['failed'], after: [{ ...DOC, contains: 'Section' }], warnings: ['node "a": verify loosened - check 1 loosened: contains shortened'] },
  { name: 'absent lengthened to text that holds the old', before: [DOC], outcomes: ['failed'], after: [{ ...DOC, absent: 'TODO: later' }], warnings: ['node "a": verify loosened - check 1 loosened: absent lengthened'] },
  { name: 'a text field dropped', before: [DOC], outcomes: ['failed'], after: [{ kind: 'file', path: 'doc.md', absent: 'TODO' }], warnings: ['node "a": verify loosened - check 1 loosened: contains removed'] },
  { name: 'contains changed to unrelated text', before: [DOC], outcomes: ['failed'], after: [{ ...DOC, contains: 'Other' }], warnings: ['node "a": verify loosened - check 1 replaced: contains changed'] },
  { name: 'exit widened from the implied 0', before: [TESTS], outcomes: ['failed'], after: [{ ...TESTS, expect: { exit: [0, 1] } }], warnings: ['node "a": verify loosened - check 1 loosened: exit [0] -> [0,1]'] },
  { name: 'exit [0,1] narrowed to the implied 0', before: [{ ...TESTS, expect: { exit: [0, 1] } }], outcomes: ['failed'], after: [TESTS], warnings: [] },
  { name: 'exit moved to a set that is neither wider nor narrower', before: [TESTS], outcomes: ['failed'], after: [{ ...TESTS, expect: { exit: 1 } }], warnings: ['node "a": verify loosened - check 1 replaced: exit [0] -> [1]'] },
  { name: 'stdout matches changed', before: [{ ...TESTS, expect: { stdout: { matches: '0 fail' } } }], outcomes: ['failed'], after: [{ ...TESTS, expect: { stdout: { matches: 'fail' } } }], warnings: ['node "a": verify loosened - check 1 replaced: stdout.matches changed'] },
  { name: 'a stderr expectation removed', before: [{ ...TESTS, expect: { stderr: { equals: '' } } }], outcomes: ['failed'], after: [TESTS], warnings: ['node "a": verify loosened - check 1 loosened: stderr removed'] },
  { name: 'a field added or made stricter', before: [DOC, TESTS], outcomes: ['failed', 'failed'], after: [{ ...DOC, contains: 'Section done well', lastLine: 'end' }, { ...TESTS, expect: { stdout: { contains: 'pass' } }, timeoutMs: 60_000 }], warnings: [] },
  { name: 'a passed check loosened', before: [DOC, TESTS], outcomes: ['passed', 'not_run'], after: [{ kind: 'file', path: 'doc.md' }], warnings: [] },
  { name: 'a runtime-expanded child', before: [TESTS], outcomes: ['failed'], expandedFrom: 'parent', warnings: [] },
]

for (const { name, before, outcomes, after, expandedFrom, warnings } of loosening) {
  test(`checkLoosening: ${name}`, () => {
    expect(checkLoosening(verifiedRun(before, outcomes, expandedFrom), oneNode(after))).toEqual(warnings)
  })
}

// Properties of checkLoosening, judged by the evaluator that decides a check (check-eval.ts): a check is the set of
// outputs it passes. A pair that draws no warning must pass no output the old check failed; a pair whose every changed
// part is reported loosened must pass every output the old check passed. Texts are every string of up to four characters
// over a, b and a newline, so contains, absent, lastLine and equals all meet hits and misses. The seed is fixed, so a
// counterexample reproduces.
function seeded(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

function pick(random: () => number, items: readonly string[]): string {
  // SAFETY: random() is below 1, so the index is below items.length, and every caller passes a nonempty list.
  return items[Math.floor(random() * items.length)] as string
}

function word(random: () => number): string {
  return Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(random, ['a', 'b'])).join('')
}

function texts(length: number): string[] {
  return length === 0 ? [''] : texts(length - 1).flatMap(text => ['a', 'b', '\n'].map(letter => text + letter))
}

const TEXTS = [0, 1, 2, 3, 4].flatMap(texts)
const PATTERNS = ['a', 'b', '^a', 'a$', 'ab|ba', '\\n']

function randomExpect(random: () => number): TextExpect {
  const expectation: TextExpect = {}
  for (const field of TEXT_FIELDS) if (random() < 0.5) expectation[field] = field === 'matches' ? pick(random, PATTERNS) : word(random)
  return expectation
}

// Per field: keep, drop, shorten, lengthen or replace, so one pair can loosen one field and tighten another.
function mutate(random: () => number, before: TextExpect): TextExpect {
  const after: TextExpect = { ...before }
  for (const field of TEXT_FIELDS) {
    const value = before[field]
    const roll = random()
    if (roll < 0.4) continue
    if (roll < 0.55) delete after[field]
    else if (value !== undefined && field !== 'matches' && roll < 0.7) after[field] = value.slice(0, Math.max(1, value.length - 1))
    else if (value !== undefined && field !== 'matches' && roll < 0.85) after[field] = random() < 0.5 ? `${value}${word(random)}` : `${word(random)}${value}`
    else after[field] = field === 'matches' ? pick(random, PATTERNS) : word(random)
  }
  return after
}

// The parts of the warnings, one per changed check part, without the node prefix.
const warnedParts = (warnings: string[]) => warnings.flatMap(warning => warning.slice(warning.indexOf(' - ') + 3).split('; '))

test('checkLoosening property: no warning passes no text the old file check failed, and all-loosened passes every text it passed', () => {
  const random = seeded(20261029)
  const counterexamples: { before: TextExpect; after: TextExpect; text: string; warnings: string[] }[] = []
  let narrowerOrSame = 0
  let wider = 0
  for (let round = 0; round < 3000; round++) {
    const before = randomExpect(random)
    const after = mutate(random, before)
    const changed = TEXT_FIELDS.filter(field => before[field] !== after[field]).length
    if (changed === 0) continue
    const warnings = checkLoosening(verifiedRun([{ kind: 'file', path: 'doc.md', ...before }], ['failed']), oneNode([{ kind: 'file', path: 'doc.md', ...after }]))
    const parts = warnedParts(warnings)
    const loosened = parts.length === changed && parts.every(part => part.includes(' loosened: '))
    if (warnings.length === 0) narrowerOrSame++
    if (loosened) wider++
    for (const text of TEXTS) {
      const was = textProblem(text, before, 'text') === undefined
      const is = textProblem(text, after, 'text') === undefined
      if ((warnings.length === 0 && is && !was) || (loosened && was && !is)) counterexamples.push({ before, after, text, warnings })
    }
  }
  expect(counterexamples.slice(0, 3)).toEqual([])
  // Both claims must be exercised, or the property holds vacuously.
  expect(narrowerOrSame).toBeGreaterThan(100)
  expect(wider).toBeGreaterThan(100)
})

test('checkLoosening property: over every pair of exit sets, no warning accepts no new code and loosened keeps every old code', () => {
  const sets: (number | number[] | undefined)[] = [undefined, 0, 1, 2, [0, 1], [1, 2], [0, 2], [0, 1, 2]]
  const command = (exit: number | number[] | undefined): VerificationCheck =>
    exit === undefined ? { kind: 'command', argv: ['t'] } : { kind: 'command', argv: ['t'], expect: { exit } }
  const counterexamples: { before: unknown; after: unknown; code: number; warnings: string[] }[] = []
  for (const before of sets) {
    for (const after of sets) {
      const warnings = checkLoosening(verifiedRun([command(before)], ['failed']), oneNode([command(after)]))
      const loosened = warnings.length > 0 && warnedParts(warnings).every(part => part.includes(' loosened: '))
      for (const code of [0, 1, 2, 3]) {
        const was = exitProblem(code, before === undefined ? undefined : { exit: before }) === undefined
        const is = exitProblem(code, after === undefined ? undefined : { exit: after }) === undefined
        if ((warnings.length === 0 && is && !was) || (loosened && was && !is)) counterexamples.push({ before, after, code, warnings })
      }
    }
  }
  expect(counterexamples).toEqual([])
})
