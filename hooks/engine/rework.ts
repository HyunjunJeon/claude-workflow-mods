import { isVerificationNode, normalizePath } from './lint.ts'
import { verdictFailure } from './recovery.ts'
import { isSettled } from './run.ts'
import { downstream } from './graph.ts'
import { COMMIT_ID, isReviewStageNode } from './stages.ts'
import type { NodeDef, Run } from './types.ts'

// One automatic review-fix round per run. A FAIL verdict names what is wrong, and only the producer can change it, so instead
// of reviewing the same work again (recovery.ts verdictFailure) the plugin reruns the producers the findings point at, with
// the findings in their prompt, and then the reviewers. In four real runs on 2026-10-12 the main conversation took 48-81 s
// per FAIL to resend a 13-15 KB definition as an amend. One of the four runs needed a second round. That round goes to the
// main conversation, together with what the reviewers still found, so a fix that did not take is not repeated blindly.
export const MAX_REVIEW_FIX_ROUNDS = 1
export const REWORK_FINDINGS_CHARS = 4_000

export type ReworkPlan = { reviewers: string[]; producers: string[]; note: string }
// Why a run that failed only on FAIL verdicts got no round: the main conversation reviews the findings and, for work
// outside the project, asks the person how to fix it.
export type ReworkSkip = { skip: string }

// Words in a node's id, label or summary that name work outside the project's files, or on its history: a rerun would push,
// deploy, upload, migrate, delete or commit again. Matched per word, so "deploy-preview" and "commitPush" count and
// "product" does not; a false match only hands the FAIL to the main conversation, as before the round existed.
const EXTERNAL_PREFIXES = ['push', 'deploy', 'publish', 'releas', 'upload', 'migrat', 'delet', 'truncat', 'provision', 'rotat', 'revok', 'commit', 'rebase', 'revert', 'stash', 'notif', 'email']
const EXTERNAL_WORDS = new Set(['prod', 'production', 'apply', 'drop', 'seed', 'send', 'reset', 'merge', 'tag', 'sms'])

