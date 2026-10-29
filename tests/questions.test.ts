import { expect, test } from 'claude-code/testing'
import { parseDefinition } from '../hooks/engine/definition.ts'
import { questionRequest } from '../hooks/engine/jev.ts'
import { buildNodePrompt, parseOutcome } from '../hooks/engine/node-prompt.ts'
import { recoverNode } from '../hooks/engine/recovery.ts'
import { verifierNodes, type SecurityCandidate } from '../hooks/engine/stages.ts'
import {
  amendRun,
  cancelRun,
  createRun,
  expandNodes,
  failUnanswered,
  markBlocked,
  markFinished,
  markRunning,
  requeueAnswered,
  resumeAnswered,
  retryRun,
  reworkRun,
  snapshotOf,
} from '../hooks/engine/run.ts'
import type { Definition, NodeDef, NodeRun, Run } from '../hooks/engine/types.ts'

const QUESTIONS = {
  key: 'questions',
  name: 'Questions',
  goal: 'A greet CLI ships.',
  nodes: [
    { id: 'a', prompt: 'Build the greet CLI.' },
    { id: 'b', prompt: 'Document it.', dependsOn: ['a'] },
  ],
}

function parse(input: unknown): Definition {
  const parsed = parseDefinition(input)
  if (!parsed.ok) throw new Error(`${parsed.error.code}: ${parsed.error.message}`)
  return parsed.value
}

function runningA(definition = parse(QUESTIONS)): Run {
  return markRunning(createRun(definition, { runId: 'rq', sessionId: 's', now: 0 }), 'a', 'agent-a', 1)
}

function defOf(run: Run, id: string): NodeDef {
  const def = run.definition.nodes.find(node => node.id === id)
  if (!def) throw new Error(`${id} is missing`)
  return def
}

function nodeOf(run: Run, id: string): NodeRun {
  const node = run.nodes.find(current => current.id === id)
  if (!node) throw new Error(`${id} is missing`)
  return node
}

function ended(answer: string) {
  return parseOutcome({ reason: 'answer', isAborted: false, answer })
}

const ASKED = [
  'I found two config files.',
  '## Question',
  'Options: src/config.ts | config/default.json',
  'Default: src/config.ts',
  'Needs: person',
  '',
  '## Output',
  'Nothing changed yet.',
  'DAG_NODE_STATUS: blocked: Which config file should the CLI read?',
].join('\n')

test('a blocked status on the last line asks the question with the options, default and Needs: person of its section', () => {
  expect(ended(ASKED)).toMatchObject({
    state: 'blocked',
    answer: ASKED,
    question: {
      text: 'Which config file should the CLI read?',
      options: ['src/config.ts', 'config/default.json'],
      default: 'src/config.ts',
      needsPerson: true,
    },
  })
})

test('a blocked status anywhere but the last line is not a question', () => {
  const answer = 'I could end with DAG_NODE_STATUS: blocked: which file?\nbut I decided.\nDAG_NODE_STATUS: completed'
  expect(ended(answer).state).toBe('completed')
})

test('a question without a section carries only its text, and a single option is no choice', () => {
  expect(ended('DAG_NODE_STATUS: blocked: Which file?')).toEqual({
    state: 'blocked', answer: 'DAG_NODE_STATUS: blocked: Which file?', question: { text: 'Which file?' },
  })
  const single = ended('### Question\n- Options: only this\n- Default: free text\n- Needs: nobody\nDAG_NODE_STATUS: blocked: Go?')
  expect(single.state === 'blocked' ? single.question : undefined).toEqual({ text: 'Go?', default: 'free text' })
})

test('a blocked status with no question text fails the node', () => {
  expect(ended('stuck\nDAG_NODE_STATUS: blocked:')).toMatchObject({ state: 'failed', error: 'The node reported blocked without a question.' })
})

test('a user node is told it may ask; a node with no clarifications gets no clarifications block', () => {
  const run = runningA()
  const prompt = buildNodePrompt(run, defOf(run, 'a'), nodeA(run))
  expect(prompt).toContain('DAG_NODE_STATUS: blocked: <one-line question>')
  expect(prompt).toContain('"## Question"')
  expect(prompt.includes('<clarifications>')).toBe(false)
})

