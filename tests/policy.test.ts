import { expect, test } from 'claude-code/testing'
import { SCENARIOS } from '../eval/scenarios.ts'
import { extractOutput } from '../hooks/engine/node-prompt.ts'
import { parseDefinition } from '../hooks/engine/definition.ts'
import { isVerificationNode, lintDefinition } from '../hooks/engine/lint.ts'
import { gatesMainLoop, gatesPlanning, isPlanningSkill, mainLoopVerdict, protocolFor, readOnlyBashProblem, type Enforcement, type TurnMode } from '../hooks/engine/policy.ts'

const NONE = new Set<string>()

test('read-only shell commands pass and anything that can write is refused', async () => {
  const readOnly = [
    'ls -la',
    'git status',
    'git -C repo log --oneline -20 | head -5',
    'rg "TODO" src && wc -l src/*.ts',
    'cat a.txt 2>/dev/null',
    'find . -name "*.ts" -not -path "./node_modules/*"',
    'git branch --show-current',
    'git diff HEAD~1 -- src/app.ts',
    'cd src; ls',
    'echo "a > b"',
  ]
  for (const command of readOnly) expect(`${command} => ${readOnlyBashProblem(command) ?? 'ok'}`).toBe(`${command} => ok`)

  const writing: [string, string][] = [
    ['rm -rf build', 'rm is not on the read-only command list'],
    ['echo hi > out.txt', 'output redirection writes files'],
    ['npm test', 'npm is not on the read-only command list'],
    ['git commit -m x', 'git commit is not a read-only git command'],
    ['git branch feature-x', 'git branch with a name or a write flag changes branches'],
    ['git branch -D old', 'git branch with a name or a write flag changes branches'],
    ['find . -name "*.tmp" -delete', 'find with -exec/-delete can change files'],
    ['cat $(which node)', 'command substitution can run anything'],
    ['echo "$(rm -rf x)"', 'command substitution can run anything'],
    ['ls && touch x', 'touch is not on the read-only command list'],
    ['sort -o out.txt in.txt', 'sort -o writes a file'],
    ['git ls-files | xargs rm', 'xargs is not on the read-only command list'],
    ['LC_ALL=C sed -i s/a/b/ f', 'sed -i is not allowed in the main conversation'],
  ]
  for (const [command, problem] of writing) expect(readOnlyBashProblem(command)).toBe(problem)
})

test('loops, version probes, uv pip reads and printing sed pass; their writing forms do not', async () => {
  const readOnly = [
    'for d in Day03 Day04 Day05; do echo "=== $d .py files"; find $d -name "*.py" -not -path "*/.venv/*" | sort; done; echo; ls -la Day03/.venv 2>&1 | head -5; which uv; uv --version; python3 --version',
    'ls -la Day03/.venv Day04/.venv 2>&1 | head; which uv; uv --version',
    'ls -a Day03 | grep -E "venv|^\\." ; grep -rhoE "^\\s*(from|import) [a-z_]+" Day03 --include=*.py | sed -E \'s/^\\s*(from|import) //\' | cut -d. -f1 | sort | uniq -c | sort -rn',
    'for f in Day03/uv.lock Day05/uv.lock; do echo "== $f"; rg -A1 \'^name = "pydantic"$\' $f; done',
    "sed -n '1,40p' README.md",
    "sed -n '/dependency-groups/,/^$/p;/\\[tool.pytest/,/^$/p' Day03/pyproject.toml",
    'uv pip list -p .venv/bin/python',
    'uv pip freeze',
    'if [ -f a.txt ]; then cat a.txt; else echo none; fi',
    'while read line; do echo "$line"; done < list.txt',
  ]
  for (const command of readOnly) expect(`${command} => ${readOnlyBashProblem(command) ?? 'ok'}`).toBe(`${command} => ok`)

  const writing: [string, string][] = [
    ['for f in *.tmp; do rm $f; done', 'rm is not on the read-only command list'],
    ['for f in $(ls); do cat $f; done', 'command substitution can run anything'],
    ['for in; do ls; done', 'a for loop must read "for NAME in WORDS"'],
    ["sed 's/a/b/w out.txt' f", 'sed s with the w or e flag writes files or runs commands'],
    ["sed -n '1w out.txt' f", 'sed command "w" can write files or run commands'],
    ["sed 's/x/date/e' f", 'sed s with the w or e flag writes files or runs commands'],
    ['sed -f script.sed f', 'sed -f is not allowed in the main conversation'],
    ['uv pip install requests', 'uv pip install is not a read-only uv command'],
    ['uv lock', 'uv lock is not a read-only uv command'],
    ['uv sync --version extra', 'uv sync is not a read-only uv command'],
    ['curl -s https://pypi.org/pypi/openrouter/json', 'curl is not on the read-only command list'],
    ['if true; then touch x; fi', 'touch is not on the read-only command list'],
    ['cat <(rm -rf build)', 'process substitution can run anything'],
    ['diff <(ls a) <(ls b)', 'process substitution can run anything'],
  ]
  for (const [command, problem] of writing) expect(readOnlyBashProblem(command)).toBe(problem)
})

