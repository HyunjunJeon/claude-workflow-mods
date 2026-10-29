import { expect, test } from 'claude-code/testing'
import { nodeFingerprint, parseDefinition } from '../hooks/engine/definition.ts'
import { absentOccurrenceWarnings, containsPrecisionWarnings, deliverablePaths, isBlockedReportPath, isVerificationNode, lintDefinition, lintNotes, notesNameFor } from '../hooks/engine/lint.ts'
import type { ReviewStage } from '../hooks/engine/types.ts'
import { verificationProblem } from '../hooks/engine/verification.ts'

// Every definition carries a goal unless a test passes undefined, so the goal warning stays out of the other tests.
const build = (nodes: unknown[], goal?: string) => {
  const r = parseDefinition({ key: 'k', ...(goal === undefined ? {} : { goal }), nodes })
  if (!r.ok) throw new Error(r.error.message)
  return r.value
}
const def = (nodes: unknown[]) => build(nodes, 'a fixture goal')
const full = 'TASK: do it. DELIVERABLE: x. SCOPE: y. VERIFY: z. STOP WHEN: done.'
const lintVerify = (verify: unknown[]) => lintDefinition(def([{ id: 'x', prompt: full, verify }]))
const command = (...argv: string[]) => ({ kind: 'command', argv })

test('vacuous verify V1 warns about a file check without contains', async () => {
  const warnings = lintVerify([{ kind: 'file', path: 'out.md' }])
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('node "x"')
  expect(warnings[0]).toContain('vacuous verify')
  expect(warnings[0]).toContain('check 1 is a file check without contains, absent, matches, lastLine or equals, so it only proves the file exists (touch passes it)')
})

test('vacuous verify V1 stays silent when the file check has contains', async () => {
  expect(lintVerify([{ kind: 'file', path: 'out.md', contains: 'heading' }])).toEqual([])
})

test('vacuous verify V1 stays silent when the file check has any one text expectation', async () => {
  for (const [field, value] of [['contains', 'x'], ['absent', 'TODO'], ['matches', '^## Output$'], ['lastLine', 'PASS'], ['equals', ''], ['lastLine', '']] as const) {
    expect({ field, warnings: lintVerify([{ kind: 'file', path: 'out.md', [field]: value }]) }).toEqual({ field, warnings: [] })
  }
})

test('vacuous verify V4 warns about a command that accepts several exit codes without checking output', async () => {
  for (const exit of [[0, 1], [1, 2, 3], [0, 255]]) {
    const warnings = lintVerify([{ kind: 'command', argv: ['bun', 'test'], expect: { exit } }])
    expect({ exit, count: warnings.length }).toEqual({ exit, count: 1 })
    expect(warnings[0]).toContain('vacuous verify')
    expect(warnings[0]).toContain('check 1 accepts several exit codes without checking output')
  }
})

test('vacuous verify V4 stays silent on one accepted exit code or when output is checked', async () => {
  const run = (expectation: unknown) => lintVerify([{ kind: 'command', argv: ['bun', 'test'], expect: expectation }])
  expect(run({ exit: 1 })).toEqual([])
  expect(run({ exit: [1] })).toEqual([])
  expect(run({ exit: [0, 0] })).toEqual([])
  expect(run({ exit: [0, 1], stdout: { lastLine: 'PASS' } })).toEqual([])
  expect(run({ exit: [0, 1], stderr: { absent: 'error' } })).toEqual([])
  expect(run({ stdout: { contains: 'ok' } })).toEqual([])
})

test('the under-split rule does not count read-only absolute file checks as files the producer owns', async () => {
  const verify = [
    { kind: 'file', path: '/etc/a.txt', contains: 'x' },
    { kind: 'file', path: '/etc/b.txt', contains: 'x' },
    { kind: 'file', path: 'C:\\data\\d.txt', contains: 'x' },
    { kind: 'file', path: 'c.md', contains: 'x' },
  ]
  expect(lintVerify(verify)).toEqual([])
})

