import { fail, type Result } from './types.ts'
import type { SecurityCandidate } from './stages.ts'

// The deterministic half of the secure-coding skill: the Semgrep rules in skills/secure-coding/rules, each naming the KISA
// item it checks (metadata.kisa) and whether a hit refuses an edit (metadata.tier: block) or only reports it. register.ts
// runs them at two points. Before an Edit or Write lands it scans the new text and refuses the call on a block hit in the
// lines the call adds; after it lands it reports the other hits as context. When a security lens finishes, every hit in that
// lens on a line the run's change added becomes a candidate with its own verifier, beside the lens's own candidates. A hit
// never decides a breach: the verifier does, and its REFUTED verdict is the only exception the plugin honours.

export type SemgrepHit = { rule: string; kisa: string; tier: 'block' | 'warn'; cwe: string[]; path: string; line: number; message: string }
// A guide row a hit can cite: its id as the reference file writes it (`1-1`, `CWE-89`), its name and its lens.
export type GuideRow = { id: string; name: string; lens: string }
export type GuideRows = { kisa: ReadonlyMap<string, GuideRow>; owasp: ReadonlyMap<string, GuideRow> }

export const SEMGREP_RULES_DIR = 'skills/secure-coding/rules'
export const SEMGREP_SECTION = '## Semgrep candidates'
// Shown in an edit note: more hits than this are counted, not listed.
const MAX_NOTED_HITS = 8
// Per lens, after hits of one rule are merged into one candidate. The rules give no lens that many rules for one language.
export const MAX_SEMGREP_CANDIDATES = 8
const MAX_CANDIDATE_ITEMS = 6
const EXTENSIONS = new Set(['py', 'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'java'])

export function semgrepTarget(path: string): boolean {
  const extension = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase()
  return extension !== undefined && EXTENSIONS.has(extension)
}

export function semgrepArgv(rulesDir: string, targets: readonly string[]): string[] {
  // --disable-nosem: a nosemgrep comment does not switch a rule off.
  return ['semgrep', 'scan', '--config', rulesDir, '--json', '--quiet', '--metrics', 'off', '--disable-nosem', ...targets]
}

// `semgrep --version` prints the bare version. Anything else, an empty answer included, means it is not there to run.
export function semgrepVersion(stdout: string): string | undefined {
  return /^\d+\.\d+\.\d+/.exec(stdout.trim())?.[0]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// A result without metadata.kisa comes from a rule outside this plugin's set and is not a hit.
export function parseSemgrepReport(stdout: string): Result<SemgrepHit[]> {
  let report: unknown
  try {
    report = JSON.parse(stdout)
  } catch (error) {
    return fail('semgrep_output', `semgrep did not print JSON (${error instanceof Error ? error.message : String(error)}).`)
  }
  if (!isRecord(report)) return fail('semgrep_output', 'semgrep printed JSON that is not an object.')
  const errors = (Array.isArray(report.errors) ? report.errors : []).filter(error => isRecord(error) && error.level === 'error')
  if (errors.length > 0) {
    return fail('semgrep_error', errors.map(error => String(isRecord(error) ? error.message ?? error.type : error).trim().slice(0, 200)).join('; '))
  }
  const hits: SemgrepHit[] = []
  for (const result of Array.isArray(report.results) ? report.results : []) {
    if (!isRecord(result) || !isRecord(result.extra) || !isRecord(result.start)) continue
    const metadata = isRecord(result.extra.metadata) ? result.extra.metadata : {}
    if (typeof metadata.kisa !== 'string' || typeof result.path !== 'string' || typeof result.start.line !== 'number') continue
    hits.push({
      rule: String(result.check_id).split('.').at(-1) ?? '',
      kisa: metadata.kisa,
      tier: metadata.tier === 'block' ? 'block' : 'warn',
      cwe: Array.isArray(metadata.cwe) ? metadata.cwe.filter((cwe): cwe is string => typeof cwe === 'string') : [],
      path: result.path,
      line: result.start.line,
      message: typeof result.extra.message === 'string' ? result.extra.message.trim() : '',
    })
  }
  return { ok: true, value: hits }
}

// The new lines per file in `git diff -U0` output, 1-based. A deleted file has none.
export function addedLinesByFile(diff: string): Map<string, Set<number>> {
  const added = new Map<string, Set<number>>()
  let current: Set<number> | undefined
  for (const line of diff.split('\n')) {
    const file = /^\+\+\+ (?:b\/(.+)|\/dev\/null)$/.exec(line)
    if (file) {
      current = file[1] === undefined ? undefined : new Set()
      if (file[1] !== undefined && current) added.set(file[1], current)
      continue
    }
    const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (hunk && current) {
      const start = Number(hunk[1])
      for (let number = start; number < start + Number(hunk[2] ?? 1); number++) current.add(number)
    }
  }
  return added
}

// The text an Edit would leave, or undefined when old_string is not in the file and the Edit will fail on its own.
export function applyEdit(before: string, oldString: string, newString: string, replaceAll: boolean): string | undefined {
  if (oldString === '' || !before.includes(oldString)) return undefined
  return replaceAll ? before.split(oldString).join(newString) : before.replace(oldString, () => newString)
}

// Rows of references/kisa.md: | id | name | CWE | `lens` | breach |
export function kisaRows(text: string): Map<string, GuideRow> {
  return new Map([...text.matchAll(/^\| (\d+-\d+) \| ([^|]+?) \| [\d, ]+ \| `(\w+)` \|/gm)]
    .map(([, id = '', name = '', lens = '']) => [id, { id, name: name.trim(), lens }]))
}

// The CWE Top 25 rows of references/owasp.md: | rank | CWE-id | name | `lens` | breach |
export function owaspCweRows(text: string): Map<string, GuideRow> {
  return new Map([...text.matchAll(/^\| \d+ \| (CWE-\d+) \| ([^|]+?) \| `(\w+)` \|/gm)]
    .map(([, id = '', name = '', lens = '']) => [id, { id, name: name.trim(), lens }]))
}

// The candidates the hits give one lens, cited in the guides the run chose. Hits of one rule merge into one candidate at
// the rule's first line whose claim lists every line, as a lens merges repeats of one pattern.
export function semgrepCandidates(hits: readonly SemgrepHit[], lens: string, guides: readonly string[], rows: GuideRows): SecurityCandidate[] {
  const byRule = new Map<string, { hit: SemgrepHit; items: string[]; lines: string[] }>()
  for (const hit of hits) {
    const kisa = rows.kisa.get(hit.kisa)
    const owasp = hit.cwe.flatMap(cwe => rows.owasp.get(cwe) ?? [])
    if ((kisa?.lens ?? owasp[0]?.lens) !== lens) continue
    const items = [
      ...(guides.includes('kisa') && kisa ? [`kisa ${kisa.id} ${kisa.name}`] : []),
      ...(guides.includes('owasp') ? owasp.map(row => `owasp ${row.id} ${row.name}`) : []),
    ]
    if (items.length === 0) continue
    const group = byRule.get(hit.rule) ?? { hit, items, lines: [] }
    group.lines.push(`${hit.path}:${hit.line}`)
    byRule.set(hit.rule, group)
  }
  return [...byRule.values()].slice(0, MAX_SEMGREP_CANDIDATES).map(({ hit, items, lines }) => ({
    items: items.slice(0, MAX_CANDIDATE_ITEMS),
    file: hit.path,
    line: hit.line,
    claim: `Semgrep rule ${hit.rule} matched ${lines.join(', ')}: ${hit.message}`.slice(0, 1500),
    missing_control: hit.message.slice(0, 600) || `the control the cited row requires (${hit.rule})`,
  }))
}

// A lens and a rule can count one statement's lines differently (an MD5 call reported at 55 by the lens and 54 by Semgrep in a
// 2026-10-19 rehearsal), so a candidate counts as already reported within this many lines of a lens candidate citing the same row.
const SAME_FINDING_LINES = 3

// The guide rows a candidate cites, as `<guide> <row id>`: `kisa 1-1 SQL 삽입` and `kisa 1-1` both give `kisa 1-1`.
function citedRows(candidate: SecurityCandidate): Set<string> {
  return new Set(candidate.items.map(item => item.split(/\s+/).slice(0, 2).join(' ')))
}

// The lens's candidates first, then each Semgrep candidate the lens did not already report: same file, a shared guide row
// and a nearby line. A rule's hit further away in the file is a separate weakness and keeps its own verifier.
export function mergeCandidates(lens: readonly SecurityCandidate[], semgrep: readonly SecurityCandidate[]): { all: SecurityCandidate[]; added: SecurityCandidate[] } {
  const reported = (candidate: SecurityCandidate) => lens.some(other => other.file === candidate.file
    && Math.abs(other.line - candidate.line) <= SAME_FINDING_LINES
    && [...citedRows(candidate)].some(row => citedRows(other).has(row)))
  const added = semgrep.filter(candidate => !reported(candidate))
  return { all: [...lens, ...added], added }
}

// The lens notes with a Semgrep section just above the closing line, replacing one an earlier expansion wrote, so the notes
// record every candidate a verifier got and review-security counts them all. `failure` records a scan that did not run.
export function lensNotesWithSemgrep(text: string, added: readonly SecurityCandidate[], failure?: string): string {
  const lines = text.replace(/\s+$/, '').split('\n')
  const closing = lines.pop() ?? ''
  const start = lines.findIndex(line => line.trim() === SEMGREP_SECTION)
  const body = start === -1 ? lines : lines.slice(0, start)
  const section = failure
    ? [SEMGREP_SECTION, `Semgrep did not run, so no rule-based candidates were added: ${failure}`]
    : [SEMGREP_SECTION, 'Added by the plugin from the Semgrep rules in skills/secure-coding/rules; each has its own verifier like the candidates above.', '```json', JSON.stringify(added, null, 1), '```']
  return [...body, ...section, closing].join('\n') + '\n'
}

export function semgrepNote(path: string, hits: readonly SemgrepHit[], kisa: ReadonlyMap<string, GuideRow>): string {
  return [
    `[secure-scan] The lines just written match ${hits.length} Semgrep secure-coding rule${hits.length === 1 ? '' : 's'}:`,
    ...hits.slice(0, MAX_NOTED_HITS).map(hit => `- ${path}:${hit.line} kisa ${hit.kisa} ${kisa.get(hit.kisa)?.name ?? ''} [${hit.rule}]: ${hit.message}`),
    ...(hits.length > MAX_NOTED_HITS ? [`- and ${hits.length - MAX_NOTED_HITS} more`] : []),
    'Fix each one, or leave a line you judge a false positive and say why: a security review gives every Semgrep hit its own verifier, and a nosemgrep comment does not switch a rule off.',
  ].join('\n')
}

// The refusal names each hit but never repeats its line: for a secret, the refusal would carry it into the transcript.
export function semgrepRefusal(path: string, hits: readonly SemgrepHit[], kisa: ReadonlyMap<string, GuideRow>): string {
  return [
    `[secure-scan] Refused before writing ${path}: the new lines break ${hits.length === 1 ? 'a rule that blocks' : 'rules that block'} the edit.`,
    ...hits.map(hit => `- ${path}:${hit.line} kisa ${hit.kisa} ${kisa.get(hit.kisa)?.name ?? ''} [${hit.rule}]: ${hit.message}`),
    'Follow each rule\'s advice and write it again.',
  ].join('\n')
}
