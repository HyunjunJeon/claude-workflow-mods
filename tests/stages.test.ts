import { expect, test } from 'claude-code/testing'
import { definitionHash, nodeFingerprint, parseDefinition } from '../hooks/engine/definition.ts'
import { defaultNotesFolder } from '../hooks/engine/stages.ts'
import { lintDefinition } from '../hooks/engine/lint.ts'
import { amendRun, createRun } from '../hooks/engine/run.ts'
import { INPUT_SCHEMA, TOOL_DESCRIPTION, TOOL_DESCRIPTION_LIMIT } from '../hooks/engine/tool-spec.ts'
import type { Definition, NodeDef } from '../hooks/engine/types.ts'
import { parseChecks } from '../hooks/engine/verification.ts'
import { parseYaml } from '../hooks/engine/yaml.ts'

const full = (what: string) => `TASK: ${what}. DELIVERABLE: x. SCOPE: y. VERIFY: z. STOP WHEN: done.`

// Two producers: build checks itself with a command, docs with a file check.
const USER_NODES = [
  {
    id: 'build',
    prompt: full('build the CLI'),
    category: 'unspecified-high',
    writes: ['src/cli.ts'],
    verify: [{ kind: 'command', argv: ['bun', 'test', 'tests/cli.test.ts'] }],
  },
  {
    id: 'docs',
    prompt: full('document the CLI'),
    category: 'writing',
    writes: ['README.md'],
    verify: [{ kind: 'file', path: 'README.md', contains: '## CLI' }],
  },
]

const REQUEST = 'Add a `greet` CLI that prints "hello <name>".\nDocument it in the README.'

function parse(input: Record<string, unknown>): Definition {
  const parsed = parseDefinition({ key: 'cli-phase', goal: 'A greet CLI ships with docs.', nodes: USER_NODES, ...input })
  if (!parsed.ok) throw new Error(`${parsed.error.code}: ${parsed.error.message}`)
  return parsed.value
}

function node(definition: Definition, id: string): NodeDef {
  const found = definition.nodes.find(candidate => candidate.id === id)
  if (!found) throw new Error(`no node "${id}" in ${definition.nodes.map(candidate => candidate.id).join(', ')}`)
  return found
}

test('review adds review-spec and review-standards after every user node, on the review category, writing nothing', () => {
  const definition = parse({ review: { request: REQUEST } })
  expect(definition.nodes.map(candidate => candidate.id)).toEqual(['build', 'docs', 'review-spec', 'review-standards'])
  const spec = node(definition, 'review-spec')
  const standards = node(definition, 'review-standards')
  expect([spec.dependsOn, spec.category, spec.writes, spec.label]).toEqual([['build', 'docs'], 'unspecified-low', [], 'Review: spec axis'])
  expect([standards.dependsOn, standards.category, standards.writes, standards.label]).toEqual([['build', 'docs'], 'unspecified-low', [], 'Review: standards axis'])
  expect(standards.load_skills).toEqual(['dag-workflow:review-standards'])
  expect(spec.load_skills).toBeUndefined()
})

const COMMITS = [
  { message: 'feat(cli): add greet\n\nPrints hello <name>.', paths: ['src/cli.ts', 'tests/cli.test.ts'] },
  { message: 'docs: document greet', paths: ['README.md'] },
]

test('commit after review depends on both reviewers, runs on quick and declares no writes', () => {
  const definition = parse({ review: { request: REQUEST }, commit: COMMITS })
  expect(definition.nodes.map(candidate => candidate.id)).toEqual(['build', 'docs', 'review-spec', 'review-standards', 'commit'])
  const commit = node(definition, 'commit')
  expect([commit.dependsOn, commit.category, commit.writes]).toEqual([['review-spec', 'review-standards'], 'quick', undefined])
})

test('commit without review depends on every user node', () => {
  const definition = parse({ commit: COMMITS })
  expect(definition.nodes.map(candidate => candidate.id)).toEqual(['build', 'docs', 'commit'])
  expect(node(definition, 'commit').dependsOn).toEqual(['build', 'docs'])
})

