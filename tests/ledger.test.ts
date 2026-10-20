import { expect, test } from 'claude-code/testing'
import { parseDefinition } from '../hooks/engine/definition.ts'
import { fixDiffText, isLedgerReviewer, LEDGER_DIFF_CHARS, ledgerBlock } from '../hooks/engine/ledger.ts'
import { reworkFindings, reworkNote, reworkPlan, type ReworkPlan, type ReworkSkip } from '../hooks/engine/rework.ts'
import { createRun, markFinished, markRunning, reworkRun } from '../hooks/engine/run.ts'
import { lensNodeId } from '../hooks/engine/stages.ts'
import type { Run } from '../hooks/engine/types.ts'

const CHECK = [{ kind: 'command', argv: ['./gradlew', 'test'] }]
const TASK = 'TASK: add GET /posts and DELETE /posts/{id} to PostController. SCOPE: the two endpoints, touch nothing else. STOP WHEN: ./gradlew test passes.'
const CONTROLLER = 'src/main/java/com/example/board/PostController.java'
const SPEC = `## Findings\n${CONTROLLER}:31 GET /posts returns every row; the request asks for the 50 newest posts, newest first.`
const SECURITY = `## Breaches\n${CONTROLLER}:48 DELETE /posts/{id} deletes any post for any signed-in user: no owner-or-admin check before postRepository.deleteById (KISA 2-2).`
const OLD_CLOSING = 'Change your deliverable so the findings that concern your work are resolved, inside your declared scope. Keep everything the original task asked for, change nothing the findings do not name, and rerun your checks. The reviewers run again after you.'
const LEDGER_CLOSING = 'A finding that cites a file in your declared writes concerns your work, also when it asks for more than your original task listed: the reviewers judge the result against the request, not against your task. Resolve each such finding inside your declared scope, keep everything the original task asked for, change nothing the findings do not name, and rerun your checks. If a finding cannot be resolved inside your scope, end failed and name it. The reviewers run again after you.'
const asPlan = (result: ReworkPlan | ReworkSkip | undefined): ReworkPlan | undefined => (result && 'skip' in result ? undefined : result)
const noteBlocks = (note: string) => [...note.matchAll(/<findings reviewer="([^"]+)">\n([\s\S]*?)\n<\/findings>/g)].map(match => ({ reviewer: match[1], text: match[2] }))
const numbered = (count: number, line: string) => Array.from({ length: count }, (_, index) => `${index + 1}. ${CONTROLLER}:${30 + index} ${line}`).join('\n')
// Three failed reviewers over the 4,000-character findings budget: 3,902 + 3,832 + 195 characters.
const LONG_SPEC = `## Findings\n${numbered(30, 'GET /posts is not limited to the 50 newest posts the request asks for.')}`
const LONG_STANDARDS = `## Rule breaches\n${numbered(25, 'anti-slop: pass-through-variable - `List<Post> result = repository.findAll(); return result`.')}`
const OVER_BUDGET = new Map([['review-spec', LONG_SPEC], ['review-standards', LONG_STANDARDS], ['review-security', SECURITY]])

// The secure-coding example's shape: one producer, a review stage with KISA, and review-spec and review-security failing.
function failedReview(): Run {
  const parsed = parseDefinition({
    key: 'board',
    nodes: [{ id: 'endpoints', prompt: TASK, writes: ['src/main/java/com/example/board'], verify: CHECK }],
    review: { request: 'Add GET /posts listing the 50 newest posts and DELETE /posts/{id} to the board API.', security: ['kisa'] },
  })
  if (!parsed.ok) throw new Error(parsed.error.message)
  let run = createRun(parsed.value, { runId: 'r', sessionId: 's', now: 0 })
  run = markFinished(markRunning(run, 'endpoints', 'agent-endpoints', 1), 'endpoints', { state: 'completed', answer: 'done' }, 2)
  for (const id of run.nodes.flatMap(node => node.state === 'scheduled' ? [node.id] : [])) {
    const result = id === 'review-spec' ? { state: 'failed' as const, error: 'Spec verdict: FAIL - 1 findings' } : { state: 'completed' as const, answer: 'done' }
    run = markFinished(markRunning(run, id, `agent-${id}`, 3), id, result, 4)
  }
  return markFinished(markRunning(run, 'review-security', 'agent-security', 5), 'review-security', { state: 'failed', error: 'Security verdict: FAIL - 1 confirmed breaches' }, 6)
}

test('reworkFindings returns the texts reworkNote puts in its findings blocks, each cut to its share', () => {
  const sent = reworkFindings(OVER_BUDGET)
  expect(sent).toEqual(noteBlocks(reworkNote(1, OVER_BUDGET)))
  expect(sent.map(finding => finding.reviewer)).toEqual(['review-spec', 'review-standards', 'review-security'])
  expect(sent[2]?.text).toBe(SECURITY)
  expect([sent[0]?.text.endsWith('\n… (truncated)'), sent[1]?.text.endsWith('\n… (truncated)')]).toEqual([true, true])
})