test('a leading command builtin is skipped and the command after it is still checked', async () => {
  const readOnly = [
    'command claude --version',
    'command git status',
    'command ls -la',
    'if command git diff --quiet; then echo x; fi',
  ]
  for (const command of readOnly) expect(`${command} => ${readOnlyBashProblem(command) ?? 'ok'}`).toBe(`${command} => ok`)

  const writing: [string, string][] = [
    ['command rm -rf x', 'rm is not on the read-only command list'],
    ['command git commit -m x', 'git commit is not a read-only git command'],
    ['command claude plugin test .', 'claude is not on the read-only command list'],
    ['command -v claude', 'command is not on the read-only command list'],
    ['command -p rm x', 'command is not on the read-only command list'],
    ['command command rm x', 'rm is not on the read-only command list'],
    ['ls && command touch x', 'touch is not on the read-only command list'],
  ]
  for (const [command, problem] of writing) expect(readOnlyBashProblem(command)).toBe(problem)
})

// The message carries the command, so a failure names the command that leaked or was blocked.
function expectAllowed(commands: string[]): void {
  for (const command of commands) expect(`${command} => ${readOnlyBashProblem(command) ?? 'ok'}`).toBe(`${command} => ok`)
}

function expectRefused(cases: [string, string][]): void {
  for (const [command, problem] of cases) expect(`${command} => ${readOnlyBashProblem(command) ?? 'ok'}`).toBe(`${command} => ${problem}`)
}

const envReason = (name: string): string =>
  `${name}= is refused here: a shell variable can change what runs (PATH, LD_PRELOAD, GIT_*, and in zsh also path or functions) or carry a flag past these checks; write the value into the command instead`

test('a NAME=value prefix is skipped only for locale and display variables', async () => {
  expectAllowed([
    'LC_ALL=C sort a',
    'TZ=UTC date',
    'LANG=en_US.UTF-8 ls',
    'LANGUAGE=en ls',
    'NO_COLOR=1 rg foo hooks',
    'FORCE_COLOR=0 cat a',
    'CLICOLOR=0 ls',
    'COLUMNS=80 ls',
    'TERM=dumb ls',
    'LC_ALL=C TZ=UTC date',
    'if LC_ALL=C sort a; then echo ok; fi',
  ])
  expectRefused([
    ['LD_PRELOAD=/tmp/e.so ls', envReason('LD_PRELOAD')],
    ['PATH=./bin ls', envReason('PATH')],
    ['GIT_PAGER=sh git log', envReason('GIT_PAGER')],
    ['FOO=1 ls', envReason('FOO')],
    ['LC_ALL=C PATH=./bin ls', envReason('PATH')],
    ['PATH=./bin; ls', envReason('PATH')],
    ['if PATH=./bin ls; then echo x; fi', envReason('PATH')],
    ['LCX_ALL=C ls', envReason('LCX_ALL')],
    ['command GIT_DIR=x git log', envReason('GIT_DIR')],
    ['PATH+=:/tmp/x/ls; ls', envReason('PATH')],
    ['path[1]=/tmp/x/ls; ls', envReason('path')],
  ])
})

