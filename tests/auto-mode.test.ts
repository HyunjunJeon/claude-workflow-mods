import { expect, test, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { DecisionRecord } from '../hooks/engine/decisions.ts'
import type { JevRequest } from '../hooks/engine/jev.ts'
import { protocolFor } from '../hooks/engine/policy.ts'
import { boot, command, dag, finish, harness, ROOT, start } from './control-harness.ts'

// Enforcement auto is the manifest default, so these tests pass no enforcement option and boot with null to keep it.
const CHECK = [{ kind: 'command', argv: ['check-control'] }]
const DEFINITION = { key: 'auto-mode', nodes: [{ id: 'a', prompt: 'Change a.ts', verify: CHECK }] }
const EDIT = { tool: 'Edit', file_path: '/work/a.ts', old_string: 'a', new_string: 'b' } as const
const REFUSED = 'dag-workflow refused Edit in the main conversation'
const DIRECT = protocolFor('auto', true, 'direct')
const AUTO_DAG = protocolFor('auto', true, 'dag')
const SMALL = { choice: 'direct', confidence: 0.9 }

type Answer = { choice: string; confidence: number }
type Backend = 'up' | 'down' | 'slow'
type Harness = ReturnType<typeof harness>

const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

// Jev for these tests. The harness's HTTP answers 500, so each question goes on to the session model, answered here;
// h.requests still records every HTTP attempt. The mode question gets `answer`; a routing question gets no answer and
// keeps the definition's category. `down` fails the model call, and `slow` holds it past MODE_BUDGET_MS.
function jevModel(on: On, h: Harness, answer: Answer = SMALL) {
  const jev = { answer, backend: 'up' as Backend }
  h.control.httpStatus = 500
  on('model.complete', async ($, e) => {
    const request: Pick<JevRequest, 'questions'> = JSON.parse(e.prompt)
    if (!('mode' in request.questions)) return { value: { isAnswered: false, reason: 'empty-reply', usage: USAGE } }
    if (jev.backend === 'down') throw new Error('model down')
    if (jev.backend === 'slow') await h.clock.sleep(60_000)
    const mode = { type: 'choice', ...jev.answer, probabilities: { [jev.answer.choice]: jev.answer.confidence } }
    return { value: { isAnswered: true, text: JSON.stringify({ answers: { mode } }), usage: USAGE } }
  })
  return jev
}

type Row = { role: 'user' | 'assistant'; text: string; toolUses: [] }

// The host's transcript for these tests. `reads` counts reads of the main conversation (a node's recovery passes an
// agentId and is not counted); `backend` makes the host throw or refuse.
function transcript(on: On, rows: Row[] = []) {
  const host = { rows, reads: 0, backend: 'rows' as 'rows' | 'throws' | 'deny' }
  on('session.messages', (_$, e) => {
    if (e.agentId === undefined) host.reads += 1
    if (host.backend === 'throws') throw new Error('transcript unavailable')
    return { value: host.backend === 'deny' ? { deny: 'transcript refused' } : host.rows }
  })
  return host
}

const OPTIONS = 'Pick one:\n1. Add the feature across four files\n2. Leave it'

async function ask($: Engine, text: string): Promise<void> {
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
}

async function relay($: Engine, text: string): Promise<void> {
  await $.prompt.submit({ text, wait: false, origin: { kind: 'plugin', name: 'dag-workflow' } })
}

// Every time Jev was asked the mode question (the HTTP attempt comes first).
function modeRequests(h: Harness): JevRequest[] {
  return h.requests.filter(request => 'mode' in request.questions)
}

function modeRecords(h: Harness): DecisionRecord[] {
  const text = h.files.get(`${ROOT}/decisions/source.json`)
  return text ? (JSON.parse(text).records as DecisionRecord[]).filter(record => record.kind === 'mode') : []
}

// The protocol each prompt carried, by name.
function protocols(h: Harness): string[] {
  return h.submits.map(submit => submit.context[0] === DIRECT ? 'direct' : submit.context[0] === AUTO_DAG ? 'dag' : String(submit.context[0]))
}

async function edit($: Engine): Promise<string | undefined> {
  return (await $.tool.call(EDIT)).deny
}

test('auto runs a request Jev judges small directly', async ($, on) => {
  const h = harness(on)
  jevModel(on, h)
  await boot($, null)
  await ask($, 'Fix the typo in the README')
  expect(modeRequests(h)).toHaveLength(1)
  expect(modeRequests(h)[0]?.state).toEqual({ request: 'Fix the typo in the README', recent: [] })
  expect(h.submits[0]?.context[0]).toBe(DIRECT)
  expect(h.submits[0]?.context[0]?.startsWith('[dag-workflow] This request is small: do it directly in this conversation; no DAG is needed.')).toBe(true)
  expect(await edit($)).toBeUndefined()
  const records = modeRecords(h)
  expect(records).toHaveLength(1)
  expect(records[0]).toMatchObject({
    kind: 'mode', subject: 'request', proposed: 'direct', selected: 'direct', source: 'jev', outcome: 'applied',
    backend: 'model', confidence: 0.9, probabilities: { direct: 0.9 }, threshold: 0.8, sessionId: 'source',
  })
  // The next request carries the one before it, for a short reply such as "yes".
  await ask($, 'yes')
  expect(modeRequests(h)[1]?.state).toEqual({ request: 'yes', recent: ['Fix the typo in the README'] })
})

test('auto keeps strict rules for a request Jev judges large', async ($, on) => {
  const h = harness(on)
  jevModel(on, h, { choice: 'dag', confidence: 0.9 })
  await boot($, null)
  await ask($, 'Add a settings page with its API, tests and docs')
  expect(h.submits[0]?.context[0]).toBe(AUTO_DAG)
  const deny = await edit($)
  expect(deny).toContain(REFUSED)
  expect(deny).toContain('DAG orchestration is mandatory here')
  expect(modeRecords(h)).toHaveLength(1)
  expect(modeRecords(h)[0]).toMatchObject({ selected: 'dag', source: 'jev', outcome: 'applied', confidence: 0.9 })
})

test('auto runs a turn directly when Jev is unsure or unavailable', async ($, on) => {
  const h = harness(on)
  const jev = jevModel(on, h)
  await boot($, null)
  // Each fallback follows a confident dag turn, so it has to open a gate that was closed.
  const closed = async (text: string) => {
    jev.answer = { choice: 'dag', confidence: 0.9 }
    jev.backend = 'up'
    await ask($, text)
    expect(await edit($)).toContain(REFUSED)
  }

  await closed('Build the settings page')
  jev.answer = { choice: 'dag', confidence: 0.7 }
  await ask($, 'Maybe tidy the module')
  expect(await edit($)).toBeUndefined()

  await closed('Build the billing page')
  jev.backend = 'down'
  await ask($, 'Fix the build')
  expect(await edit($)).toBeUndefined()

  // A backend that outlasts MODE_BUDGET_MS: the prompt enters at 8 s, as a direct turn.
  await closed('Build the reports page')
  jev.backend = 'slow'
  const slow = ask($, 'Fix the flaky test')
  await h.clock.settle()
  await h.clock.advance(8_000)
  await slow
  expect(await edit($)).toBeUndefined()

  expect(protocols(h)).toEqual(['dag', 'direct', 'dag', 'direct', 'dag', 'direct'])
  const fallbacks = modeRecords(h).filter(record => record.source === 'baseline')
  expect(fallbacks).toHaveLength(3)
  expect(fallbacks[0]).toMatchObject({ proposed: 'direct', selected: 'direct', outcome: 'low-confidence', confidence: 0.7, threshold: 0.8 })
  expect(fallbacks[1]).toMatchObject({ selected: 'direct', outcome: 'transport-error', backend: 'model' })
  expect(fallbacks[1]?.confidence).toBeUndefined()
  expect(fallbacks[2]).toMatchObject({ selected: 'direct', outcome: 'timeout', latencyMs: 8_000 })
})

test('auto runs every turn directly when Jev is off', { options: { jev_enabled: false } }, async ($, on) => {
  const h = harness(on)
  jevModel(on, h, { choice: 'dag', confidence: 0.9 })
  await boot($, null)
  await ask($, 'Build the settings page')
  expect(modeRequests(h)).toHaveLength(0)
  expect(modeRecords(h)).toHaveLength(0)
  expect(h.submits[0]?.context[0]).toBe(DIRECT)
  expect(await edit($)).toBeUndefined()
  expect(h.logs).toContain('dag-workflow: turn mode direct without asking Jev: jev_enabled is off')
})

test('auto keeps strict rules while this session has an active run', async ($, on) => {
  const h = harness(on)
  jevModel(on, h)
  await boot($, null)
  const runId = await start($, DEFINITION)
  await ask($, 'Also fix the typo in b.ts')
  expect(modeRequests(h)).toHaveLength(0)
  expect(modeRecords(h)).toHaveLength(0)
  expect(h.submits[0]?.context[0]).toBe(AUTO_DAG)
  expect(await edit($)).toContain(REFUSED)
  expect(h.logs).toContain('dag-workflow: turn mode dag without asking Jev: this session has a run that has not settled, and a direct turn could edit files its nodes write')

  // Once the run settles, the next request is Jev's to decide again.
  await finish($, h, 'agent-1')
  expect((await dag($, { action: 'snapshot', run_id: runId })).status).toBe('completed')
  await ask($, 'Now fix the typo in b.ts')
  expect(modeRequests(h)).toHaveLength(1)
  expect(await edit($)).toBeUndefined()
})

test('a plugin prompt keeps the current turn mode without asking Jev', async ($, on) => {
  const h = harness(on)
  const jev = jevModel(on, h)
  await boot($, null)
  await ask($, 'Fix the typo')
  await relay($, 'Node a finished.')
  expect(modeRequests(h)).toHaveLength(1)
  expect(await edit($)).toBeUndefined()

  jev.answer = { choice: 'dag', confidence: 0.9 }
  await ask($, 'Now build the whole feature')
  jev.answer = SMALL
  await relay($, 'DAG run settled.')
  expect(modeRequests(h)).toHaveLength(2)
  expect(await edit($)).toContain(REFUSED)
  expect(h.submits.map(submit => submit.origin)).toEqual(['composer', 'plugin', 'composer', 'plugin'])
  expect(protocols(h)).toEqual(['direct', 'direct', 'dag', 'dag'])
  expect(modeRecords(h)).toHaveLength(2)
})

test('starting a run in a direct turn switches the turn to strict rules', async ($, on) => {
  const h = harness(on)
  jevModel(on, h)
  await boot($, null)
  await ask($, 'Fix the typo, and run it as a DAG if it grows')
  expect(await edit($)).toBeUndefined()
  // A dry run starts nothing, so the turn stays direct.
  expect((await dag($, { action: 'start', definition: DEFINITION, dryRun: true })).dry_run).toBe(true)
  expect(await edit($)).toBeUndefined()
  const runId = await start($, DEFINITION)
  expect(h.spawns).toHaveLength(1)
  expect(await edit($)).toContain(REFUSED)
  expect((await command($, 'enforce')).text).toBe('DAG enforcement: auto (this turn: dag)')
  expect(h.logs).toContain(`dag-workflow: turn mode dag: run ${runId} started in a direct turn`)
})

test('the planning gate applies to dag start under auto', async ($, on) => {
  const h = harness(on)
  jevModel(on, h)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await ask($, 'Fix the typo')
  // The turn is direct, and still no DAG opens before the planning skill is loaded.
  expect(await edit($)).toBeUndefined()
  expect(await dag($, { action: 'start', definition: DEFINITION })).toMatchObject({ error: { code: 'planning_skill_required' } })
  expect(await dag($, { action: 'amend', run_id: 'dag_x', definition: DEFINITION })).toMatchObject({ error: { code: 'planning_skill_required' } })
  expect(h.spawns).toHaveLength(0)
  await $.skill.prompt({ skill: 'dag-workflow:planning', text: '# planning' })
  await start($, DEFINITION)
  expect(h.spawns).toHaveLength(1)
})

test('/dag enforce accepts auto and shows the turn mode', async ($, on) => {
  const h = harness(on)
  jevModel(on, h)
  await boot($, null)
  // No option given: the manifest default, before any request has decided the turn.
  expect((await command($, 'enforce')).text).toBe('DAG enforcement: auto (this turn: dag)')
  await ask($, 'Fix the typo')
  expect((await command($, 'enforce')).text).toBe('DAG enforcement: auto (this turn: direct)')
  expect((await command($, 'enforce strict')).text).toBe('DAG enforcement: strict')
  // strict ignores the turn's mode.
  expect(await edit($)).toContain(REFUSED)
  expect((await command($, 'enforce auto')).text).toBe('DAG enforcement: auto (this turn: direct)')
  expect(await edit($)).toBeUndefined()
  expect((await command($, 'enforce loose')).text).toBe('Unknown enforcement level "loose". Use strict, auto, guide or off.')
  expect((await command($, 'enforce')).text).toBe('DAG enforcement: auto (this turn: direct)')
})

test('the mode question carries the end of the assistant\'s last reply', async ($, on) => {
  const h = harness(on)
  jevModel(on, h, { choice: 'dag', confidence: 0.9 })
  transcript(on, [
    { role: 'user', text: 'Plan the settings page', toolUses: [] },
    { role: 'assistant', text: OPTIONS, toolUses: [] },
  ])
  await boot($, null)
  await ask($, '1')
  expect(modeRequests(h)).toHaveLength(1)
  expect(modeRequests(h)[0]?.state).toEqual({ request: '1', recent: [], previousReply: OPTIONS })
  expect(h.submits[0]?.context[0]).toBe(AUTO_DAG)
})

test('the mode question skips a newest assistant message that has no text', async ($, on) => {
  const h = harness(on)
  jevModel(on, h)
  transcript(on, [
    { role: 'assistant', text: OPTIONS, toolUses: [] },
    { role: 'user', text: 'Show me', toolUses: [] },
    { role: 'assistant', text: '  \n', toolUses: [] },
  ])
  await boot($, null)
  await ask($, '2')
  expect((modeRequests(h)[0]?.state as { previousReply?: string }).previousReply).toBe(OPTIONS)
})

test('the mode question is still asked, and a direct answer still opens a direct turn, when the transcript is unreadable', async ($, on) => {
  const h = harness(on)
  jevModel(on, h)
  const host = transcript(on, [{ role: 'assistant', text: OPTIONS, toolUses: [] }])
  await boot($, null)

  host.backend = 'throws'
  await ask($, 'Fix the typo in a.ts')
  expect(await edit($)).toBeUndefined()

  host.backend = 'deny'
  await ask($, 'Fix the typo in b.ts')
  expect(await edit($)).toBeUndefined()

  expect(modeRequests(h)).toHaveLength(2)
  expect(modeRequests(h)[0]?.state).toEqual({ request: 'Fix the typo in a.ts', recent: [] })
  expect(modeRequests(h)[1]?.state).toEqual({ request: 'Fix the typo in b.ts', recent: ['Fix the typo in a.ts'] })
  expect(protocols(h)).toEqual(['direct', 'direct'])
})

test('the mode question reads no transcript while this session has an active run', async ($, on) => {
  const h = harness(on)
  jevModel(on, h)
  const host = transcript(on, [{ role: 'assistant', text: OPTIONS, toolUses: [] }])
  await boot($, null)
  await start($, DEFINITION)
  await ask($, '1')
  expect(modeRequests(h)).toHaveLength(0)
  expect(host.reads).toBe(0)
  expect(h.submits[0]?.context[0]).toBe(AUTO_DAG)
})

const QUESTION = 'Which task should I do next?'
const POPUP = {
  tool: 'AskUserQuestion' as const,
  questions: [{
    question: QUESTION,
    header: 'Next task',
    multiSelect: false,
    options: [{ label: 'Add the feature', description: 'Four files plus tests and docs' }, { label: 'Push main', description: 'One git push' }],
  }],
}
const POPUP_STATE = {
  request: `Answer to "${QUESTION}": Add the feature`,
  recent: ['What next?'],
  previousReply: `Question: ${QUESTION}\n- Add the feature: Four files plus tests and docs\n- Push main: One git push`,
}

// The host's popup: the person's answer arrives as the AskUserQuestion result. Registered before the harness so this
// hook, not its catch-all tool.call, answers the call. `reply` is what the person did; `calls` counts popups shown.
function popup(on: On, reply: { answers?: Record<string, string>; response?: string; deny?: string } = { answers: { [QUESTION]: 'Add the feature' } }) {
  const person = { reply, calls: 0 }
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    person.calls += 1
    if (person.reply.deny !== undefined) return { deny: person.reply.deny }
    return { result: { questions: e.questions, answers: person.reply.answers ?? {}, ...(person.reply.response === undefined ? {} : { response: person.reply.response }) } }
  })
  return person
}

