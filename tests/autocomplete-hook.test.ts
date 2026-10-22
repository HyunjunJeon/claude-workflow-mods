import { expect, test, type Engine, type EngineCall, type EngineNoun } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { VerificationCheck } from '../hooks/engine/types.ts'
import { boot, folder, harness, start } from './control-harness.ts'

const CHECK: VerificationCheck[] = [{ kind: 'command', argv: ['check-control'] }]
const solo = (key: string, name: string) => ({ key, name, nodes: [{ id: 'a', prompt: 'Write a', verify: CHECK }] })

// The kit's typings give the engine's `$.prompt` only the nouns of EventCalls and leave out autocomplete, though the runtime `$`
// raises it (Object.keys($.prompt) lists it) as the host does: through the chain of every plugin that hooks it.
type Raises = EngineNoun<'prompt'> & { autocomplete: EngineCall<'prompt.autocomplete'> }

// The box as the host reports it at the caret, asked of the plugin's hook.
async function ask($: Engine, text: string) {
  const from = text.search(/\S*$/)
  // SAFETY: the runtime $.prompt has autocomplete, as the probe of Object.keys($.prompt) showed; only its typing is missing.
  const prompt = $.prompt as Raises
  return (await prompt.autocomplete({ text, cursor: text.length, token: text.slice(from), start: from })).suggestions
}

// Nothing beneath the plugins answers prompt.autocomplete (the host has no row of its own on this event), so a test gives
// the bottom of the chain: the rows the engine or an earlier plugin would have added.
function bottom(on: On, rows: { text: string }[] = []): void {
  on('prompt.autocomplete', () => ({ suggestions: rows }))
}

test('/dag status dag_ offers the run ids of this project, newest first, each with its name and status', async ($, on) => {
  const h = harness(on)
  bottom(on)
  await boot($)
  const older = await start($, solo('older', 'Older'))
  await h.clock.advance(1_000)
  const newer = await start($, solo('newer', 'Newer'))
  expect(await ask($, '/dag status dag_')).toEqual([
    { text: newer, description: 'Newer · running' },
    { text: older, description: 'Older · running' },
  ])
})

test('/dag run and /dag preview offer the definition files under flows/ and eval/fixtures/ whose path starts with the token', async ($, on) => {
  const h = harness(on)
  bottom(on)
  await boot($)
  folder(h, '/work/flows/improvement', { 'p0.yaml': 'key: p0', 'p1.json': '{}', 'audit.md': 'notes' })
  folder(h, '/work/eval/fixtures', { 'valid-definition.yaml': 'key: v' })
  expect(await ask($, '/dag run flows/')).toEqual([{ text: 'flows/improvement/p0.yaml' }, { text: 'flows/improvement/p1.json' }])
  expect(await ask($, '/dag preview e')).toEqual([{ text: 'eval/fixtures/valid-definition.yaml' }])
})

test('the file list is reused for 10 seconds and read again after that', async ($, on) => {
  const h = harness(on)
  bottom(on)
  await boot($)
  folder(h, '/work/flows', { 'a.yaml': 'key: a' })
  expect(await ask($, '/dag run flows/')).toEqual([{ text: 'flows/a.yaml' }])
  h.files.set('/work/flows/b.yaml', 'key: b')
  await h.clock.advance(9_999)
  expect(await ask($, '/dag run flows/')).toEqual([{ text: 'flows/a.yaml' }])
  await h.clock.advance(1)
  expect(await ask($, '/dag run flows/')).toEqual([{ text: 'flows/a.yaml' }, { text: 'flows/b.yaml' }])
})

test('typing anywhere else adds nothing and leaves the rows beneath as they were, without reading the folders', async ($, on) => {
  const h = harness(on)
  bottom(on, [{ text: '#123' }])
  await boot($)
  await start($, solo('only', 'Only'))
  folder(h, '/work/flows', { 'a.yaml': 'key: a' })
  for (const text of ['#1', 'hello flows/', '/dag list d', '/dag status dag_xxx extra', '/dag run flows/a.yaml fl', '/dag retry dag_1 a']) {
    expect(await ask($, text)).toEqual([{ text: '#123' }])
  }
  // The folders were never listed for those keystrokes, so a file created now shows at once instead of after the 10 s.
  h.files.set('/work/flows/late.yaml', 'key: late')
  expect((await ask($, '/dag run flows/l')).map(row => row.text)).toEqual(['#123', 'flows/late.yaml'])
})

test('the rows of the plugin join after the rows beneath it', async ($, on) => {
  const h = harness(on)
  bottom(on, [{ text: '#123' }])
  await boot($)
  const id = await start($, solo('only', 'Only'))
  expect(await ask($, '/dag cancel dag_')).toEqual([{ text: '#123' }, { text: id, description: 'Only · running' }])
  folder(h, '/work/flows', { 'a.yaml': 'key: a' })
  expect(await ask($, '/dag run fl')).toEqual([{ text: '#123' }, { text: 'flows/a.yaml' }])
})
