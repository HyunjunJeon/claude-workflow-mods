import { expect, test, type Engine } from 'claude-code/testing'
import { settleMessage } from '../hooks/engine/format.ts'
import { attemptReportPath, buildNodePrompt, cutOutput, UPSTREAM_OUTPUT_CHARS, UPSTREAM_TOTAL_CHARS } from '../hooks/engine/node-prompt.ts'
import { recoverNode } from '../hooks/engine/recovery.ts'
import { createRun, markFinished, markRunning, snapshotOf } from '../hooks/engine/run.ts'
import type { VerificationCheck } from '../hooks/engine/types.ts'
import { boot, checkpoint, harness, ROOT, start } from './control-harness.ts'

// A node's output must not be lost to a cut. On 2026-10-23 nearly every stored output in this repository's checkpoints had
// been cut at 4,000 characters, and dependents read only that part. The checkpoint still keeps short views, but every step
// that acts on the output reads it whole, and every short view says how much it left out and where the rest is.

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

test('a dependent\'s prompt carries a long upstream output whole, and past the inline budget names where the rest is', () => {
  const run = createRun({ key: 'up', name: 'Up', nodes: [{ id: 'a', prompt: 'A', dependsOn: [] }, { id: 'b', prompt: 'B', dependsOn: ['a'] }] }, { runId: 'dag_up', sessionId: 's', now: 0 })
  const def = run.definition.nodes[1]
  const node = run.nodes[1]
  if (!def || !node) throw new Error('missing node b')
  const whole = `${filler(30_000)}\nlast line of a`
  const fits = buildNodePrompt(run, def, node, [{ id: 'a', label: 'a', output: whole, reportPath: '/r/a.md' }])
  expect(fits).toContain(whole)
  expect(fits).not.toContain('this output continues')

  const huge = `${filler(UPSTREAM_TOTAL_CHARS + 5_000)}\nlast line of a`
  const cut = buildNodePrompt(run, def, node, [{ id: 'a', label: 'a', output: huge, reportPath: '/r/a.md' }])
  expect(cut).not.toContain('last line of a')
  expect(cut).toContain(`… (this output continues for ${huge.length - UPSTREAM_TOTAL_CHARS} more characters, past what this prompt carries: read the rest of the ## Output section in the report /r/a.md before relying on it)`)
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

test('a dependent node is spawned with its dependency\'s whole Output, read from the report, and each attempt\'s report is kept', async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = await start($, CHAIN)
  const output = `${OUTPUT_START}\n${filler(9_000)}\nlast line of a`
  await answer($, h, 'agent-1', `reasoning\n## Output\n${output}\nDAG_NODE_STATUS: completed`)
  expect(checkpoint(h, runId).nodes[0]?.output?.length).toBeLessThan(UPSTREAM_OUTPUT_CHARS + 100)
  const prompt = h.spawns[1]?.prompt ?? ''
  expect(prompt).toContain(output)
  expect(prompt).toContain(`report="${ROOT}/runs/${runId}/a.md"`)
  expect(h.files.get(`${ROOT}/runs/${runId}/a.attempt-1.md`)).toBe(h.files.get(`${ROOT}/runs/${runId}/a.md`))
})

test('when the report could not be written, the dependent gets the stored output with its cut marker', async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = await start($, CHAIN)
  h.writeErrors.set(`${ROOT}/runs/${runId}/a.md`, 'disk full')
  await answer($, h, 'agent-1', `## Output\n${OUTPUT_START}\n${filler(9_000)}\nDAG_NODE_STATUS: completed`)
  const prompt = h.spawns[1]?.prompt ?? ''
  expect(prompt).toContain(OUTPUT_START)
  expect(prompt).toContain('more characters: the node\'s full report has the whole Output)')
})
