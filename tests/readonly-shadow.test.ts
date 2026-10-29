import { expect, test, type Engine } from 'claude-code/testing'
import type { DecisionRecord } from '../hooks/engine/decisions.ts'
import { ROOT, boot, checkpoint, command, harness, start } from './control-harness.ts'

type Harness = ReturnType<typeof harness>

const CHECK = [{ kind: 'command', argv: ['check-control'] }]
const DEFINITION = { key: 'readonly-shadow', nodes: [{ id: 'a', prompt: 'Read the repository', verify: CHECK }] }
const DECISIONS = `${ROOT}/decisions/source.json`
const BASH = (line: string) => ({ tool: 'Bash', input: { command: line }, tool_use_id: 'main-bash' }) as const

// Every `readonly` record in the session's decisions file, in the order they were written.
function readonlyRecords(h: Harness): DecisionRecord[] {
  const text = h.files.get(DECISIONS)
  const records: DecisionRecord[] = text ? JSON.parse(text).records : []
  return records.filter(record => record.kind === 'readonly')
}

// After a silent call: a plain main-conversation Bash call does record, so the silence was not a broken probe.
async function expectMainBashRecords($: Engine, h: Harness): Promise<void> {
  await $.tool.check(BASH('make test'))
  expect(readonlyRecords(h)).toHaveLength(1)
}

// A Bash call without isReadOnly is how the host sends a call its own check cannot hold read-only.
test('a main-conversation Bash call the host did not mark read-only is recorded and the host verdict stands', async ($, on) => {
  on('tool.check', () => ({ decision: 'allow', reason: 'host rules' }))
  const h = harness(on)
  await boot($)
  expect(await $.tool.check(BASH('git log --oneline -3'))).toEqual({ decision: 'allow', reason: 'host rules' })
  expect(readonlyRecords(h)).toMatchObject([{
    at: 1_000, sessionId: 'source', kind: 'readonly', subject: 'Bash', proposed: 'allow', selected: 'allow',
    source: 'baseline', outcome: 'existing-decision', latencyMs: 0, note: 'git log --oneline -3',
  }])
  const [record] = readonlyRecords(h)
  expect(record).not.toHaveProperty('runId')
  expect(record).not.toHaveProperty('nodeId')
})

test('the record names what the host decided when it asks, and the ask is returned unchanged', async ($, on) => {
  on('tool.check', () => ({ decision: 'ask', reason: 'host rules' }))
  const h = harness(on)
  await boot($)
  expect(await $.tool.check(BASH('cat docs/reference.md'))).toEqual({ decision: 'ask', reason: 'host rules' })
  expect(readonlyRecords(h)).toMatchObject([{ proposed: 'allow', selected: 'ask', note: 'cat docs/reference.md' }])
})

test('the host denying the call is recorded as the host decision, not changed', async ($, on) => {
  on('tool.check', () => ({ decision: 'deny', reason: 'organization rule' }))
  const h = harness(on)
  await boot($)
  expect(await $.tool.check(BASH('ls /root'))).toEqual({ decision: 'deny', reason: 'organization rule' })
  expect(readonlyRecords(h)).toMatchObject([{ proposed: 'allow', selected: 'deny' }])
})

test('the note masks secrets before it cuts the command to 200 characters', async ($, on) => {
  on('tool.check', () => ({ decision: 'allow' }))
  const h = harness(on)
  await boot($)
  const head = 'cat [REDACTED:bearer-token] '
  await $.tool.check(BASH(`cat Bearer abcdef1234567890 ${'y'.repeat(300)}`))
  // A key that starts before the cut and ends after it: cutting first would leave the start of the key, masking first leaves none of it.
  await $.tool.check(BASH(`${'x'.repeat(190)} sk-${'A'.repeat(40)}`))
  const [masked, straddling] = readonlyRecords(h).map(record => record.note)
  expect(masked).toBe(head + 'y'.repeat(200 - head.length))
  expect(straddling).toBe(`${'x'.repeat(190)} [REDACTED`)
})