test('a shell variable of any case is refused, standing alone or as a prefix, and the reason says to write the value into the command', async () => {
  expectRefused([
    ['d=/tmp/x; tail -1 $d/f', envReason('d')],
    ['out=hooks; ls $out', envReason('out')],
    ['path=(/x $path); ls', envReason('path')],
    ['functions[ls]=x; ls', envReason('functions')],
    ['precmd_functions=x; ls', envReason('precmd_functions')],
    ['a=-delete; find . $a', envReason('a')],
    ['D=/tmp/x; ls', envReason('D')],
    ['http_proxy=x git log', envReason('http_proxy')],
  ])
  expectAllowed(['LC_ALL=C sort a', 'TZ=UTC date', 'LC_ALL=C TZ=UTC date'])
  expect(readOnlyBashProblem('d=/tmp/x; tail -1 $d/f')).toContain('write the value into the command')
})

test('git global options are limited to choosing the repository and the pager', async () => {
  expectAllowed([
    'git -C hooks status',
    'git -C a -C b log -1',
    'git --no-pager diff --stat',
    'git -P log -1',
    'git --git-dir .git status',
    'git --git-dir=.git --work-tree=. status',
    'git --work-tree . ls-files',
    'git --no-optional-locks status',
    'git --literal-pathspecs ls-files',
    'git --glob-pathspecs ls-files',
    'git --noglob-pathspecs ls-files',
    'git --icase-pathspecs ls-files',
  ])
  expectRefused([
    ['git -c core.pager=sh log', 'git global option -c is not on the read-only list'],
    ['git --config-env=core.pager=PAGER log', 'git global option --config-env is not on the read-only list'],
    ['git --exec-path=/tmp log', 'git global option --exec-path is not on the read-only list'],
    ['git --paginate log', 'git global option --paginate is not on the read-only list'],
    ['git --no-pager -c core.editor=sh log', 'git global option -c is not on the read-only list'],
    ['git -C hooks -c alias.x=y status', 'git global option -c is not on the read-only list'],
  ])
})

test('git refuses --output and --ext-diff after any subcommand and -O for grep', async () => {
  expectAllowed([
    'git log --oneline -3',
    'git diff --stat',
    'git diff --no-ext-diff',
    'git diff --output-indicator-new=+',
    'git diff -O orderfile',
    'git grep -n foo -- hooks',
    'git grep -e foo -e bar',
    'git show HEAD:README.md',
  ])
  expectRefused([
    ['git log --output=x', 'git --output writes a file'],
    ['git diff --output x', 'git --output writes a file'],
    ['git show --output=x HEAD', 'git --output writes a file'],
    ['git diff --ext-diff', 'git --ext-diff can run a program'],
    ['git log -p --ext-diff', 'git --ext-diff can run a program'],
    ['git grep -O foo', 'git grep -O can run a program'],
    ['git grep -nOsh foo', 'git grep -O can run a program'],
    ['git grep --open-files-in-pager=sh foo', 'git grep -O can run a program'],
    ['git grep --open-files-in-pager sh foo', 'git grep -O can run a program'],
  ])
})

test('fd, rg and tree refuse the flags that run a program or write a file', async () => {
  expectAllowed([
    'fd -e ts hooks',
    'fd -E node_modules',
    'fd -H',
    'fd -t f -e md docs',
    'rg -n foo hooks',
    'rg --no-pre foo hooks',
    'rg --pre-glob "*.md" foo',
    'tree -L 2',
    'tree -a -I node_modules',
    'tree -H .',
  ])
  expectRefused([
    ['fd -x rm {}', 'fd with -x/-X/--exec can run programs'],
    ['fd . --exec touch x', 'fd with -x/-X/--exec can run programs'],
    ['fd -HX rm', 'fd with -x/-X/--exec can run programs'],
    ['fd --exec-batch rm', 'fd with -x/-X/--exec can run programs'],
    ['fd --exec=rm', 'fd with -x/-X/--exec can run programs'],
    ['rg --pre ./x.sh foo', 'rg --pre/--hostname-bin can run a program'],
    ['rg --pre=./x.sh foo', 'rg --pre/--hostname-bin can run a program'],
    ['rg --hostname-bin=./h.sh foo', 'rg --pre/--hostname-bin can run a program'],
    ['tree -o out.txt', 'tree -o/-R writes files'],
    ['tree -aoout.txt', 'tree -o/-R writes files'],
    ['tree -R -H . x', 'tree -o/-R writes files'],
  ])
})