test('the report-name rule warns on absolute verify paths too, such as review notes under /tmp', async () => {
  for (const path of ['/tmp/run/FINDINGS-notes.md', 'C:\\tmp\\REPORT.md', '/var/summary.md']) {
    const warnings = lintVerify([{ kind: 'file', path, lastLine: 'Verdict: PASS' }])
    expect({ path, count: warnings.length }).toEqual({ path, count: 1 })
    expect(warnings[0]).toContain(`node "x": "${path}" is named like a report`)
  }
  expect(lintVerify([{ kind: 'file', path: '/tmp/run/review-spec-notes.md', lastLine: 'Verdict: PASS' }])).toEqual([])
})

// Seen in eval 20261012050550: node report-draft wrote and checked report-draft-notes.md, got the warning three times, and
// was told to use report-draft-notes.md, the very name it warned about.
test('the report-name rule warns once per node and never suggests a name it would refuse', async () => {
  const notes = '/tmp/stats/report-draft-notes.md'
  const warnings = lintDefinition(def([{ id: 'report-draft', prompt: full, writes: ['report-draft-notes.md'], verify: [
    { kind: 'file', path: notes, lastLine: 'Done' },
    { kind: 'file', path: notes, contains: '| n |' },
    { kind: 'file', path: 'report-draft-notes.md', contains: 'x' },
  ] }]))
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain(`node "report-draft": "${notes}", "report-draft-notes.md" are named like a report`)
  expect(warnings[0]).toContain('such as notes-report-draft.md')
  for (const id of ['report-draft', 'summary', 'Findings-1', 'analysis_x', 'build', 'review-spec']) {
    expect({ id, refused: isBlockedReportPath(notesNameFor(id)) }).toEqual({ id, refused: false })
  }
  expect([notesNameFor('build'), notesNameFor('summary')]).toEqual(['build-notes.md', 'notes-summary.md'])
})

test('vacuous verify V2 warns about every program that always passes', async () => {
  for (const program of ['true', ':', 'echo', 'printf', 'exit', 'yes', 'sleep']) {
    const warnings = lintVerify([command(program, 'x')])
    expect({ program, count: warnings.length }).toEqual({ program, count: 1 })
    expect(warnings[0]).toContain('vacuous verify')
    expect(warnings[0]).toContain(`check 1 runs ${program}, which always passes`)
  }
  const byPath = lintVerify([{ kind: 'file', path: 'out.md', contains: 'heading' }, command('/bin/true')])
  expect(byPath).toHaveLength(1)
  expect(byPath[0]).toContain('check 2 runs true, which always passes')
  const windows = lintVerify([command('C:\\tools\\echo', 'ok')])
  expect(windows).toHaveLength(1)
  expect(windows[0]).toContain('check 1 runs echo, which always passes')
})

test('vacuous verify V2 stays silent on commands that can fail', async () => {
  expect(lintVerify([command('bun', 'test')])).toEqual([])
  expect(lintVerify([command('git', 'diff', '--check')])).toEqual([])
})

test('vacuous verify V3 warns about bare existence tests and path-only programs', async () => {
  const existence: string[][] = [
    ['test', '-e', 'x'],
    ['test', '-f', 'x'],
    ['test', '-d', 'x'],
    ['test', '-s', 'x'],
    ['[', '-f', 'x', ']'],
    ['/usr/bin/test', '-f', 'x'],
    ['ls', 'x'],
    ['stat', 'x'],
    ['cat', 'x'],
  ]
  for (const argv of existence) {
    const warnings = lintVerify([command(...argv)])
    expect({ argv, count: warnings.length }).toEqual({ argv, count: 1 })
    expect(warnings[0]).toContain('vacuous verify')
    expect(warnings[0]).toContain('check 1 only tests that a path exists')
  }
})

