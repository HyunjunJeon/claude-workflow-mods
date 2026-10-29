import { expect, test, type Engine, type Plugin } from 'claude-code/testing'
import type { DecisionRecord } from '../hooks/engine/decisions.ts'
import type { JevRequest } from '../hooks/engine/jev.ts'
import type { VerificationCheck } from '../hooks/engine/types.ts'
import { boot, checkpoint, command, dag, finish, harness, ROOT, start } from './control-harness.ts'

// A node that ends its turn with DAG_NODE_STATUS: blocked waits for an answer, and the answer goes back to the same agent
// with $.session.send (docs/design/node-questions.md). The harness answers every send as delivered and every Jev question with
// 'trivial'; SEND_FAILURES and QUESTION_JEV sit above it. A plugin's register closes over nothing of this file, so their
// behaviour travels in the data: the answer text picks the send's fate, and the question text Jev's confidence.

const CHECK: VerificationCheck[] = [{ kind: 'command', argv: ['check-control'] }]
const DEFINITION = {
  key: 'questions',
  name: 'Questions',
  nodes: [
    { id: 'a', prompt: 'Write the artifact', verify: CHECK },
    { id: 'b', prompt: 'Use the artifact', dependsOn: ['a'], verify: CHECK },
  ],
}
const QUESTION = 'Which format should the artifact use?'
// Jev answers this one below jev_recovery_confidence (0.9 by default).
const UNSURE = 'Which format should the artifact use? (unsure)'
const FIFTEEN_MINUTES = 15 * 60_000
const USER_ONLY = 'This action requires a user command or pane control.'

type Harness = ReturnType<typeof harness>

let turns = 0

// The node's agent ends its turn on the question, with the given lines in its ## Question section.
async function ask($: Engine, h: Harness, lines: string[], question = QUESTION, agentId = 'agent-1') {
  const answer = ['I cannot choose the format myself.', '', '## Question', ...lines, '', `DAG_NODE_STATUS: blocked: ${question}`].join('\n')
  await $.turn.complete({ turnId: `ask-${++turns}`, agentId, reason: 'answer', isAborted: false, answer, durationMs: 1 })
  await h.clock.settle()
}

// An answer "refused-send" is not delivered. (A hook that throws is skipped by the kit, so a send that rejects is not
// reproducible here; answerNode treats it as not delivered.)
const SEND_FAILURES: Plugin = {
  name: 'questions-send-failures',
  register(on) {
    on('session.send', ($, e, next) => {
      if (e.text.includes('>refused-send</answer>')) return { isDelivered: false, reason: 'the agent is gone' }
      return next(e)
    })
  },
}

// Jev picks "yaml" for a node question, at 0.6 when the question says "(unsure)" and 0.95 otherwise. The harness still sees the
// request (h.requests); only its answer is replaced.
const QUESTION_JEV: Plugin = {
  name: 'questions-jev',
  register(on) {
    on('http.fetch', async ($, e, next) => {
      const body = e.init?.body ?? ''
      const seen = await next(e)
      if (!body.includes('"question":{"type":"choice"')) return seen
      const answers = { question: { type: 'choice', choice: 'yaml', confidence: body.includes('(unsure)') ? 0.6 : 0.95 } }
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ answers }) } }
    })
  },
}

function questionRequests(h: Harness): JevRequest[] {
  return h.requests.filter(request => 'question' in request.questions)
}

function nodeA(h: Harness, runId: string) {
  const node = checkpoint(h, runId).nodes.find(current => current.id === 'a')
  if (!node) throw new Error('Missing node a')
  return node
}

function checksRun(h: Harness): number {
  return h.processes.filter(e => e.argv[0] === 'check-control').length
}

function recoveryRequests(h: Harness): number {
  return h.requests.filter(request => 'recovery' in request.questions).length
}

function questionNews(h: Harness) {
  return h.submits.filter(submit => submit.text.includes('is blocked on a question'))
}

async function bootHeadless($: Engine) {
  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  await $.skill.prompt({ skill: 'dag-workflow:planning', text: '# planning' })
}

function questionRecords(h: Harness): DecisionRecord[] {
  const text = h.files.get(`${ROOT}/decisions/source.json`)
  const records: DecisionRecord[] = text ? JSON.parse(text).records : []
  return records.filter(record => record.kind === 'question')
}

