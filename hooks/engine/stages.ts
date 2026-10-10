import { fail, type CommitEntry, type Definition, type NodeDef, type Result, type ReviewStage, type VerificationCheck } from './types.ts'
import { hash } from './hash.ts'
import { parseChecks, projectPath, readOnlyAbsolutePath } from './verification.ts'

// Built-in stages: a definition declares its review pair in "review" and its commits in "commit", and parseDefinition
// expands them here into ordinary nodes after the user's nodes. Every prompt and check below is a fixed template over the
// definition, so the same input expands to the same nodes and fingerprints, and amend reruns a stage only when its input changed.

export const REVIEW_SPEC_ID = 'review-spec'
export const REVIEW_STANDARDS_ID = 'review-standards'
export const DEFAULT_REVIEW_CATEGORY = 'unspecified-low'
export const REVIEW_STANDARDS_SKILL = 'dag-workflow:review-standards'
const MAX_RULE_FILES = 20
const REVIEW_FIELDS = new Set(['request', 'notes', 'category', 'rules'])

export const COMMIT_ID = 'commit'
export const MAX_COMMITS = 5
export const MAX_COMMIT_PATHS = 50
const COMMIT_FIELDS = new Set(['message', 'paths'])

export const SPEC_PASS = 'Spec verdict: PASS'
export const SPEC_FAIL = 'Spec verdict: FAIL'
export const STANDARDS_PASS = 'Standards verdict: PASS'
export const STANDARDS_FAIL = 'Standards verdict: FAIL'

// Copied from skills/planning/references/planning.md "Safe-but-wrong audit checklist"; keep the two in step.
export const SAFE_BUT_WRONG_AUDIT = [
  'AUDIT FOR SAFE-BUT-WRONG OUTPUT. Answer every item with evidence (command output or a file excerpt with its path), not assertion; write `n/a` plus the reason only when an item cannot apply.',
  '1. Name the requested kind of artifact and the produced kind; they must match (a CLI request is not met by documents alone).',
  '2. Run the deliverable again with an input no producer used and quote the result.',
  '3. Feed it missing data; missing data must show as `unchecked`, `insufficient data` or `blocked`, never as OK, 0 or an empty value.',
  '4. Quote the check that would have failed had the behavior been wrong; a file that exists or a heading that is present does not prove behavior.',
  '5. On any shortfall in 1-4, write `Status: partial/supporting-output` in ## Output naming the missing artifact kind or behavior, then end with `DAG_NODE_STATUS: failed: partial/supporting-output - <what is missing>`.',
  'Write complete only when 1-4 all pass with evidence.',
].join('\n')

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function unknownField(raw: Record<string, unknown>, allowed: Set<string>): string | undefined {
  return Object.keys(raw).find(key => !allowed.has(key))
}

// The default notes folder is one segment per key: anything outside [A-Za-z0-9_.-] becomes "-", so no key can climb out of
// /tmp/dag-review or fail the read-only path rule. Cleaning loses information ("Q3 ledger/missing" and "Q3-ledger-missing" clean
// alike), and runs sharing a folder would read each other's verdicts, so the first six hex digits of a hash of the raw key follow.
// The hash is pure, so the same key always expands to the same folder and the same fingerprints.
export function defaultNotesFolder(key: string): string {
  return `/tmp/dag-review/${key.replace(/[^A-Za-z0-9_.-]+/g, '-')}-${hash(key).slice(0, 6)}`
}

function notesFile(review: ReviewStage, id: string): string {
  return `${review.notes.replace(/[\\/]+$/, '')}/${id}-notes.md`
}

