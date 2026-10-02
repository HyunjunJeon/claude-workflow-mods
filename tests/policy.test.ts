import { expect, test } from 'claude-code/testing'
import { extractOutput } from '../hooks/engine/node-prompt.ts'
import { parseDefinition } from '../hooks/engine/definition.ts'
import { isVerificationNode, lintDefinition } from '../hooks/engine/lint.ts'
import { isPlanningSkill, mainLoopVerdict, protocolFor, readOnlyBashProblem } from '../hooks/engine/policy.ts'

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
    ['FOO=1 sed -i s/a/b/ f', 'sed is not on the read-only command list'],
  ]
  for (const [command, problem] of writing) expect(readOnlyBashProblem(command)).toBe(problem)
})

test('the main conversation keeps read and orchestration tools only', async () => {
  for (const tool of ['mcp__dag-workflow__dag', 'Read', 'LSP', 'WebFetch', 'AskUserQuestion', 'ExitPlanMode', 'TaskStop']) {
    expect(mainLoopVerdict(tool, {}, NONE)).toEqual({ allowed: true })
  }
  for (const tool of ['Edit', 'Write', 'NotebookEdit', 'Agent', 'Workflow', 'TodoWrite', 'TaskCreate', 'mcp__github__create_issue']) {
    expect(mainLoopVerdict(tool, {}, NONE).allowed).toBe(false)
  }
  expect(mainLoopVerdict('Bash', { command: 'git log -3' }, NONE)).toEqual({ allowed: true })
  expect(mainLoopVerdict('Bash', { command: 'make' }, NONE).allowed).toBe(false)
  expect(mainLoopVerdict('mcp__github__create_issue', {}, new Set(['mcp__github__create_issue']))).toEqual({ allowed: true })
})

test('the planning skill is recognised by its plugin-qualified and bare names only', async () => {
  expect(isPlanningSkill('dag-workflow:dag-planning')).toBe(true)
  expect(isPlanningSkill('/dag-workflow:dag-planning')).toBe(true)
  expect(isPlanningSkill('dag-planning')).toBe(true)
  expect(isPlanningSkill('mass-ulw')).toBe(false)
  expect(isPlanningSkill('dag-planning-extra')).toBe(false)
  expect(isPlanningSkill(undefined)).toBe(false)
})

test('the lint flags contract gaps per node and a missing verification node only for multi-node graphs', async () => {
  const def = (nodes: unknown[]) => {
    const r = parseDefinition({ key: 'k', nodes })
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

test('the injected protocol states the rule for each enforcement level', async () => {
  expect(protocolFor('strict')).toContain('load the dag-workflow:dag-planning skill with the Skill tool and follow it; start is refused until you do')
  expect(protocolFor('strict')).toContain('are refused here and belong inside DAG nodes')
  expect(protocolFor('guide')).toContain('Prefer doing all work inside DAG nodes')
  expect(protocolFor('strict')).toContain('mcp__dag-workflow__dag')
})

test('a node output is its "## Output" section, else its report without the status line', async () => {
  expect(extractOutput('notes\n## Output\n- wrote a.ts\n- API_KEY name is FOO\nDAG_NODE_STATUS: completed')).toBe('- wrote a.ts\n- API_KEY name is FOO')
  expect(extractOutput('just a report\nDAG_NODE_STATUS: completed')).toBe('just a report')
  expect(extractOutput(undefined)).toBe('')
  expect(extractOutput('### Output:\nx'.padEnd(50, 'y'), 10)).toBe('xyyyyyyyyy\n\u2026 (truncated)')
})
