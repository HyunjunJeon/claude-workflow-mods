import { expect, test } from 'claude-code/testing'
import type { SessionMessage } from 'claude-code'
import { defaultNotesFolder } from '../hooks/engine/stages.ts'
import { addUsage, cut, eventFileName, rowsAfter, sanitize, TRAJECTORY_EVENT_CHARS, trajectoryLine, transcriptRows, type TrajectoryEvent, type TranscriptRow } from '../hooks/engine/trajectory.ts'
import { boot, finish, harness, ROOT, start } from './control-harness.ts'

// The trajectory log (trajectory_log): the pure line, row and usage helpers, and what a run with a review-fix round and the
// main conversation leave under .claude/dag/trajectories.

const TRAJECTORIES = `${ROOT}/trajectories`
const SECRET = 'sk-ant-TRAJECTORYTESTKEY0123456789'
type Logged = TrajectoryEvent & { nodeId?: string; attempt?: number; prompt?: string }

function eventFiles(h: ReturnType<typeof harness>, folder: string): string[] {
  return [...h.files.keys()].filter(path => path.startsWith(`${TRAJECTORIES}/${folder}/`)).sort()
}

function events(h: ReturnType<typeof harness>, folder: string): Logged[] {
  return eventFiles(h, folder).map(path => JSON.parse(h.files.get(path) ?? 'null'))
}

const row = (role: 'user' | 'assistant', text: string, toolUses: TranscriptRow['toolUses'] = []): TranscriptRow => ({ role, text, toolUses })

test('every string is masked and cut, values that are not JSON are dropped, and an event too long for one read is cut harder', () => {
  expect(sanitize({ prompt: `use ${SECRET}`, long: 'x'.repeat(30), n: 1, ok: true, none: null, skip: undefined, fn: () => 1, nan: Number.NaN }, 10)).toEqual({
    prompt: `use [REDAC\n[truncated: original length ${4 + SECRET.length} characters]`, long: 'xxxxxxxxxx\n[truncated: original length 30 characters]', n: 1, ok: true, none: null, nan: null,
  })
  // A secret just past the cut is masked before the cut, so none of it is kept.
  expect(cut(`${'a '.repeat(5)}${SECRET}`, 14)).toBe('a a a a a [RED\n[truncated: original length 44 characters]')
  expect(cut('b '.repeat(20_000), 10)).toBe('b b b b b \n[truncated: original length 40000 characters]')
  const huge = { kind: 'node.transcript' as const, at: 1, sessionId: 's', runId: 'r', nodeId: 'a', attempt: 1, agentId: 'g', rows: Array.from({ length: 400 }, () => ({ role: 'user' as const, text: 'yes '.repeat(2_500) })) }
  const line = trajectoryLine(huge)
  expect(line.length).toBeLessThanOrEqual(TRAJECTORY_EVENT_CHARS + 1)
  expect(JSON.parse(line).rows).toHaveLength(400)
  const hopeless = { ...huge, rows: Array.from({ length: 5_000 }, () => ({ role: 'user' as const, text: 'yes '.repeat(75) })) }
  expect(JSON.parse(trajectoryLine(hopeless))).toEqual({ kind: 'node.transcript', at: 1, sessionId: 's', runId: 'r', nodeId: 'a', omitted: expect.stringMatching(/^event of \d+ characters$/) })
})

test('event files sort by time and then by their counter, and a node id is made safe for a file name', () => {
  const names = [eventFileName(20, 3, 'node.end', 'a'), eventFileName(3, 9, 'run.start'), eventFileName(20, 2, 'node.start', 'review/spec x')]
  expect([...names].sort()).toEqual(['0000000000003-000009-run.start.jsonl', '0000000000020-000002-node.start-review_spec_x.jsonl', '0000000000020-000003-node.end-a.jsonl'])
})

test('a transcript keeps what was said and each tool call with the result the model read, and drops the stored record and bare result rows', () => {
  const rows = [
    row('user', 'task'),
    row('assistant', 'editing', [{ tool_use_id: 't1', tool: 'Edit', input: { file_path: 'a.ts', new_string: 'z'.repeat(4_100) }, text: 'done' }]),
    row('user', ''),
    row('assistant', '', [{ tool_use_id: 't2', tool: 'Bash', input: { command: 'false' }, text: 'exit 1', isError: true }]),
  ]
  expect(transcriptRows(rows)).toEqual([
    { role: 'user', text: 'task' },
    { role: 'assistant', text: 'editing', toolUses: [{ tool: 'Edit', input: { file_path: 'a.ts', new_string: `${'z'.repeat(4_000)}\n[truncated: original length 4100 characters]` }, result: 'done' }] },
    { role: 'assistant', toolUses: [{ tool: 'Bash', input: { command: 'false' }, result: 'exit 1', isError: true }] },
  ].map(entry => expect.objectContaining(entry)))
  expect(JSON.parse(JSON.stringify(transcriptRows([row('assistant', 'x', [{ tool: 'Read', input: {} }])])))).toEqual([{ role: 'assistant', text: 'x', toolUses: [{ tool: 'Read', input: {} }] }])
})