function answerRecords(h: Harness): DecisionRecord[] {
  return modeRecords(h).filter(record => record.subject === 'answer')
}

test('an answer that selects large work in a direct turn closes the gate and tells the model to plan a DAG', async ($, on) => {
  const person = popup(on)
  const h = harness(on)
  const jev = jevModel(on, h)
  await boot($, null)
  await ask($, 'What next?')
  expect(await edit($)).toBeUndefined()

  jev.answer = { choice: 'dag', confidence: 0.9 }
  const reply = await $.tool.call(POPUP)
  expect(reply.deny).toBeUndefined()
  // The tool's own result reaches the model as it was; only a reminder after it is new.
  expect(reply.result).toEqual({ questions: POPUP.questions, answers: { [QUESTION]: 'Add the feature' } })
  expect(reply.context).toHaveLength(1)
  expect(reply.context?.[0]).toContain('This answer selects work that runs as a DAG under enforcement auto')
  expect(reply.context?.[0]).toContain(AUTO_DAG)

  expect(modeRequests(h)).toHaveLength(2)
  expect(modeRequests(h)[1]?.state).toEqual(POPUP_STATE)
  expect(await edit($)).toContain(REFUSED)
  expect((await command($, 'enforce')).text).toBe('DAG enforcement: auto (this turn: dag)')
  expect(answerRecords(h)).toHaveLength(1)
  expect(answerRecords(h)[0]).toMatchObject({ kind: 'mode', subject: 'answer', proposed: 'direct', selected: 'dag', source: 'jev', outcome: 'applied', confidence: 0.9 })
  expect(modeRecords(h).map(record => record.subject)).toEqual(['request', 'answer'])

  // The turn is dag now: a later popup is not judged again, and its reply carries no reminder.
  jev.answer = SMALL
  const later = await $.tool.call(POPUP)
  expect(later.context).toBeUndefined()
  expect(modeRequests(h)).toHaveLength(2)
  expect(person.calls).toBe(2)
  expect(await edit($)).toContain(REFUSED)
})