test('sort refuses every spelling of its output file and compress program, uniq its second operand', async () => {
  expectAllowed([
    'sort -u a',
    'sort -rn a',
    'sort -t o -k 2 a',
    'sort a | uniq -c | sort -rn',
    'uniq a',
    'uniq -c a',
    'uniq -f 1 a',
    'uniq -cs 2 a',
    'uniq < in.txt',
  ])
  expectRefused([
    ['sort -o out.txt in.txt', 'sort -o writes a file'],
    ['sort -oout.txt in.txt', 'sort -o writes a file'],
    ['sort -uo out.txt in.txt', 'sort -o writes a file'],
    ['sort --out=out.txt in.txt', 'sort -o writes a file'],
    ['sort --output out.txt in.txt', 'sort -o writes a file'],
    ['sort --compress-program=sh a', 'sort --compress-program can run a program'],
    ['sort --compress-program sh a', 'sort --compress-program can run a program'],
    ['sort --compress-prog=sh a', 'sort --compress-program can run a program'],
    ['uniq a b', 'uniq with an output file writes it'],
    ['uniq -c a b', 'uniq with an output file writes it'],
    ['uniq -f 1 a b', 'uniq with an output file writes it'],
    ['uniq -cs 2 a b', 'uniq with an output file writes it'],
    ['uniq -- a b', 'uniq with an output file writes it'],
    ['uniq - b', 'uniq with an output file writes it'],
  ])
})

test('file refuses -C, which compiles a magic file next to the source', async () => {
  expectAllowed(['file a.txt', 'file -b a.txt', 'file --mime-type a.txt', 'file -m magic a.txt'])
  expectRefused([
    ['file -C -m magic', 'file -C writes a magic.mgc file'],
    ['file -bC -m magic', 'file -C writes a magic.mgc file'],
    ['file --compile -m magic', 'file -C writes a magic.mgc file'],
    ['file --comp -m magic', 'file -C writes a magic.mgc file'],
  ])
})

test('the main conversation keeps read and orchestration tools only', async () => {
  for (const tool of ['mcp__dag-workflow__dag', 'mcp__dag-workflow__board', 'Read', 'LSP', 'WebFetch', 'AskUserQuestion', 'ExitPlanMode', 'TaskStop']) {
    expect(mainLoopVerdict(tool, {}, NONE)).toEqual({ allowed: true })
  }
  for (const tool of ['Edit', 'Write', 'NotebookEdit', 'Agent', 'Workflow', 'TodoWrite', 'TaskCreate', 'mcp__github__create_issue']) {
    expect(mainLoopVerdict(tool, {}, NONE).allowed).toBe(false)
  }
  expect(mainLoopVerdict('Bash', { command: 'git log -3' }, NONE)).toEqual({ allowed: true })
  expect(mainLoopVerdict('Bash', { command: 'make' }, NONE).allowed).toBe(false)
  expect(mainLoopVerdict('mcp__github__create_issue', {}, new Set(['mcp__github__create_issue']))).toEqual({ allowed: true })
})

test('the main conversation may Write only the report names the host refuses to subagents', async () => {
  for (const file_path of ['report.md', 'docs/REPORT-final.md', 'Summary.MD', '/work/out/findings_2026.md', 'analysis.md']) {
    expect(`${file_path} => ${mainLoopVerdict('Write', { file_path }, NONE).allowed}`).toBe(`${file_path} => true`)
  }
  for (const file_path of ['report.ts', 'notes/x.md', 'docs/report/index.md', 'my-report.md', 'report.md.bak', '']) {
    expect(`${file_path} => ${mainLoopVerdict('Write', { file_path }, NONE).allowed}`).toBe(`${file_path} => false`)
  }
  expect(mainLoopVerdict('Write', {}, NONE).allowed).toBe(false)
  expect(mainLoopVerdict('Write', { file_path: 42 }, NONE).allowed).toBe(false)
  for (const tool of ['Edit', 'MultiEdit', 'NotebookEdit']) {
    expect(mainLoopVerdict(tool, { file_path: 'report.md', notebook_path: 'report.md' }, NONE).allowed).toBe(false)
  }
  expect(mainLoopVerdict('Bash', { command: 'mv notes.md report.md' }, NONE).allowed).toBe(false)
  expect(mainLoopVerdict('Bash', { command: 'echo hi > report.md' }, NONE).allowed).toBe(false)
})

