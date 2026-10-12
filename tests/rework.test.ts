import { expect, test } from 'claude-code/testing'
import { parseDefinition } from '../hooks/engine/definition.ts'
import { citedPaths, findingSections, producersOf, rerunRisk, reworkPlan, type ReworkPlan, type ReworkSkip } from '../hooks/engine/rework.ts'
import { createRun, markFinished, markRunning, reworkRun } from '../hooks/engine/run.ts'
import type { Run } from '../hooks/engine/types.ts'

const CHECK = [{ kind: 'command', argv: ['check-control'] }]
const asPlan = (result: ReworkPlan | ReworkSkip | undefined): ReworkPlan | undefined => (result && 'skip' in result ? undefined : result)
const TASK = 'TASK: x STOP WHEN: y'

// Two producers with their own files, an optional third one with no write scope, and a hand-written audit over all of them.
function settled(audit: { error: string; state?: 'failed' | 'completed' }, extra: { id: string; failed?: string }[] = []): Run {
  const parsed = parseDefinition({ key: 'k', nodes: [
    { id: 'api', prompt: TASK, writes: ['src/api'], verify: CHECK },
    { id: 'docs', prompt: TASK, writes: ['README.md'], verify: CHECK },
    ...extra.map(node => ({ id: node.id, prompt: TASK, verify: CHECK })),
    { id: 'verify-all', prompt: TASK, dependsOn: ['api', 'docs', ...extra.map(node => node.id)], verify: CHECK },
  ] })
  if (!parsed.ok) throw new Error(parsed.error.message)
  let run = createRun(parsed.value, { runId: 'r', sessionId: 's', now: 0 })
  for (const node of ['api', 'docs', ...extra.map(node => node.id)]) {
    const failure = extra.find(item => item.id === node)?.failed
    run = markFinished(markRunning(run, node, `agent-${node}`, 1), node, failure ? { state: 'failed', error: failure } : { state: 'completed', answer: 'done' }, 2)
  }
  if (run.nodes.find(node => node.id === 'verify-all')?.state === 'scheduled') {
    run = markFinished(markRunning(run, 'verify-all', 'agent-audit', 3), 'verify-all', { state: audit.state ?? 'failed', error: audit.error }, 4)
  }
  return run
}

test('a settled FAIL verdict sends back the producer whose write scope the findings cite, with the findings', () => {
  const run = settled({ error: 'partial/supporting-output - /work/src/api/handler.ts:12 drops the 404 branch' })
  const plan = asPlan(reworkPlan(run, new Map(), '/work'))
  expect(plan).toMatchObject({ reviewers: ['verify-all'], producers: ['api'] })
  expect(plan?.note).toContain('[Review fix 1/1] After this node completed, verify-all failed')
  expect(plan?.note).toContain('drops the 404 branch')
})

test('no round when another kind of failure is in the run or the round is spent; a skip with its reason when no single owner is cited', () => {
  expect(reworkPlan(settled({ error: 'x' }, [{ id: 'flaky', failed: 'The node agent ended with error.' }]), new Map(), '/work')).toBeUndefined()
  const cited = settled({ error: 'Doc verdict: FAIL - README.md:3 lacks the return value' })
  expect(reworkPlan({ ...cited, reviewFix: { rounds: 1, history: [] } }, new Map(), '/work')).toBeUndefined()
  expect(reworkPlan(settled({ error: 'The node agent ended with error.' }), new Map(), '/work')).toBeUndefined()
  expect(reworkPlan(settled({ error: 'Spec verdict: FAIL - the greeting is not localised' }), new Map(), '/work')).toEqual({
    skip: "the findings of verify-all name no file inside one producer's declared writes, so which producer to change is your call",
  })
  // A findings text from the notes wins over the error line, and a basename finds its owner too.
  expect(asPlan(reworkPlan(cited, new Map([['verify-all', 'README.md:3 lacks it']]), '/work'))?.producers).toEqual(['docs'])
})