test('an answer Jev judges small leaves the direct turn and the reply alone', async ($, on) => {
  popup(on, { answers: { [QUESTION]: 'Push main' } })
  const h = harness(on)
  jevModel(on, h)
  await boot($, null)
  await ask($, 'What next?')
  const reply = await $.tool.call(POPUP)
  expect(reply.result).toEqual({ questions: POPUP.questions, answers: { [QUESTION]: 'Push main' } })
  expect(reply.context).toBeUndefined()
  expect(modeRequests(h)).toHaveLength(2)
  expect((modeRequests(h)[1]?.state as { request: string }).request).toBe(`Answer to "${QUESTION}": Push main`)
  expect(await edit($)).toBeUndefined()
  expect(answerRecords(h)).toHaveLength(1)
  expect(answerRecords(h)[0]).toMatchObject({ subject: 'answer', proposed: 'direct', selected: 'direct', source: 'jev', outcome: 'applied', confidence: 0.9 })
})

test('an answer in a dag turn is not judged and never opens the gate', async ($, on) => {
  popup(on, { answers: { [QUESTION]: 'Push main' } })
  const h = harness(on)
  const jev = jevModel(on, h, { choice: 'dag', confidence: 0.9 })
  await boot($, null)
  await ask($, 'Add a settings page with its API, tests and docs')
  jev.answer = SMALL
  const reply = await $.tool.call(POPUP)
  expect(reply.context).toBeUndefined()
  expect(modeRequests(h)).toHaveLength(1)
  expect(answerRecords(h)).toHaveLength(0)
  expect(await edit($)).toContain(REFUSED)
})

