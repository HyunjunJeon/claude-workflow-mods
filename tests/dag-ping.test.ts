import { test, expect } from 'claude-code/testing'
import { boot, command, harness } from './control-harness.ts'

test('/dag-ping answers that the mod is loaded', async $ => {
  const { text } = await $.command.run({
    command: 'dag-ping',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })
  expect(text).toBe('dag-workflow loaded')
})

test('the /dag argument hint lists the same forms as the usage text', async ($, on) => {
  const hints: (string | undefined)[] = []
  // Registered before the harness, filtered to /dag, so this handler sees the registration the harness would otherwise answer alone.
  on('command.register', { name: 'dag' }, (_$, e) => { hints.push(e.argumentHint); return { value: { command: e.name } } })
  harness(on)
  await boot($)
  const { text } = await command($, 'no-such-verb')
  expect(hints.at(-1)).toBe(text?.replace(/^Usage: \/dag /, ''))
})