test('vacuous verify V3 stays silent on tests that look at content or have no existence flag', async () => {
  expect(lintVerify([command('test', '-n', 'x')])).toEqual([])
  expect(lintVerify([command('test', '-r', 'x')])).toEqual([])
  expect(lintVerify([command('[', '-z', 'x', ']')])).toEqual([])
  expect(lintVerify([command('test', '-f', 'a', '-a', '-f', 'b')])).toEqual([])
  expect(lintVerify([command('test', 'a', '=', 'b')])).toEqual([])
  expect(lintVerify([command('grep', '-q', 'x', 'a.md')])).toEqual([])
})

test('vacuous verify collects every offending check of one node into one warning', async () => {
  const definition = def([
    {
      id: 'x',
      prompt: full,
      verify: [{ kind: 'file', path: 'out.md' }, { kind: 'file', path: 'out.md', contains: 'heading' }, command('true')],
    },
    { id: 'verify-x', prompt: full, dependsOn: ['x'], verify: [{ kind: 'file', path: 'y.md', contains: 'ok' }, command('bun', 'test')] },
  ])
  const warnings = lintDefinition(definition)
  expect(warnings).toEqual([
    'node "x": vacuous verify - check 1 is a file check without contains, absent, matches, lastLine or equals, so it only proves the file exists (touch passes it); check 3 runs true, which always passes - declare a file check with contains, absent, matches, lastLine or equals, or a command that fails when the deliverable is wrong (one accepted exit code, or an expect on its stdout or stderr).',
  ])
  expect(warnings[0]).not.toContain('check 2')
  expect(verificationProblem(definition)).toBeUndefined()
})

test('a definition without a goal gets the goal warning, after every other warning', async () => {
  const nodes = [{ id: 'x', prompt: 'TASK: only a task' }]
  for (const goal of [undefined, '', '   ']) {
    const warnings = lintDefinition(build(nodes, goal))
    expect({ goal, count: warnings.length }).toEqual({ goal, count: 2 })
    expect(warnings[0]).toContain('node "x": the prompt lacks STOP WHEN')
    expect(warnings[1]).toContain('the definition has no goal')
    expect(warnings[1]).toBe('the definition has no goal - set "goal" to one sentence naming the deliverable and its observable done condition; every node sees it.')
  }
  const alone = lintDefinition(build([{ id: 'x', prompt: full }]))
  expect(alone).toHaveLength(1)
  expect(alone[0]).toContain('the definition has no goal')
})

test('the same definition with a goal gets no goal warning', async () => {
  const nodes = [{ id: 'x', prompt: 'TASK: only a task' }]
  const withGoal = lintDefinition(build(nodes, 'One sentence naming the deliverable and when it is done.'))
  expect(withGoal).toHaveLength(1)
  expect(withGoal.some(warning => warning.includes('the definition has no goal'))).toBe(false)
  expect(lintDefinition(build([{ id: 'x', prompt: full }], 'One sentence naming the deliverable and when it is done.'))).toEqual([])
})

const fileCheck = (path: string) => ({ kind: 'file', path, contains: 'ok' })
const underSplit = (node: Record<string, unknown>) =>
  lintDefinition(def([{ id: 'x', prompt: full, ...node }])).filter(warning => warning.includes('one producer owns'))

test('under-split lint counts the files inside a declared folder, not the folder itself', async () => {
  expect(underSplit({
    writes: ['skills/x/'],
    verify: [fileCheck('skills/x/A.md'), fileCheck('skills/x/sub/B.md')],
  })).toEqual([])
})

test('under-split lint names the three files of a folder and not the folder', async () => {
  const warnings = underSplit({
    writes: ['src/'],
    verify: [fileCheck('src/a.ts'), fileCheck('src/b.ts'), fileCheck('src/c.ts')],
  })
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('node "x": one producer owns 3 files (src/a.ts, src/b.ts, src/c.ts)')
  expect(warnings[0]).not.toContain('(src,')
})

test('under-split lint still warns on three paths that are not nested', async () => {
  const warnings = underSplit({ writes: ['a/', 'b/', 'c.md'] })
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('node "x": one producer owns 3 files (a, b, c.md)')
})

