import { expect, test, type Plugin } from 'claude-code/testing'
import { boot, checkpoint, harness, PROGRAMS, start } from './control-harness.ts'

// A `gate` command takes 5 s of virtual time and then reaches the harness, which records it in h.processes. A plugin hook runs
// apart from this module, so it holds no test state: what ran when is read from the clock and the harness.
const GATES: Plugin = {
  name: 'check-detail-gates',
  register(on) {
    on('process.run', async ($, e, next) => {
      if (e.argv[0] !== 'gate') return next(e)
      await new Promise<void>(resolve => $.clock.after(5_000, resolve))
      return next(e)
    })
  },
}

const ran = (h: ReturnType<typeof harness>) => h.processes.filter(e => e.argv[0] === 'gate').map(e => e.argv.join(' '))

test('two nodes that verify with the same command run it one at a time, and a different command does not wait', { options: { auto_recovery: false }, plugins: [GATES, PROGRAMS] }, async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = await start($, { key: 'one-at-a-time', nodes: [
    { id: 'a', prompt: 'Produce a', verify: [{ kind: 'command', argv: ['gate', 'suite'] }] },
    { id: 'b', prompt: 'Produce b', verify: [{ kind: 'command', argv: ['gate', 'suite'] }] },
    { id: 'c', prompt: 'Produce c', verify: [{ kind: 'command', argv: ['gate', 'lint'] }] },
  ] })
  // Each end waits for its node's checks, which wait on the clock, so the ends are awaited only after the clock has run.
  const ends = ['agent-1', 'agent-2', 'agent-3'].map(agentId => $.turn.complete({
    turnId: `turn-${agentId}`, agentId, reason: 'answer', isAborted: false, answer: 'DAG_NODE_STATUS: completed', durationMs: 1,
  }))
  await h.clock.advance(0)
  expect(ran(h)).toEqual([])
  await h.clock.advance(5_000)
  expect(ran(h).sort()).toEqual(['gate lint', 'gate suite'])
  await h.clock.advance(5_000)
  expect(ran(h).sort()).toEqual(['gate lint', 'gate suite', 'gate suite'])
  await Promise.all(ends)
  await h.clock.settle()
  expect(checkpoint(h, runId).nodes.map(node => [node.id, node.state])).toEqual([['a', 'completed'], ['b', 'completed'], ['c', 'completed']])
})