// The pathspec is `:/`, the repository root, not `.`: checks run from the project root, and `.` covers only that folder, so a
// project that is a subfolder of its repository would let a file swept in from outside it pass. The `:(exclude,literal)` entries
// stay relative to the project root, which is where the worker's paths are written from. Every listed path is literal: git reads
// a bare pathspec as a pattern, so `app/[id]/page.ts` would also name `app/i/page.ts` and a leading `:` would start magic.
const SHOW = ['git', 'show', '--format=', '--name-only']
const EMPTY = { stdout: { equals: '' } }

test('commit verify checks each subject in commit order, that each commit holds only its own paths, and that no listed path is left uncommitted', () => {
  expect(node(parse({ commit: COMMITS }), 'commit').verify).toEqual([
    { kind: 'command', argv: ['git', 'log', '-1', '--skip=1', '--format=%s'], expect: { stdout: { equals: 'feat(cli): add greet' } } },
    { kind: 'command', argv: ['git', 'log', '-1', '--skip=0', '--format=%s'], expect: { stdout: { equals: 'docs: document greet' } } },
    // Commit 1 of 2 sits at HEAD~1 and commit 2 at HEAD; each lists what it changed outside its own paths, which must be nothing.
    { kind: 'command', argv: [...SHOW, 'HEAD~1', '--', ':/', ':(exclude,literal)src/cli.ts', ':(exclude,literal)tests/cli.test.ts'], expect: EMPTY },
    { kind: 'command', argv: [...SHOW, 'HEAD', '--', ':/', ':(exclude,literal)README.md'], expect: EMPTY },
    { kind: 'command', argv: ['git', 'status', '--porcelain', '--', ':(literal)src/cli.ts', ':(literal)tests/cli.test.ts', ':(literal)README.md'], expect: { stdout: { equals: '' } } },
  ])
})

test('a single commit is checked at HEAD, and five commits at HEAD~4 down to HEAD, within the 16-check limit', () => {
  const one = node(parse({ commit: [COMMITS[1]] }), 'commit').verify
  expect(one?.map(check => (check.kind === 'command' ? check.argv.join(' ') : check.kind))).toEqual([
    'git log -1 --skip=0 --format=%s',
    'git show --format= --name-only HEAD -- :/ :(exclude,literal)README.md',
    'git status --porcelain -- :(literal)README.md',
  ])
  const five = parse({ commit: Array.from({ length: 5 }, (_, index) => ({ message: `chore: step ${index}`, paths: [`f${index}.txt`, `d${index}`] })) })
  const checks = node(five, 'commit').verify ?? []
  expect(checks).toHaveLength(11)
  const sweeps = checks.filter(check => check.kind === 'command' && check.argv[1] === 'show')
  expect(sweeps.map(check => (check.kind === 'command' ? check.argv.slice(4) : []))).toEqual([
    ['HEAD~4', '--', ':/', ':(exclude,literal)f0.txt', ':(exclude,literal)d0'],
    ['HEAD~3', '--', ':/', ':(exclude,literal)f1.txt', ':(exclude,literal)d1'],
    ['HEAD~2', '--', ':/', ':(exclude,literal)f2.txt', ':(exclude,literal)d2'],
    ['HEAD~1', '--', ':/', ':(exclude,literal)f3.txt', ':(exclude,literal)d3'],
    ['HEAD', '--', ':/', ':(exclude,literal)f4.txt', ':(exclude,literal)d4'],
  ])
})