test('under-split lint does not treat a shared name prefix as a folder', async () => {
  const warnings = underSplit({ writes: ['src', 'src2/x.ts', 'z.md'] })
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('node "x": one producer owns 3 files (src, src2/x.ts, z.md)')
})

test('under-split lint counts a folder spelled ./src/ and a file inside it as one deliverable', async () => {
  expect(underSplit({ writes: ['./src/', 'src/a.ts', 'b.md'] })).toEqual([])
})

test('under-split lint counts one file once whatever its spelling', async () => {
  expect(underSplit({
    writes: ['src//a.ts', './src/a.ts', 'src\\a.ts', 'src/./a.ts', 'b.md'],
    verify: [fileCheck('src/a.ts')],
  })).toEqual([])
})

test('under-split lint lists the normalized spelling of each path it counts', async () => {
  const warnings = underSplit({ writes: ['./a.md', 'b//c.md', 'd\\e.md'] })
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('node "x": one producer owns 3 files (a.md, b/c.md, d/e.md)')
})

test('under-split lint treats a bare tests folder as tests, not as a deliverable', async () => {
  expect(underSplit({ writes: ['tests/', 'a.ts', 'b.md'] })).toEqual([])
})

test('under-split lint treats a nested tests folder as tests', async () => {
  expect(underSplit({ writes: ['src/tests', 'a.ts', 'b.md'] })).toEqual([])
})

test('under-split lint treats a nested __tests__ folder as tests', async () => {
  expect(underSplit({ writes: ['src/__tests__/', 'a.ts', 'b.md'] })).toEqual([])
})

test('under-split lint treats a bare test folder as tests', async () => {
  expect(underSplit({ writes: ['test', 'a.ts', 'b.md'] })).toEqual([])
})

test('under-split lint treats a file inside a tests folder as tests', async () => {
  expect(underSplit({ writes: ['tests/x.ts', 'a.ts', 'b.md'] })).toEqual([])
})

test('under-split lint treats a spec file as tests', async () => {
  expect(underSplit({ writes: ['src/a.spec.ts', 'a.ts', 'b.md'] })).toEqual([])
})

test('under-split lint does not treat names that merely contain test as tests', async () => {
  const warnings = underSplit({ writes: ['testsuite/a.ts', 'contest/b.ts', 'c.md'] })
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('node "x": one producer owns 3 files (testsuite/a.ts, contest/b.ts, c.md)')
})

const node = (fields: Record<string, string>) => ({ id: 'n', prompt: full, dependsOn: ['a'], ...fields })

test('a verification word counts only at the start of a word', async () => {
  for (const id of ['review-spec', 'verify', 'verify-x', 'checks', 'tests', 'unit_test', 'final.audit', 'validate-all', 'finalReview', 'e2eTests']) {
    expect({ id, verification: isVerificationNode(node({ id })) }).toEqual({ id, verification: true })
  }
  for (const id of ['preview', 'commit-preview', 'contest', 'retest', 'previewDocs', 'attestation', 'build']) {
    expect({ id, verification: isVerificationNode(node({ id })) }).toEqual({ id, verification: false })
  }
  expect(isVerificationNode(node({ id: 'commit', label: 'Commit the run preview' }))).toBe(false)
  expect(isVerificationNode(node({ id: 'final', label: 'Run tests' }))).toBe(true)
  expect(isVerificationNode(node({ id: 'final', task_summary: 'Re-check the diff' }))).toBe(true)
  expect(isVerificationNode(node({ id: 'final', description: '(Audit) every lane' }))).toBe(true)
})

test('a graph whose only candidate is a preview commit gets the no-verification-node warning', async () => {
  const warnings = lintDefinition(def([
    { id: 'a', prompt: full },
    { id: 'commit', label: 'Commit the run preview', prompt: full, dependsOn: ['a'] },
  ]))
  expect(warnings).toEqual(['the graph has no verification node - add a node that depends on the producers, runs the real check and has "verify" in its id or label.'])
})