test('an answer is not judged under enforcement strict', async ($, on) => {
  popup(on)
  const h = harness(on)
  jevModel(on, h, { choice: 'dag', confidence: 0.9 })
  await boot($)
  const reply = await $.tool.call(POPUP)
  expect(reply.context).toBeUndefined()
  expect(modeRequests(h)).toHaveLength(0)
  expect(await edit($)).toContain(REFUSED)
})

test('an answer Jev cannot judge confidently keeps the direct turn, as an undecided prompt does', async ($, on) => {
  popup(on)
  const h = harness(on)
  const jev = jevModel(on, h)
  await boot($, null)
  await ask($, 'What next?')
  jev.answer = { choice: 'dag', confidence: 0.7 }
  const reply = await $.tool.call(POPUP)
  expect(reply.context).toBeUndefined()
  expect(await edit($)).toBeUndefined()
  expect(answerRecords(h)[0]).toMatchObject({ subject: 'answer', selected: 'direct', source: 'baseline', outcome: 'low-confidence', confidence: 0.7 })

  // A backend that fails does the same.
  jev.backend = 'down'
  const failed = await $.tool.call(POPUP)
  expect(failed.context).toBeUndefined()
  expect(await edit($)).toBeUndefined()
  expect(answerRecords(h)[1]).toMatchObject({ selected: 'direct', source: 'baseline', outcome: 'transport-error' })
})

