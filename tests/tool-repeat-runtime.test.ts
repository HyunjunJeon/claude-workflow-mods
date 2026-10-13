import { expect, test, type Plugin } from 'claude-code/testing'
import { boot, harness } from './control-harness.ts'
import { REPEAT_CHECK_NOTE } from '../hooks/engine/tool-repeat.ts'

const RESULTS: Plugin = {
  name: 'repeat-check-results',
  register(on) {
    on('tool.call', ($, e, next) => {
      if (e.tool !== 'Bash') return next(e)
      if (e.description === 'denied') return { deny: 'test permission denied' }
      if (e.description === 'background') return { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bg-1' } }
      if (e.description === 'ok') return { result: { stdout: 'ok', stderr: '', interrupted: false } }
      return { isError: true, result: undefined, text: `Exit code 1\n${e.description === 'changed' ? 'different failure' : 'Assertion failed'}`, context: ['existing-context'] }
    })
  },
}

test('a repeated foreground check warns once without changing its result or existing context', { plugins: [RESULTS] }, async ($, on) => {
  harness(on)
  await boot($, 'off')
  const call = { tool: 'Bash', command: 'bun test' } as const
  const first = await $.tool.call(call)
  const second = await $.tool.call(call)
  const third = await $.tool.call(call)
  expect(first.context).toEqual(['existing-context'])
  expect(second.context).toEqual(['existing-context', REPEAT_CHECK_NOTE])
  expect(third.context).toEqual(['existing-context'])
  expect([first.result, second.result, third.result]).toEqual([undefined, undefined, undefined])
  expect([first.isError, second.isError, third.isError]).toEqual([true, true, true])
})

for (const interrupt of ['edit', 'shell', 'success', 'changed', 'clear', 'background', 'parallel'] as const) {
  test(`${interrupt} invalidates a repeat comparison`, { plugins: [RESULTS] }, async ($, on) => {
    harness(on)
    await boot($, 'off')
    const call = { tool: 'Bash', command: 'bun test' } as const
    await $.tool.call(call)
    switch (interrupt) {
      case 'edit':
        await $.tool.call({ tool: 'Write', file_path: '/work/a.ts', content: 'export const a = 1' })
        break
      case 'shell':
        await $.tool.call({ tool: 'Bash', command: 'npm install' })
        break
      case 'success':
        await $.tool.call({ ...call, description: 'ok' })
        break
      case 'changed':
        await $.tool.call({ ...call, description: 'changed' })
        break
      case 'clear':
        await $.classic.SessionStart({ source: 'clear' })
        break
      case 'background':
        await $.tool.call({ ...call, description: 'background' })
        break
      case 'parallel':
        await Promise.all([$.tool.call(call), $.tool.call(call)])
        break
    }
    const reply = await $.tool.call(call)
    expect(reply.context).toEqual(['existing-context'])
  })
}

test('observations are isolated between main conversation and node workers', { plugins: [RESULTS] }, async ($, on) => {
  harness(on)
  await boot($, 'off')
  const call = { tool: 'Bash', command: 'bun test' } as const
  await $.tool.call(call)
  const workerCall = { ...call, agentId: 'agent-1' } as const
  const worker = await $.tool.call(workerCall)
  const main = await $.tool.call(call)
  expect(worker.context).toEqual(['existing-context'])
  expect(main.context).toEqual(['existing-context', REPEAT_CHECK_NOTE])
})

test('read-only tools preserve a comparison and denied checks do not count as executions', { plugins: [RESULTS] }, async ($, on) => {
  const h = harness(on)
  await boot($, 'off')
  h.files.set('/work/a.ts', 'export const a = 1')
  const call = { tool: 'Bash', command: 'bun test' } as const
  await $.tool.call(call)
  await $.tool.call({ tool: 'Read', file_path: '/work/a.ts' })
  await $.tool.call({ ...call, description: 'denied' })
  const reply = await $.tool.call(call)
  expect(reply.context).toEqual(['existing-context', REPEAT_CHECK_NOTE])
})

test('ending a worker turn drops its comparison', { plugins: [RESULTS] }, async ($, on) => {
  harness(on)
  await boot($, 'off')
  const call = { tool: 'Bash', command: 'bun test', agentId: 'agent-1' } as const
  await $.tool.call(call)
  await $.turn.complete({ turnId: 'turn-worker', agentId: 'agent-1', reason: 'answer', isAborted: false, answer: 'Done', durationMs: 1 })
  const reply = await $.tool.call(call)
  expect(reply.context).toEqual(['existing-context'])
})
