import { test, expect } from 'claude-code/testing'

test('/dag-ping answers that the mod is loaded', async $ => {
  const { text } = await $.command.run({
    command: 'dag-ping',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })
  expect(text).toBe('dag-workflow loaded')
})