function nodeA(run: Run): NodeRun {
  return nodeOf(run, 'a')
}

function unwrap(result: { ok: true; value: Run } | { ok: false; error: { code: string } }): Run {
  if (!result.ok) throw new Error(result.error.code)
  return result.value
}

function blockedA(question = 'Which config file?', run = runningA()): Run {
  return markBlocked(run, 'a', { state: 'blocked', question: { text: question, options: ['src', 'config'], default: 'src' } }, 5)
}

test('a blocked turn end leaves the node blocked on its question with its agent, and the run still running', () => {
  const run = markFinished(runningA(), 'a', ended(ASKED), 5)
  expect(nodeA(run)).toMatchObject({
    state: 'blocked',
    attempt: 1,
    agentId: 'agent-a',
    question: { text: 'Which config file should the CLI read?', default: 'src/config.ts', needsPerson: true, askedAt: 5 },
  })
  expect(nodeA(run).finishedAt).toBe(undefined)
  expect(run.status).toBe('running')
  expect(run.nodes[1]?.state).toBe('pending')
})

test('an answer resumes the same attempt with the same agent, records the answer and clears the question', () => {
  const run = unwrap(resumeAnswered(blockedA(), 'a', { answer: 'src', by: 'person' }, 7))
  const node = nodeA(run)
  expect(node).toMatchObject({ state: 'running', attempt: 1, agentId: 'agent-a' })
  expect(node.question).toBe(undefined)
  expect(node.clarifications).toEqual([{ question: 'Which config file?', answer: 'src', by: 'person', at: 7, attempt: 1 }])
  const done = markFinished(run, 'a', ended('done\nDAG_NODE_STATUS: completed'), 9)
  expect(nodeA(done).state).toBe('completed')
})

test('an answer that could not reach the agent starts a new attempt whose prompt lists every earlier answer', () => {
  const first = unwrap(resumeAnswered(blockedA('Which config file?'), 'a', { answer: 'src', by: 'model' }, 6))
  const requeued = unwrap(requeueAnswered(blockedA('Keep the old flag?', first), 'a', { answer: 'no', by: 'timeout' }, 8))
  const node = nodeA(requeued)
  expect(node.state).toBe('scheduled')
  expect(node.agentId).toBe(undefined)
  expect(node.question).toBe(undefined)
  const next = markRunning(requeued, 'a', 'agent-a2', 9)
  expect(nodeA(next).attempt).toBe(2)
  const prompt = buildNodePrompt(next, defOf(next, 'a'), nodeA(requeued))
  expect(prompt).toContain([
    '<clarifications>',
    'This node asked these questions earlier and got these answers; follow them. An earlier attempt may already have changed files, so check the working tree before you redo its work.',
    '<clarification attempt="1" by="model">',
    'Question: Which config file?',
    'Answer: src',
    '</clarification>',
    '<clarification attempt="1" by="timeout">',
    'Question: Keep the old flag?',
    'Answer: no',
    '</clarification>',
    '</clarifications>',
  ].join('\n'))
})

test('only a blocked node takes an answer', () => {
  const run = runningA()
  for (const result of [
    resumeAnswered(run, 'a', { answer: 'x', by: 'person' }, 2),
    requeueAnswered(run, 'a', { answer: 'x', by: 'person' }, 2),
    failUnanswered(run, 'a', 2),
  ]) expect(result.ok ? 'ok' : result.error.code).toBe('node_not_blocked')
  expect(markBlocked(createRun(parse(QUESTIONS), { runId: 'rq', sessionId: 's', now: 0 }), 'a', { state: 'blocked', question: { text: 'q' } }, 2).nodes[0]?.state).toBe('scheduled')
})

