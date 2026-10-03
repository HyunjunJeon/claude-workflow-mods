import { expect, test, type Mounted } from 'claude-code/testing'
import type { EventOf, On, UiOpenResult } from 'claude-code'
import { hash } from '../hooks/engine/hash.ts'
import type { VerificationCheck } from '../hooks/engine/types.ts'
import { BAND_GAP } from '../hooks/ui/band.ts'
import { stringsFor } from '../hooks/ui/i18n.ts'
import { width } from '../hooks/ui/text.ts'
import { boot, command, finish, harness, start } from './control-harness.ts'

const CHECK: VerificationCheck[] = [{ kind: 'command', argv: ['check-control'] }]
const node = (id: string, dependsOn: string[] = []) => ({ id, prompt: `Write ${id}`, dependsOn, verify: CHECK })
const SOLO = { key: 'solo', name: 'Solo', nodes: [node('a')] }
const CHAIN = { key: 'chain', name: 'Chain', nodes: [node('a'), node('b', ['a'])] }
const TRIO = { key: 'trio', name: 'Trio', nodes: [node('a'), node('b'), node('c')] }
const FAN_IN = { key: 'fan-in', name: 'Fan in', nodes: [node('a'), node('b'), node('c', ['a', 'b'])] }
const OTHER = 'another mod'

const BAND = {
  plugin: 'dag-workflow', component: 'AbovePrompt', surface: 'terminal', viewport: { columns: 100, rows: 40 },
  props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const PANE = {
  plugin: 'dag-workflow', component: 'Pane', requestId: 'dag', surface: 'terminal', viewport: { columns: 140, rows: 40 },
  props: { title: 'DAG', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

function host(on: On, placement: UiOpenResult = { isPlaced: true }) {
  const opened: EventOf['ui.open'][] = []
  // Registered before the harness so this answer, not its always-placed one, reaches the plugin.
  on('ui.open', { id: 'dag' }, ($, e) => {
    opened.push(e)
    return { value: placement }
  })
  const h = harness(on)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Text({ children: [OTHER] }))
  return { ...h, opened }
}

test('an active run draws the status counts and most-urgent-first digit buttons above other band content', { options: { auto_recovery: false } }, async ($, on) => {
  const h = host(on)
  const t = stringsFor('en')
  await boot($)
  await start($, TRIO)
  h.control.exitCode = 1
  await finish($, h, 'agent-3')
  await $.classic.PermissionRequest({ agent_id: 'agent-2', tool_name: 'Write', tool_input: {} })
  expect(h.statuses.at(-1)).toBe(t.statusLine('Trio', 0, 3, 2, 1, 0, 1))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
    expect(texts.slice(0, -1).join('')).toBe(`DAG Trio  ${t.done(0, 3)} · × ${t.failedCount(1)} · ? ${t.bandWaiting(1)} · ● ${t.bandRunning(2)}`)
    expect(texts.at(-1)).toBe(OTHER)
    expect((await ui.findAll({ type: 'Button' })).map(button => `${button.props.hotkey}: ${button.text}`)).toEqual([`0: ${t.bandOpen}`, '1: × c', '2: ? b', '3: ● a'])
    await ui.unmount()
  }
})

test('0 opens the pane for the person and a node digit opens it on the DAG view with that node selected', async ($, on) => {
  const h = host(on)
  await boot($)
  await start($, FAN_IN)
  await command($, 'inspect decisions')
  const asked = h.opened.length
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'band-open' })
  expect(h.opened.slice(asked)).toMatchObject([{ id: 'dag', focus: true, closeOnEscape: true }])
  expect(await band.find({ key: 'band-node-b' })).toMatchObject({ props: { hotkey: '2' } })
  await band.press({ key: 'band-node-b' })
  expect(h.opened.slice(asked)).toMatchObject([{ id: 'dag', focus: true }, { id: 'dag', focus: true, closeOnEscape: true }])
  await band.unmount()

  const pane = (await $.ui.mount(PANE)) as Mounted<'terminal', 'Pane'>
  await pane.resize({ columns: 60, rows: 40, in: 'graph' })
  expect(await pane.find({ type: 'Text', text: /^> \[-\] b/, in: 'graph' })).toBeDefined()
  await pane.unmount()
})