test('the main conversation\'s new rows follow the marked row, also when older rows dropped off or compaction replaced them', () => {
  const first = [row('user', 'a'), row('assistant', 'b')]
  const start = rowsAfter(first, undefined)
  expect(start.rows).toEqual(first)
  const grown = [...first, row('user', 'c'), row('assistant', 'd')]
  const next = rowsAfter(grown, start.mark)
  expect(next.rows.map(current => current.text)).toEqual(['c', 'd'])
  // The host keeps the newest rows only: the marked row moved to the front.
  expect(rowsAfter([row('assistant', 'd'), row('user', 'e')], next.mark).rows.map(current => current.text)).toEqual(['e'])
  // Compaction wrote a summary in place of everything: all of it is new.
  expect(rowsAfter([row('user', 'summary'), row('user', 'f')], next.mark).rows.map(current => current.text)).toEqual(['summary', 'f'])
  expect(rowsAfter(grown, rowsAfter(grown, start.mark).mark).rows).toEqual([])
})

test('token counts of an agent\'s turns add up and keep the last model', () => {
  const turn = (model: string, n: number) => ({ model, input_tokens: n, output_tokens: n, cache_read_input_tokens: n, cache_creation_input_tokens: n })
  expect(addUsage(addUsage(undefined, turn('a', 1)), turn('b', 2))).toEqual(turn('b', 3))
  expect(addUsage(turn('a', 1), undefined)).toEqual(turn('a', 1))
})

const REQUEST = 'Add a greet function and document it in the README'

function greetFlow(key: string) {
  return {
    key,
    name: 'Greet',
    goal: 'A greet function exists in src/greet.ts and the README documents it',
    nodes: [
      { id: 'code', prompt: `TASK: Write src/greet.ts exporting greet; the API key ${SECRET} stays out of it. STOP WHEN: done.`, writes: ['src/greet.ts'], verify: [{ kind: 'file', path: 'src/greet.ts', contains: 'export function greet' }] },
      { id: 'docs', prompt: 'TASK: Document greet in the README. STOP WHEN: done.', writes: ['README.md'], verify: [{ kind: 'file', path: 'README.md', contains: 'greet(' }] },
    ],
    review: { request: REQUEST },
  }
}

const specNotes = (verdict: string, finding: string) =>
  `## Request sentences\n"${REQUEST}"\n\n## Findings\n${finding}\n\n## Real check\n- file checks: both met\n\n## Safe-but-wrong audit\n1. a function and a README section, as requested\n\n${verdict}\n`
const standardsNotes = (verdict: string) =>
  `## Rule sources\nnone - baseline only\n\n## Rule breaches\nnone\n\n## Judgment calls\nnone\n\n${verdict}\n`

test('trajectory_log is off by default and leaves nothing', async ($, on) => {
  const h = harness(on)
  await boot($)
  await start($, greetFlow('greet-quiet'))
  h.files.set('/work/src/greet.ts', 'export function greet() {}\n')
  await finish($, h, 'agent-1')
  expect([...h.files.keys()].filter(path => path.startsWith(TRAJECTORIES))).toEqual([])
})

