import { expect, test, type Engine } from 'claude-code/testing'
import { settleMessage } from '../hooks/engine/format.ts'
import { attemptReportPath, buildNodePrompt, cutOutput, UPSTREAM_OUTPUT_CHARS } from '../hooks/engine/node-prompt.ts'
import { recoverNode } from '../hooks/engine/recovery.ts'
import { createRun, markFinished, markRunning, snapshotOf } from '../hooks/engine/run.ts'
import type { VerificationCheck } from '../hooks/engine/types.ts'
import { boot, checkpoint, harness, ROOT, start } from './control-harness.ts'

// A node's output must not be lost to a cut. On 2026-10-23 nearly every stored output in this repository's checkpoints had
// been cut at 4,000 characters without a word about the rest. The whole report stays in a file, the facts later steps need
// are read from the whole answer, and every short view, the dependents' inline summary included, says how much it left out
// and where the rest is.

// Filler lines of the given total length, so a test can place a field past a cut.
function filler(chars: number): string {
  return 'filler line of the report\n'.repeat(Math.ceil(chars / 26)).slice(0, chars)
}

// 9,000 characters of reasoning before ## Output (past the 8,000 the stored answer keeps at its start), then an Output of
// about 30,000 characters with a ruling and the failed-report fields in the part the stored answer drops.
const OUTPUT_START = 'first line of the output'
const MIDDLE_RULING = 'Ruling: kept the old parser - two callers need it - a caller breaks'
function longAnswer(status: string): string {
  return [
    filler(9_000),
    '## Output',
    OUTPUT_START,
    filler(12_000),
    MIDDLE_RULING,
    filler(16_000),
    'Next: read src/parse.ts lines 10-40 first',
    'Tried and failed: a cache - stale entries - the key misses the locale',
    status,
  ].join('\n')
}

function finishedRun(status: string) {
  let run = createRun({ key: 'whole', name: 'Whole', nodes: [{ id: 'a', prompt: 'A', dependsOn: [] }, { id: 'b', prompt: 'B', dependsOn: ['a'] }] }, { runId: 'dag_whole', sessionId: 's', now: 0 })
  run = markRunning(run, 'a', 'agent-a', 1)
  const state = status.includes('failed') ? 'failed' : 'completed'
  return markFinished(run, 'a', { state, answer: longAnswer(status), reportPath: '/work/.claude/dag/runs/dag_whole/a.md' }, 2)
}

