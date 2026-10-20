import { REVIEW_SPEC_ID, REVIEW_STANDARDS_ID } from './stages.ts'
import type { ReviewFinding } from './types.ts'

// The review ledger (option review_ledger): what the rerun reviewers of a review-fix round are told about the first review.
// In five headless runs of examples/secure-coding on 2026-10-19/20, review-spec failed again after the round in 5 of 5. The
// rerun reviewers started from their original prompts without the first findings, so review-spec reported the controls the
// producer added for review-security (an owner-or-admin 403 on delete, LIMIT 50, input validation) as unrequested in some
// attempts and accepted them in others, and raised new findings on code the fix never touched. The ledger hands review-spec
// and review-standards the findings the round sent and the fix's diff, with fixed rules for what may fail the re-review.

// The fix's diff in a ledger keeps this much; a longer one keeps its head and says how long it was.
export const LEDGER_DIFF_CHARS = 12_000

export function isLedgerReviewer(id: string): boolean {
  return id === REVIEW_SPEC_ID || id === REVIEW_STANDARDS_ID
}

// The per-file `git diff --no-index <before> <file>` outputs as one diff whose headers name the project files on both sides:
// git writes the before-state copy's path after a/, and the reviewer needs `a/src/A.java`, not the copy's folder. A file the
// fix left unchanged has empty output and adds nothing, so a fix that changed nothing gives ''.
export function fixDiffText(parts: readonly string[], beforePrefix: string): string {
  const text = parts.flatMap(part => {
    const diff = part.replace(/\n+$/, '')
    return diff === '' ? [] : [diff]
  }).join('\n').replaceAll(`${beforePrefix}/`, '')
  if (text.length <= LEDGER_DIFF_CHARS) return text
  return `${text.slice(0, LEDGER_DIFF_CHARS).trimEnd()}\n… (truncated: ${text.length} characters in all)`
}

function diffBody(fixDiff: string | undefined): string {
  if (fixDiff === undefined) return "(the change could not be recorded; treat every line of the producers' declared files as changed)"
  return fixDiff === '' ? '(no change)' : fixDiff
}

// The section a rerun reviewer's prompt gains: every reviewer's findings as the round sent them, so a control added for
// review-security is known as requested work, and the diff, so a new finding can be told apart from old code.
// WITHDRAWN exists because with RESOLVED and OPEN alone, in two of three runs on 2026-10-20 review-spec marked its earlier MD5
// ETag note OPEN and passed anyway: the note was never a breach, and OPEN was the only word left for it.
export function ledgerBlock(input: { reviewerId: string; producers: readonly string[]; findings: readonly ReviewFinding[]; fixDiff: string | undefined }): string {
  return [
    `REVIEW FIX LEDGER. This is a re-review: after the first review, the review-fix round sent the findings below to ${input.producers.join(', ')}, and they changed their work. Each block holds one reviewer's findings as they were sent.`,
    ...input.findings.flatMap(({ reviewer, text }) => [`<ledger reviewer="${reviewer}">`, text, '</ledger>']),
    'What changed since then, as git diff output with the state before the fix on the a/ side:',
    '<fix-diff>',
    diffBody(input.fixDiff),
    '</fix-diff>',
    'Rules for this re-review, on top of your task:',
    `1. Above your verdict line, write a \`## Ledger\` section with one line per finding in your own block (reviewer="${input.reviewerId}"): RESOLVED (the fix removed it), OPEN (it is still there) or WITHDRAWN (you now judge it was never a breach of the request or the rules), each with file:line evidence; a WITHDRAWN line also names what shows the finding was wrong. Write \`none\` under it when you have no block.`,
    '2. A change the fix made to resolve a ledger finding, from any reviewer, is requested work: never report it as unrequested behavior or scope creep. If it conflicts with a request sentence (for example an authorization check that answers before a requested not-found result), report the conflict under `## Deferred` for the person to decide; it does not fail your verdict.',
    '3. A finding that is not in the ledger fails your verdict only when it cites a line the fix added or changed in the diff above. Report every other new finding under `## Deferred`; it does not fail your verdict.',
    '4. Fail your verdict only for an OPEN finding of your own or a new finding that rule 3 lets fail it. An OPEN finding fails the verdict however minor it is: withdraw it with evidence, or keep it open and fail.',
  ].join('\n')
}