test('a blocked turn end runs no verification, keeps the agent and tells the main conversation and the person once', async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = await start($, DEFINITION)
  await ask($, h, ['Options: json | yaml', 'Default: json'])

  expect(checksRun(h)).toBe(0)
  expect(h.spawns).toHaveLength(1)
  expect(checkpoint(h, runId).nodes.map(node => node.state)).toEqual(['blocked', 'pending'])
  expect(nodeA(h, runId)).toMatchObject({ agentId: 'agent-1', attempt: 1, question: { text: QUESTION, options: ['json', 'yaml'], default: 'json' } })
  const snapshot = await dag($, { action: 'snapshot', run_id: runId })
  expect(snapshot).toMatchObject({ status: 'running', nodes: [{ id: 'a', state: 'blocked', question: { text: QUESTION, options: ['json', 'yaml'], default: 'json', asked_at: 1_000 } }, { id: 'b' }] })

  const news = questionNews(h)
  expect(news).toHaveLength(1)
  expect(news[0]?.text).toContain(`<question>\n${QUESTION}\n</question>`)
  expect(news[0]?.text).toContain('If nobody answers within 15 minutes, the default is sent as the answer.')
  expect(news[0]?.text).toContain(`{"action":"answer","run_id":"${runId}","node_id":"a","answer":"..."}`)
  expect(news[0]?.text).toContain(`/dag answer ${runId} a <text>`)
  expect(h.notifications.map(note => note.text)).toEqual([`DAG Questions › a asks: ${QUESTION}`])
})

test('the answer action resumes the same agent at the same attempt, and its next turn end is verified and completes the node', async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = await start($, DEFINITION)
  await ask($, h, ['Options: json | yaml', 'Default: json'])

  expect(await dag($, { action: 'answer', run_id: runId, node_id: 'a', answer: 'yaml' })).toEqual({ node_id: 'a', resumed: true, state: 'running', attempt: 1 })
  expect(h.sends).toHaveLength(1)
  expect(h.sends[0]).toMatchObject({ to: 'agent-1' })
  expect(h.sends[0]?.text).toContain('<answer by="model">yaml</answer>')
  expect(h.sends[0]?.text).toContain('DAG_NODE_STATUS')
  expect(nodeA(h, runId)).toMatchObject({ state: 'running', attempt: 1, agentId: 'agent-1', clarifications: [{ question: QUESTION, answer: 'yaml', by: 'model', attempt: 1 }] })
  expect(nodeA(h, runId).question).toBeUndefined()
  expect(h.spawns).toHaveLength(1)

  await finish($, h, 'agent-1')
  expect(checksRun(h)).toBe(1)
  expect(nodeA(h, runId)).toMatchObject({ state: 'completed', attempt: 1, verification: { status: 'passed' } })
  expect(h.spawns).toHaveLength(2)

  // The answered question's timer was cancelled: nothing more is sent when its 15 minutes pass.
  await h.clock.advance(FIFTEEN_MINUTES)
  expect(h.sends).toHaveLength(1)
})

test('/dag answer typed by the person resumes the agent with a person answer; the same command from elsewhere is refused', async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = await start($, DEFINITION)
  await ask($, h, ['Options: json | yaml'])

  const sdk = await $.command.run({ command: 'dag', args: `answer ${runId} a yaml`, origin: { kind: 'sdk' }, presentation: { isFullscreen: false, columns: 80 } })
  expect(sdk.text).toBe(USER_ONLY)
  expect(h.sends).toHaveLength(0)

  expect((await command($, `answer ${runId} a`)).text).toBe('Usage: /dag answer <run> <node> <text>')
  const typed = await command($, `answer ${runId} a yaml with comments`)
  expect(typed.text).toContain('running')
  expect(h.sends[0]?.text).toContain('<answer by="person">yaml with comments</answer>')
  expect(nodeA(h, runId)).toMatchObject({ state: 'running', attempt: 1, clarifications: [{ answer: 'yaml with comments', by: 'person' }] })

  await finish($, h, 'agent-1')
  expect(nodeA(h, runId)).toMatchObject({ state: 'completed', attempt: 1 })
})