test('the sweep check reads one commit by itself, so it needs no commit below it and fails closed when the commit is missing', () => {
  // `git show <commit>` of a repository's first commit lists every file it added, so a repository with exactly n commits works;
  // a ranged `git diff HEAD~n HEAD~(n-1)` would die with "bad revision" there. A commit that does not exist makes git exit 128.
  const sweeps = (node(parse({ commit: COMMITS }), 'commit').verify ?? []).filter(check => check.kind === 'command' && check.argv[1] === 'show')
  expect(sweeps).toHaveLength(COMMITS.length)
  for (const sweep of sweeps) {
    const argv = sweep.kind === 'command' ? sweep.argv : []
    expect(argv.slice(0, 4)).toEqual(SHOW)
    // One revision, always one of the n commits made (HEAD~0..HEAD~n-1): never HEAD~n, which a repository with n commits lacks.
    const revisions = argv.slice(4, argv.indexOf('--'))
    expect(revisions).toHaveLength(1)
    expect(['HEAD', 'HEAD~1']).toContain(revisions[0])
    // The first pathspec after `--` is the repository root, then only excludes: nothing narrows the sweep to a folder.
    const pathspecs = argv.slice(argv.indexOf('--') + 1)
    expect(pathspecs[0]).toBe(':/')
    expect(pathspecs.slice(1).every(pathspec => pathspec.startsWith(':(exclude,literal)'))).toBe(true)
    expect(sweep.kind === 'command' ? sweep.expect : undefined).toEqual(EMPTY)
  }
})

// Git reads a bare pathspec as a pattern: a listed `app/[id]/page.ts` also names the sibling `app/i/page.ts` (the brackets are a
// character class), and a listed `:memo.md` starts pathspec magic and names `memo.md`. Next.js and SvelteKit routes make such
// paths routine, so every path the commit stage hands git is literal, in the generated checks and in the worker's commands.
const ROUTE = 'app/[id]/page.ts'
const MEMO = ':memo.md'
const ROUTE_COMMIT = [{ message: 'feat(app): add the id route', paths: [ROUTE, MEMO] }]

test('a bracket path and a path starting with a colon reach the sweep and status checks as literal pathspecs', () => {
  const checks = node(parse({ commit: ROUTE_COMMIT }), 'commit').verify ?? []
  expect(checks.map(check => (check.kind === 'command' ? check.argv : [check.kind]))).toEqual([
    ['git', 'log', '-1', '--skip=0', '--format=%s'],
    [...SHOW, 'HEAD', '--', ':/', ':(exclude,literal)app/[id]/page.ts', ':(exclude,literal):memo.md'],
    ['git', 'status', '--porcelain', '--', ':(literal)app/[id]/page.ts', ':(literal):memo.md'],
  ])
})

test('the commit prompt has the worker run git with literal pathspecs, naming each path as the shell needs it', () => {
  const prompt = node(parse({ commit: ROUTE_COMMIT }), 'commit').prompt
  for (const text of [
    'run `git --literal-pathspecs add -- <its paths>`, then `git --literal-pathspecs commit -m <subject> -m <body> -- <its paths>`',
    // Plain git would read these as patterns; the shell would expand the bracket path before git sees it.
    'read every path as a literal file name',
    'Quote each path for the shell too',
    "Commit 1 of 1\n  paths: 'app/[id]/page.ts' :memo.md\n",
    "`git --literal-pathspecs status --porcelain -- 'app/[id]/page.ts' :memo.md` prints nothing",
  ]) expect({ text, found: prompt.includes(text) }).toEqual({ text, found: true })
  expect(prompt).not.toContain('`git add --')
  expect(prompt).not.toContain('`git status --porcelain --')
})

test('a path with a space or a quote is single-quoted for the shell in the prompt and left whole in the checks', () => {
  const awkward = ['notes/my file.md', "it's.md", 'plain-name_1.txt']
  const commit = node(parse({ commit: [{ message: 'docs: notes', paths: awkward }] }), 'commit')
  expect(commit.prompt).toContain("paths: 'notes/my file.md' 'it'\\''s.md' plain-name_1.txt\n")
  const status = (commit.verify ?? []).find(check => check.kind === 'command' && check.argv[1] === 'status')
  expect(status?.kind === 'command' ? status.argv.slice(4) : []).toEqual([':(literal)notes/my file.md', ":(literal)it's.md", ':(literal)plain-name_1.txt'])
})