test('with trajectory_log on, a review-fix round keeps each attempt\'s exact prompt, the FAIL notes the next start removes, the findings, the change, the transcript and the token counts, and the settled run is joined into one file', { options: { trajectory_log: true } }, async ($, on) => {
  const h = harness(on)
  on('session.messages', ($, e) => ({
    value: e.agentId === undefined ? [] : [
      { role: 'user', text: `task of ${e.agentId}`, toolUses: [] },
      { role: 'assistant', text: 'editing', toolUses: [{ tool_use_id: `t-${e.agentId}`, tool: 'Edit', input: { file_path: 'README.md' }, result: { stored: 'record' }, text: 'edited' }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `t-${e.agentId}`, text: 'edited', isError: false }] },
    ],
  }))
  h.control.git.set('-c core.quotePath=false diff --no-color HEAD -- :(literal)README.md', 'diff --git a/README.md b/README.md\n+Call greet(name) to say hello.\n')
  h.control.git.set('ls-files -z --others --exclude-standard -- :(literal)README.md', '')
  const notes = defaultNotesFolder('greet-trajectory')
  await boot($)
  const runId = await start($, greetFlow('greet-trajectory'))
  h.files.set('/work/src/greet.ts', 'export function greet(name: string) {\n  return `hello ${name}`\n}\n')
  h.files.set('/work/README.md', '# app\n\nCall greet(name) to say hello.\n')
  await finish($, h, 'agent-1')
  const usage = { model: 'claude-sonnet-test', input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 560, cache_creation_input_tokens: 78 }
  await $.turn.complete({ turnId: 'turn-agent-2', agentId: 'agent-2', reason: 'answer', isAborted: false, answer: 'DAG_NODE_STATUS: completed', durationMs: 1, usage })
  await h.clock.settle()
  h.files.set(`${notes}/review-standards-notes.md`, standardsNotes('Standards verdict: PASS'))
  await finish($, h, 'agent-4')
  const failNotes = specNotes('Spec verdict: FAIL', '(a) README.md:3 documents greet(name) but never says what it returns\n(b) none\n(c) none')
  h.files.set(`${notes}/review-spec-notes.md`, failNotes)
  await finish($, h, 'agent-3')
  // The round reran docs; review-spec's next start will remove the FAIL notes.
  expect(h.spawns.map(spawn => spawn.description).at(-1)).toBe('Greet: docs')
  h.files.set('/work/README.md', '# app\n\nCall greet(name); it returns the greeting string.\n')
  await finish($, h, 'agent-5')
  h.files.set(`${notes}/review-spec-notes.md`, specNotes('Spec verdict: PASS', '(a) none\n(b) none\n(c) none'))
  h.files.set(`${notes}/review-standards-notes.md`, standardsNotes('Standards verdict: PASS'))
  await finish($, h, 'agent-6')
  await finish($, h, 'agent-7')

  const logged = events(h, runId)
  const steps = logged.map(event => [event.kind, event.nodeId, event.attempt].filter(part => part !== undefined).join(':'))
  expect(steps[0]).toBe('run.start')
  expect(steps.at(-1)).toBe('run.settle')
  const order = ['node.end:review-spec:1', 'rework', 'node.start:docs:2', 'node.end:docs:2', 'node.start:review-spec:2', 'node.end:review-spec:2']
  expect(steps.filter(step => order.includes(step))).toEqual(order)

  const find = (step: string) => logged[steps.indexOf(step)]!
  // The FAIL verdict as review-spec wrote it, though the file is gone now.
  expect(find('node.end:review-spec:1')).toMatchObject({ state: 'failed', notes: [{ path: `${notes}/review-spec-notes.md`, text: failNotes }] })
  expect(find('rework')).toMatchObject({ round: 1, reviewers: ['review-spec'], producers: ['docs'], note: expect.stringContaining('(a) README.md:3 documents greet(name)') })
  // The exact prompt the docs agent got the second time, findings included.
  expect(find('node.start:docs:2')).toMatchObject({ agentId: 'agent-5', prompt: h.spawns[4]?.prompt })
  expect(find('node.start:docs:2').prompt).toContain('[Review fix 1/1]')
  expect(find('node.end:docs:1')).toMatchObject({ state: 'completed', usage, diff: expect.stringContaining('+Call greet(name) to say hello.'), verification: { status: 'passed' } })
  expect(find('node.transcript:docs:1')).toMatchObject({
    agentId: 'agent-2',
    rows: [{ role: 'user', text: 'task of agent-2' }, { role: 'assistant', text: 'editing', toolUses: [{ tool: 'Edit', input: { file_path: 'README.md' }, result: 'edited' }] }],
  })
  expect(find('run.settle')).toMatchObject({ status: 'completed', reviewFix: { rounds: 1 } })
  // The secret in a node prompt is masked everywhere it went.
  expect(eventFiles(h, runId).some(path => h.files.get(path)?.includes(SECRET))).toBe(false)
  expect(find('node.start:code:1').prompt).toContain('[REDACTED:api-key]')
  // The joined file is the event files in order.
  expect(h.files.get(`${TRAJECTORIES}/${runId}.jsonl`)).toBe(eventFiles(h, runId).map(path => h.files.get(path)).join(''))
})

test('with trajectory_log on, each main turn logs the main conversation\'s rows since the last one it logged, and a resumed conversation\'s earlier rows are left to the log that saw them', { options: { trajectory_log: true } }, async ($, on) => {
  const h = harness(on)
  const said = (role: 'user' | 'assistant', text: string, toolUses: SessionMessage['toolUses'] = []): SessionMessage => ({ role, text, toolUses })
  const main = [said('user', 'before the restart'), said('assistant', 'answered before')]
  on('session.messages', ($, e) => ({ value: e.agentId === undefined ? [...main] : [] }))
  await boot($)
  main.push(said('user', 'plan the docs'), said('assistant', 'starting', [{ tool_use_id: 'u1', tool: 'Read', input: { file_path: 'README.md' }, text: '# app' }]))
  const usage = { model: 'claude-opus-test', input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }
  await $.turn.complete({ turnId: 'main-1', reason: 'answer', isAborted: false, answer: 'starting', durationMs: 900, usage })
  main.push(said('assistant', 'done'))
  await $.turn.complete({ turnId: 'main-2', reason: 'answer', isAborted: false, answer: 'done', durationMs: 5 })
  await h.clock.settle()
  const turns = events(h, 'session-source')
  expect(turns).toEqual([
    expect.objectContaining({ kind: 'main.turn', turnId: 'main-1', durationMs: 900, usage, rows: [
      { role: 'user', text: 'plan the docs' },
      { role: 'assistant', text: 'starting', toolUses: [{ tool: 'Read', input: { file_path: 'README.md' }, result: '# app' }] },
    ] }),
    expect.objectContaining({ kind: 'main.turn', turnId: 'main-2', rows: [{ role: 'assistant', text: 'done' }] }),
  ])
})