test('an answer whose send is not delivered starts a new attempt whose prompt carries the clarification', { plugins: [SEND_FAILURES] }, async ($, on) => {
  const answer = 'refused-send'
  const h = harness(on)
  await boot($)
  const runId = await start($, DEFINITION)
  await ask($, h, ['Options: json | yaml'])

  expect(await dag($, { action: 'answer', run_id: runId, node_id: 'a', answer })).toEqual({ node_id: 'a', resumed: false, state: 'running', attempt: 2 })
  expect(h.spawns).toHaveLength(2)
  expect(h.spawns[1]?.prompt).toContain('<clarifications>')
  expect(h.spawns[1]?.prompt).toContain(`Question: ${QUESTION}\nAnswer: ${answer}`)
  expect(nodeA(h, runId)).toMatchObject({ state: 'running', attempt: 2, agentId: 'agent-2' })

  // The first agent's mapping is gone, so a late turn end of it changes nothing; the new attempt's end completes the node.
  await finish($, h, 'agent-1')
  expect(nodeA(h, runId)).toMatchObject({ state: 'running', attempt: 2 })
  await finish($, h, 'agent-2')
  expect(nodeA(h, runId)).toMatchObject({ state: 'completed', attempt: 2 })
})

test('an interactive question with a default gets the default after 15 minutes as a timeout answer', async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = await start($, DEFINITION)
  await ask($, h, ['Options: json | yaml', 'Default: json'])

  await h.clock.advance(FIFTEEN_MINUTES - 1)
  expect(h.sends).toHaveLength(0)
  await h.clock.advance(1)
  await h.clock.settle()
  expect(h.sends).toHaveLength(1)
  expect(h.sends[0]?.text).toContain('<answer by="timeout">json</answer>')
  expect(nodeA(h, runId)).toMatchObject({ state: 'running', attempt: 1, clarifications: [{ answer: 'json', by: 'timeout' }] })
})

test('an interactive question without a default fails the node as a clarification after 15 minutes, with no Jev call', async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = await start($, DEFINITION)
  await ask($, h, ['Options: json | yaml'])

  await h.clock.advance(FIFTEEN_MINUTES)
  await h.clock.settle()
  expect(h.sends).toHaveLength(0)
  expect(nodeA(h, runId)).toMatchObject({ state: 'failed', error: `clarification: ${QUESTION}`, recovery: { used: 0, kind: 'clarification' } })
  expect(checkpoint(h, runId)).toMatchObject({ status: 'failed', nodes: [{ id: 'a' }, { id: 'b', state: 'skipped' }] })
  expect(recoveryRequests(h)).toBe(0)
  expect(h.spawns).toHaveLength(1)
})

test('cancelling a run with a blocked node ends it, and nothing is sent when its 15 minutes pass', async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = await start($, DEFINITION)
  await ask($, h, ['Default: json'])

  await dag($, { action: 'cancel', run_id: runId, reason: 'not needed' })
  expect(nodeA(h, runId).state).toBe('cancelled')
  await h.clock.advance(FIFTEEN_MINUTES)
  await h.clock.settle()
  expect(h.sends).toHaveLength(0)
  expect(nodeA(h, runId).state).toBe('cancelled')
})

test('a third question in one attempt fails the node as a clarification with no Jev call', async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = await start($, DEFINITION)
  for (const answer of ['json', 'yaml']) {
    await ask($, h, ['Options: json | yaml'])
    await dag($, { action: 'answer', run_id: runId, node_id: 'a', answer })
  }
  await ask($, h, ['Options: json | yaml'])

  expect(nodeA(h, runId)).toMatchObject({ state: 'failed', attempt: 1, error: `clarification: ${QUESTION}`, recovery: { kind: 'clarification' } })
  expect(recoveryRequests(h)).toBe(0)
  expect(questionNews(h)).toHaveLength(2)
})

test('the model may not answer a Needs: person question, a node that is not blocked, or a run the person rejected', { options: { start_approval: 'always' } }, async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = await start($, DEFINITION)
  await command($, `approve ${runId}`)
  expect(await dag($, { action: 'answer', run_id: runId, node_id: 'a', answer: 'yaml' })).toMatchObject({
    error: { code: 'node_not_blocked', message: 'Node "a" is running; only a blocked node takes an answer.' },
  })

  await ask($, h, ['Options: json | yaml', 'Needs: person'])
  expect(questionNews(h)[0]?.text).toContain('Only the user may answer this question (Needs: person)')
  expect(await dag($, { action: 'answer', run_id: runId, node_id: 'a', answer: 'yaml' })).toMatchObject({ error: { code: 'needs_person' } })
  expect(h.sends).toHaveLength(0)
  await command($, `answer ${runId} a yaml`)
  expect(h.sends[0]?.text).toContain('<answer by="person">yaml</answer>')

  const rejected = await start($, { ...DEFINITION, key: 'questions-rejected' })
  await command($, `reject ${rejected} not this one`)
  expect(await dag($, { action: 'answer', run_id: rejected, node_id: 'a', answer: 'yaml' })).toMatchObject({ error: { code: 'rejected_by_user' } })
})

