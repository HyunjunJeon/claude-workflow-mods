import { expect, test, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { protocolFor } from '../hooks/engine/policy.ts'
import { boot, command, dag, finish, harness, start } from './control-harness.ts'

// The restoration block is up to 8,000 characters. These tests pin when a submitted prompt carries it: only a user
// prompt, and only when the run and note state changed since the model last received it.
const CHECK = [{ kind: 'command', argv: ['check-control'] }]
const DEFINITION = {
  key: 'diet',
  nodes: [
    { id: 'a', prompt: 'Produce artifact', verify: CHECK },
    { id: 'b', prompt: 'Consume artifact', dependsOn: ['a'], verify: CHECK },
  ],
}
const STRICT = protocolFor('strict', true)

type Submit = ReturnType<typeof harness>['submits'][number]

function restores(submit: Submit | undefined): boolean {
  return submit?.context.some(entry => entry.includes('"kind":"context-restoration"')) ?? false
}

// The node states the restoration block on this prompt reports, as `id:state`.
function reportedNodes(submit: Submit | undefined): string[] {
  const block = submit?.context.find(entry => entry.includes('"kind":"context-restoration"'))
  if (!block) return []
  const parsed: { entries: { kind: string; id?: { text: string }; state?: string }[] } = JSON.parse(block)
  return parsed.entries.filter(entry => entry.kind === 'node').map(entry => `${entry.id?.text}:${entry.state}`).sort()
}

function chain(key: string) {
  return {
    key,
    nodes: [
      { id: `${key}1`, prompt: 'Produce artifact', verify: CHECK },
      { id: `${key}2`, prompt: 'Consume artifact', dependsOn: [`${key}1`], verify: CHECK },
    ],
  }
}

async function ask($: Engine, text: string): Promise<void> {
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
}

function userPrompts(h: ReturnType<typeof harness>): Submit[] {
  return h.submits.filter(submit => submit.origin === 'composer')
}

// No DAG pane: every finished node also reaches the model as a node progress prompt.
async function bootWithoutPane($: Engine): Promise<void> {
  await $.session.start({ surface: 'vscode', isInteractive: true, cwd: '/work' })
  await $.skill.prompt({ skill: 'dag-workflow:planning', text: '# planning' })
}

function compactor(on: On): void {
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'engine summary', toolUses: [] }] }))
}

test('of two user prompts with no state change between them only the first carries the restoration block', async ($, on) => {
  const h = harness(on)
  await boot($)
  await ask($, 'Explain this repository')
  await ask($, 'And the tests?')
  const [first, second] = userPrompts(h)
  expect(first?.context[0]).toBe(STRICT)
  expect(restores(first)).toBe(true)
  expect(second?.context).toEqual([STRICT])
})

test('a user prompt after prompt.context rendered the block carries only the protocol', async ($, on) => {
  const h = harness(on)
  on('prompt.context', ($, e) => ({ blocks: e.blocks }))
  await boot($)
  const rendered = await $.prompt.context({ blocks: [] })
  expect(rendered.blocks.some(block => block.name === 'dag-workflow' && block.text.includes('"kind":"context-restoration"'))).toBe(true)
  await ask($, 'Explain this repository')
  expect(userPrompts(h)[0]?.context).toEqual([STRICT])
})

test('settle and node progress prompts from the plugin never carry the restoration block', async ($, on) => {
  const h = harness(on)
  await bootWithoutPane($)
  await start($, DEFINITION)
  await finish($, h, 'agent-1')
  await finish($, h, 'agent-2')
  const plugin = h.submits.filter(submit => submit.origin === 'plugin')
  expect(plugin.map(submit => submit.text.split(' ')[0])).toEqual(['Node', 'DAG'])
  expect(plugin.map(submit => submit.context)).toEqual([[STRICT], [STRICT]])
})

test('a node finishing behind the pane reaches the next user prompt once', async ($, on) => {
  const h = harness(on)
  await boot($)
  await ask($, 'Build the artifact')
  await start($, DEFINITION)
  await ask($, 'How is it going?')
  await finish($, h, 'agent-1')
  // With the pane up a finished node sends no prompt of its own, so the model has not seen node a complete.
  expect(h.submits.filter(submit => submit.origin === 'plugin')).toEqual([])
  await ask($, 'And now?')
  await ask($, 'Still there?')
  expect(userPrompts(h).map(restores)).toEqual([true, true, true, false])
})

test('a pinned note reaches the next user prompt once', async ($, on) => {
  const h = harness(on)
  await boot($)
  await ask($, 'Build the artifact')
  await command($, 'note Keep the public API stable')
  await ask($, 'Go on')
  await ask($, 'Continue')
  expect(userPrompts(h).map(restores)).toEqual([true, true, false])
  expect(userPrompts(h)[1]?.context.join('\n')).toContain('Keep the public API stable')
})

test('after a settle message the next user prompt does not repeat the block for the same state', async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = await start($, DEFINITION)
  await ask($, 'Build the artifact')
  await command($, `cancel ${runId}`)
  await finish($, h, 'agent-1', true)
  expect(h.submits.filter(submit => submit.origin === 'plugin').map(submit => submit.text)).toEqual([expect.stringContaining('settled: cancelled')])
  await ask($, 'What happened?')
  expect(userPrompts(h).map(restores)).toEqual([true, false])
})