test('a third question in one attempt fails the node as a clarification, while a new attempt may ask again', () => {
  let run = unwrap(resumeAnswered(blockedA('one?'), 'a', { answer: '1', by: 'person' }, 6))
  run = unwrap(resumeAnswered(blockedA('two?', run), 'a', { answer: '2', by: 'person' }, 7))
  const third = blockedA('three?', run)
  expect(nodeA(third)).toMatchObject({ state: 'failed', error: 'clarification: three?', finishedAt: 5, recovery: { used: 0, kind: 'clarification', reason: 'clarification: three?' } })
  expect(nodeA(third).question).toBe(undefined)
  expect(third.nodes[1]?.state).toBe('skipped')
  const retried = markRunning(unwrap(retryRun(third, { nodeIds: ['a'] }, 8)), 'a', 'agent-a2', 9)
  expect(nodeA(blockedA('one again?', retried)).state).toBe('blocked')
})

test('a question nobody answers fails the node as a clarification and skips what depends on it', () => {
  const run = unwrap(failUnanswered(blockedA('Which config file?'), 'a', 9))
  expect(nodeA(run)).toMatchObject({ state: 'failed', error: 'clarification: Which config file?', finishedAt: 9, recovery: { kind: 'clarification', used: 0 } })
  expect(nodeA(run).question).toBe(undefined)
  expect(run.nodes[1]?.state).toBe('skipped')
  expect(run.status).toBe('failed')
  expect(recoverNode(run, 'a', { kind: 'clarification', reason: 'x', now: 10 }).ok).toBe(false)
})

test('cancel ends a blocked node without an agent to stop', () => {
  const cancelled = cancelRun(blockedA(), 'superseded', 6)
  expect(cancelled.stopAgents).toEqual([])
  expect(nodeA(cancelled.run)).toMatchObject({ state: 'cancelled', error: 'Cancelled: superseded' })
  expect(nodeA(cancelled.run).question).toBe(undefined)
  expect(cancelled.run.status).toBe('cancelled')
})

test('the snapshot shows the question a node waits on', () => {
  expect(snapshotOf(blockedA()).nodes[0]?.question).toEqual({ text: 'Which config file?', options: ['src', 'config'], default: 'src', asked_at: 5 })
  expect(snapshotOf(markFinished(runningA(), 'a', ended(ASKED), 5)).nodes[0]?.question).toEqual({
    text: 'Which config file should the CLI read?', options: ['src/config.ts', 'config/default.json'], default: 'src/config.ts', needs_person: true, asked_at: 5,
  })
  expect(Object.hasOwn(snapshotOf(runningA()).nodes[0] ?? {}, 'question')).toBe(false)
})

const answered = (run: Run) => nodeA(run).clarifications?.map(entry => entry.answer)

function answeredAndFailed(): Run {
  const resumed = unwrap(resumeAnswered(blockedA(), 'a', { answer: 'src', by: 'person' }, 6))
  return markFinished(resumed, 'a', ended('DAG_NODE_STATUS: failed: tests fail'), 7)
}

test('retry and automatic recovery keep the answers', () => {
  expect(answered(unwrap(retryRun(answeredAndFailed(), { nodeIds: ['a'] }, 8)))).toEqual(['src'])
  expect(answered(unwrap(recoverNode(answeredAndFailed(), 'a', { kind: 'implementation', reason: 'tests fail', now: 8 })))).toEqual(['src'])
})

test('a review-fix round keeps the answers', () => {
  const resumed = unwrap(resumeAnswered(blockedA(), 'a', { answer: 'src', by: 'person' }, 6))
  let run = markFinished(resumed, 'a', ended('DAG_NODE_STATUS: completed'), 7)
  run = markFinished(markRunning(run, 'b', 'agent-b', 8), 'b', ended('DAG_NODE_STATUS: completed'), 9)
  expect(answered(unwrap(reworkRun(run, ['a'], 'fix it', ['review-spec'], 10)))).toEqual(['src'])
})