function externalWord(def: NodeDef): string | undefined {
  const words = [def.id, def.label, def.task_summary].flatMap(text => (text ?? '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/))
  return words.find(word => word !== '' && (EXTERNAL_WORDS.has(word) || EXTERNAL_PREFIXES.some(prefix => word.startsWith(prefix))))
}

// Why a node that already completed must not run again unattended, or undefined when a rerun only rewrites project files
// (a producer with declared writes) or judges them (a verifier). In real runs every node that changed something outside the
// project (apply-env, switch-role, setup-assets, delete-token-row, commit-push) left writes undeclared.
export function rerunRisk(def: NodeDef): string | undefined {
  if (def.external) return 'declares external: true'
  const word = externalWord(def)
  if (word) return `is named for work outside the project files ("${word}")`
  if (!isVerificationNode(def) && !def.writes?.length) return 'declares no writes, so what a rerun would change is unknown'
  return undefined
}

// Records why this settle got no review-fix round; the settle message shows it while the run stays failed.
export function withReworkSkip(run: Run, reason: string, now: number): Run {
  return { ...run, reviewFix: { rounds: run.reviewFix?.rounds ?? 0, history: run.reviewFix?.history ?? [], skipped: { at: now, reason } } }
}

function defOf(run: Run, id: string): NodeDef | undefined {
  return run.definition.nodes.find(def => def.id === id)
}

// The nodes whose work a reviewer judged: its dependencies, looking through generated stage nodes (security lenses) and
// other verifiers to the producers behind them.
export function producersOf(run: Run, reviewerId: string): string[] {
  const found = new Set<string>()
  const seen = new Set<string>()
  const stack = [...(defOf(run, reviewerId)?.dependsOn ?? [])]
  while (stack.length > 0) {
    const id = stack.pop() as string
    if (seen.has(id)) continue
    seen.add(id)
    const def = defOf(run, id)
    if (!def) continue
    const generated = id === COMMIT_ID || (run.definition.review !== undefined && isReviewStageNode(run.definition.review, id))
    if (generated || isVerificationNode(def)) stack.push(...def.dependsOn)
    else found.add(id)
  }
  return [...found]
}

// File paths a finding cites, as project-relative paths when they sit under the project root: `src/db.js:6`, `./a.ts`,
// `/work/proj/lib/x.ts:12`. A bare basename (`guard.mjs:49`) is kept as it is and matched by basename.
export function citedPaths(text: string, projectRoot: string): string[] {
  const root = projectRoot.replace(/[\\/]+$/, '')
  const paths = [...text.matchAll(/(?:^|[\s`'"(\[,])((?:[A-Za-z]:)?[\w@.+~/\\-]*[\w@+-]\.[A-Za-z][\w]{0,7})(?::\d+)?/g)].map(match => match[1] ?? '')
  return [...new Set(paths.flatMap(raw => {
    const path = raw.replaceAll('\\', '/')
    if (root && path.startsWith(`${root}/`)) return [normalizePath(path.slice(root.length + 1))]
    if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return []
    return [normalizePath(path)]
  }))]
}

// The sections of a reviewer's notes that say what is wrong. Request sentences and real-check lines also name files, and
// those files are not findings, so they would send the wrong producer back. Notes without these headings are kept whole.
export function findingSections(notes: string): string {
  const sections = [...notes.matchAll(/^##\s+(?:Findings|Rule breaches|Breaches)\b[^\n]*\n[\s\S]*?(?=^##\s|(?![\s\S]))/gm)].map(match => match[0].trim())
  return sections.length > 0 ? sections.join('\n\n') : notes
}

function owns(writes: readonly string[], path: string): boolean {
  return writes.map(normalizePath).some(scope =>
    scope === '.' || scope === path || path.startsWith(`${scope}/`) || (!path.includes('/') && scope.split('/').pop() === path))
}

// What the producers are told: which reviewers failed the result, their findings (bounded), and to fix only that.
export function reworkNote(round: number, findings: ReadonlyMap<string, string>): string {
  let budget = REWORK_FINDINGS_CHARS
  const blocks = [...findings].map(([reviewer, text]) => {
    const kept = text.length <= budget ? text : `${text.slice(0, Math.max(0, budget)).trimEnd()}\n… (truncated)`
    budget -= kept.length
    return `<findings reviewer="${reviewer}">\n${kept}\n</findings>`
  })
  return [
    `[Review fix ${round}/${MAX_REVIEW_FIX_ROUNDS}] After this node completed, ${[...findings.keys()].join(' and ')} failed the run's result with the findings below.`,
    ...blocks,
    'Change your deliverable so the findings that concern your work are resolved, inside your declared scope. Keep everything the original task asked for, change nothing the findings do not name, and rerun your checks. The reviewers run again after you.',
  ].join('\n')
}

// The producers to rerun when a settled run failed only on reviewer or audit FAIL verdicts. A skip says why such a run gets
// no round: the findings point at no single producer, or a completed node the round would rerun works outside the project.
// undefined means the round does not apply at all: another kind of failure, or the round is spent.
// findings maps each failed reviewer to its text (the error, its ## Output, its notes); register.ts reads the notes.
export function reworkPlan(run: Run, findings: ReadonlyMap<string, string>, projectRoot: string): ReworkPlan | ReworkSkip | undefined {
  if (!isSettled(run) || run.cancelReason || run.handoff || run.approval || run.rejected) return undefined
  if ((run.reviewFix?.rounds ?? 0) >= MAX_REVIEW_FIX_ROUNDS) return undefined
  const failed = run.nodes.filter(node => node.state === 'failed')
  if (failed.length === 0 || !failed.every(node => verdictFailure(run, node.id))) return undefined
  const selected = new Set<string>()
  for (const reviewer of failed) {
    const candidates = producersOf(run, reviewer.id).filter(id => run.nodes.find(node => node.id === id)?.state === 'completed')
    let chosen = candidates
    if (candidates.length > 1) {
      const cited = citedPaths(findings.get(reviewer.id) ?? reviewer.error ?? '', projectRoot)
      chosen = candidates.filter(id => cited.some(path => owns(defOf(run, id)?.writes ?? [], path)))
    }
    if (chosen.length === 0) return { skip: `the findings of ${reviewer.id} name no file inside one producer's declared writes, so which producer to change is your call` }
    for (const id of chosen) selected.add(id)
  }
  // Every node the round would run again after it already completed: the producers and what downstream of them had finished.
  const rerun = [...selected, ...downstream(run.definition.nodes, selected)].filter(id => run.nodes.find(node => node.id === id)?.state === 'completed')
  for (const id of rerun) {
    const def = defOf(run, id)
    const risk = def ? rerunRisk(def) : 'is not in the definition'
    if (risk) return { skip: `${id} already ran and ${risk}, so the round does not rerun it unattended` }
  }
  const reviewers = failed.map(node => node.id)
  const texts = new Map(reviewers.map(id => [id, findings.get(id) ?? run.nodes.find(node => node.id === id)?.error ?? '']))
  return { reviewers, producers: [...selected], note: reworkNote((run.reviewFix?.rounds ?? 0) + 1, texts) }
}