test('a settle message does not deliver a note pinned before it', async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = await start($, DEFINITION)
  await ask($, 'Build the artifact')
  await command($, 'note Keep the public API stable')
  await command($, `cancel ${runId}`)
  await finish($, h, 'agent-1', true)
  await ask($, 'What happened?')
  await ask($, 'Anything else?')
  expect(userPrompts(h).map(restores)).toEqual([true, true, false])
})

test('a settle message the host dropped does not count as delivered', async ($, on) => {
  on('prompt.submit', { text: /settled:/ }, () => ({ drop: 'host is busy' }))
  const h = harness(on)
  await boot($)
  const runId = await start($, DEFINITION)
  await ask($, 'Build the artifact')
  await command($, `cancel ${runId}`)
  await finish($, h, 'agent-1', true)
  await ask($, 'What happened?')
  expect(userPrompts(h).map(restores)).toEqual([true, true])
})

test("a plugin message about one run leaves another run's unseen change pending", async ($, on) => {
  const h = harness(on)
  await boot($)
  const a = await start($, chain('a'))
  const b = await start($, chain('b'))
  await ask($, 'Build both')
  // agent-2 runs b1. With the pane up its finish sends no prompt, so nothing tells the model that b1 completed.
  await finish($, h, 'agent-2')
  await command($, `cancel ${a}`)
  await finish($, h, 'agent-1', true)
  const news = h.submits.filter(submit => submit.origin === 'plugin')
  expect(news.map(submit => submit.text)).toEqual([expect.stringContaining(`(${a}) settled: cancelled`)])
  expect(news[0]?.text).not.toContain(b)
  await ask($, 'What is run b doing?')
  await ask($, 'Anything else?')
  expect(userPrompts(h).map(restores)).toEqual([true, true, false])
  expect(reportedNodes(userPrompts(h)[1])).toEqual(['a1:cancelled', 'a2:cancelled', 'b1:completed', 'b2:running'])
})

test('a dropped user prompt is not counted as delivered', async ($, on) => {
  on('prompt.submit', { text: /^Blocked/ }, () => ({ drop: 'blocked by another hook' }))
  const h = harness(on)
  await boot($)
  await start($, DEFINITION)
  const dropped = await $.prompt.submit({ text: 'Blocked prompt', wait: false, origin: { kind: 'composer' } })
  expect(dropped.drop).toBe('blocked by another hook')
  await ask($, 'Build the artifact')
  await ask($, 'Continue')
  expect(userPrompts(h).map(submit => submit.text)).toEqual(['Build the artifact', 'Continue'])
  expect(userPrompts(h).map(restores)).toEqual([true, false])
})

test('an amended node makes the next user prompt carry the block', async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = await start($, DEFINITION)
  await ask($, 'Build the artifact')
  // b is still pending: give it a write scope and a second check. Neither changes a node state, attempt or verification.
  const [first, second] = DEFINITION.nodes
  const amended = await dag($, {
    action: 'amend', run_id: runId,
    definition: { ...DEFINITION, nodes: [first, { ...second, writes: ['out/'], verify: [...CHECK, { kind: 'command', argv: ['check-control', 'again'] }] }] },
  })
  expect(amended.error).toBeUndefined()
  await ask($, 'Go on')
  await ask($, 'Continue')
  expect(userPrompts(h).map(restores)).toEqual([true, true, false])
})

test('a compaction restoration counts as delivered for the next user prompt', async ($, on) => {
  const h = harness(on)
  compactor(on)
  await boot($)
  await start($, DEFINITION)
  const compacted = await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'Build the artifact', toolUses: [] }] })
  if (compacted.skip !== undefined) throw new Error(compacted.skip)
  expect(compacted.messages.at(-1)?.text).toContain('[dag-workflow context restoration]')
  await ask($, 'Continue')
  expect(userPrompts(h)[0]?.context).toEqual([STRICT])
})

test('a /clear makes the next user prompt carry the block again', async ($, on) => {
  const h = harness(on)
  await boot($)
  await start($, DEFINITION)
  await ask($, 'Build the artifact')
  await ask($, 'Continue')
  h.control.sessionId = 'cleared'
  await $.classic.SessionStart({ source: 'clear' })
  await ask($, 'Start over')
  expect(userPrompts(h).map(restores)).toEqual([true, false, true])
})

for (const level of ['strict', 'guide'] as const) {
  test(`the ${level} protocol rides on every user and plugin prompt`, { options: { enforcement: level } }, async ($, on) => {
    const h = harness(on)
    await boot($)
    const runId = await start($, DEFINITION)
    await ask($, 'Build the artifact')
    await ask($, 'Continue')
    await command($, `cancel ${runId}`)
    await finish($, h, 'agent-1', true)
    expect(h.submits.map(submit => submit.origin)).toEqual(['composer', 'composer', 'plugin'])
    expect(h.submits.map(submit => submit.context[0])).toEqual([protocolFor(level, true), protocolFor(level, true), protocolFor(level, true)])
  })
}

test('under enforcement off a prompt with no unseen state change gets nothing appended', { options: { enforcement: 'off' } }, async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = await start($, DEFINITION)
  await ask($, 'Build the artifact')
  await ask($, 'Continue')
  await command($, `cancel ${runId}`)
  await finish($, h, 'agent-1', true)
  await ask($, 'What happened?')
  const [first, ...rest] = h.submits
  // The block still restores state under off; only the protocol is withheld.
  expect(first?.context).toHaveLength(1)
  expect(restores(first)).toBe(true)
  expect(rest.map(submit => submit.context)).toEqual([[], [], []])
})
