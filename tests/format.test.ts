import { expect, test } from 'claude-code/testing'
import { parseDefinition } from '../hooks/engine/definition.ts'
import { settleMessage } from '../hooks/engine/format.ts'
import { createRun, markFinished, markRunning } from '../hooks/engine/run.ts'
import type { Run } from '../hooks/engine/types.ts'

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