const KIT_GOAL = 'Add the user search, avatar and user deletion endpoints, and commit the change only after it passes a secure-coding review against the KISA guide.'
const KIT_TAIL = " an endpoint that returns a user's avatar as a PNG with an ETag for HTTP caching (404 when the avatar file is missing), and an endpoint that deletes a user (404 when the user does not exist)."
const KIT_REQUEST = `Add a user search endpoint,${KIT_TAIL}`
const vagueClause = (clause: string) => `review.request: "${clause}" names a deliverable without an observable criterion (what it returns or does, its error and edge cases) - review-spec judges such a part by its own reading, so repeated runs can disagree; state the expected behavior.`
const NO_ACCESS_RULE = 'review.request: review.security is set, but neither the request nor the goal says who may use what it asks for - after a security fix adds an access check, review-spec can report it as unrequested or as conflicting with a requested result (a 403 before a requested 404); say who may perform each action.'
const review = (request: string, security?: string[]): ReviewStage => ({ request, notes: '/tmp/notes', category: 'standard', security })
const reviewLint = (stage: ReviewStage, goal = KIT_GOAL) => lintDefinition({ ...build([{ id: 'x', prompt: full }], goal), review: stage })
const requestWarnings = (warnings: string[]) => warnings.filter(warning => warning.startsWith('review.request:'))

test('review.request warns about the vague search clause and the missing access rule of the kit request', async () => {
  expect(requestWarnings(reviewLint(review(KIT_REQUEST, ['kisa'])))).toEqual([vagueClause('Add a user search endpoint'), NO_ACCESS_RULE])
})

test('review.request stays silent for a request with criteria and an access rule', async () => {
  const request = `Add a user search endpoint that returns the id and name of users whose name contains the query,${KIT_TAIL} Only the user or an admin may delete a user.`
  expect(requestWarnings(reviewLint(review(request, ['kisa'])))).toEqual([])
})

test('review.request never warns about access without review.security', async () => {
  expect(requestWarnings(reviewLint(review(KIT_REQUEST)))).toEqual([vagueClause('Add a user search endpoint')])
  expect(requestWarnings(reviewLint(review(KIT_REQUEST, [])))).toEqual([vagueClause('Add a user search endpoint')])
})

test('review.request accepts an access rule stated in the goal', async () => {
  const goal = 'Add the endpoints; only signed-in users may call them.'
  expect(requestWarnings(reviewLint(review('Add a user search endpoint that returns matching users', ['kisa']), goal))).toEqual([])
})

test('a definition without review gets no review.request warning', async () => {
  expect(requestWarnings(lintDefinition(build([{ id: 'x', prompt: full }], KIT_GOAL)))).toEqual([])
})

test('review.request keeps the commas inside parentheses in one clause', async () => {
  expect(requestWarnings(reviewLint(review('Add a lookup (by id, by name, by email) for users')))).toEqual([vagueClause('Add a lookup (by id, by name, by email) for users')])
})

test('review.request joins a clause of fewer than three words to the one before it', async () => {
  expect(requestWarnings(reviewLint(review('Add an order list, sorted newest-first')))).toEqual([])
})

test('review.request accepts a printed quoted literal as a criterion', async () => {
  expect(requestWarnings(reviewLint(review('Add a `greet` CLI that prints "hello <name>".\nDocument it in the README.')))).toEqual([])
})

test('review.request still warns about a clause whose only detail is a backticked name', async () => {
  expect(requestWarnings(reviewLint(review('Add a `search` endpoint')))).toEqual([vagueClause('Add a `search` endpoint')])
})

test('review.request accepts an output verb as a criterion', async () => {
  expect(requestWarnings(reviewLint(review('Add an export command that writes report.csv')))).toEqual([])
})

test('review.request accepts a quoted literal without an output verb, but not an empty one', async () => {
  expect(requestWarnings(reviewLint(review('Add a banner reading "Welcome back", add a placeholder field reading ""')))).toEqual([vagueClause('add a placeholder field reading ""')])
})