test('the planning skill is recognised by this plugin\'s qualified name and the bare name only', async () => {
  // the retired names are assembled so no tracked file outside flows/ spells an old skill name
  const retired = ['dag', 'planning'].join('-')
  expect(isPlanningSkill('dag-workflow:planning')).toBe(true)
  expect(isPlanningSkill('/dag-workflow:planning')).toBe(true)
  expect(isPlanningSkill(' dag-workflow:planning ')).toBe(true)
  expect(isPlanningSkill('planning')).toBe(true)
  expect(isPlanningSkill('/planning')).toBe(true)
  expect(isPlanningSkill('other:planning')).toBe(false)
  expect(isPlanningSkill('x:dag-workflow:planning')).toBe(false)
  expect(isPlanningSkill(`dag-workflow:${retired}`)).toBe(false)
  expect(isPlanningSkill(retired)).toBe(false)
  expect(isPlanningSkill('planning-extra')).toBe(false)
  expect(isPlanningSkill('dag-workflow:planning-extra')).toBe(false)
  expect(isPlanningSkill('mass-ulw')).toBe(false)
  expect(isPlanningSkill(undefined)).toBe(false)
})

test('the lint flags contract gaps per node and a missing verification node only for multi-node graphs', async () => {
  const def = (nodes: unknown[]) => {
    const r = parseDefinition({ key: 'k', goal: 'a fixture goal', nodes })
    if (!r.ok) throw new Error(r.error.message)
    return r.value
  }
  const full = 'TASK: do it. DELIVERABLE: x. SCOPE: y. VERIFY: z. STOP WHEN: done.'
  expect(lintDefinition(def([{ id: 'one', prompt: full }]))).toEqual([])
  expect(lintDefinition(def([{ id: 'one', prompt: 'TASK: only a task' }]))).toEqual([
    'node "one": the prompt lacks STOP WHEN - follow the node prompt contract (TASK, DELIVERABLE, SCOPE, VERIFY, STOP WHEN).',
  ])
  const noVerify = def([{ id: 'a', prompt: full }, { id: 'b', prompt: full, dependsOn: ['a'] }])
  expect(lintDefinition(noVerify)).toEqual(['the graph has no verification node - add a node that depends on the producers, runs the real check and has "verify" in its id or label.'])
  expect(lintDefinition(def([{ id: 'a', prompt: full }, { id: 'final', label: 'Run tests', prompt: full, dependsOn: ['a'] }]))).toEqual([])
  expect(isVerificationNode({ id: 'verify', prompt: full, dependsOn: [] })).toBe(false)
})

test('the lint reserves trivial for mechanical checks rather than a final audit', async () => {
  const def = (nodes: unknown[]) => {
    const r = parseDefinition({ key: 'k', goal: 'a fixture goal', nodes })
    if (!r.ok) throw new Error(r.error.message)
    return r.value
  }
  const full = 'TASK: do it. DELIVERABLE: x. SCOPE: y. VERIFY: z. STOP WHEN: done.'
  const lanes = [{ id: 'a', prompt: full }, { id: 'b', prompt: full }]
  expect(lintDefinition(def([...lanes, { id: 'audit', category: 'trivial', prompt: full, dependsOn: ['a', 'b'] }]))).toHaveLength(1)
  expect(lintDefinition(def([...lanes, { id: 'audit', prompt: full, dependsOn: ['a', 'b'] }]))).toHaveLength(1)
  expect(lintDefinition(def([...lanes, { id: 'audit', category: 'standard', prompt: full, dependsOn: ['a', 'b'] }]))).toEqual([])
  expect(lintDefinition(def([...lanes, { id: 'verify-a', category: 'trivial', prompt: full, dependsOn: ['a'] }]))).toEqual([])
  expect(
    lintDefinition(def([
      ...lanes,
      { id: 'verify-ab', category: 'trivial', prompt: full, dependsOn: ['a', 'b'] },
      { id: 'report', category: 'writing', prompt: full, dependsOn: ['verify-ab'] },
    ])),
  ).toEqual([])
})