test('a typed reply instead of an option is judged as the answer', async ($, on) => {
  popup(on, { answers: {}, response: 'Rename the hooks across every module' })
  const h = harness(on)
  const jev = jevModel(on, h)
  await boot($, null)
  await ask($, 'What next?')
  jev.answer = { choice: 'dag', confidence: 0.9 }
  const reply = await $.tool.call(POPUP)
  expect(reply.context).toHaveLength(1)
  expect((modeRequests(h)[1]?.state as { request: string }).request).toBe('Typed reply: Rename the hooks across every module')
  expect(await edit($)).toContain(REFUSED)
})

test('a popup with no answer asks Jev nothing', async ($, on) => {
  popup(on, { answers: {}, response: '  ' })
  const h = harness(on)
  const jev = jevModel(on, h)
  await boot($, null)
  await ask($, 'What next?')
  jev.answer = { choice: 'dag', confidence: 0.9 }
  const reply = await $.tool.call(POPUP)
  expect(reply.context).toBeUndefined()
  expect(modeRequests(h)).toHaveLength(1)
  expect(await edit($)).toBeUndefined()
})

test('a declined popup asks Jev nothing and keeps the direct turn', async ($, on) => {
  popup(on, { deny: 'The user declined to answer' })
  const h = harness(on)
  const jev = jevModel(on, h)
  await boot($, null)
  await ask($, 'What next?')
  jev.answer = { choice: 'dag', confidence: 0.9 }
  const reply = await $.tool.call(POPUP)
  expect(reply.deny).toBe('The user declined to answer')
  expect(modeRequests(h)).toHaveLength(1)
  expect(await edit($)).toBeUndefined()
})