test('a failure to record is logged to debug and the host verdict stands', async ($, on) => {
  on('tool.check', () => ({ decision: 'allow' }))
  const h = harness(on)
  await boot($)
  h.writeErrors.set(DECISIONS, 'disk full')
  h.logs.length = 0
  h.logOptions.length = 0
  expect(await $.tool.check(BASH('ls'))).toEqual({ decision: 'allow' })
  expect(h.logs).toHaveLength(1)
  expect(h.logs[0]).toContain('could not persist decision history')
  expect(h.logOptions).toEqual([{ to: 'debug' }])
})

test('a Bash call the host marked read-only records nothing', async ($, on) => {
  on('tool.check', () => ({ decision: 'allow' }))
  const h = harness(on)
  await boot($)
  expect(await $.tool.check({ ...BASH('git status'), isReadOnly: true })).toEqual({ decision: 'allow' })
  expect(readonlyRecords(h)).toEqual([])
  await expectMainBashRecords($, h)
})

test('a call from a node worker records nothing', async ($, on) => {
  on('tool.check', () => ({ decision: 'allow' }))
  const h = harness(on)
  await boot($)
  const runId = await start($, DEFINITION)
  const agentId = checkpoint(h, runId).nodes[0]?.agentId
  expect(agentId).toBe('agent-1')
  await $.tool.check({ ...BASH('make test'), agentId })
  expect(readonlyRecords(h)).toEqual([])
  await expectMainBashRecords($, h)
})

test('a tool other than Bash records nothing', async ($, on) => {
  on('tool.check', () => ({ decision: 'allow' }))
  const h = harness(on)
  await boot($)
  await $.tool.check({ tool: 'Read', input: { file_path: '/work/a.ts' }, tool_use_id: 'main-read' })
  await $.tool.check({ tool: 'Write', input: { file_path: '/work/a.ts', content: 'x' }, tool_use_id: 'main-write' })
  expect(readonlyRecords(h)).toEqual([])
  await expectMainBashRecords($, h)
})

test('a query without a call id records nothing', async ($, on) => {
  on('tool.check', () => ({ decision: 'allow' }))
  const h = harness(on)
  await boot($)
  await $.tool.check({ tool: 'Bash', input: { command: 'make test' } })
  expect(readonlyRecords(h)).toEqual([])
  await expectMainBashRecords($, h)
})

test('with the gate off the call records nothing', async ($, on) => {
  on('tool.check', () => ({ decision: 'allow' }))
  const h = harness(on)
  await boot($, 'guide')
  await $.tool.check(BASH('ls'))
  expect(readonlyRecords(h)).toEqual([])
  await command($, 'enforce strict')
  await expectMainBashRecords($, h)
})

test('a tool allowed in the main conversation by main_allowed_tools never met the judge and records nothing', { options: { main_allowed_tools: ['Bash'] } }, async ($, on) => {
  on('tool.check', () => ({ decision: 'allow' }))
  const h = harness(on)
  await boot($)
  await $.tool.check(BASH('rm -rf build'))
  expect(readonlyRecords(h)).toEqual([])
})

async function ask($: Engine, text: string): Promise<void> {
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
}

test('under auto the call records while the turn is a DAG turn and stops once a prompt makes the turn direct', async ($, on) => {
  on('tool.check', () => ({ decision: 'allow' }))
  const h = harness(on)
  await boot($, 'auto')
  await $.tool.check(BASH('ls'))
  expect(readonlyRecords(h)).toHaveLength(1)
  // The harness's Jev answers the mode question with a category, which is no mode, so the turn runs directly and the gate is lifted.
  await ask($, 'What does the planning skill say?')
  await $.tool.check(BASH('ls'))
  expect(readonlyRecords(h)).toHaveLength(1)
})