test('reworkNote without the ledger keeps its output from before the ledger, and with it ends with the scope instruction', () => {
  const findings = new Map([['review-spec', SPEC], ['review-security', SECURITY]])
  const before = [
    "[Review fix 1/1] After this node completed, review-spec and review-security failed the run's result with the findings below.",
    '<findings reviewer="review-spec">', SPEC, '</findings>',
    '<findings reviewer="review-security">', SECURITY, '</findings>',
    OLD_CLOSING,
  ].join('\n')
  expect(reworkNote(1, findings)).toBe(before)
  expect(reworkNote(1, findings, false)).toBe(before)
  const ledger = reworkNote(1, findings, true).split('\n')
  expect(ledger.at(-1)).toBe(LEDGER_CLOSING)
  expect(ledger.slice(0, -1)).toEqual(before.split('\n').slice(0, -1))
})

// The fair-share cut (findingShares) predates the ledger: rework.ts had it from the 2026-10-19 rehearsals, so the note
// without the ledger must cut exactly as then. Worked shares: review-security's 195 characters stay whole, review-standards
// gets floor((4000 - 195) / 2) = 1902 and review-spec the 1903 left. The rework.ts of before the ledger printed this same note.
test('reworkNote without the ledger cuts over-budget findings to the same shares as before the ledger', () => {
  expect([LONG_SPEC.length, LONG_STANDARDS.length, SECURITY.length]).toEqual([3_902, 3_832, 195])
  expect(reworkNote(1, OVER_BUDGET, false)).toBe([
    "[Review fix 1/1] After this node completed, review-spec and review-standards and review-security failed the run's result with the findings below.",
    '<findings reviewer="review-spec">', LONG_SPEC.slice(0, 1_903), '… (truncated)', '</findings>',
    '<findings reviewer="review-standards">', LONG_STANDARDS.slice(0, 1_902), '… (truncated)', '</findings>',
    '<findings reviewer="review-security">', SECURITY, '</findings>',
    OLD_CLOSING,
  ].join('\n'))
})

test('reworkPlan carries the findings it sends and passes the ledger switch to its note', () => {
  const findings = new Map([['review-spec', SPEC], ['review-security', SECURITY]])
  const sent = [{ reviewer: 'review-spec', text: SPEC }, { reviewer: 'review-security', text: SECURITY }]
  const ledger = asPlan(reworkPlan(failedReview(), findings, '/work', true))
  expect(ledger).toMatchObject({ reviewers: ['review-spec', 'review-security'], producers: ['endpoints'], findings: sent })
  expect(ledger?.note.split('\n').at(-1)).toBe(LEDGER_CLOSING)
  const plain = asPlan(reworkPlan(failedReview(), findings, '/work'))
  expect(plain?.findings).toEqual(sent)
  expect(plain?.note.split('\n').at(-1)).toBe(OLD_CLOSING)
})

test('reworkRun records the findings the round sent on its history entry, and leaves the field out when none are given', () => {
  const run = failedReview()
  const sent = [{ reviewer: 'review-spec', text: SPEC }, { reviewer: 'review-security', text: SECURITY }]
  const recorded = reworkRun(run, ['endpoints'], 'note', ['review-spec', 'review-security'], 9, sent)
  if (!recorded.ok) throw new Error(recorded.error.message)
  expect(recorded.value.reviewFix?.history).toEqual([{ at: 9, reviewers: ['review-spec', 'review-security'], producers: ['endpoints'], findings: sent }])
  const bare = reworkRun(run, ['endpoints'], 'note', ['review-spec', 'review-security'], 9)
  if (!bare.ok) throw new Error(bare.error.message)
  expect(Object.keys(bare.value.reviewFix?.history[0] ?? {})).toEqual(['at', 'reviewers', 'producers'])
})

const FIX_DIFF = [
  `diff --git a/${CONTROLLER} b/${CONTROLLER}`,
  '--- a/src/main/java/com/example/board/PostController.java',
  '+++ b/src/main/java/com/example/board/PostController.java',
  '@@ -46,6 +46,9 @@ public class PostController {',
  '     @DeleteMapping("/posts/{id}")',
  '     public ResponseEntity<Void> delete(@PathVariable long id, Principal principal) {',
  '+        if (!postService.isOwnerOrAdmin(id, principal.getName())) {',
  '+            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();',
  '+        }',
  '         if (!postRepository.existsById(id)) {',
  '             return ResponseEntity.notFound().build();',
].join('\n')