test('the lint warns about verify paths and writes the host refuses for subagents', async () => {
  const def = (nodes: unknown[]) => {
    const r = parseDefinition({ key: 'k', goal: 'a fixture goal', nodes })
    if (!r.ok) throw new Error(r.error.message)
    return r.value
  }
  const full = 'TASK: do it. DELIVERABLE: x. SCOPE: y. VERIFY: z. STOP WHEN: done.'
  const blocked = lintDefinition(def([{ id: 'one', prompt: full, verify: [{ kind: 'file', path: 'REPORT.md', contains: 'ok' }] }]))
  expect(blocked).toHaveLength(1)
  expect(blocked[0]).toContain('node "one"')
  expect(blocked[0]).toContain('"REPORT.md" is named like a report')
  expect(blocked[0]).toContain('Claude Code 2.1.295')
  expect(blocked[0]).toContain('one-notes.md')
  expect(blocked[0]).toContain('main conversation writes the file after the run settles')
  expect(lintDefinition(def([{ id: 'one', prompt: full, verify: [{ kind: 'file', path: 'notes/docs-audit.md', contains: 'ok' }] }]))).toEqual([])
  const written = lintDefinition(def([{ id: 'one', prompt: full, writes: ['out/summary-final.md'] }]))
  expect(written).toHaveLength(1)
  expect(written[0]).toContain('"out/summary-final.md"')
})

const underSplitDef = (nodes: unknown[]) => {
  const r = parseDefinition({ key: 'k', goal: 'a fixture goal', nodes })
  if (!r.ok) throw new Error(r.error.message)
  return r.value
}
const contract = 'TASK: do it. DELIVERABLE: x. SCOPE: y. VERIFY: z. STOP WHEN: done.'
const fileCheck = (path: string) => ({ kind: 'file', path, contains: 'ok' })
const lane = (id: string, writes: string[], extra: Record<string, unknown> = {}) => ({
  id,
  category: 'trivial',
  prompt: contract,
  writes,
  verify: writes.map(fileCheck),
  ...extra,
})
const audit = (dependsOn: string[]) => lane('audit', ['notes/audit.md'], { category: 'standard', dependsOn })

test('a change with its own tests and docs stays one node without an under-split warning', async () => {
  expect(lintDefinition(underSplitDef([
    lane('feature', ['hooks/register.ts', 'tests/runtime.test.ts', 'src/band.spec.ts', 'README.md']),
    audit(['feature']),
  ]))).toEqual([])
})

test('the lint warns when one producer owns several independent files', async () => {
  const warnings = lintDefinition(underSplitDef([
    lane('site', ['LICENSE', '.editorconfig', 'CONTRIBUTING.md']),
    audit(['site']),
  ]))
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('node "site": one producer owns 3 files')
  expect(warnings[0]).toContain('LICENSE, .editorconfig, CONTRIBUTING.md')
})

test('the lint warns when the only producer writes several named sections', async () => {
  const prompt = `${contract} Write sorting.md with ## Bubble Sort, ## Merge Sort and ## Quicksort sections.`
  const warnings = lintDefinition(underSplitDef([
    { ...lane('write', ['sorting.md']), prompt },
    audit(['write']),
  ]))
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('node "write": the only producer writes 3 separate sections (bubble sort, merge sort, quicksort)')
  const lanes = ['bubble', 'merge', 'quick'].map(name => ({ ...lane(name, [`notes/${name}.md`]), prompt }))
  expect(lintDefinition(underSplitDef([...lanes, audit(['bubble', 'merge', 'quick'])]))).toEqual([])
})