export function parseReview(raw: unknown, key: string): Result<ReviewStage> {
  const where = 'definition.review'
  if (!isRecord(raw)) return fail('invalid_definition', `${where} must be an object with a nonempty "request".`)
  const unknown = unknownField(raw, REVIEW_FIELDS)
  if (unknown !== undefined) return fail('invalid_definition', `unknown field "${unknown}" in ${where}; use request, notes, category or rules.`)
  const { request, notes, category, rules } = raw
  if (typeof request !== 'string' || request.trim() === '') {
    return fail('invalid_definition', `${where}.request must be the user's request text, nonempty.`)
  }
  let folder = defaultNotesFolder(key)
  if (notes !== undefined) {
    const trimmed = typeof notes === 'string' ? notes.trim() : ''
    if (!readOnlyAbsolutePath(trimmed)) {
      return fail('invalid_definition', `${where}.notes must be an absolute folder path with no ".." segment, outside .claude/dag.`)
    }
    // A trailing separator is dropped, so /tmp/x/ and /tmp/x expand alike; a bare root such as / keeps its own.
    const bare = trimmed.replace(/[\\/]+$/, '')
    folder = readOnlyAbsolutePath(bare) ? bare : trimmed
  }
  let reviewCategory = DEFAULT_REVIEW_CATEGORY
  if (category !== undefined) {
    if (typeof category !== 'string' || category.trim() === '') return fail('invalid_definition', `${where}.category must be a nonempty string.`)
    reviewCategory = category.trim()
  }
  const review: ReviewStage = { request: request.trim(), notes: folder, category: reviewCategory }
  if (rules !== undefined) {
    if (!Array.isArray(rules) || rules.length === 0 || rules.length > MAX_RULE_FILES ||
      !rules.every((rule: unknown) => typeof rule === 'string' && rule.trim() !== '')) {
      return fail('invalid_definition', `${where}.rules must list 1-${MAX_RULE_FILES} rule file paths (files to read, not rule text); review-standards reads them in addition to its own search.`)
    }
    review.rules = [...new Set(rules.map(rule => String(rule).trim()))]
  }
  return { ok: true, value: review }
}

// What the review prompts quote from the user's nodes: each node's declared write scopes and its command checks.
function writeScopes(nodes: NodeDef[]): string {
  const lines = nodes.filter(node => node.writes !== undefined).map(node => `- ${node.id}: ${node.writes?.length ? node.writes.join(', ') : '(read-only)'}`)
  return lines.length > 0 ? lines.join('\n') : '- (no node declared write scopes)'
}

function commandChecks(nodes: NodeDef[]): string[] {
  return nodes.flatMap(node => (node.verify ?? []).flatMap(check => (check.kind === 'command'
    ? [`- ${node.id}: argv ${JSON.stringify(check.argv)}${check.expect ? `, expect ${JSON.stringify(check.expect)}` : ', expect exit 0'}`]
    : [])))
}

function changeBlock(nodes: NodeDef[]): string[] {
  return [
    'THE CHANGE: it is uncommitted in the working tree. Run `git rev-parse HEAD`, `git status --porcelain`, `git diff` and `git diff --cached`, and read every untracked (`??`) file in full: untracked files are part of the change.',
    'The upstream results say what each node changed. The nodes declared these write scopes:',
    writeScopes(nodes),
    'A working-tree change outside these scopes that no upstream result claims may predate the run: name it, and judge it only when the request covers it.',
  ]
}

function goalLine(goal: string | undefined): string {
  return `GOAL: ${goal ?? '(the definition sets no goal; judge against the request alone)'}`
}

function scopeLine(review: ReviewStage, otherAxis: string): string {
  return `SCOPE: You are READ-ONLY on the repository: never edit, create, delete, stage, commit, restore or stash anything in it. Write only under ${review.notes}: create the folder with \`mkdir -p\` if it is missing, and overwrite a notes file left by an earlier attempt. ${otherAxis} A missing input ends the node with \`DAG_NODE_STATUS: failed: missing-input: <what>\`, never a question.`
}

