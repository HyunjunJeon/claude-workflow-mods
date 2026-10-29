import { expect, test, type Engine, type Plugin } from 'claude-code/testing'
import { defaultNotesFolder } from '../hooks/engine/stages.ts'
import { boot, checkpoint, dag, finish, harness, start } from './control-harness.ts'

// The automatic review-fix round sends the findings to each producer's own finished agent with $.session.send, and the
// producer's next attempt runs on that agent; the reviewers start fresh. A send that is not delivered spawns the producer as
// before. The harness answers every send as delivered; REFUSED_SENDS sits above it.

type Harness = ReturnType<typeof harness>

const REQUEST = 'Add a greet function and document it in the README'
const FINDING = '(a) README.md:3 documents greet(name) but never says what it returns'
// A finding with this word is in the send's text, so REFUSED_SENDS can refuse that send alone.
const REFUSED = 'refused-send'

// A plugin's register closes over nothing of this file: the refusal travels in the sent text. A send that throws is not
// reproducible here: the kit skips a session.send hook that throws and the harness beneath delivers the send, and
// session.send has no deny. resumeProducer folds a throw into the same failure as an undelivered send.
const REFUSED_SENDS: Plugin = {
  name: 'rework-refused-sends',
  register(on) {
    on('session.send', ($, e, next) => {
      if (e.text.includes('refused-send')) return { isDelivered: false, reason: 'the agent is gone' }
      return next(e)
    })
  },
}

function greetFlow(key: string, docsPrompt = 'TASK: Document greet in the README. STOP WHEN: done.') {
  return {
    key,
    name: 'Greet',
    goal: 'A greet function exists in src/greet.ts and the README documents it',
    nodes: [
      { id: 'code', prompt: 'TASK: Write src/greet.ts exporting greet. STOP WHEN: done.', writes: ['src/greet.ts'], verify: [{ kind: 'file', path: 'src/greet.ts', contains: 'export function greet' }] },
      { id: 'docs', prompt: docsPrompt, writes: ['README.md'], verify: [{ kind: 'file', path: 'README.md', contains: 'greet(' }] },
    ],
    review: { request: REQUEST },
  }
}

const specNotes = (verdict: string, finding: string) =>
  `## Request sentences\n"${REQUEST}"\n\n## Findings\n${finding}\n\n## Real check\n- file checks: both met\n\n## Safe-but-wrong audit\n1. a function and a README section, as requested\n\n${verdict}\n`
const standardsNotes = (verdict: string) =>
  `## Rule sources\nnone - baseline only\n\n## Rule breaches\nnone\n\n## Judgment calls\nnone\n\n${verdict}\n`

// code (agent-1) and docs (agent-2) complete, review-standards (agent-4) passes and review-spec (agent-3) fails with the
// finding, so the round reruns docs.
async function failSpecReview($: Engine, h: Harness, key: string, finding = FINDING): Promise<{ runId: string; notes: string }> {
  const notes = defaultNotesFolder(key)
  await boot($)
  const runId = await start($, greetFlow(key))
  h.files.set('/work/src/greet.ts', 'export function greet(name: string) {\n  return `hello ${name}`\n}\n')
  h.files.set('/work/README.md', '# app\n\nCall greet(name) to say hello.\n')
  await finish($, h, 'agent-1')
  await finish($, h, 'agent-2')
  h.files.set(`${notes}/review-standards-notes.md`, standardsNotes('Standards verdict: PASS'))
  await finish($, h, 'agent-4')
  h.files.set(`${notes}/review-spec-notes.md`, specNotes('Spec verdict: FAIL', `${finding}\n(b) none\n(c) none`))
  await finish($, h, 'agent-3')
  return { runId, notes }
}

function docsNode(h: Harness, runId: string) {
  return checkpoint(h, runId).nodes.find(node => node.id === 'docs')
}

function sendsTo(h: Harness, agentId: string) {
  return h.sends.filter(send => send.to === agentId)
}