test('the under-split lints stay silent on every expected scenario shape', async () => {
  const docs = ['intro', 'install', 'usage', 'config', 'faq', 'support']
  const shapes: Record<string, unknown[]> = {
    'single-edit': [lane('edit', ['counter.py'])],
    'parallel-files': [lane('license', ['LICENSE']), lane('editorconfig', ['.editorconfig']), lane('contributing', ['CONTRIBUTING.md']), audit(['license', 'editorconfig', 'contributing'])],
    'map-reduce-docs': [
      ...docs.map(name => lane(`fix-${name}`, [`docs/${name}.md`])),
      lane('changes', ['docs/CHANGES.md'], { dependsOn: docs.map(name => `fix-${name}`) }),
      audit(['changes']),
    ],
    'pipeline-stats': [
      lane('gen', ['gen.py', 'data.csv']),
      lane('stats', ['stats.py', 'stats.json'], { dependsOn: ['gen'] }),
      lane('table', ['stats-table.md'], { dependsOn: ['stats'] }),
      audit(['table']),
    ],
    'diamond-app': [
      lane('settings', ['settings.py']),
      lane('greeter', ['greeter.py'], { dependsOn: ['settings'] }),
      lane('repeater', ['repeater.py'], { dependsOn: ['settings'] }),
      lane('main', ['main.py'], { dependsOn: ['greeter', 'repeater'] }),
      lane('tests', ['test_app.py'], { dependsOn: ['main'] }),
      audit(['tests']),
    ],
    'debug-fix': [
      lane('diagnose', ['notes/diagnosis.md']),
      lane('fix', ['mathutil.py'], { dependsOn: ['diagnose'] }),
      audit(['fix']),
    ],
    // 450 items at 200 per trivial node: three batches is the minimum
    'wide-harvest': [
      ...[1, 2, 3].map(n => lane(`batch-${n}`, [`notes/batch-${n}.md`])),
      lane('totals', ['todo-report.md'], { dependsOn: ['batch-1', 'batch-2', 'batch-3'] }),
      audit(['totals']),
    ],
    'research-write': [
      ...['bubble', 'merge', 'quick'].map(name => lane(name, [`notes/${name}.md`])),
      lane('sorting', ['sorting.md'], { dependsOn: ['bubble', 'merge', 'quick'] }),
      audit(['sorting']),
    ],
  }
  expect(Object.keys(shapes).sort()).toEqual(SCENARIOS.map(scenario => scenario.id).sort())
  for (const [id, nodes] of Object.entries(shapes)) {
    expect({ id, warnings: lintDefinition(underSplitDef(nodes)) }).toEqual({ id, warnings: [] })
  }
})

test('the injected protocol states the rule for each enforcement level', async () => {
  expect(protocolFor('strict')).toContain('load the dag-workflow:planning skill with the Skill tool and follow it; start is refused until you do')
  expect(protocolFor('strict')).toContain('are refused here and belong inside DAG nodes')
  expect(protocolFor('strict')).toContain('The one exception: Write to a REPORT*, SUMMARY*, FINDINGS* or ANALYSIS* .md file the user asked for, which Claude Code refuses to subagents, only to copy a settled node\'s Output or notes verbatim.')
  expect(protocolFor('guide')).not.toContain('The one exception')
  expect(protocolFor('guide')).toContain('Prefer doing all work inside DAG nodes')
  expect(protocolFor('strict')).toContain('mcp__dag-workflow__dag')
})

test('a non-interactive session is told not to ask the user, an interactive one is not', async () => {
  for (const level of ['strict', 'guide'] as const) {
    const quiet = protocolFor(level, false)
    expect(quiet).toContain('Non-interactive session: do not ask the user')
    expect(quiet).toContain('record every assumption')
    expect(protocolFor(level, true)).toBe(protocolFor(level))
    expect(protocolFor(level, true)).not.toContain('Non-interactive session')
    expect(protocolFor(level)).not.toContain('Non-interactive session')
    expect(quiet.startsWith(protocolFor(level))).toBe(true)
  }
})

test('only strict, and auto on a DAG turn, gate the main loop; strict and auto gate the planning skill', async () => {
  const levels: Enforcement[] = ['strict', 'auto', 'guide', 'off']
  const gates = (mode: TurnMode) => levels.map(level => gatesMainLoop(level, mode))
  expect(gates('dag')).toEqual([true, true, false, false])
  expect(gates('direct')).toEqual([true, false, false, false])
  expect(levels.map(gatesPlanning)).toEqual([true, true, false, false])
})

test('under auto a DAG turn reads like strict plus one line saying why, and a direct turn is told to just do it', async () => {
  const strict = protocolFor('strict').split('\n')
  const why = '- This request runs as a DAG: under enforcement auto, Jev judged it to need three or more nodes that gain from parallel or isolated work, or this session has a DAG run that has not settled.'
  expect(protocolFor('auto', true, 'dag').split('\n')).toEqual([strict[0], why, ...strict.slice(1)])
  expect(protocolFor('auto')).toBe(protocolFor('auto', true, 'dag'))
  expect(protocolFor('auto', false, 'dag').split('\n')).toEqual([strict[0], why, ...strict.slice(1), protocolFor('strict', false).split('\n').at(-1)])

  const direct = [
    '[dag-workflow] This request is small: do it directly in this conversation; no DAG is needed.',
    '- If it turns out to need three or more independent pieces of work that gain from running in parallel or in isolated contexts, load the dag-workflow:planning skill and run it as a DAG instead.',
  ]
  expect(protocolFor('auto', true, 'direct').split('\n')).toEqual(direct)
  const quiet = protocolFor('auto', false, 'direct').split('\n')
  expect(quiet.slice(0, 2)).toEqual(direct)
  expect(quiet).toHaveLength(3)
  expect(quiet[2]).toBe(protocolFor('strict', false).split('\n').at(-1))
  expect(quiet[2]).toContain('Non-interactive session: do not ask the user')
  expect(protocolFor('auto', true, 'direct')).not.toContain('are refused here')
})