function reviewSpecPrompt(definition: Definition, review: ReviewStage, nodes: NodeDef[]): string {
  const notes = notesFile(review, REVIEW_SPEC_ID)
  const checks = commandChecks(nodes)
  return [
    `TASK: Review this run's change on the spec axis - does it do what the request asks, no less and no more - and write the verdict to ${notes}.`,
    goalLine(definition.goal),
    'REQUEST (the user\'s words, verbatim; with the goal it is the spec):',
    '<request>',
    review.request,
    '</request>',
    ...changeBlock(nodes),
    `DELIVERABLE: ${notes}, written once and in full, with these sections in this order:`,
    '## Request sentences - every sentence of the request and the goal, quoted, one per line.',
    '## Findings - three groups, each `none` when empty: (a) missing or partial implementation; (b) unrequested behavior (scope creep); (c) implemented but wrong-looking behavior. Each finding quotes its request sentence and cites its evidence as file:line. For (b) quote the nearest sentence it exceeds, or state that no sentence covers it.',
    '## Real check - rerun every command check the nodes declared, from the project root, and record each command, its exit code and the decisive output. Each must meet its expectation; one that does not is a (c) finding.',
    ...(checks.length > 0 ? checks : ['- (the nodes declared no command checks: write `none declared` and judge (c) from the files)']),
    '## Safe-but-wrong audit - answer every item of this block:',
    SAFE_BUT_WRONG_AUDIT,
    `End the file with exactly one verdict line as its LAST line and write nothing after it: \`${SPEC_PASS}\` only when (a), (b) and (c) are all none, every real check meets its expectation and the audit holds; otherwise \`${SPEC_FAIL}\`. Write the PASS line nowhere else in the file.`,
    scopeLine(review, 'The standards axis (repository rules and code smells) belongs to review-standards and is out of scope here.'),
    `VERIFY: Read ${notes} back: it has the four sections in order and its last line is the verdict line.`,
    `STOP WHEN: the notes file ends with its verdict line. In ## Output give the verdict, the worst finding of each group and every real check's exit code. On FAIL end with \`DAG_NODE_STATUS: failed: ${SPEC_FAIL} - <worst finding>\`.`,
  ].join('\n')
}

function reviewStandardsPrompt(definition: Definition, review: ReviewStage, nodes: NodeDef[]): string {
  const notes = notesFile(review, REVIEW_STANDARDS_ID)
  // The search runs with or without rules: a listed file adds to the repository's own documents and never replaces them.
  const search = 'search for CONTRIBUTING, CLAUDE.md and AGENTS.md (at the root and in every folder the change touches) and similar style or convention documents'
  const sources = review.rules
    ? `RULE SOURCES: read these repository rule files first: ${review.rules.join(', ')}. A listed file that does not exist is recorded under ## Rule sources as missing and does not end the node. They are in addition to the repository's own documented rules, never instead of them: also ${search}. If no other rule document exists, say so.`
    : `RULE SOURCES: find the repository's documented rules: ${search}. If none exist, say so and use only the baseline.`
  return [
    `TASK: Review this run's change on the standards axis - does it follow the repository's documented rules - and write the verdict to ${notes}.`,
    goalLine(definition.goal),
    ...changeBlock(nodes),
    sources,
    `Apply the smell baseline from the ${REVIEW_STANDARDS_SKILL} skill you loaded, and label every smell a judgment call, never a breach. Repository rules override the baseline; skip what a linter or compiler already enforces. If the baseline is not in your context, write "baseline unavailable" and judge only documented rules.`,
    `DELIVERABLE: ${notes}, written once and in full, with these sections in this order, each \`none\` when empty:`,
    '## Rule sources - the files you reviewed against, or `none - baseline only`.',
    '## Rule breaches - each breach of a documented rule, quoting the rule and its source file, with the evidence as file:line.',
    '## Judgment calls - baseline smells, each labelled a judgment call, with file:line.',
    `End the file with exactly one verdict line as its LAST line and write nothing after it: \`${STANDARDS_PASS}\` when Rule breaches is none (judgment calls alone pass); otherwise \`${STANDARDS_FAIL}\`. Write the PASS line nowhere else in the file.`,
    scopeLine(review, 'The spec axis (whether the change does what was requested) belongs to review-spec and is out of scope here.'),
    `VERIFY: Read ${notes} back: it has the three sections in order and its last line is the verdict line.`,
    `STOP WHEN: the notes file ends with its verdict line. In ## Output give the verdict and the worst breach. On FAIL end with \`DAG_NODE_STATUS: failed: ${STANDARDS_FAIL} - <n> documented-rule breaches\`.`,
  ].join('\n')
}