test('a finished node keeps the facts of its whole answer although the stored answer and output are cut', () => {
  const node = finishedRun('DAG_NODE_STATUS: completed').nodes[0]
  expect(node?.answer).not.toContain(MIDDLE_RULING)
  expect(node?.answer).toContain('characters omitted here: the node\'s full report has the whole answer')
  expect(node?.output?.length).toBeLessThan(UPSTREAM_OUTPUT_CHARS + 100)
  expect(node?.output).toMatch(/more characters: the node's full report has the whole Output\)$/)
  expect(node?.whole?.rulings).toEqual(['kept the old parser - two callers need it - a caller breaks'])
  expect(node?.whole?.outputChars).toBeGreaterThan(28_000)
  // A completed report's Next line is follow-up work, not a hypothesis for a retry.
  expect(node?.whole?.attemptNote).toBeUndefined()
})

test('the settle message lists a ruling the stored answer lost and says how much of each output it shows', () => {
  const run = finishedRun('DAG_NODE_STATUS: completed')
  const message = settleMessage(run, 'dag')
  expect(message).toContain('- a: kept the old parser - two callers need it - a caller breaks')
  const total = run.nodes[0]?.whole?.outputChars
  expect(message).toMatch(new RegExp(`… \\(\\d+ of ${total} characters shown: the full report has the whole output\\)`))
  expect(message).toContain('Each node\'s full report above holds its whole output')
})

test('a retry gets the failed attempt\'s Next and Tried fields from the whole answer and the path of that attempt\'s report', () => {
  const run = finishedRun('DAG_NODE_STATUS: failed: the parser still breaks')
  const retried = recoverNode(run, 'a', { kind: 'transient', reason: 'retry', now: 3 })
  if (!retried.ok) throw new Error(retried.error.message)
  const prompt = retried.value.nodes[0]?.promptOverride ?? ''
  expect(prompt).toContain('Next: read src/parse.ts lines 10-40 first')
  expect(prompt).toContain('Tried and failed: a cache - stale entries')
  expect(prompt).toContain('<previous_attempt attempt="1" report="/work/.claude/dag/runs/dag_whole/a.attempt-1.md">')
  // The retried node starts clean: the facts belonged to the failed attempt.
  expect(retried.value.nodes[0]?.whole).toBeUndefined()
})

test('the snapshot gives the whole Output\'s length beside its cut output and the report path', () => {
  const node = snapshotOf(finishedRun('DAG_NODE_STATUS: completed')).nodes[0]
  expect(node?.output_chars).toBeGreaterThan(28_000)
  expect(node?.report_path).toBe('/work/.claude/dag/runs/dag_whole/a.md')
})

test('a dependent\'s prompt carries a long upstream Output as its first 4,000 characters, the cut marker and the report to read', () => {
  const run = createRun({ key: 'up', name: 'Up', nodes: [{ id: 'a', prompt: 'A', dependsOn: [] }, { id: 'b', prompt: 'B', dependsOn: ['a'] }] }, { runId: 'dag_up', sessionId: 's', now: 0 })
  const def = run.definition.nodes[1]
  const node = run.nodes[1]
  if (!def || !node) throw new Error('missing node b')
  const whole = `${filler(30_000)}\nlast line of a`
  const prompt = buildNodePrompt(run, def, node, [{ id: 'a', label: 'a', output: cutOutput(whole, UPSTREAM_OUTPUT_CHARS), reportPath: '/r/a.md' }])
  expect(prompt).not.toContain('last line of a')
  expect(prompt).toContain('<result node="a" report="/r/a.md">')
  expect(prompt).toMatch(/… \(\d+ more characters: the node's full report has the whole Output\)\n<\/result>/)
  expect(prompt).toContain('One that ends with "… (N more characters: …)" was cut there: its whole report is the file named in its report attribute, so read that file before you rely on anything the cut part may hold.')
  // The producing worker is asked to keep its Output inside what reaches its dependents.
  expect(prompt).toContain('Keep it under 4,000 characters: that much reaches your dependents inline.')
})

test('a short view of an output counts what it left out', () => {
  expect(cutOutput('abcdef', 6)).toBe('abcdef')
  expect(cutOutput('abc def ghi', 7)).toBe('abc def\n… (4 more characters: the node\'s full report has the whole Output)')
  expect(attemptReportPath('/r/a.md', 2)).toBe('/r/a.attempt-2.md')
})

const CHECK: VerificationCheck[] = [{ kind: 'command', argv: ['check-control'] }]
const CHAIN = { key: 'chain', name: 'Chain', nodes: [
  { id: 'a', prompt: 'TASK: Do a. STOP WHEN: done.', verify: CHECK },
  { id: 'b', prompt: 'TASK: Do b. STOP WHEN: done.', dependsOn: ['a'], verify: CHECK },
] }

async function answer($: Engine, h: ReturnType<typeof harness>, agentId: string, text: string) {
  await $.turn.complete({ turnId: `turn-${agentId}`, agentId, reason: 'answer', isAborted: false, answer: text, durationMs: 1 })
  await h.clock.settle()
}

test('a dependent node gets its dependency\'s summary and report path while the report keeps the whole answer, once per attempt', async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = await start($, CHAIN)
  const answerText = `reasoning\n## Output\n${OUTPUT_START}\n${filler(9_000)}\nlast line of a\nDAG_NODE_STATUS: completed`
  await answer($, h, 'agent-1', answerText)
  const stored = checkpoint(h, runId).nodes[0]?.output ?? ''
  expect(stored.length).toBeLessThan(UPSTREAM_OUTPUT_CHARS + 100)
  const prompt = h.spawns[1]?.prompt ?? ''
  expect(prompt).toContain(stored)
  expect(prompt).not.toContain('last line of a')
  expect(prompt).toContain(`report="${ROOT}/runs/${runId}/a.md"`)
  expect(h.files.get(`${ROOT}/runs/${runId}/a.md`)).toBe(answerText)
  expect(h.files.get(`${ROOT}/runs/${runId}/a.attempt-1.md`)).toBe(answerText)
})
