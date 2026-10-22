import { expect, test, type Engine, type Plugin } from 'claude-code/testing'
import { defaultNotesFolder } from '../hooks/engine/stages.ts'
import { boot, checkpoint, finish, harness, ROOT, start } from './control-harness.ts'

// The review ledger (review_ledger) in a run: the review-fix round copies the producers' files before the fix, keeps the
// findings it sent, and the rerun review-spec and review-standards get both with the fix's diff.

const REQUEST = 'Add a greet function and document it in the README'
const BEFORE_FIX = '# app\n\nCall greet(name) to say hello.\n'
const AFTER_FIX = '# app\n\nCall greet(name); it returns the greeting string.\n'
const FINDING = '(a) README.md:3 documents greet(name) but never says what it returns'
const LS_README = '-c core.quotePath=false ls-files -z -c -o --exclude-standard -- :(literal)README.md'
const LS_DOCS = '-c core.quotePath=false ls-files -z -c -o --exclude-standard -- :(literal)docs'
const LEDGER_CLOSING = 'A finding that cites a file in your declared writes concerns your work, also when it asks for more than your original task listed: the reviewers judge the result against the request, not against your task. Resolve each such finding inside your declared scope, keep everything the original task asked for, change nothing the findings do not name, and rerun your checks. If a finding cannot be resolved inside your scope, end failed and name it. The reviewers run again after you.'
const CLOSING = 'Change your deliverable so the findings that concern your work are resolved, inside your declared scope. Keep everything the original task asked for, change nothing the findings do not name, and rerun your checks. The reviewers run again after you.'
const LAST_RULE = '4. Fail your verdict only for an OPEN finding of your own or a new finding that rule 3 lets fail it. An OPEN finding fails the verdict however minor it is: withdraw it with evidence, or keep it open and fail.'

