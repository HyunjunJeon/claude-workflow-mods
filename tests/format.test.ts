import { expect, test } from 'claude-code/testing'
import { parseDefinition } from '../hooks/engine/definition.ts'
import { settleMessage } from '../hooks/engine/format.ts'
import { createRun, markFinished, markRunning } from '../hooks/engine/run.ts'
import type { Run } from '../hooks/engine/types.ts'
import { VERIFICATION_GUIDANCE } from '../hooks/engine/check-eval.ts'

const HINT = (tools: string) => `; needed approval this non-interactive session cannot give: ${tools} (allow them up front with --allowedTools)`

// Three independent nodes: a completed with a report, b completed, c failed, so the run is settled.
function settled(): Run {
  const parsed = parseDefinition({ key: 'settle', name: 'Settle', nodes: [{ id: 'a', prompt: 'A' }, { id: 'b', prompt: 'B' }, { id: 'c', prompt: 'C' }] })
  if (!parsed.ok) throw new Error(parsed.error.message)
  let run = createRun(parsed.value, { runId: 'dag_unit', sessionId: 's', now: 1 })
  for (const id of ['a', 'b', 'c']) run = markRunning(run, id, `agent-${id}`, 2)
  run = markFinished(run, 'a', { state: 'completed', answer: 'DAG_NODE_STATUS: completed\n## Output\nwrote a', reportPath: '.claude/dag/runs/dag_unit/a.md' }, 3)
  run = markFinished(run, 'b', { state: 'completed', answer: 'DAG_NODE_STATUS: completed\n## Output\nwrote b' }, 3)
  return markFinished(run, 'c', { state: 'failed', answer: 'c broke', error: 'verification failed' }, 3)
}

// The text before the approval hint existed, written out so the check does not recompute it.
const WITHOUT_HINT = [
  'DAG run "Settle" (dag_unit) settled: failed.',
  'Node results (outputs as each node reported them):',
  '- a: completed; verification: unrecorded — full report: .claude/dag/runs/dag_unit/a.md',
  '    wrote a',
  '- b: completed; verification: unrecorded',
  '    wrote b',
  '- c: failed (verification failed); verification: unrecorded',
  '    c broke',
  '',
  'TREAT EVERY NODE COMPLETION CLAIM AS FALSE UNTIL YOU PROVE IT: check the real files, test output or command results each node was responsible for before you report success.',
  'Call dag with {"action":"snapshot","run_id":"dag_unit"} for every node\'s output; use "retry" or "amend" to recover failed or wrong nodes, or start a follow-up run.',
].join('\n')

test('a settle message without approval tools reads exactly as before, with an empty map or nodes missing from it', () => {
  const run = settled()
  expect(settleMessage(run, 'dag')).toBe(WITHOUT_HINT)
  expect(settleMessage(run, 'dag', new Map())).toBe(WITHOUT_HINT)
  expect(settleMessage(run, 'dag', new Map([['a', []], ['unknown', ['Write']]]))).toBe(WITHOUT_HINT)
})

test('the approval hint ends the head line of the node that needed it and no other line', () => {
  const message = settleMessage(settled(), 'dag', new Map([['b', ['Write', 'Bash']]]))
  expect(message.split('\n')).toEqual(WITHOUT_HINT.split('\n').map(line => line.startsWith('- b:') ? line + HINT('Write, Bash') : line))
})

test('the hint follows the full-report link and comes before the output excerpt', () => {
  const lines = settleMessage(settled(), 'dag', new Map([['a', ['Edit']]])).split('\n')
  const head = lines.findIndex(line => line.startsWith('- a:'))
  expect(lines[head]).toBe(`- a: completed; verification: unrecorded — full report: .claude/dag/runs/dag_unit/a.md${HINT('Edit')}`)
  expect(lines[head + 1]).toBe('    wrote a')
})

test('two nodes that needed approval each get their own tools in first-seen order', () => {
  const lines = settleMessage(settled(), 'dag', new Map([['a', ['Write']], ['c', ['Bash', 'Write']]])).split('\n')
  expect(lines.filter(line => line.includes('needed approval'))).toEqual([
    `- a: completed; verification: unrecorded — full report: .claude/dag/runs/dag_unit/a.md${HINT('Write')}`,
    `- c: failed (verification failed); verification: unrecorded${HINT('Bash, Write')}`,
  ])
})

test('settle reports check outcome counts including unclassified legacy failures', () => {
  const run = settled()
  const current = run.nodes[0]
  if (!current) throw new Error('Missing fixture node')
  current.verification = {
    status: 'failed',
    evidence: [
      { check: { kind: 'command', argv: ['test'] }, passed: true, checkedAt: 1, detail: '' },
      ...(['failed', 'not_run', 'unknown'] as const).map(outcome => ({
        check: { kind: 'file' as const, path: 'a.txt' }, outcome, passed: false, checkedAt: 1, detail: '',
      })),
      { check: { kind: 'file', path: 'b.txt' }, passed: false, checkedAt: 1, detail: '' },
    ],
  }
  const counts = /checks: passed=(\d+), failed=(\d+), not_run=(\d+), unknown=(\d+)/.exec(settleMessage(run, 'dag'))
  expect(counts?.slice(1).map(Number)).toEqual([1, 1, 1, 2])
  expect(settleMessage(run, 'dag').includes(VERIFICATION_GUIDANCE)).toBe(true)
})

const CLOSING = WITHOUT_HINT.split('\n').slice(-3)

// Written out, not built from BOARD_TOOL, so a rename of the tool or a reworded request fails here instead of passing by construction.
const BOARD_ANSWER = [
  'This run answers a request to understand something, and the user wants the answer on a board. After you have verified the result, draw the findings on a board with mcp__dag-workflow__board (load it with ToolSearch query "select:mcp__dag-workflow__board" when it is deferred): a section with the conclusion, ONE diagram or table, and the quoted lines that prove it (code_peek, diff, or trace with this run\'s id). Call open once and keep the chat report short.',
  'If the tool is unavailable, an edit is refused twice, or open replies shown: false, report the result in chat as before.',
]

test('a settle message has no board lines by default or when the answer does not go on a board', () => {
  expect(settleMessage(settled(), 'dag')).toBe(WITHOUT_HINT)
  expect(settleMessage(settled(), 'dag', new Map(), false)).toBe(WITHOUT_HINT)
})

test('a settle message for an answer on a board adds the two board lines before the closing lines', () => {
  const lines = settleMessage(settled(), 'dag', new Map(), true).split('\n')
  const body = WITHOUT_HINT.split('\n').slice(0, -3)
  expect(lines).toEqual([...body, ...BOARD_ANSWER, ...CLOSING])
  expect(lines.at(-3)).toBe('')
  expect(lines.at(-2)).toContain('TREAT EVERY NODE COMPLETION CLAIM AS FALSE UNTIL YOU PROVE IT')
})

test('the board lines come after the node results, whose approval hints stay', () => {
  const message = settleMessage(settled(), 'dag', new Map([['b', ['Write']]]), true)
  expect(message).toContain(HINT('Write'))
  expect(message).toContain('the user wants the answer on a board')
  expect(message.indexOf('the user wants the answer on a board')).toBeLessThan(message.indexOf('TREAT EVERY NODE COMPLETION CLAIM AS FALSE'))
})