// The default folder is the cleaned key plus the first six hex digits of cyrb53(key); the digits are a pinned literal so a change shows.
const CLI_FOLDER = '/tmp/dag-review/cli-phase-ffa95b'
const SPEC_NOTES = `${CLI_FOLDER}/review-spec-notes.md`
const STANDARDS_NOTES = `${CLI_FOLDER}/review-standards-notes.md`

test('reviewer verify checks read the verdict line and the findings heading of their notes files, and parse as written', () => {
  const definition = parse({ review: { request: REQUEST } })
  const spec = node(definition, 'review-spec').verify
  const standards = node(definition, 'review-standards').verify
  expect(spec).toEqual([
    { kind: 'file', path: SPEC_NOTES, lastLine: 'Spec verdict: PASS' },
    { kind: 'file', path: SPEC_NOTES, contains: '## Findings' },
  ])
  expect(standards).toEqual([
    { kind: 'file', path: STANDARDS_NOTES, lastLine: 'Standards verdict: PASS' },
    { kind: 'file', path: STANDARDS_NOTES, contains: '## Rule breaches' },
  ])
  for (const checks of [spec, standards, node(parse({ commit: COMMITS }), 'commit').verify]) {
    expect(parseChecks(checks)).toEqual({ ok: true, value: checks })
  }
})

test('review notes, category and rules replace the defaults', () => {
  const definition = parse({ review: { request: REQUEST, notes: '/var/tmp/greet-notes/', category: 'unspecified-high', rules: ['CONTRIBUTING.md', 'docs/style.md'] } })
  const spec = node(definition, 'review-spec')
  const standards = node(definition, 'review-standards')
  expect(spec.verify?.[0]).toEqual({ kind: 'file', path: '/var/tmp/greet-notes/review-spec-notes.md', lastLine: 'Spec verdict: PASS' })
  expect(standards.verify?.[0]).toEqual({ kind: 'file', path: '/var/tmp/greet-notes/review-standards-notes.md', lastLine: 'Standards verdict: PASS' })
  expect([spec.category, standards.category]).toEqual(['unspecified-high', 'unspecified-high'])
  expect(standards.prompt).toContain('CONTRIBUTING.md, docs/style.md')
})

test('rules are read first and add to the default search for CONTRIBUTING, CLAUDE.md and AGENTS.md instead of replacing it', () => {
  const withRules = node(parse({ review: { request: REQUEST, rules: ['docs/style.md', 'CONTRIBUTING.md'] } }), 'review-standards').prompt
  const without = node(parse({ review: { request: REQUEST } }), 'review-standards').prompt
  const search = 'search for CONTRIBUTING, CLAUDE.md and AGENTS.md (at the root and in every folder the change touches)'
  expect(without).toContain(search)
  expect(withRules).toContain(search)
  expect(withRules).toContain('docs/style.md, CONTRIBUTING.md')
  expect(withRules.indexOf('docs/style.md, CONTRIBUTING.md')).toBeLessThan(withRules.indexOf(search))
  expect(withRules).toContain('in addition to')
  expect(withRules).not.toContain('If none exist, say so and use only the baseline')
  const bad = parseDefinition({ key: 'k', goal: 'g', nodes: USER_NODES, review: { request: REQUEST, rules: [] } })
  expect(bad.ok ? undefined : bad.error.message).toContain('rule file paths')
})

test('the default notes folder keeps a key with slashes or dots inside /tmp/dag-review', () => {
  const parsed = parseDefinition({ key: '../phase 2/x', goal: 'g', nodes: USER_NODES, review: { request: REQUEST } })
  if (!parsed.ok) throw new Error(parsed.error.message)
  expect(node(parsed.value, 'review-spec').verify?.[0]).toEqual({ kind: 'file', path: '/tmp/dag-review/..-phase-2-x-1a6928/review-spec-notes.md', lastLine: 'Spec verdict: PASS' })
})

