import { expect, test, type Plugin } from 'claude-code/testing'
import { CHECK_DETAIL_LIMIT, commandDetail } from '../hooks/engine/check-eval.ts'
import { boot, checkpoint, harness, PROGRAMS, start } from './control-harness.ts'

const HEAD = '["claude","plugin","test","."] exited 1'
const passing = (count: number) => Array.from({ length: count }, (_, i) => `(pass) behaviour number ${i} holds [0.31ms]`)
// A suite run whose failing test sits far past the first 4,000 characters, as in the 2026-10-28 X3 run.
const SUITE = [...passing(150), 'error: expect(received).toBe(expected)', '(fail) the character bound retains the request [2.10ms]', ...passing(150), '', ' 299 pass', ' 1 fail', 'Ran 300 tests across 70 files. [19.02s]'].join('\n')

test('a command detail that fits is kept whole', () => {
  expect(commandDetail(HEAD, 'ok\n')).toBe(`${HEAD}\nok\n`)
})

test('a long command detail keeps the header, the failing test, its error and the summary within the limit', () => {
  const detail = commandDetail(HEAD, SUITE)
  expect(detail.length).toBeLessThanOrEqual(CHECK_DETAIL_LIMIT)
  expect(detail.split('\n')[0]).toBe(HEAD)
  expect(detail).toContain('(fail) the character bound retains the request [2.10ms]')
  expect(detail).toContain('error: expect(received).toBe(expected)')
  expect(detail).toContain(' 1 fail\nRan 300 tests across 70 files. [19.02s]')
  expect(detail).toContain('output cut to fit')
})

test('the end of a long detail starts at a line', () => {
  const tail = commandDetail(HEAD, SUITE).split('…\n').at(-1) ?? ''
  expect(tail.startsWith('(pass) behaviour number')).toBe(true)
})

test('a failure line repeated in the output is kept once', () => {
  const output = [...passing(10), 'error: same', 'error: same', ...passing(200)].join('\n')
  expect(commandDetail(HEAD, output).match(/error: same/g)?.length).toBe(1)
})

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