test('a FAIL verdict reruns the producer on its own agent with the findings, spawns only the reviewers, and the resumed turn completes it', async ($, on) => {
  const h = harness(on)
  const { runId, notes } = await failSpecReview($, h, 'resume-fix')
  expect(h.spawns).toHaveLength(4)
  const sent = sendsTo(h, 'agent-2')
  expect(sent).toHaveLength(1)
  expect(sent[0]?.text).toContain('[Review fix 1/1] After this node completed, review-spec failed')
  expect(sent[0]?.text).toContain(FINDING)
  expect(sent[0]?.text).toContain('the "## Output" section, then one DAG_NODE_STATUS: line')
  // The resumed attempt keeps the model the agent ran on (the harness reports the 'sonnet' docs was spawned with).
  expect(docsNode(h, runId)).toMatchObject({ state: 'running', agentId: 'agent-2', attempt: 2, model: 'sonnet' })
  expect(docsNode(h, runId)).not.toHaveProperty('resume')

  // The same agent's next turn end is verified and completes docs; both reviewers start fresh on the new work.
  h.files.set('/work/README.md', '# app\n\nCall greet(name); it returns the greeting string.\n')
  await finish($, h, 'agent-2')
  expect(docsNode(h, runId)?.state).toBe('completed')
  expect(h.spawns.map(spawn => spawn.description).slice(4)).toEqual(['Greet: Review: spec axis', 'Greet: Review: standards axis'])
  h.files.set(`${notes}/review-spec-notes.md`, specNotes('Spec verdict: PASS', '(a) none\n(b) none\n(c) none'))
  h.files.set(`${notes}/review-standards-notes.md`, standardsNotes('Standards verdict: PASS'))
  await finish($, h, 'agent-5')
  await finish($, h, 'agent-6')
  expect(checkpoint(h, runId).status).toBe('completed')
  expect(h.sends).toHaveLength(1)
})

test('a review-fix send that is not delivered spawns the producer as before, with the findings in its prompt', { plugins: [REFUSED_SENDS] }, async ($, on) => {
  const h = harness(on)
  const finding = `(a) README.md:3 never says what greet returns (${REFUSED})`
  const { runId } = await failSpecReview($, h, 'resume-refused', finding)
  expect(h.spawns.map(spawn => spawn.description).slice(4)).toEqual(['Greet: docs'])
  expect(h.spawns[4]?.prompt).toContain('[Review fix 1/1] After this node completed, review-spec failed')
  expect(h.spawns[4]?.prompt).toContain(finding)
  expect(docsNode(h, runId)).toMatchObject({ state: 'running', agentId: 'agent-5', attempt: 2 })
  expect(h.logs).toContain('Greet › docs: the review fix did not reach agent agent-2 (the agent is gone); a new agent starts with the findings in its prompt')
})

test('a retry after the resumed producer failed spawns a fresh agent for it', async ($, on) => {
  const h = harness(on)
  // No automatic recovery of the resumed attempt's failure, so the run settles for the retry.
  h.control.recovery = 'permanent'
  const { runId } = await failSpecReview($, h, 'resume-retry')
  await $.turn.complete({ turnId: 'turn-agent-2-fix', agentId: 'agent-2', reason: 'answer', isAborted: false, answer: 'DAG_NODE_STATUS: failed: cannot document it', durationMs: 1 })
  await h.clock.settle()
  expect(checkpoint(h, runId).status).toBe('failed')
  await dag($, { action: 'retry', run_id: runId })
  expect(h.spawns.map(spawn => spawn.description).slice(4)).toEqual(['Greet: docs'])
  expect(docsNode(h, runId)).toMatchObject({ state: 'running', agentId: 'agent-5', attempt: 3 })
  expect(h.sends).toHaveLength(1)
})

test('an amend after the round settled spawns a fresh agent for the changed producer', async ($, on) => {
  const h = harness(on)
  const { runId, notes } = await failSpecReview($, h, 'resume-amend')
  await finish($, h, 'agent-2')
  // Each reviewer's notes are removed before its spawn, so both verdicts are written again for the rerun reviewers.
  h.files.set(`${notes}/review-spec-notes.md`, specNotes('Spec verdict: FAIL', `${FINDING}\n(b) none\n(c) none`))
  h.files.set(`${notes}/review-standards-notes.md`, standardsNotes('Standards verdict: PASS'))
  await finish($, h, 'agent-5')
  await finish($, h, 'agent-6')
  expect(checkpoint(h, runId).status).toBe('failed')
  await dag($, { action: 'amend', run_id: runId, definition: greetFlow('resume-amend', 'TASK: Document greet and what it returns in the README. STOP WHEN: done.') })
  expect(h.spawns.map(spawn => spawn.description).slice(6)).toEqual(['Greet: docs'])
  expect(docsNode(h, runId)).toMatchObject({ state: 'running', agentId: 'agent-7' })
  expect(h.sends).toHaveLength(1)
})