test('keys that clean alike get distinct default folders, and one key always gets the same folder', () => {
  const spaced = defaultNotesFolder('Q3 ledger/missing')
  const dashed = defaultNotesFolder('Q3-ledger-missing')
  expect([spaced, dashed]).toEqual(['/tmp/dag-review/Q3-ledger-missing-f88d12', '/tmp/dag-review/Q3-ledger-missing-17a779'])
  expect(defaultNotesFolder('Q3 ledger/missing')).toBe(spaced)
  expect(defaultNotesFolder('stages-1')).toBe('/tmp/dag-review/stages-1-1894e0')
  for (const key of ['.', '..', '...', '../x', 'a b', 'ünï', '한국어', 'x'.repeat(40)]) {
    expect(defaultNotesFolder(key)).toMatch(/^\/tmp\/dag-review\/[A-Za-z0-9_.-]+-[0-9a-f]{6}$/)
  }
  // Through the definition: the two keys' reviewers read different notes files.
  const specPath = (key: string) => {
    const parsed = parseDefinition({ key, goal: 'g', nodes: USER_NODES, review: { request: REQUEST } })
    if (!parsed.ok) throw new Error(parsed.error.message)
    const check = node(parsed.value, 'review-spec').verify?.[0]
    return check?.kind === 'file' ? check.path : undefined
  }
  expect(specPath('Q3 ledger/missing')).toBe(`${spaced}/review-spec-notes.md`)
  expect(specPath('Q3-ledger-missing')).toBe(`${dashed}/review-spec-notes.md`)
  // A key of only dots no longer needs a special name: the hash suffix keeps its segment from being "." or "..".
  expect([specPath('.'), specPath('..')]).toEqual([`${defaultNotesFolder('.')}/review-spec-notes.md`, `${defaultNotesFolder('..')}/review-spec-notes.md`])
  expect(defaultNotesFolder('..')).toBe('/tmp/dag-review/..-60c0ac')
})

test('review-spec prompt carries the request verbatim, the goal, the change, the real checks, the audit and the notes contract', () => {
  const prompt = node(parse({ review: { request: REQUEST } }), 'review-spec').prompt
  for (const text of [
    'TASK:', 'DELIVERABLE:', 'SCOPE:', 'VERIFY:', 'STOP WHEN',
    REQUEST,
    'GOAL: A greet CLI ships with docs.',
    'git status --porcelain', 'git diff', 'untracked',
    'build: argv ["bun","test","tests/cli.test.ts"], expect exit 0',
    '(a) missing or partial implementation', '(b) unrequested behavior', '(c) implemented but wrong-looking behavior', 'file:line',
    'AUDIT FOR SAFE-BUT-WRONG OUTPUT', 'Status: partial/supporting-output', 'Write complete only when 1-4 all pass with evidence.',
    SPEC_NOTES, '## Request sentences', '## Findings', '## Real check', '## Safe-but-wrong audit',
    '`Spec verdict: PASS`', '`Spec verdict: FAIL`', 'LAST line',
    'READ-ONLY on the repository', `Write only under ${CLI_FOLDER}`, 'review-standards and is out of scope',
    'DAG_NODE_STATUS: failed',
  ]) expect({ text, found: prompt.includes(text) }).toEqual({ text, found: true })
})

test('review-spec says so when the user nodes declare no command check', () => {
  const nodes = [{ id: 'docs', prompt: full('document'), verify: [{ kind: 'file', path: 'README.md', contains: '## CLI' }] }]
  const parsed = parseDefinition({ key: 'k', goal: 'g', nodes, review: { request: REQUEST } })
  if (!parsed.ok) throw new Error(parsed.error.message)
  expect(node(parsed.value, 'review-spec').prompt).toContain('the nodes declared no command checks: write `none declared`')
})