test('an amend that changes the node drops its question and answers; one that leaves it alone keeps them', () => {
  const resumed = unwrap(resumeAnswered(blockedA('one?'), 'a', { answer: '1', by: 'person' }, 6))
  const blocked = blockedA('two?', resumed)
  const unchanged = amendRun(blocked, parse({ ...QUESTIONS, nodes: [...QUESTIONS.nodes, { id: 'c', prompt: 'More.' }] }), 8)
  if (!unchanged.ok) throw new Error(unchanged.error.code)
  expect(nodeA(unchanged.value.run)).toMatchObject({ state: 'blocked', question: { text: 'two?' }, clarifications: [{ answer: '1' }] })
  const changed = amendRun(blocked, parse({ ...QUESTIONS, nodes: QUESTIONS.nodes.map(node => node.id === 'a' ? { ...node, prompt: 'Build it in Go.' } : node) }), 8)
  if (!changed.ok) throw new Error(changed.error.code)
  const node = nodeA(changed.value.run)
  expect(node.state).toBe('scheduled')
  expect(node.question).toBe(undefined)
  expect(node.clarifications).toBe(undefined)
})

const COMMITS = [{ message: 'feat: greet', paths: ['src'] }]
const CANDIDATE: SecurityCandidate = { items: ['kisa 1-1 SQL 삽입'], file: 'src/db.ts', line: 4, claim: 'The query concatenates input.', missing_control: 'Bind it.' }

test('generated review, security and commit nodes are not told they may ask, and a question they raise fails them', () => {
  const definition = parse({ ...QUESTIONS, review: { request: 'Build greet.', security: ['kisa'] }, commit: COMMITS })
  const verifiers = verifierNodes(definition, 'security-injection', [CANDIDATE])
  if (!verifiers.ok) throw new Error(verifiers.error.message)
  let run = createRun(definition, { runId: 'rg', sessionId: 's', now: 0 })
  run = unwrap(expandNodes(run, 'security-injection', 'review-security', verifiers.value))
  const generated = ['review-spec', 'review-standards', 'security-injection', 'security-verify-injection-1', 'review-security', 'commit']
  for (const id of generated) {
    expect({ id, asks: buildNodePrompt(run, defOf(run, id), nodeOf(run, id)).includes('blocked:') }).toEqual({ id, asks: false })
  }
  const lens = markRunning({ ...run, nodes: run.nodes.map(node => node.id === 'review-spec' ? { ...node, state: 'scheduled' as const } : node) }, 'review-spec', 'agent-r', 1)
  const asked = markFinished(lens, 'review-spec', ended('DAG_NODE_STATUS: blocked: Which request?'), 2)
  expect(asked.nodes.find(node => node.id === 'review-spec')).toMatchObject({ state: 'failed', error: 'missing-input: Which request?' })
})

test('a user node named commit may ask when the definition has no commit stage', () => {
  const run = createRun(parse({ ...QUESTIONS, nodes: [{ id: 'commit', prompt: 'Commit it.' }] }), { runId: 'rc', sessionId: 's', now: 0 })
  expect(buildNodePrompt(run, defOf(run, 'commit'), nodeOf(run, 'commit'))).toContain('blocked: <one-line question>')
})

test('Jev is asked to pick one of the options of the question, with the task and earlier answers as data', () => {
  const run = unwrap(resumeAnswered(blockedA('Which language?'), 'a', { answer: 'src', by: 'person' }, 6))
  const blocked = blockedA('Which config file?', run)
  const request = questionRequest(blocked, nodeA(blocked))
  expect(Object.keys(request?.questions ?? {})).toEqual(['question'])
  expect(Object.keys(request?.questions.question?.criteria ?? {})).toEqual(['src', 'config'])
  expect(request?.state).toMatchObject({
    goal: 'A greet CLI ships.',
    task: 'Build the greet CLI.',
    question: 'Which config file?',
    options: ['src', 'config'],
    default: 'src',
    clarifications: [{ question: 'Which language?', answer: 'src' }],
  })
})

test('Jev gets no question without options or one only the person may answer', () => {
  const plain = markBlocked(runningA(), 'a', { state: 'blocked', question: { text: 'Why?' } }, 5)
  expect(questionRequest(plain, nodeA(plain))).toBe(undefined)
  const personal = markFinished(runningA(), 'a', ended(ASKED), 5)
  expect(questionRequest(personal, nodeA(personal))).toBe(undefined)
  expect(questionRequest(runningA(), nodeA(runningA()))).toBe(undefined)
})