test('ledgerBlock gives each reviewer block in order, the diff and the rules for the reviewer it is written for', () => {
  const block = ledgerBlock({
    reviewerId: 'review-spec',
    producers: ['endpoints', 'endpoint-tests'],
    findings: [{ reviewer: 'review-spec', text: SPEC }, { reviewer: 'review-security', text: SECURITY }],
    fixDiff: FIX_DIFF,
  })
  expect(block).toBe([
    "REVIEW FIX LEDGER. This is a re-review: after the first review, the review-fix round sent the findings below to endpoints, endpoint-tests, and they changed their work. Each block holds one reviewer's findings as they were sent.",
    '<ledger reviewer="review-spec">', SPEC, '</ledger>',
    '<ledger reviewer="review-security">', SECURITY, '</ledger>',
    'What changed since then, as git diff output with the state before the fix on the a/ side:',
    '<fix-diff>', FIX_DIFF, '</fix-diff>',
    'Rules for this re-review, on top of your task:',
    '1. Above your verdict line, write a `## Ledger` section with one line per finding in your own block (reviewer="review-spec"): RESOLVED (the fix removed it), OPEN (it is still there) or WITHDRAWN (you now judge it was never a breach of the request or the rules), each with file:line evidence; a WITHDRAWN line also names what shows the finding was wrong. Write `none` under it when you have no block.',
    '2. A change the fix made to resolve a ledger finding, from any reviewer, is requested work: never report it as unrequested behavior or scope creep. If it conflicts with a request sentence (for example an authorization check that answers before a requested not-found result), report the conflict under `## Deferred` for the person to decide; it does not fail your verdict.',
    '3. A finding that is not in the ledger fails your verdict only when it cites a line the fix added or changed in the diff above. Report every other new finding under `## Deferred`; it does not fail your verdict.',
    '4. Fail your verdict only for an OPEN finding of your own or a new finding that rule 3 lets fail it. An OPEN finding fails the verdict however minor it is: withdraw it with evidence, or keep it open and fail.',
  ].join('\n'))
})

test('ledgerBlock says when the fix diff could not be recorded and when the fix changed nothing', () => {
  const diffBody = (fixDiff: string | undefined) => ledgerBlock({ reviewerId: 'review-standards', producers: ['endpoints'], findings: [], fixDiff }).match(/<fix-diff>\n([\s\S]*?)\n<\/fix-diff>/)?.[1]
  expect(diffBody(undefined)).toBe("(the change could not be recorded; treat every line of the producers' declared files as changed)")
  expect(diffBody('')).toBe('(no change)')
  expect(ledgerBlock({ reviewerId: 'review-standards', producers: ['endpoints'], findings: [], fixDiff: '' })).toContain('(reviewer="review-standards")')
})

test('fixDiffText strips the before-state folder from the headers and joins the files', () => {
  const before = '.claude/dag/runs/dag_r/fix-before'
  const repository = 'src/main/java/com/example/board/PostRepository.java'
  const controller = FIX_DIFF.replace(`a/${CONTROLLER} b/`, `a/${before}/${CONTROLLER} b/`).replace(`--- a/${CONTROLLER}`, `--- a/${before}/${CONTROLLER}`)
  const repo = [`diff --git a/${before}/${repository} b/${repository}`, `--- a/${before}/${repository}`, `+++ b/${repository}`, '@@ -9,4 +9,6 @@', '+    List<Post> findTop50ByOrderByCreatedAtDesc();'].join('\n')
  const text = fixDiffText([`${controller}\n`, '', `${repo}\n`], before)
  expect(text).toBe([
    FIX_DIFF,
    `diff --git a/${repository} b/${repository}`, `--- a/${repository}`, `+++ b/${repository}`, '@@ -9,4 +9,6 @@', '+    List<Post> findTop50ByOrderByCreatedAtDesc();',
  ].join('\n'))
  expect(text).not.toContain(before)
  expect(text.split('\n').filter(line => line.startsWith('diff --git '))).toEqual([
    `diff --git a/${CONTROLLER} b/${CONTROLLER}`,
    `diff --git a/${repository} b/${repository}`,
  ])
  expect(fixDiffText([], before)).toBe('')
  expect(fixDiffText(['', ''], before)).toBe('')
})

test('fixDiffText cuts a long diff to its budget and says how long the whole diff was', () => {
  expect(LEDGER_DIFF_CHARS).toBe(12_000)
  expect(fixDiffText(['+'.repeat(12_000)], 'before')).toBe('+'.repeat(12_000))
  expect(fixDiffText(['+'.repeat(7_000), '-'.repeat(7_000)], 'before').split('\n')).toEqual([
    '+'.repeat(7_000),
    '-'.repeat(4_999),
    '… (truncated: 14001 characters in all)',
  ])
})

test('isLedgerReviewer holds for review-spec and review-standards only', () => {
  expect(['review-spec', 'review-standards'].map(isLedgerReviewer)).toEqual([true, true])
  expect(['review-security', lensNodeId('access'), 'security-verify-access-1', 'verify-all'].map(isLedgerReviewer)).toEqual([false, false, false, false])
})
