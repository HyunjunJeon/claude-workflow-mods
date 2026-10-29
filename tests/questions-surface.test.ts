import { expect, test, type Engine, type Mounted } from 'claude-code/testing'
import type { Language } from '../hooks/ui/i18n.ts'
import { stringsFor } from '../hooks/ui/i18n.ts'
import { buildInspector } from '../hooks/ui/inspector-model.ts'
import { emptyContext } from '../hooks/engine/context.ts'
import type { VerificationCheck } from '../hooks/engine/types.ts'
import { boot, checkpoint, harness, ROOT, start } from './control-harness.ts'

// A blocked node shows its question on the pane card and in the inspector, offers one button per option, and the band counts
// the nodes waiting for an answer. Answering itself is covered by questions-runtime.test.ts; here a press must reach it.

const CHECK: VerificationCheck[] = [{ kind: 'command', argv: ['check-control'] }]
const DEFINITION = {
  key: 'questions-surface',
  name: 'Surface',
  nodes: [
    { id: 'a', prompt: 'Write the artifact', verify: CHECK },
    { id: 'b', prompt: 'Use the artifact', dependsOn: ['a'], verify: CHECK },
  ],
}
const QUESTION = 'Which format should the artifact use?'
const LANGUAGES: readonly Language[] = ['en', 'ko']

const PANE = {
  plugin: 'dag-workflow', component: 'Pane', requestId: 'dag', surface: 'terminal', viewport: { columns: 140, rows: 40 },
  props: { title: 'DAG', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const
const BAND = {
  plugin: 'dag-workflow', component: 'AbovePrompt', surface: 'terminal', viewport: { columns: 140, rows: 40 },
  props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 140, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

async function ask($: Engine, h: ReturnType<typeof harness>, lines: string[]) {
  const answer = ['I cannot choose.', '', '## Question', ...lines, '', `DAG_NODE_STATUS: blocked: ${QUESTION}`].join('\n')
  await $.turn.complete({ turnId: 'ask', agentId: 'agent-1', reason: 'answer', isAborted: false, answer, durationMs: 1 })
  await h.clock.settle()
}

async function texts(ui: Mounted<'terminal', 'Pane'>): Promise<string[]> {
  return (await ui.findAll({ type: 'Text' })).map(found => found.text ?? '')
}

for (const language of LANGUAGES) {
  const t = stringsFor(language)
  const options = { options: { language } }

  test(`${language}: the card of a blocked node shows the question, its default and an answer button per option`, options, async ($, on) => {
    const h = harness(on)
    await boot($)
    await start($, DEFINITION)
    await ask($, h, ['Options: json | yaml', 'Default: json'])
    // SAFETY: PANE is registered as a terminal Pane, so mount returns the terminal Pane surface.
    const ui = (await $.ui.mount(PANE)) as Mounted<'terminal', 'Pane'>
    const shown = await texts(ui)
    expect(shown).toContain(t.questionAsks(QUESTION))
    expect(shown).toContain(t.questionDefault('json'))
    expect(shown).not.toContain(t.questionNeedsPerson)
    expect(shown.some(text => text.includes('/dag answer'))).toBe(false)
    expect(await ui.find({ type: 'Button', key: 'answer-a-0' })).toMatchObject({ props: { label: 'json' } })
    expect(await ui.find({ type: 'Button', key: 'answer-a-1' })).toMatchObject({ props: { label: 'yaml' } })
    await ui.unmount()
  })

  test(`${language}: a question without options shows the /dag answer hint and no buttons, and Needs: person is said`, options, async ($, on) => {
    const h = harness(on)
    await boot($)
    const runId = await start($, DEFINITION)
    await ask($, h, ['Needs: person'])
    // SAFETY: PANE is registered as a terminal Pane, so mount returns the terminal Pane surface.
    const ui = (await $.ui.mount(PANE)) as Mounted<'terminal', 'Pane'>
    const shown = await texts(ui)
    expect(shown).toContain(t.questionHint(runId, 'a'))
    expect(shown).toContain(t.questionNeedsPerson)
    expect(await ui.find({ type: 'Button', key: 'answer-a-0' })).toBeUndefined()
    await ui.unmount()
  })

  test(`${language}: the inspector scope lists the question of a blocked node`, options, async ($, on) => {
    const h = harness(on)
    await boot($)
    const runId = await start($, DEFINITION)
    await ask($, h, ['Options: json | yaml', 'Default: json'])
    const model = buildInspector({
      view: 'context', columns: 100, language, decisions: [], context: emptyContext('/work', 'source', 0),
      contextPath: `${ROOT}/context/source.json`, runs: [checkpoint(h, runId)], sessions: [], projectRoot: '/work',
      sessionId: 'source', now: 2_000, page: 0,
    })
    const shown = model.lines.map(line => line.map(segment => segment.text).join('').trim())
    expect(shown).toContain(t.questionAsks(QUESTION))
    expect(shown).toContain(t.questionDefault('json'))
  })

  test(`${language}: pressing an option answers the node as the person and the agent continues`, options, async ($, on) => {
    const h = harness(on)
    await boot($)
    const runId = await start($, DEFINITION)
    await ask($, h, ['Options: json | yaml', 'Default: json'])
    // SAFETY: PANE is registered as a terminal Pane, so mount returns the terminal Pane surface.
    const ui = (await $.ui.mount(PANE)) as Mounted<'terminal', 'Pane'>
    await ui.press({ key: 'answer-a-1' })
    await h.clock.settle()
    const node = checkpoint(h, runId).nodes.find(current => current.id === 'a')
    expect(node).toMatchObject({ state: 'running', attempt: 1, clarifications: [{ question: QUESTION, answer: 'yaml', by: 'person' }] })
    expect(h.sends.map(send => send.text).join('\n')).toContain('yaml')
    await ui.redraw(PANE.props)
    expect(await ui.find({ type: 'Button', key: 'answer-a-0' })).toBeUndefined()
    await ui.unmount()
  })

  test(`${language}: the band says how many nodes wait for an answer`, options, async ($, on) => {
    const h = harness(on)
    // The band draws over the host's own content; the host here has none.
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Text({ children: [''] }))
    await boot($)
    await start($, DEFINITION)
    const before = await $.ui.mount(BAND)
    expect((await before.findAll({ type: 'Text' })).map(found => found.text).join('')).not.toContain(t.bandAsking(1))
    await before.unmount()
    await ask($, h, ['Options: json | yaml'])
    const ui = await $.ui.mount(BAND)
    expect((await ui.findAll({ type: 'Text' })).map(found => found.text).join('')).toContain(`? ${t.bandAsking(1)}`)
    await ui.unmount()
  })
}