function reviewNode(id: string, label: string, prompt: string, review: ReviewStage, nodes: NodeDef[], verify: VerificationCheck[]): NodeDef {
  return { id, prompt, dependsOn: nodes.map(node => node.id), category: review.category, label, writes: [], verify }
}

function reviewNodes(definition: Definition, review: ReviewStage, nodes: NodeDef[]): NodeDef[] {
  const spec = notesFile(review, REVIEW_SPEC_ID)
  const standards = notesFile(review, REVIEW_STANDARDS_ID)
  return [
    reviewNode(REVIEW_SPEC_ID, 'Review: spec axis', reviewSpecPrompt(definition, review, nodes), review, nodes, [
      { kind: 'file', path: spec, lastLine: SPEC_PASS },
      { kind: 'file', path: spec, contains: '## Findings' },
    ]),
    {
      ...reviewNode(REVIEW_STANDARDS_ID, 'Review: standards axis', reviewStandardsPrompt(definition, review, nodes), review, nodes, [
        { kind: 'file', path: standards, lastLine: STANDARDS_PASS },
        { kind: 'file', path: standards, contains: '## Rule breaches' },
      ]),
      load_skills: [REVIEW_STANDARDS_SKILL],
    },
  ]
}

// git log --format=%s prints a commit's first paragraph joined into one line. The commit node passes the subject as the first -m
// and the body as a second -m, so the first paragraph is exactly this line and the subject check can be decided from the message.
export function commitSubject(message: string): string {
  return (message.split('\n')[0] ?? '').trim()
}

function commitBody(message: string): string {
  return message.split('\n').slice(1).join('\n').trim()
}

export function parseCommit(raw: unknown): Result<CommitEntry[]> {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_COMMITS) {
    return fail('invalid_definition', `definition.commit must list 1-${MAX_COMMITS} commits in commit order, each {message, paths}.`)
  }
  const entries: CommitEntry[] = []
  for (const [index, entry] of raw.entries()) {
    const where = `definition.commit[${index}]`
    if (!isRecord(entry)) return fail('invalid_definition', `${where} must be an object with "message" and "paths".`)
    const unknown = unknownField(entry, COMMIT_FIELDS)
    if (unknown !== undefined) return fail('invalid_definition', `unknown field "${unknown}" in ${where}; use message and paths.`)
    const { message, paths } = entry
    if (typeof message !== 'string' || message.trim() === '') {
      return fail('invalid_definition', `${where}.message must be a nonempty commit message; its first line is the subject.`)
    }
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_COMMIT_PATHS ||
      !paths.every((path: unknown) => typeof path === 'string' && projectPath(path))) {
      return fail('invalid_definition', `${where}.paths must list 1-${MAX_COMMIT_PATHS} project-relative files or folders outside .claude.`)
    }
    entries.push({ message: message.trim(), paths: [...new Set(paths.map(String))] })
  }
  return { ok: true, value: entries }
}