test('review-standards prompt names the rule sources, its sections and verdict lines, and leaves the spec axis out', () => {
  const prompt = node(parse({ review: { request: REQUEST } }), 'review-standards').prompt
  for (const text of [
    'TASK:', 'DELIVERABLE:', 'SCOPE:', 'VERIFY:', 'STOP WHEN',
    'GOAL: A greet CLI ships with docs.',
    'CONTRIBUTING', 'CLAUDE.md', 'AGENTS.md', 'smell baseline', 'dag-workflow:review-standards',
    STANDARDS_NOTES, '## Rule sources', '## Rule breaches', '## Judgment calls',
    '`Standards verdict: PASS`', '`Standards verdict: FAIL`', 'LAST line',
    'git status --porcelain', 'untracked', 'READ-ONLY on the repository', 'review-spec and is out of scope',
    'DAG_NODE_STATUS: failed',
  ]) expect({ text, found: prompt.includes(text) }).toEqual({ text, found: true })
})

test('commit prompt lists each commit in order, gates on both verdicts and forbids broad staging, reverts and pushes', () => {
  const prompt = node(parse({ review: { request: REQUEST }, commit: COMMITS }), 'commit').prompt
  for (const text of [
    'TASK:', 'DELIVERABLE:', 'SCOPE:', 'VERIFY:', 'STOP WHEN',
    'Commit 1 of 2\n  paths: src/cli.ts tests/cli.test.ts\n  subject: feat(cli): add greet\n  body:\n    Prints hello <name>.',
    'Commit 2 of 2\n  paths: README.md\n  subject: docs: document greet\n  body: (none)',
    SPEC_NOTES, STANDARDS_NOTES, 'Commit NOTHING unless',
    'git --literal-pathspecs add -- <its paths>', 'git --literal-pathspecs commit -m <subject> -m <body> -- <its paths>', 'NEVER run `git add -A`, `git add .`',
    'never stage, restore, revert', 'Do not push', '--allow-empty',
    'git show --format= --name-only <commit>` lists no file outside that commit\'s own paths', 'all three VERIFY commands',
  ]) expect({ text, found: prompt.includes(text) }).toEqual({ text, found: true })
  expect(node(parse({ commit: COMMITS }), 'commit').prompt).not.toContain('review-spec-notes.md')
})

test('the same input expands to the same nodes, fingerprints and hash, and spelling a default out changes nothing', () => {
  const input = { review: { request: REQUEST }, commit: COMMITS }
  const first = parse(input)
  const second = parse(input)
  expect(second).toEqual(first)
  expect(second.nodes.map(nodeFingerprint)).toEqual(first.nodes.map(nodeFingerprint))
  const explicit = parse({ review: { request: REQUEST, notes: CLI_FOLDER, category: 'unspecified-low' }, commit: COMMITS })
  expect(definitionHash(explicit)).toBe(definitionHash(first))
  expect(first.review).toEqual({ request: REQUEST, notes: CLI_FOLDER, category: 'unspecified-low' })
  expect(first.commit).toEqual(COMMITS)
})

test('amend with the original fields reruns nothing, and a new request reruns only review-spec and the commit', () => {
  const input = { review: { request: REQUEST }, commit: COMMITS }
  const run = createRun(parse(input), { runId: 'r1', sessionId: 's1', now: 1_000 })
  const same = amendRun(run, parse(input), 2_000)
  if (!same.ok) throw new Error(same.error.message)
  expect(same.value.rerun).toEqual([])
  const changed = amendRun(run, parse({ ...input, review: { request: `${REQUEST}\nAlso print a newline.` } }), 2_000)
  if (!changed.ok) throw new Error(changed.error.message)
  expect([...changed.value.rerun].sort()).toEqual(['commit', 'review-spec'])
})