test('without an active run the band is left to the mods beneath', async ($, on) => {
  const h = host(on)
  await boot($)
  const ui = await $.ui.mount(BAND)
  expect(await ui.drawn()).toMatchObject({ type: 'Text', children: [OTHER] })
  await start($, SOLO)
  expect(await ui.find({ key: 'band-open' })).toBeDefined()
  await finish($, h)
  expect(await ui.drawn()).toMatchObject({ type: 'Text', children: [OTHER] })
  await ui.unmount()
})

test('a survey keeps the band to itself while a run is active', async ($, on) => {
  host(on)
  await boot($)
  await start($, SOLO)
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, hasSurvey: true } })
  expect(await ui.drawn()).toMatchObject({ type: 'Text', children: [OTHER] })
  await ui.redraw(BAND.props)
  expect(await ui.find({ key: 'band-open' })).toBeDefined()
  await ui.unmount()
})

test('a pane the surface cannot place leaves the band up with the reason and toasts once', async ($, on) => {
  const placement = { isPlaced: false as const, reason: 'the terminal is 100 columns wide' }
  const h = host(on, placement)
  await boot($)
  const runId = await start($, CHAIN)
  h.store.set(`dag-session:${hash('/work')}:target`, { schemaVersion: 1, sessionId: 'target', projectRoot: '/work', updatedAt: 1_000, status: 'active', runIds: [], writes: [] })
  await command($, `handoff ${runId} target`)
  await finish($, h)
  const first = placement.reason
  placement.reason = 'the terminal is 90 columns wide'
  await command($, '')
  expect(h.opened).toHaveLength(2)
  expect(h.toasts).toEqual([{ text: expect.stringContaining(first), timeoutMs: 12_000 }])

  const ui = await $.ui.mount(BAND)
  expect((await ui.findAll({ type: 'Button' })).map(button => button.key)).toEqual(['band-open'])
  expect(await ui.find({ type: 'Text', text: placement.reason })).toBeDefined()
  const pane = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: placement.reason })).toBeUndefined()
  expect(await ui.find({ key: 'band-open' })).toBeDefined()
  await pane.unmount()
  await ui.unmount()
})

test('the band speaks the configured language and stays inside its columns and rows', { options: { language: 'ko' } }, async ($, on) => {
  host(on)
  const columns = 40
  await boot($)
  await start($, { key: 'wide', name: '릴리스 파이프라인 전체 점검', nodes: [node('typecheck-and-build'), node('integration-suite'), node('deploy-staging')] })
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: columns } })
  const summary = (await ui.findAll({ type: 'Text' })).map(found => found.text).slice(0, -1).join('')
  expect(summary.endsWith('…')).toBe(true)
  expect(width(summary)).toBeLessThanOrEqual(columns)
  const buttons = await ui.findAll({ type: 'Button' })
  expect(buttons.map(button => button.props.hotkey)).toEqual(['0', '1', '2'])
  expect(buttons[0]?.text).toBe(stringsFor('ko').bandOpen)
  expect(buttons.reduce((cells, button) => cells + width(`${button.props.hotkey}: ${button.text}`), BAND_GAP * (buttons.length - 1))).toBeLessThanOrEqual(columns)

  await ui.redraw({ ...BAND.props, bodyColumns: columns, maxRows: 1 })
  expect((await ui.findAll({ type: 'Text' })).map(found => found.text)).toEqual([OTHER])
  expect(await ui.find({ key: 'band-open' })).toBeDefined()
  await ui.unmount()
})