test('review.request does not ask who may act under review.security for a local CLI', async () => {
  expect(requestWarnings(reviewLint(review('Add a `greet` CLI that prints "hello <name>"', ['kisa']), 'A greet CLI ships with docs.'))).toEqual([])
})

test('review.request still asks who may act under review.security for an endpoint', async () => {
  expect(requestWarnings(reviewLint(review(KIT_REQUEST, ['kisa'])))).toContain(NO_ACCESS_RULE)
})

const threeFiles = { writes: ['src/a.ts', 'src/b.ts', 'src/c.ts'] }
const sliceNode = (extra: Record<string, unknown>) => ({ id: 'api', prompt: full, ...threeFiles, ...extra })

const pathCases: [string, Record<string, unknown>, string[]][] = [
  ['./src/ and src are one spelling', { writes: ['./src/', 'src'] }, ['src']],
  ['a backslash path folds to a slash path', { writes: ['src\\a.ts', 'src/a.ts'] }, ['src/a.ts']],
  ['a folder and a file inside it count as the file', { writes: ['src', 'src/a.ts'] }, ['src/a.ts']],
  ['a tests folder and test files do not count', { writes: ['tests/', 'src/a.test.ts', 'src/a.ts'] }, ['src/a.ts']],
  ['an absolute check path is not a project file', { writes: ['a.ts'], verify: [{ kind: 'file', path: '/tmp/n.md', contains: 'x' }] }, ['a.ts']],
  ['a checked file inside a written folder counts as the file', { writes: ['src'], verify: [{ kind: 'file', path: './src/a.ts', contains: 'x' }] }, ['src/a.ts']],
  ['a duplicate spelling counts once', { writes: ['a.ts', './a.ts', 'a.ts'] }, ['a.ts']],
]

for (const [name, extra, expected] of pathCases) {
  test(`deliverablePaths: ${name}`, async () => {
    const node = def([{ id: 'x', prompt: full, ...extra }]).nodes[0]!
    expect(deliverablePaths(node)).toEqual(expected)
  })
}

test('slice: true turns the files warning into a note and slice: false keeps the warning', async () => {
  const sliced = def([sliceNode({ slice: true })])
  expect(lintDefinition(sliced).filter(w => w.includes('one producer owns'))).toEqual([])
  expect(lintNotes(sliced)).toEqual(['node "api": declared a vertical slice that owns 3 files (src/a.ts, src/b.ts, src/c.ts) - the files warning is expected'])
  const plain = def([sliceNode({ slice: false })])
  expect(lintDefinition(plain).some(w => w.includes('one producer owns 3 files'))).toBe(true)
  expect(lintNotes(plain)).toEqual([])
})

test('a slice that owns fewer than three files gets neither warning nor note', async () => {
  const small = def([sliceNode({ slice: true, writes: ['src/a.ts'] })])
  expect(lintDefinition(small)).toEqual([])
  expect(lintNotes(small)).toEqual([])
})

test('slice must be a boolean', async () => {
  const r = parseDefinition({ key: 'k', nodes: [sliceNode({ slice: 'yes' })] })
  expect(r.ok).toBe(false)
})

test('two definitions that differ only in slice give the same node fingerprint', async () => {
  const [a, b] = [true, false].map(slice => def([sliceNode({ slice })]).nodes[0]!)
  expect(nodeFingerprint(a!)).toBe(nodeFingerprint(b!))
})

const clauseWarnings = (request: string) => lintDefinition({ ...def([{ id: 'x', prompt: full }]), review: { request, notes: '/tmp/n', category: 'standard' } })
  .filter(w => w.startsWith('review.request: "'))

test('a clause that starts with a bare article states behavior and is not taken for a deliverable', async () => {
  expect(clauseWarnings('a run started in a board turn gets board lines in its settle message instead')).toEqual([])
  expect(clauseWarnings('Add a thing that does X, and a re-settle after a retry updates the same board')).toHaveLength(1)
  expect(clauseWarnings('and a re-settle after a retry updates the same board')).toEqual([])
})