const REFUSALS: [string, Record<string, unknown>, string][] = [
  ['a user node named review-spec next to review', { review: { request: REQUEST }, nodes: [...USER_NODES, { id: 'review-spec', prompt: 'p', dependsOn: ['build'] }] }, 'named "review-spec"'],
  ['a user node named review-standards next to review', { review: { request: REQUEST }, nodes: [...USER_NODES, { id: 'review-standards', prompt: 'p' }] }, 'named "review-standards"'],
  ['a user node named commit next to commit', { commit: COMMITS, nodes: [...USER_NODES, { id: 'commit', prompt: 'p' }] }, 'named "commit"'],
  ['review that is not an object', { review: 'please review' }, 'definition.review must be an object'],
  ['a missing request', { review: {} }, 'request must be'],
  ['an empty request', { review: { request: '' } }, 'request must be'],
  ['a blank request', { review: { request: '  \n ' } }, 'request must be'],
  ['an unknown review field', { review: { request: REQUEST, note: '/tmp/x' } }, 'unknown field "note"'],
  ['a relative notes folder', { review: { request: REQUEST, notes: 'notes/review' } }, 'notes must be an absolute folder'],
  ['a notes folder that climbs', { review: { request: REQUEST, notes: '/tmp/../etc' } }, 'notes must be an absolute folder'],
  ['a notes folder in .claude/dag', { review: { request: REQUEST, notes: '/work/.claude/dag/notes' } }, 'notes must be an absolute folder'],
  ['a notes folder in .CLAUDE/DAG', { review: { request: REQUEST, notes: '/work/.CLAUDE/DAG' } }, 'notes must be an absolute folder'],
  ['an empty category', { review: { request: REQUEST, category: ' ' } }, 'category must be'],
  ['empty rules', { review: { request: REQUEST, rules: [] } }, 'rules must list'],
  ['a blank rule', { review: { request: REQUEST, rules: [''] } }, 'rules must list'],
  ['commit that is not a list', { commit: { message: 'm', paths: ['a'] } }, 'commit must list 1-5 commits'],
  ['no commits', { commit: [] }, 'commit must list 1-5 commits'],
  ['six commits', { commit: Array.from({ length: 6 }, (_, i) => ({ message: `m${i}`, paths: ['a'] })) }, 'commit must list 1-5 commits'],
  ['a commit that is not an object', { commit: ['feat: x'] }, 'commit[0] must be an object'],
  ['an empty message', { commit: [{ message: '', paths: ['a'] }] }, 'commit[0].message must be'],
  ['a blank message', { commit: [COMMITS[0], { message: ' \n', paths: ['a'] }] }, 'commit[1].message must be'],
  ['a commit without paths', { commit: [{ message: 'm' }] }, 'commit[0].paths must list'],
  ['empty paths', { commit: [{ message: 'm', paths: [] }] }, 'commit[0].paths must list'],
  ['51 paths', { commit: [{ message: 'm', paths: Array.from({ length: 51 }, (_, i) => `f${i}`) }] }, 'commit[0].paths must list'],
  ['a path that climbs', { commit: [{ message: 'm', paths: ['../x'] }] }, 'commit[0].paths must list'],
  ['an absolute path', { commit: [{ message: 'm', paths: ['/etc/passwd'] }] }, 'commit[0].paths must list'],
  ['a path in .claude', { commit: [{ message: 'm', paths: ['.claude/dag'] }] }, 'commit[0].paths must list'],
  ['an unknown commit field', { commit: [{ message: 'm', path: ['a'] }] }, 'unknown field "path"'],
]

test('review and commit refuse bad input with invalid_definition', () => {
  for (const [name, input, message] of REFUSALS) {
    const parsed = parseDefinition({ key: 'cli-phase', goal: 'g', nodes: USER_NODES, ...input })
    const error = parsed.ok ? undefined : parsed.error
    expect({ name, code: error?.code, matched: error?.message.includes(message) }).toEqual({ name, code: 'invalid_definition', matched: true })
  }
})

test('a user node may be named review-spec or commit when the matching field is absent', () => {
  const parsed = parseDefinition({ key: 'k', goal: 'g', nodes: [{ id: 'commit', prompt: 'p' }, { id: 'review-spec', prompt: 'p', dependsOn: ['commit'] }] })
  expect(parsed.ok).toBe(true)
})

test('a user node cannot depend on a generated node', () => {
  const parsed = parseDefinition({ key: 'k', goal: 'g', nodes: [...USER_NODES, { id: 'after', prompt: 'p', dependsOn: ['review-spec'] }], review: { request: REQUEST } })
  expect(parsed.ok ? undefined : parsed.error.code).toBe('unknown_dependency')
})