// The harness answers every git call it knows with exit 0; git diff --no-index exits 1 when it prints a difference.
const NO_INDEX_EXIT: Plugin = {
  name: 'ledger-no-index-exit',
  register(on) {
    on('process.run', async ($, e, next) => {
      if (e.argv[0] !== 'git' || e.argv[2] !== '--no-index') return next(e)
      const done = await next(e)
      const stdout = done.value?.stdout ?? ''
      return { value: { exitCode: stdout === '' ? done.value?.exitCode ?? 128 : 1, stdout, stderr: done.value?.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
  },
}

function greetFlow(key: string, docsWrites: string[]) {
  return {
    key,
    name: 'Greet',
    goal: 'A greet function exists in src/greet.ts and the README documents it',
    nodes: [
      { id: 'code', prompt: 'TASK: Write src/greet.ts exporting greet. STOP WHEN: done.', writes: ['src/greet.ts'], verify: [{ kind: 'file', path: 'src/greet.ts', contains: 'export function greet' }] },
      { id: 'docs', prompt: 'TASK: Document greet in the README. STOP WHEN: done.', writes: docsWrites, verify: [{ kind: 'file', path: 'README.md', contains: 'greet(' }] },
    ],
    review: { request: REQUEST },
  }
}

const specNotes = (verdict: string, finding: string) =>
  `## Request sentences\n"${REQUEST}"\n\n## Findings\n${finding}\n\n## Real check\n- file checks: both met\n\n## Safe-but-wrong audit\n1. a function and a README section, as requested\n\n${verdict}\n`
const standardsNotes = (verdict: string) =>
  `## Rule sources\nnone - baseline only\n\n## Rule breaches\nnone\n\n## Judgment calls\nnone\n\n${verdict}\n`

// The prompt a node's last spawn got.
function promptOf(h: ReturnType<typeof harness>, id: string): string {
  return h.spawns.filter(spawn => spawn.prompt.startsWith(`You are executing node "${id}"`)).at(-1)?.prompt ?? ''
}

// code and docs complete, review-standards passes and review-spec fails, so the round reruns docs (agent-5).
async function failSpecReview($: Engine, h: ReturnType<typeof harness>, key: string, docsWrites = ['README.md'], root = '/work'): Promise<string> {
  const notes = defaultNotesFolder(key)
  await boot($)
  const runId = await start($, greetFlow(key, docsWrites))
  h.files.set(`${root}/src/greet.ts`, 'export function greet(name: string) {\n  return `hello ${name}`\n}\n')
  h.files.set(`${root}/README.md`, BEFORE_FIX)
  await finish($, h, 'agent-1')
  await finish($, h, 'agent-2')
  h.files.set(`${notes}/review-standards-notes.md`, standardsNotes('Standards verdict: PASS'))
  await finish($, h, 'agent-4')
  h.files.set(`${notes}/review-spec-notes.md`, specNotes('Spec verdict: FAIL', `${FINDING}\n(b) none\n(c) none`))
  await finish($, h, 'agent-3')
  return runId
}

// docs makes its fix and the reviewers start again.
async function fixDocs($: Engine, h: ReturnType<typeof harness>, root = '/work'): Promise<void> {
  h.files.set(`${root}/README.md`, AFTER_FIX)
  await finish($, h, 'agent-5')
}

test('a run started in a worktree copies and diffs the worktree\'s files, while the copy stays in the session\'s run store', { plugins: [NO_INDEX_EXIT] }, async ($, on) => {
  const h = harness(on)
  const worktree = '/work/.claude/worktrees/x'
  h.control.root = worktree
  h.control.git.set(LS_README, 'README.md\0')
  const runId = await failSpecReview($, h, 'greet-worktree-ledger', ['README.md'], worktree)
  // The copy lives in the store; git runs in the worktree, so the before side is named by its absolute path.
  const before = `/work/.claude/dag/runs/${runId}/review-fix-1/before`
  expect(h.files.get(`${before}/README.md`)).toBe(BEFORE_FIX)
  expect(h.processes.filter(run => run.argv.includes('ls-files')).map(run => run.init?.cwd)).toEqual([worktree])
  h.control.git.set(`diff --no-index --no-color -- ${before}/README.md README.md`, [
    `diff --git a${before}/README.md b/README.md`,
    `--- a${before}/README.md`,
    '+++ b/README.md',
    '@@ -3 +3 @@',
    '-Call greet(name) to say hello.',
    '+Call greet(name); it returns the greeting string.',
    '',
  ].join('\n'))
  await fixDocs($, h, worktree)
  expect(promptOf(h, 'review-spec')).toContain('<fix-diff>\ndiff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -3 +3 @@\n-Call greet(name) to say hello.\n+Call greet(name); it returns the greeting string.\n</fix-diff>')
})

test('with the ledger on by default, the round copies the producer\'s files before the fix, records the findings it sent, and both rerun reviewers get the findings and the fix\'s diff in their task', { plugins: [NO_INDEX_EXIT] }, async ($, on) => {
  const h = harness(on)
  h.control.git.set(LS_README, 'README.md\0')
  const runId = await failSpecReview($, h, 'greet-ledger')
  const before = `.claude/dag/runs/${runId}/review-fix-1/before`
  h.control.git.set(`diff --no-index --no-color -- ${before}/README.md README.md`, [
    `diff --git a/${before}/README.md b/README.md`,
    `--- a/${before}/README.md`,
    '+++ b/README.md',
    '@@ -3 +3 @@',
    '-Call greet(name) to say hello.',
    '+Call greet(name); it returns the greeting string.',
    '',
  ].join('\n'))
  expect(promptOf(h, 'docs')).toContain(`${LEDGER_CLOSING}\n</task>`)
  expect(h.files.get(`${ROOT}/runs/${runId}/review-fix-1/before/README.md`)).toBe(BEFORE_FIX)
  expect(JSON.parse(h.files.get(`${ROOT}/runs/${runId}/review-fix-1/before.json`) ?? 'null')).toEqual({ scopes: ['README.md'], files: ['README.md'] })
  expect(checkpoint(h, runId).reviewFix?.history[0]?.findings).toEqual([{ reviewer: 'review-spec', text: expect.stringContaining(FINDING) }])
  // The first review had no round behind it.
  expect(h.spawns[2]?.prompt).not.toContain('REVIEW FIX LEDGER')

  await fixDocs($, h)
  for (const reviewer of ['review-spec', 'review-standards']) {
    const prompt = promptOf(h, reviewer)
    expect(prompt).toContain('REVIEW FIX LEDGER')
    expect(prompt).toContain(`<ledger reviewer="review-spec">`)
    expect(prompt).toContain(FINDING)
    expect(prompt).toContain('<fix-diff>\ndiff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -3 +3 @@\n-Call greet(name) to say hello.\n+Call greet(name); it returns the greeting string.\n</fix-diff>')
    expect(prompt).toContain(`in your own block (reviewer="${reviewer}")`)
    expect(prompt).toContain(`${LAST_RULE}\n</task>`)
  }
})

test('with review_ledger off, the producer gets the closing line from before the ledger, nothing is copied, and the rerun reviewers keep their original prompts', { options: { review_ledger: false }, plugins: [NO_INDEX_EXIT] }, async ($, on) => {
  const h = harness(on)
  h.control.git.set(LS_README, 'README.md\0')
  const runId = await failSpecReview($, h, 'greet-no-ledger')
  expect(promptOf(h, 'docs')).toContain(`${CLOSING}\n</task>`)
  expect(checkpoint(h, runId).reviewFix?.history[0]).not.toHaveProperty('findings')

  await fixDocs($, h)
  expect([...h.files.keys()].filter(path => path.startsWith(`${ROOT}/runs/${runId}/review-fix-1`))).toEqual([])
  for (const reviewer of ['review-spec', 'review-standards']) {
    expect(h.spawns.filter(spawn => spawn.prompt.startsWith(`You are executing node "${reviewer}"`))).toHaveLength(2)
    expect(promptOf(h, reviewer)).not.toContain('REVIEW FIX LEDGER')
  }
})

test('when the files before the fix could not be copied, the round still runs and the rerun reviewers read that the change could not be recorded', { plugins: [NO_INDEX_EXIT] }, async ($, on) => {
  const h = harness(on)
  // No answer for ls-files: git exits 128, so no before.json is written.
  const runId = await failSpecReview($, h, 'greet-ledger-unrecorded')
  expect(h.files.has(`${ROOT}/runs/${runId}/review-fix-1/before.json`)).toBe(false)

  await fixDocs($, h)
  const prompt = promptOf(h, 'review-spec')
  expect(prompt).toContain(FINDING)
  expect(prompt).toContain("<fix-diff>\n(the change could not be recorded; treat every line of the producers' declared files as changed)\n</fix-diff>")
})

test('a tracked file the producer already deleted is left out of the copy, and the rerun reviewers still get the fix\'s diff', { plugins: [NO_INDEX_EXIT] }, async ($, on) => {
  const h = harness(on)
  h.control.git.set(LS_README, 'README.md\0')
  // ls-files -c still lists docs/gone.md, which the producer's first run removed without git rm.
  h.control.git.set(LS_DOCS, 'docs/gone.md\0')
  const runId = await failSpecReview($, h, 'greet-ledger-gone', ['README.md', 'docs'])
  expect(JSON.parse(h.files.get(`${ROOT}/runs/${runId}/review-fix-1/before.json`) ?? 'null')).toEqual({ scopes: ['README.md', 'docs'], files: ['README.md'] })
  const before = `.claude/dag/runs/${runId}/review-fix-1/before`
  h.control.git.set(`diff --no-index --no-color -- ${before}/README.md README.md`, `diff --git a/${before}/README.md b/README.md\n--- a/${before}/README.md\n+++ b/README.md\n@@ -3 +3 @@\n-Call greet(name) to say hello.\n+Call greet(name); it returns the greeting string.\n`)
  // Missing on both sides: real git prints nothing and exits 0.
  h.control.git.set('diff --no-index --no-color -- /dev/null /dev/null', '')

  await fixDocs($, h)
  expect(promptOf(h, 'review-spec')).toContain('<fix-diff>\ndiff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -3 +3 @@\n-Call greet(name) to say hello.\n+Call greet(name); it returns the greeting string.\n</fix-diff>')
})

test('a file the fix deletes or adds reaches the rerun reviewers\' diff with /dev/null on the side it is missing from, and a file git cannot diff is left out', { plugins: [NO_INDEX_EXIT] }, async ($, on) => {
  const h = harness(on)
  h.control.git.set(LS_README, 'README.md\0')
  h.control.git.set(LS_DOCS, 'docs/old.md\0')
  h.files.set('/work/docs/old.md', 'old page\n')
  const runId = await failSpecReview($, h, 'greet-ledger-files', ['README.md', 'docs'])
  const before = `.claude/dag/runs/${runId}/review-fix-1/before`
  expect(h.files.get(`/work/${before}/docs/old.md`)).toBe('old page\n')
  // The fix moves the page. ls-files -c still lists the tracked docs/old.md it removed without git rm, and git knows no diff
  // of README.md, so that call exits 128.
  h.files.delete('/work/docs/old.md')
  h.files.set('/work/docs/greet.md', 'greet page\n')
  h.control.git.set(LS_DOCS, 'docs/old.md\0docs/greet.md\0')
  h.control.git.set(`diff --no-index --no-color -- ${before}/docs/old.md /dev/null`, `diff --git a/${before}/docs/old.md b/${before}/docs/old.md\ndeleted file mode 100644\n--- a/${before}/docs/old.md\n+++ /dev/null\n@@ -1 +0,0 @@\n-old page\n`)
  h.control.git.set('diff --no-index --no-color -- /dev/null docs/greet.md', 'diff --git a/docs/greet.md b/docs/greet.md\nnew file mode 100644\n--- /dev/null\n+++ b/docs/greet.md\n@@ -0,0 +1 @@\n+greet page\n')

  await fixDocs($, h)
  expect(promptOf(h, 'review-spec')).toContain([
    '<fix-diff>',
    'diff --git a/docs/old.md b/docs/old.md', 'deleted file mode 100644', '--- a/docs/old.md', '+++ /dev/null', '@@ -1 +0,0 @@', '-old page',
    'diff --git a/docs/greet.md b/docs/greet.md', 'new file mode 100644', '--- /dev/null', '+++ b/docs/greet.md', '@@ -0,0 +1 @@', '+greet page',
    '</fix-diff>',
  ].join('\n'))
  expect(h.logs.some(log => log.includes('git diff of README.md exited 128'))).toBe(true)
})

// A plugin's register closes over nothing of this file: the unreadable path is written into it.
const UNREADABLE_BINARY: Plugin = {
  name: 'ledger-unreadable-binary',
  register(on) {
    on('fs.read', ($, e, next) => {
      if (e.path === '/work/docs/blob.bin') return { deny: 'EINVAL: file is binary or over the read limit' }
      return next(e)
    })
  },
}

test('a file the host cannot read is left out of the copy alone, and the rerun reviewers still get the fix\'s diff', { plugins: [NO_INDEX_EXIT, UNREADABLE_BINARY] }, async ($, on) => {
  const h = harness(on)
  h.control.git.set(LS_README, 'README.md\0')
  h.control.git.set(LS_DOCS, 'docs/blob.bin\0')
  h.files.set('/work/docs/blob.bin', 'binary')
  const runId = await failSpecReview($, h, 'greet-ledger-unreadable', ['README.md', 'docs'])
  const folder = `${ROOT}/runs/${runId}/review-fix-1`
  expect(JSON.parse(h.files.get(`${folder}/before.json`) ?? 'null')).toEqual({ scopes: ['README.md', 'docs'], files: ['README.md'] })
  expect(h.files.get(`${folder}/before/README.md`)).toBe(BEFORE_FIX)
  expect(h.files.has(`${folder}/before/docs/blob.bin`)).toBe(false)
  expect(h.logs.some(log => log.includes('docs/blob.bin') && log.includes('EINVAL'))).toBe(true)
  const before = `.claude/dag/runs/${runId}/review-fix-1/before`
  h.control.git.set(`diff --no-index --no-color -- ${before}/README.md README.md`, `diff --git a/${before}/README.md b/README.md\n--- a/${before}/README.md\n+++ b/README.md\n@@ -3 +3 @@\n-Call greet(name) to say hello.\n+Call greet(name); it returns the greeting string.\n`)

  await fixDocs($, h)
  const prompt = promptOf(h, 'review-spec')
  expect(prompt).toContain('<fix-diff>\ndiff --git a/README.md b/README.md')
  expect(prompt).not.toContain('the change could not be recorded')
})