test('a non-interactive session takes the option Jev picks above jev_recovery_confidence and records the decision', { plugins: [QUESTION_JEV] }, async ($, on) => {
  const h = harness(on)
  await bootHeadless($)
  const runId = await start($, DEFINITION)
  await ask($, h, ['Options: json | yaml', 'Default: json'])

  expect(questionRequests(h)).toHaveLength(1)
  expect(questionRequests(h)[0]?.state).toMatchObject({ question: QUESTION, options: ['json', 'yaml'], default: 'json' })
  expect(h.sends[0]?.text).toContain('<answer by="jev">yaml</answer>')
  expect(nodeA(h, runId)).toMatchObject({ state: 'running', attempt: 1, clarifications: [{ answer: 'yaml', by: 'jev' }] })
  expect(questionRecords(h)).toMatchObject([{ kind: 'question', subject: 'a', nodeId: 'a', selected: 'yaml', source: 'jev', outcome: 'applied', confidence: 0.95, threshold: 0.9 }])
  expect(questionNews(h)).toHaveLength(0)
})

test('a non-interactive session sends the default when Jev stays below the bar', { plugins: [QUESTION_JEV] }, async ($, on) => {
  const h = harness(on)
  await bootHeadless($)
  const runId = await start($, DEFINITION)
  await ask($, h, ['Options: json | yaml', 'Default: json'], UNSURE)

  expect(h.sends[0]?.text).toContain('<answer by="default">json</answer>')
  expect(nodeA(h, runId)).toMatchObject({ state: 'running', clarifications: [{ answer: 'json', by: 'default' }] })
  expect(questionRecords(h)).toMatchObject([{ selected: 'json', source: 'baseline', outcome: 'low-confidence', confidence: 0.6 }])
})

test('a non-interactive question without options gets its default without asking Jev', { plugins: [QUESTION_JEV] }, async ($, on) => {
  const h = harness(on)
  await bootHeadless($)
  const runId = await start($, DEFINITION)
  await ask($, h, ['Default: json'])

  expect(questionRequests(h)).toHaveLength(0)
  expect(h.sends[0]?.text).toContain('<answer by="default">json</answer>')
  expect(nodeA(h, runId).state).toBe('running')
})

test('a non-interactive question Jev cannot settle and with no default fails the node as a clarification', { plugins: [QUESTION_JEV] }, async ($, on) => {
  const h = harness(on)
  await bootHeadless($)
  const runId = await start($, DEFINITION)
  await ask($, h, ['Options: json | yaml'], UNSURE)

  expect(questionRequests(h)).toHaveLength(1)
  expect(h.sends).toHaveLength(0)
  expect(nodeA(h, runId)).toMatchObject({ state: 'failed', error: `clarification: ${UNSURE}`, recovery: { kind: 'clarification' } })
  expect(recoveryRequests(h)).toBe(0)
})

test('a session restarted without a person decides a question the earlier session left waiting', async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = await start($, DEFINITION)
  await ask($, h, ['Default: json'])
  expect(h.sends).toHaveLength(0)

  await $.session.start({ surface: null, isInteractive: false, cwd: '/work' })
  expect(h.sends).toHaveLength(1)
  expect(h.sends[0]).toMatchObject({ to: 'agent-1' })
  expect(h.sends[0]?.text).toContain('<answer by="default">json</answer>')
  await finish($, h, 'agent-1')
  expect(nodeA(h, runId)).toMatchObject({ state: 'completed', attempt: 1 })
})

// The host runs a plugin's prompt once the session is idle, so a notice can pass prompt.submit after the question was
// answered; the test kit runs it at once, so the late pass is the same notice submitted again after the answer.
test('a question notice that passes after the question was answered is dropped, and an open one still arrives', async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = await start($, DEFINITION)
  await ask($, h, ['Options: json | yaml'])
  const notice = questionNews(h)[0]?.text ?? ''
  expect(notice).toContain(QUESTION)
  await dag($, { action: 'answer', run_id: runId, node_id: 'a', answer: 'yaml' })

  expect(await $.prompt.submit({ text: notice, wait: false, origin: { kind: 'plugin', name: 'dag-workflow' } })).toEqual({ drop: 'the question was answered or withdrawn before this notice ran' })
  expect(questionNews(h)).toHaveLength(1)

  await ask($, h, ['Options: json | yaml'])
  expect(questionNews(h)).toHaveLength(2)
})