test('a clause that starts with a deliverable verb still warns', async () => {
  expect(clauseWarnings('Add a /health endpoint')).toHaveLength(1)
})

const LONG = 'the exact sentence a worker could never guess'
const containsWarnings = (contains: string, prompt: string, texts: ReadonlyMap<string, string> = new Map()) =>
  containsPrecisionWarnings(def([{ id: 'x', prompt, verify: [{ kind: 'file', path: 'out.md', contains }] }]), texts)

test('a long contains that the prompt does not repeat warns with its length', () => {
  expect(LONG).toHaveLength(45)
  expect(containsWarnings(LONG, full)).toEqual([`node "x": check 1 contains a 45-character exact text that the prompt does not give the worker - quote it in the prompt or check a shorter stable phrase`])
})

test('a 40-character contains that the prompt repeats does not warn', () => {
  const forty = 'x'.repeat(40)
  expect(containsWarnings(forty, `${full} The file holds ${forty}.`)).toEqual([])
})

test('a long contains that the target file lacks warns, and one the file already holds does not', () => {
  expect(containsWarnings(LONG, full, new Map([['out.md', 'something else entirely']]))).toHaveLength(1)
  expect(containsWarnings(LONG, full, new Map([['out.md', `before ${LONG} after`]]))).toEqual([])
})

test('lintDefinition alone no longer judges a long contains', () => {
  expect(lintDefinition(def([{ id: 'x', prompt: full, verify: [{ kind: 'file', path: 'out.md', contains: LONG }] }])).filter(warning => warning.includes('exact text'))).toEqual([])
})

test('a 39-character contains does not warn even when the prompt lacks it', () => {
  expect(containsWarnings('x'.repeat(39), full)).toEqual([])
})

test('a 40-character contains the prompt lacks warns', () => {
  expect(containsWarnings('x'.repeat(40), full)).toHaveLength(1)
})

const absentDef = def([{ id: 'edit', prompt: full, verify: [{ kind: 'command', argv: ['true'] }, { kind: 'file', path: 'a.txt', absent: 'old' }] }])

test('an absent string that already occurs twice warns with its count and path', () => {
  expect(absentOccurrenceWarnings(absentDef, new Map([['a.txt', 'old and old']]))).toEqual(['node "edit": check 2 absent "old" already occurs 2 times in a.txt - narrow the string or the path, or the check may never pass'])
})

test('an absent string found once, or in a file that was not read, does not warn', () => {
  expect(absentOccurrenceWarnings(absentDef, new Map([['a.txt', 'one old only']]))).toEqual([])
  expect(absentOccurrenceWarnings(absentDef, new Map())).toEqual([])
})

const reviewFixWarnings = (fields: Record<string, unknown>, withReview = true) =>
  lintDefinition({ ...def([{ id: 'api', prompt: full, writes: ['src/api.ts'], ...fields }]), ...(withReview ? { review: review('Add the endpoints, each returns 200.') } : {}) })
    .filter(warning => warning.includes('review-fix'))

test('a review definition warns about a producer labelled with a word the review-fix round skips', () => {
  expect(reviewFixWarnings({ label: 'Add avatar and delete endpoints' })).toEqual(['node "api": its name contains "delete", so the automatic review-fix round would not rerun it after a FAIL verdict - rename it (id, label or task_summary) unless it really works outside the project files'])
})

test('the same producer without review does not warn about the review-fix round', () => {
  expect(reviewFixWarnings({ label: 'Add avatar and delete endpoints' }, false)).toEqual([])
})

test('a producer that declares external: true does not warn about the review-fix round', () => {
  expect(reviewFixWarnings({ label: 'Add avatar and delete endpoints', external: true })).toEqual([])
})

test('a producer labelled "Document the notify setting" does not warn about the review-fix round', () => {
  expect(reviewFixWarnings({ label: 'Document the notify setting' })).toEqual([])
})