test('the mode only changes the text under auto: strict and guide ignore it', async () => {
  for (const level of ['strict', 'guide'] as const) {
    for (const interactive of [true, false]) expect(protocolFor(level, interactive, 'direct')).toBe(protocolFor(level, interactive))
  }
  expect(protocolFor('guide', true, 'dag')).not.toContain('under enforcement auto')
  expect(protocolFor('strict', true, 'dag')).not.toContain('under enforcement auto')
})

test('under auto a direct turn the user wants shown on a board is told to answer on one, with the load-and-draw steps', async () => {
  const board = protocolFor('auto', true, 'direct', 'board').split('\n')
  expect(board).toHaveLength(4)
  expect(board[0]).toBe('[dag-workflow] This request asks to understand something: answer it on a board in this conversation; no DAG is needed.')
  expect(board[1]).toContain('when it is deferred, load it with ToolSearch query "select:mcp__dag-workflow__board"')
  expect(board[2]).toBe('- Keep the chat reply to a few lines that point to the board. This is a should, not a gate: if the tool is unavailable, an edit is refused twice, or open replies shown: false, answer in chat instead.')
  expect(board[3]).toContain('- If it turns out to need three or more independent pieces of work')
  expect(protocolFor('auto', true, 'direct', 'board')).not.toContain('This request is small')
  const quiet = protocolFor('auto', false, 'direct', 'board').split('\n')
  expect(quiet.slice(0, 4)).toEqual(board)
  expect(quiet).toHaveLength(5)
  expect(quiet[4]).toContain('Non-interactive session: do not ask the user')
})

test('under auto a DAG turn the user wants shown on a board keeps the DAG text and adds the settle-time board line', async () => {
  const dag = protocolFor('auto', true, 'dag').split('\n')
  const board = protocolFor('auto', true, 'dag', 'board').split('\n')
  expect(board).toEqual([...dag, '- The user wants the answer on a board: once the run settles and you have verified it, draw the findings on a board with mcp__dag-workflow__board; the settle message repeats how.'])
  const quiet = protocolFor('auto', false, 'dag', 'board').split('\n')
  const quietDag = protocolFor('auto', false, 'dag').split('\n')
  expect(quiet).toEqual([...quietDag.slice(0, -1), board.at(-1), quietDag.at(-1)])
  expect(quiet.at(-1)).toContain('Non-interactive session: do not ask the user')
})

test('the surface only changes the text under auto: the chat default and every other level are untouched', async () => {
  for (const interactive of [true, false]) {
    for (const mode of ['dag', 'direct'] as const) expect(protocolFor('auto', interactive, mode, 'chat')).toBe(protocolFor('auto', interactive, mode))
    for (const level of ['strict', 'guide', 'off'] as const) {
      for (const mode of ['dag', 'direct'] as const) expect(protocolFor(level, interactive, mode, 'board')).toBe(protocolFor(level, interactive, mode, 'chat'))
    }
  }
  expect(protocolFor('auto', true, 'direct')).not.toContain('board')
  expect(protocolFor('auto', true, 'dag')).not.toContain('The user wants the answer on a board')
})

test('a node output is its "## Output" section, else its report without the status line', async () => {
  expect(extractOutput('notes\n## Output\n- wrote a.ts\n- API_KEY name is FOO\nDAG_NODE_STATUS: completed')).toBe('- wrote a.ts\n- API_KEY name is FOO')
  expect(extractOutput('just a report\nDAG_NODE_STATUS: completed')).toBe('just a report')
  expect(extractOutput(undefined)).toBe('')
  expect(extractOutput('### Output:\nx'.padEnd(50, 'y'), 10)).toBe('xyyyyyyyyy\n\u2026 (truncated)')
})
