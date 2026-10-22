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

// Node a's Output holds two rulings after 4,800 characters, one of them as a bold bullet: past both the 1,200-character excerpt
// and the 4,000 characters an upstream prompt carries.
function ruled(answerA: string): Run {
  const parsed = parseDefinition({ key: 'ruled', name: 'Ruled', nodes: [{ id: 'a', prompt: 'A' }, { id: 'b', prompt: 'B' }] })
  if (!parsed.ok) throw new Error(parsed.error.message)
  let run = createRun(parsed.value, { runId: 'dag_ruled', sessionId: 's', now: 1 })
  for (const id of ['a', 'b']) run = markRunning(run, id, `agent-${id}`, 2)
  run = markFinished(run, 'a', { state: 'completed', answer: answerA }, 3)
  return markFinished(run, 'b', { state: 'completed', answer: '## Output\nwrote b\nRuling: no cache - the spec names none - slower repeat runs\nDAG_NODE_STATUS: completed' }, 3)
}

const RULED_A = [
  '## Output',
  `wrote a\n${'filler line\n'.repeat(400)}`,
  'Ruling: kept parse() as it is - two other nodes call it - a caller would break',
  '- **Ruling:** UTF-8 only - the request names no encoding - Latin-1 files fail to load',
  'Rulings are listed above.',
  'DAG_NODE_STATUS: completed',
].join('\n')

test('the rulings of every node are listed after the node results, even past the stored output', () => {
  expect((ruled(RULED_A).nodes[0]?.output ?? '').includes('Ruling:')).toBe(false)
  const lines = settleMessage(ruled(RULED_A), 'dag').split('\n')
  const start = lines.indexOf('Decisions the nodes made on their own (Ruling lines). Pass them on to the person in your report:')
  expect(start > lines.findIndex(line => line.startsWith('- b:'))).toBe(true)
  expect(lines.slice(start + 1, start + 4)).toEqual([
    '- a: kept parse() as it is - two other nodes call it - a caller would break',
    '- a: UTF-8 only - the request names no encoding - Latin-1 files fail to load',
    '- b: no cache - the spec names none - slower repeat runs',
  ])
  expect(lines[start + 4]).toBe('')
})

test('a long list of rulings is capped and says how many were left out', () => {
  const many = ['## Output', ...Array.from({ length: 25 }, (_, index) => `Ruling: choice ${index} - why - cost`)].join('\n')
  const message = settleMessage(ruled(many), 'dag')
  expect(message).toContain('- a: choice 19 - why - cost')
  expect(message).not.toContain('- a: choice 20 - why - cost')
  expect(message).toContain('(6 more rulings are in the node reports.)')
})

test('the rulings block stops at its character budget', () => {
  const twelve = ['## Output', ...Array.from({ length: 12 }, (_, index) => `Ruling: ${String(index).padStart(2, '0')}${'x'.repeat(293)}`)].join('\n')
  const lines = settleMessage(ruled(twelve), 'dag').split('\n')
  const block = lines.slice(lines.indexOf('Decisions the nodes made on their own (Ruling lines). Pass them on to the person in your report:') + 1)
  const shown = block.filter(line => line.startsWith('- a: '))
  expect(shown.length).toBe(10)
  expect(shown.every(line => line.length === 300)).toBe(true)
  expect(lines).toContain('(3 more rulings are in the node reports.)')
})

test('when the stored answer lost its Output heading to the length cut, no ruling comes from the reasoning before it', () => {
  // About 29,600 characters: the stored answer keeps the first 8,000 and the last 12,000, and the heading sits near 9,550.
  const answer = `Ruling: <decision> - <why> - <cost if wrong> is the template\n${'n'.repeat(9_500)}\n## Output\nwrote a\n${'o'.repeat(20_000)}\nDAG_NODE_STATUS: completed`
  const run = ruled(answer)
  expect(run.nodes[0]?.answer?.includes('## Output')).toBe(false)
  expect(settleMessage(run, 'dag')).not.toContain('is the template')
})