// Seen in real runs: apply-env, switch-role, setup-assets (a Supabase upload), delete-token-row and commit-push changed
// things outside the project, and none of them declared writes.
test('rerunRisk keeps nodes that work outside the project files out of the round, and lets file producers and verifiers through', () => {
  const node = (fields: Record<string, unknown>) => ({ id: 'x', prompt: TASK, dependsOn: [], ...fields })
  expect(rerunRisk(node({ id: 'apply-env' }))).toBe('is named for work outside the project files ("apply")')
  expect(rerunRisk(node({ id: 'commitPush', writes: ['src/a.ts'] }))).toContain('("commit")')
  expect(rerunRisk(node({ id: 'deploy-preview', writes: ['dist'] }))).toContain('("deploy")')
  expect(rerunRisk(node({ id: 'setup-assets' }))).toBe('declares no writes, so what a rerun would change is unknown')
  expect(rerunRisk(node({ id: 'buckets', writes: ['scripts/buckets.ts'], external: true }))).toBe('declares external: true')
  expect(rerunRisk(node({ id: 'verify-prod', dependsOn: ['a'] }))).toContain('("prod")')
  for (const ok of [node({ id: 'product-page', writes: ['src/product.ts'] }), node({ id: 'verify-files', dependsOn: ['a'] }), node({ id: 'docs', writes: ['README.md'] })]) {
    expect({ id: ok.id, risk: rerunRisk(ok) }).toEqual({ id: ok.id, risk: undefined })
  }
})

test('a round that would rerun an external producer, or a completed external node downstream of it, becomes a skip naming it', () => {
  const external = settled({ error: 'Spec verdict: FAIL - src/api/a.ts:1' })
  const marked: Run = { ...external, definition: { ...external.definition, nodes: external.definition.nodes.map(def => def.id === 'api' ? { ...def, external: true } : def) } }
  expect(reworkPlan(marked, new Map(), '/work')).toEqual({ skip: 'api already ran and declares external: true, so the round does not rerun it unattended' })
  // An upload that ran beside the reviewer, after api, would run again as api's dependent.
  const parsed = parseDefinition({ key: 'k', nodes: [
    { id: 'api', prompt: TASK, writes: ['src/api'], verify: CHECK },
    { id: 'upload-assets', prompt: TASK, dependsOn: ['api'], verify: CHECK },
    { id: 'review-api', prompt: TASK, dependsOn: ['api'], verify: CHECK },
  ] })
  if (!parsed.ok) throw new Error(parsed.error.message)
  let run = createRun(parsed.value, { runId: 'r', sessionId: 's', now: 0 })
  run = markFinished(markRunning(run, 'api', 'a1', 1), 'api', { state: 'completed', answer: 'done' }, 2)
  run = markFinished(markRunning(run, 'upload-assets', 'a2', 3), 'upload-assets', { state: 'completed', answer: 'done' }, 4)
  run = markFinished(markRunning(run, 'review-api', 'a3', 3), 'review-api', { state: 'failed', error: 'Spec verdict: FAIL - src/api/a.ts:1' }, 5)
  expect(reworkPlan(run, new Map(), '/work')).toEqual({ skip: 'upload-assets already ran and is named for work outside the project files ("upload"), so the round does not rerun it unattended' })
})

test('producersOf looks through generated review nodes to the user nodes, and a single producer needs no citation', () => {
  const parsed = parseDefinition({ key: 'sec', nodes: [{ id: 'build', prompt: TASK, writes: ['src'], verify: CHECK }], review: { request: 'Build it', security: ['owasp'] } })
  if (!parsed.ok) throw new Error(parsed.error.message)
  const run = createRun(parsed.value, { runId: 'r', sessionId: 's', now: 0 })
  expect(producersOf(run, 'review-security')).toEqual(['build'])
  expect(producersOf(run, 'review-spec')).toEqual(['build'])
})

test('reworkRun reruns the producers with the note and everything downstream, and records the round', () => {
  const run = settled({ error: 'Spec verdict: FAIL - src/api/a.ts:1' })
  const result = reworkRun(run, ['api'], '[Review fix 1/1] fix it', ['verify-all'], 9)
  if (!result.ok) throw new Error(result.error.message)
  const node = (id: string) => result.value.nodes.find(current => current.id === id)
  expect([node('api')?.state, node('docs')?.state, node('verify-all')?.state]).toEqual(['scheduled', 'completed', 'pending'])
  expect(node('api')?.promptOverride).toBe(`${TASK}\n\n[Review fix 1/1] fix it`)
  expect(node('verify-all')?.error).toBeUndefined()
  expect(result.value.reviewFix).toEqual({ rounds: 1, history: [{ at: 9, reviewers: ['verify-all'], producers: ['api'] }] })
  expect(reworkRun(run, ['verify-all'], 'x', [], 9).ok).toBe(false)
})

test('citedPaths keeps project files and basenames, and drops paths outside the project', () => {
  expect(citedPaths('see /work/lib/x.ts:12, ./a.ts and guard.mjs:49; not /tmp/dag-review/k/review-spec-notes.md', '/work')).toEqual(['lib/x.ts', 'a.ts', 'guard.mjs'])
  expect(findingSections('## Request sentences\n"Edit src/a.ts"\n\n## Findings\n(a) b.ts:2\n\n## Real check\nok')).toBe('## Findings\n(a) b.ts:2')
})