// A path as the shell must read it: left bare when it holds only characters the shell never touches, single-quoted otherwise
// (the shell would expand `[id]` and `*`, split a space and eat a quote). `:` is safe, so `:memo.md` stays bare; `=` and `~` are not (zsh expands them at the start of a word).
function shellWord(path: string): string {
  return /^[A-Za-z0-9_@+:,./-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`
}

function commitList(commits: CommitEntry[]): string[] {
  return commits.flatMap((entry, index) => {
    const body = commitBody(entry.message)
    return [
      `Commit ${index + 1} of ${commits.length}`,
      `  paths: ${entry.paths.map(shellWord).join(' ')}`,
      `  subject: ${commitSubject(entry.message)}`,
      ...(body ? ['  body:', ...body.split('\n').map(line => `    ${line}`.trimEnd())] : ['  body: (none)']),
    ]
  })
}

function commitPrompt(definition: Definition, commits: CommitEntry[], review: ReviewStage | undefined, paths: string[]): string {
  const count = commits.length === 1 ? 'one commit' : `${commits.length} commits`
  const gate = review
    ? `GATE: Read ${notesFile(review, REVIEW_SPEC_ID)} and ${notesFile(review, REVIEW_STANDARDS_ID)} first. Commit NOTHING unless both exist and their last lines are exactly \`${SPEC_PASS}\` and \`${STANDARDS_PASS}\`; otherwise end with \`DAG_NODE_STATUS: failed: review verdict not PASS - <which notes file>\`.`
    : 'GATE: No review stage was declared; the upstream nodes completed with their checks passing.'
  return [
    `TASK: Commit this run's change as ${count} on the current branch, in the order listed, each staging exactly its own paths.`,
    goalLine(definition.goal),
    gate,
    'COMMITS, in this order (paths are project-relative):',
    ...commitList(commits),
    'HOW, for each commit in order: run `git --literal-pathspecs add -- <its paths>`, then `git --literal-pathspecs commit -m <subject> -m <body> -- <its paths>`, leaving out `-m <body>` when the body is (none). The trailing `-- <its paths>` commits only those paths even if something else was staged before the run. `--literal-pathspecs` makes git read every path as a literal file name: without it a path such as `app/[id]/page.ts` is a pattern that also names `app/i/page.ts`, and a leading `:` starts pathspec magic, so a sibling file would be committed with it. Quote each path for the shell too (the lists here already do), since the shell expands `[id]` and `*` before git sees them; the quotes are not part of the file name. Quote each message argument so the shell passes it unchanged; a quoted heredoc such as "$(cat <<\'EOF\' ... EOF)" keeps quotes and $ intact. If a commit\'s paths have nothing to commit, stop and end with `DAG_NODE_STATUS: failed: commit <n> has nothing to commit`; never use --allow-empty and never widen its paths.',
    'SCOPE: NEVER run `git add -A`, `git add .`, `git add -u` or `git commit -a`, and never stage a path that is not listed above. Leave every other working-tree change exactly as it is: never stage, restore, revert, stash, reset or delete it. Do not push, amend, rebase or tag, and edit no file.',
    `DELIVERABLE: ${count} on the current branch, oldest first in the order above.`,
    `VERIFY: \`git log -${commits.length} --format=%s\` prints the subjects above newest first, \`git --literal-pathspecs status --porcelain -- ${paths.map(shellWord).join(' ')}\` prints nothing, and \`git show --format= --name-only <commit>\` lists no file outside that commit's own paths.`,
    'STOP WHEN: the last commit is made and all three VERIFY commands match. In ## Output give each commit\'s hash and subject.',
  ].join('\n')
}

// Commit i of n sits n-1-i commits below HEAD once all n are made, so --skip=<n-1-i> reads its subject back. The same offset
// names it for the sweep check: `git show --format= --name-only <commit> -- :/ :(exclude,literal)<path>...` lists what the commit
// changed outside its own paths, which must be nothing, so a worker that ran `git add -A` and swept an unrelated edit in is caught by name.
// The pathspec is `:/`, the repository root, not `.`: checks run from the project root and `.` covers only that folder, so when the
// project is a subfolder of its repository a file swept in from outside it would pass. The excludes stay relative to the project
// root, where the worker's paths are written (real git 2.54 from the subfolder: `:/` plus an exclude names the outside file, and
// prints nothing when the project root is the repository root).
// Every listed path is literal, in these checks and in the worker's commands: git reads a bare pathspec as a pattern, so a listed
// `app/[id]/page.ts` (a Next.js or SvelteKit route) also names `app/i/page.ts`, which `git add` would stage and `:(exclude)` would
// then excuse, and a leading `:` is magic (`:memo.md` reads as `memo.md`). `:(exclude,literal)` and `:(literal)` keep the check
// as strict as the path (real git 2.54: a bracket path with a one-character sibling, and `:memo.md` beside `memo.md`).
// It reads one commit alone: `git diff HEAD~n HEAD~(n-1)` needs a commit below the first and dies with "bad revision" in a
// repository that holds exactly n commits, while `git show` lists a root commit's files in full. A commit that does not exist
// exits 128, so the check also fails when fewer than n commits were made. n is at most MAX_COMMITS, so a node carries at most
// n subject checks, n sweep checks and one status check: 11, inside the 16-check limit.
function commitRevision(offset: number): string {
  return offset === 0 ? 'HEAD' : `HEAD~${offset}`
}

function commitNode(definition: Definition, commits: CommitEntry[], review: ReviewStage | undefined, user: NodeDef[]): NodeDef {
  const paths = [...new Set(commits.flatMap(entry => entry.paths))]
  return {
    id: COMMIT_ID,
    prompt: commitPrompt(definition, commits, review, paths),
    dependsOn: review ? [REVIEW_SPEC_ID, REVIEW_STANDARDS_ID] : user.map(node => node.id),
    category: 'quick',
    label: 'Commit',
    verify: [
      ...commits.map((entry, index): VerificationCheck => ({
        kind: 'command',
        argv: ['git', 'log', '-1', `--skip=${commits.length - 1 - index}`, '--format=%s'],
        expect: { stdout: { equals: commitSubject(entry.message) } },
      })),
      ...commits.map((entry, index): VerificationCheck => ({
        kind: 'command',
        argv: ['git', 'show', '--format=', '--name-only', commitRevision(commits.length - 1 - index), '--', ':/', ...entry.paths.map(path => `:(exclude,literal)${path}`)],
        expect: { stdout: { equals: '' } },
      })),
      { kind: 'command', argv: ['git', 'status', '--porcelain', '--', ...paths.map(path => `:(literal)${path}`)], expect: { stdout: { equals: '' } } },
    ],
  }
}

// Generated checks go through the same parser as a user's, so they carry exactly the shape a written definition would.
function parsedNodes(generated: NodeDef[]): Result<NodeDef[]> {
  const nodes: NodeDef[] = []
  for (const node of generated) {
    const verify = parseChecks(node.verify)
    if (!verify.ok) return fail('invalid_definition', `The generated node "${node.id}" has an invalid check: ${verify.error.message}`)
    nodes.push({ ...node, verify: verify.value })
  }
  return { ok: true, value: nodes }
}

// Expands review and commit into nodes after the user's nodes. definition.nodes must be the user's nodes, already valid.
export function expandStages(definition: Definition, raw: { review?: unknown; commit?: unknown }): Result<Definition> {
  if (raw.review === undefined && raw.commit === undefined) return { ok: true, value: definition }
  const user = definition.nodes
  const ids = new Set(user.map(node => node.id))
  let review: ReviewStage | undefined
  if (raw.review !== undefined) {
    const taken = [REVIEW_SPEC_ID, REVIEW_STANDARDS_ID].find(id => ids.has(id))
    if (taken) return fail('invalid_definition', `A node is named "${taken}" while definition.review is set; drop the node, since review adds review-spec and review-standards itself.`)
    const parsed = parseReview(raw.review, definition.key)
    if (!parsed.ok) return parsed
    review = parsed.value
  }
  let commit: CommitEntry[] | undefined
  if (raw.commit !== undefined) {
    if (ids.has(COMMIT_ID)) return fail('invalid_definition', `A node is named "${COMMIT_ID}" while definition.commit is set; drop the node, since commit adds it itself.`)
    const parsed = parseCommit(raw.commit)
    if (!parsed.ok) return parsed
    commit = parsed.value
  }
  const generated = parsedNodes([
    ...(review ? reviewNodes(definition, review, user) : []),
    ...(commit ? [commitNode(definition, commit, review, user)] : []),
  ])
  if (!generated.ok) return generated
  return {
    ok: true,
    value: { ...definition, nodes: [...user, ...generated.value], ...(review ? { review } : {}), ...(commit ? { commit } : {}) },
  }
}
