import type { EngineInterface } from 'claude-code'
import { hash } from '../engine/hash.ts'
import { addedLines, allowedPatterns, RULE_FILES } from '../engine/slop-scan.ts'
import { addedLinesByFile, kisaRows, lensNotesWithSemgrep, mergeCandidates, owaspCweRows, parseSemgrepReport, SEMGREP_RULES_DIR, semgrepArgv, semgrepCandidates, semgrepTarget, semgrepVersion, type GuideRows, type SemgrepHit } from '../engine/semgrep.ts'
import { lensNotesFile, lensVerifyFolder, parseCandidates, securityLensOf, verifierNodes } from '../engine/stages.ts'
import { fail, type NodeDef, type Result, type Run } from '../engine/types.ts'
import { debug, message, readOrEmpty } from './io.ts'

// The scans of what an Edit or Write adds: the anti-slop scan (engine/slop-scan.ts) and the secure-coding Semgrep scan
// (engine/semgrep.ts), which a security lens's expansion also runs on a run's change. The state createScan returns and the
// functions that take it. validate refuses $ passed to a method or a callback, so each operation that calls the host is a
// top-level function taking ($, scan, ...), and the host gives only what needs no $.
export type ScanHost = {
  // The session's folder, whose rule files (RULE_FILES) slopSkips reads.
  projectRoot(): string
  // The folder a run works in (register.ts rootOf), where a security lens reads the run's change.
  rootOf(run: Run): string
}

// register.ts parses the options into the two switches and the skip list, sets repositoryAllows back to undefined when an
// Edit or Write changes a rule file, and calls resetScan when a session starts.
export type Scan = {
  readonly host: ScanHost
  // anti_slop_scan, anti_slop_skip and secure_scan.
  antiSlopScan: boolean
  antiSlopSkip: ReadonlySet<string>
  secureScan: boolean
  // The semgrep version a session found on its first scan, '' when there is none; undefined until it asks.
  semgrepFound: string | undefined
  guideRowsRead: Promise<GuideRows> | undefined
  // The Semgrep hits of a run's change, keyed by the run and the change, so the lenses of one review share one scan.
  readonly changeScans: Map<string, Promise<Result<SemgrepHit[]>>>
  // The patterns the repository's rule files allow, read once per session; undefined until then or after one of them is edited.
  repositoryAllows: ReadonlySet<string> | undefined
}

export function createScan(host: ScanHost): Scan {
  return { host, antiSlopScan: true, antiSlopSkip: new Set(), secureScan: true, semgrepFound: undefined, guideRowsRead: undefined, changeScans: new Map(), repositoryAllows: undefined }
}

// A new session asks for semgrep again and reads the rule files and the guide references again.
export function resetScan(scan: Scan): void {
  scan.repositoryAllows = undefined
  scan.semgrepFound = undefined
  scan.guideRowsRead = undefined
  scan.changeScans.clear()
}

// Semgrep is optional. The first scan of a session asks for its version once; without one every scan stays off.
async function semgrepReady($: EngineInterface, scan: Scan): Promise<boolean> {
  if (!scan.secureScan) return false
  if (scan.semgrepFound === undefined) {
    try {
      const probe = await $.process.run(['semgrep', '--version'], { timeoutMs: 30_000 })
      scan.semgrepFound = (probe.exitCode === 0 && semgrepVersion(probe.stdout)) || ''
    } catch {
      scan.semgrepFound = ''
    }
    debug($, scan.semgrepFound ? `semgrep ${scan.semgrepFound} runs the secure-coding rules` : 'semgrep is not installed; the secure-coding scan is off')
  }
  return scan.semgrepFound !== ''
}

async function runSemgrep($: EngineInterface, cwd: string, targets: readonly string[]): Promise<Result<SemgrepHit[]>> {
  try {
    const done = await $.process.run(semgrepArgv(`${$.plugin.root}/${SEMGREP_RULES_DIR}`, targets), { cwd, timeoutMs: 120_000 })
    return parseSemgrepReport(done.stdout)
  } catch (error) {
    return fail('semgrep_error', `semgrep could not run (${message(error)}).`)
  }
}

// The names and lenses a hit cites, from the guide references the plugin ships.
export function guideRows($: EngineInterface, scan: Scan): Promise<GuideRows> {
  const reference = (id: string) => readOrEmpty($, `${$.plugin.root}/skills/secure-coding/references/${id}.md`)
  scan.guideRowsRead ??= Promise.all([reference('kisa'), reference('owasp')]).then(([kisa, owasp]) => ({ kisa: kisaRows(kisa), owasp: owaspCweRows(owasp) }))
  return scan.guideRowsRead
}