test('lint finds no warning in a definition expanded with review and commit, or review alone', () => {
  expect(lintDefinition(parse({ review: { request: REQUEST }, commit: COMMITS }))).toEqual([])
  expect(lintDefinition(parse({ review: { request: REQUEST } }))).toEqual([])
})

test('lint still flags reviewers routed to quick as final audits, so the clean result above is not vacuous', () => {
  const warnings = lintDefinition(parse({ review: { request: REQUEST, category: 'quick' } }))
  expect(warnings.filter(warning => warning.includes('final audit')).length).toBe(2)
})

test('commit alone adds no final-audit, vacuous or prompt-contract warning', () => {
  const warnings = lintDefinition(parse({ commit: COMMITS }))
  expect(warnings.filter(warning => /final audit|vacuous|TASK:|STOP WHEN/.test(warning))).toEqual([])
})

test('a definition without review or commit parses exactly as before', () => {
  const parsed = parseDefinition({ key: 'cli-phase', goal: 'A greet CLI ships with docs.', nodes: USER_NODES })
  expect(parsed).toEqual({
    ok: true,
    value: { key: 'cli-phase', name: 'cli-phase', goal: 'A greet CLI ships with docs.', nodes: USER_NODES.map(user => ({ ...user, dependsOn: [] })) },
  })
  expect(parsed.ok && ('review' in parsed.value || 'commit' in parsed.value)).toBe(false)
})

test('a YAML definition file declares review and commit in block style', () => {
  const source = [
    'key: yaml-phase',
    'goal: A greet CLI ships.',
    'review:',
    '  request: |',
    '    Add a greet CLI.',
    '    Keep it small.',
    '  rules:',
    '    - AGENTS.md',
    'commit:',
    '  - message: "feat(cli): add greet"',
    '    paths:',
    '      - src/cli.ts',
    'nodes:',
    '  - id: build',
    '    prompt: build it',
    '    verify:',
    '      - kind: command',
    '        argv: [bun, test]',
  ].join('\n')
  const parsed = parseDefinition(parseYaml(source))
  if (!parsed.ok) throw new Error(parsed.error.message)
  expect(parsed.value.nodes.map(candidate => candidate.id)).toEqual(['build', 'review-spec', 'review-standards', 'commit'])
  expect(parsed.value.review).toEqual({ request: 'Add a greet CLI.\nKeep it small.', notes: '/tmp/dag-review/yaml-phase-7520b8', category: 'unspecified-low', rules: ['AGENTS.md'] })
  expect(node(parsed.value, 'commit').verify?.[0]).toEqual({ kind: 'command', argv: ['git', 'log', '-1', '--skip=0', '--format=%s'], expect: { stdout: { equals: 'feat(cli): add greet' } } })
})

test('the dag tool schema declares review and commit, and the description names both within its limit', () => {
  const { review, commit } = INPUT_SCHEMA.properties.definition.properties
  expect([review.required, Object.keys(review.properties)]).toEqual([['request'], ['request', 'notes', 'category', 'rules']])
  expect([commit.minItems, commit.maxItems, commit.items.required, commit.items.properties.paths.maxItems]).toEqual([1, 5, ['message', 'paths'], 50])
  expect(TOOL_DESCRIPTION).toContain('"review":{request} and "commit":[{message,paths}]')
  expect(TOOL_DESCRIPTION.length).toBeLessThanOrEqual(TOOL_DESCRIPTION_LIMIT)
})

test('the description keeps the wording it had before review and commit, and still fits the limit', () => {
  for (const phrase of ['for session conflict display', '.yaml/.yml/.json definition file', 'previews waves, models, write conflicts and warnings']) {
    expect({ phrase, found: TOOL_DESCRIPTION.includes(phrase) }).toEqual({ phrase, found: true })
  }
  expect(TOOL_DESCRIPTION.length).toBeLessThanOrEqual(2048)
})
