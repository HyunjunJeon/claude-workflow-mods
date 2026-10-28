import type { On } from 'claude-code'
import { expect, test, type Engine, type Mounted } from 'claude-code/testing'
import type { VerificationCheck } from '../hooks/engine/types.ts'
import { boot, checkpoint, finish, harness, start } from './control-harness.ts'

// The `o` (transcript) button of the DAG pane puts the selected node's agent transcript in the main view
// through `ui.view({ agentId })`; a node without an agent, or a refused view, toasts why.

const CHECK: VerificationCheck[] = [{ kind: 'command', argv: ['check-control'] }]
const TWO = {
  key: 'pair',
  name: 'Pair',
  nodes: [
    { id: 'a', prompt: 'Write a', dependsOn: [], verify: CHECK },
    { id: 'b', prompt: 'Write b', dependsOn: ['a'], verify: CHECK },
  ],
}
const PANE = {
  plugin: 'dag-workflow', component: 'Pane', requestId: 'dag', surface: 'terminal', viewport: { columns: 140, rows: 40 },
  props: { title: 'DAG', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

type Pane = Mounted<'terminal', 'Pane'>

async function mountPane($: Engine): Promise<Pane> {
  return $.ui.mount(PANE)
}

function recordViews(on: On, answer: () => { deny?: string } = () => ({})): { agentId?: string }[] {
  const views: { agentId?: string }[] = []
  on('ui.view', (_engine, e) => {
    views.push(e.agentId === undefined ? {} : { agentId: e.agentId })
    return { value: answer() }
  })
  return views
}

test('no transcript button shows while no node is selected', async ($, on) => {
  recordViews(on)
  harness(on)
  await boot($)
  await start($, TWO)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Button', key: 'transcript' })).toBeUndefined()
  await ui.unmount()
})

test('pressing transcript on a node that never started toasts why and opens no view', async ($, on) => {
  const views = recordViews(on)
  const h = harness(on)
  await boot($)
  await start($, TWO)
  const ui = await mountPane($)
  await ui.press({ key: 'select-next' })
  await ui.press({ key: 'select-next' })
  await ui.press({ key: 'transcript' })

  expect(views).toEqual([])
  expect(h.toasts).toEqual([{ text: 'Node b never started, so it has no transcript', timeoutMs: 12_000 }])
  await ui.unmount()
})

test('pressing transcript on a started node asks the host to show its agent', async ($, on) => {
  const views = recordViews(on)
  const h = harness(on)
  await boot($)
  await start($, TWO)
  const ui = await mountPane($)
  await ui.press({ key: 'select-next' })
  await ui.press({ key: 'transcript' })

  expect(views).toEqual([{ agentId: 'agent-1' }])
  expect(h.toasts).toEqual([])
  await ui.unmount()
})

test('a denied view toasts the host reason and the report path of a finished node', async ($, on) => {
  const views = recordViews(on, () => ({ deny: 'the tasks list shows none for it' }))
  const h = harness(on)
  await boot($)
  const runId = await start($, TWO)
  await finish($, h)
  const reportPath = checkpoint(h, runId).nodes[0]?.reportPath
  const ui = await mountPane($)
  await ui.press({ key: 'select-next' })
  await ui.press({ key: 'transcript' })
  await h.clock.settle()

  expect(views).toEqual([{ agentId: 'agent-1' }])
  expect(h.toasts.map(toast => toast.text)).toEqual([`Node a transcript not shown: the tasks list shows none for it · report: ${reportPath}`])
  await ui.unmount()
})

test('a view the host rejects is logged and toasts the same fallback', async ($, on) => {
  on('ui.view', () => ({ deny: 'view blocked' }))
  const h = harness(on)
  await boot($)
  await start($, TWO)
  const ui = await mountPane($)
  await ui.press({ key: 'select-next' })
  await ui.press({ key: 'transcript' })
  await h.clock.settle()

  expect(h.toasts).toHaveLength(1)
  expect(h.toasts[0]?.text).toMatch(/^Node a transcript not shown: .*view blocked$/)
  expect(h.logs.some(line => line.includes('transcript view failed'))).toBe(true)
  await ui.unmount()
})