// The hits an Edit or Write would add, scanned before it lands. The new text goes to a copy at the same root-relative path
// in a scratch folder, so the rules' path filters (tests/, *Test.java) match as they would in the project. root is the folder
// the edit lands in (editRoot): measured from the session's own folder, every file of a worktree under .claude/ was skipped.
export async function scanEdit($: EngineInterface, scan: Scan, path: string, before: string, after: string, root: string): Promise<SemgrepHit[]> {
  if (!root || !path.startsWith(`${root}/`) || path.startsWith(`${root}/.claude/`) || !(await semgrepReady($, scan))) return []
  const rel = path.slice(root.length + 1)
  const made = await $.process.run(['mktemp', '-d'], { timeoutMs: 10_000 })
  const scratch = made.stdout.trim()
  if (made.exitCode !== 0 || !scratch.startsWith('/')) return []
  try {
    await $.fs.write(`${scratch}/${rel}`, after)
    const report = await runSemgrep($, scratch, [rel])
    if (!report.ok) {
      $.ui.log(`secure-coding scan skipped ${rel}: ${report.error.message}`)
      return []
    }
    const added = addedLines(before, after)
    return report.value.filter(hit => hit.path === rel && added.has(hit.line))
  } finally {
    await $.process.run(['rm', '-rf', scratch]).catch(() => undefined)
  }
}

// The Semgrep hits on the lines a run's change added, read as the review nodes read the change: tracked files against
// HEAD and untracked files whole. The lenses of one review share one scan; undefined when semgrep is not there.
async function changeHits($: EngineInterface, scan: Scan, run: Run): Promise<Result<SemgrepHit[]> | undefined> {
  if (!(await semgrepReady($, scan))) return undefined
  const root = scan.host.rootOf(run)
  const diff = await $.process.run(['git', '-c', 'core.quotePath=false', 'diff', '-U0', '--no-color', '--relative', 'HEAD'], { cwd: root })
  const untracked = await $.process.run(['git', 'ls-files', '-z', '--others', '--exclude-standard'], { cwd: root })
  if (diff.exitCode !== 0 || untracked.exitCode !== 0) return fail('semgrep_change', `git could not list the change (${(diff.stderr || untracked.stderr).trim()}).`)
  const added = addedLinesByFile(diff.stdout)
  const fresh = new Set(untracked.stdout.split('\0').filter(Boolean))
  const targets = [...new Set([...added.keys(), ...fresh])].filter(path => semgrepTarget(path) && !path.startsWith('.claude/'))
  if (targets.length === 0) return { ok: true, value: [] }
  const key = `${run.runId}\0${hash(`${diff.stdout}\0${untracked.stdout}`)}`
  let shared = scan.changeScans.get(key)
  if (!shared) {
    shared = runSemgrep($, root, targets).then((report): Result<SemgrepHit[]> => report.ok
      ? { ok: true, value: report.value.filter(hit => fresh.has(hit.path) || added.get(hit.path)?.has(hit.line) === true) }
      : report)
    scan.changeScans.set(key, shared)
  }
  return shared
}

export async function slopSkips($: EngineInterface, scan: Scan): Promise<ReadonlySet<string>> {
  scan.repositoryAllows ??= new Set((await Promise.all(RULE_FILES.map(name => readOrEmpty($, `${scan.host.projectRoot()}/${name}`)))).flatMap(allowedPatterns))
  return new Set([...scan.antiSlopSkip, ...scan.repositoryAllows])
}

// A security lens that passed its checks: read its candidates and build one verifier node per candidate, after creating the
// lens's verifier folder, which review-security's folder check needs even when there are no candidates. Any problem fails
// the lens with the reason, so recovery or a retry can redo it; nothing is spawned from a candidates block read in part.
export async function lensExpansion($: EngineInterface, scan: Scan, run: Run, lensId: string): Promise<Result<NodeDef[]>> {
  const review = run.definition.review
  const lens = securityLensOf(run.definition, lensId)
  if (!review?.security || !lens) return fail('invalid_expansion', `"${lensId}" is not a security lens of this run.`)
  const notes = lensNotesFile(review, lens)
  let text: string
  try {
    text = await $.fs.read(notes)
  } catch (error) {
    return fail('invalid_candidates', `could not read ${notes} (${message(error)}).`)
  }
  const candidates = parseCandidates(text, review.security)
  if (!candidates.ok) return fail('invalid_candidates', `${notes}: ${candidates.error.message}`)
  let all = candidates.value
  // The Semgrep rules cite kisa and owasp rows. Their hits in this lens join the lens's candidates, and the lens notes record
  // them, or the scan's failure, so review-security counts a verifier for each.
  const hits = review.security.some(guide => guide === 'kisa' || guide === 'owasp') ? await changeHits($, scan, run) : undefined
  if (hits) {
    const merged = hits.ok ? mergeCandidates(all, semgrepCandidates(hits.value, lens, review.security, await guideRows($, scan))) : undefined
    all = merged?.all ?? all
    try {
      await $.fs.write(notes, lensNotesWithSemgrep(text, merged?.added ?? [], hits.ok ? undefined : hits.error.message))
    } catch (error) {
      return fail('invalid_expansion', `could not record the Semgrep candidates in ${notes} (${message(error)}).`)
    }
  }
  const folder = lensVerifyFolder(review, lens)
  try {
    const made = await $.process.run(['mkdir', '-p', folder])
    if (made.exitCode !== 0) return fail('invalid_expansion', `could not create ${folder}: ${made.stderr.trim() || `exit ${made.exitCode}`}`)
  } catch (error) {
    return fail('invalid_expansion', `could not create ${folder}: ${message(error)}`)
  }
  return verifierNodes(run.definition, lensId, all)
}
