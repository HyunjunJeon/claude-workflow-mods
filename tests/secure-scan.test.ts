import { expect, test, type Plugin } from 'claude-code/testing'
import { addedLinesByFile, applyEdit, kisaRows, lensNotesWithSemgrep, mergeCandidates, owaspCweRows, parseSemgrepReport, semgrepCandidates, semgrepVersion, SEMGREP_SECTION, type SemgrepHit } from '../hooks/engine/semgrep.ts'
import type { VerificationCheck } from '../hooks/engine/types.ts'
import { boot, finish, harness, start } from './control-harness.ts'

// The Semgrep secure-coding scan: the pure parsing and candidate logic, the Edit/Write hook, and the security lens expansion.
// The real rules are checked by `semgrep --test --config skills/secure-coding/rules tests/semgrep`; here semgrep is a stub.

const KISA = [
  '| 1-1 | SQL 삽입 | 89 | `injection` | External input reaches a SQL string by concatenation. |',
  '| 2-4 | 취약한 암호화 알고리즘 사용 | 327 | `crypto` | Code uses MD5 or SHA-1 for protection. |',
  '| 2-6 | 하드코드된 중요정보 | 259, 321 | `crypto` | A password is written in code. |',
].join('\n')
const OWASP = "| 2 | CWE-89 | Improper Neutralization of Special Elements used in an SQL Command ('SQL Injection') | `injection` | Input reaches SQL. |"
const ROWS = { kisa: kisaRows(KISA), owasp: owaspCweRows(OWASP) }
const hit = (overrides: Partial<SemgrepHit> = {}): SemgrepHit => ({ rule: 'kisa-1-1-sql-injection', kisa: '1-1', tier: 'warn', cwe: ['CWE-89'], path: 'src/db.py', line: 2, message: 'Bind it as a parameter.', ...overrides })
type RuleMetadata = { kisa?: string; tier?: string; cwe?: string[] }
const result = (rule: string, path: string, line: number, metadata: RuleMetadata) => ({ check_id: `rules.${rule}`, path, start: { line }, extra: { message: `${rule} message`, metadata } })

test('a report keeps the results of rules that name a KISA item and refuses one with an error', () => {
  const report = parseSemgrepReport(JSON.stringify({
    results: [
      result('kisa-2-6-hardcoded-secret', 'src/config.py', 3, { kisa: '2-6', tier: 'block', cwe: ['CWE-259'] }),
      result('someone-elses-rule', 'src/config.py', 4, {}),
    ],
    errors: [{ level: 'warn', message: 'Syntax error, partially parsed' }],
  }))
  expect(report).toEqual({ ok: true, value: [{ rule: 'kisa-2-6-hardcoded-secret', kisa: '2-6', tier: 'block', cwe: ['CWE-259'], path: 'src/config.py', line: 3, message: 'kisa-2-6-hardcoded-secret message' }] })
  expect(parseSemgrepReport(JSON.stringify({ results: [], errors: [{ level: 'error', message: 'invalid rule' }] }))).toMatchObject({ ok: false, error: { code: 'semgrep_error' } })
  expect(parseSemgrepReport('')).toMatchObject({ ok: false, error: { code: 'semgrep_output' } })
  expect([semgrepVersion('1.181.0\n'), semgrepVersion(''), semgrepVersion('zsh: command not found: semgrep')]).toEqual(['1.181.0', undefined, undefined])
})

test('added lines come from the new side of each hunk, and a deleted file adds none', () => {
  const diff = [
    'diff --git a/src/db.py b/src/db.py', '--- a/src/db.py', '+++ b/src/db.py', '@@ -1,0 +2,2 @@', '+a', '+b', '@@ -9 +11 @@', '-c', '+d',
    'diff --git a/src/old.py b/src/old.py', '--- a/src/old.py', '+++ /dev/null', '@@ -1,3 +0,0 @@',
    'diff --git a/src/cut.py b/src/cut.py', '--- a/src/cut.py', '+++ b/src/cut.py', '@@ -4,2 +3,0 @@',
  ].join('\n')
  const added = addedLinesByFile(diff)
  expect([...added.entries()].map(([path, lines]) => [path, [...lines]])).toEqual([['src/db.py', [2, 3, 11]], ['src/cut.py', []]])
})

test('an Edit applies once, or everywhere with replace_all, and is undefined when its text is absent', () => {
  expect(applyEdit('a $1 a', 'a', 'b', false)).toBe('b $1 a')
  expect(applyEdit('a $1 a', 'a', '$&', true)).toBe('$& $1 $&')
  expect(applyEdit('a', 'x', 'y', false)).toBeUndefined()
})

test('a lens gets the hits whose KISA row has its lens, cited in the chosen guides, one candidate per rule', () => {
  const hits = [hit(), hit({ line: 7 }), hit({ rule: 'kisa-2-4-weak-hash', kisa: '2-4', cwe: ['CWE-327'], line: 9 })]
  expect(semgrepCandidates(hits, 'injection', ['kisa', 'owasp'], ROWS)).toEqual([{
    items: ['kisa 1-1 SQL 삽입', "owasp CWE-89 Improper Neutralization of Special Elements used in an SQL Command ('SQL Injection')"],
    file: 'src/db.py', line: 2,
    claim: 'Semgrep rule kisa-1-1-sql-injection matched src/db.py:2, src/db.py:7: Bind it as a parameter.',
    missing_control: 'Bind it as a parameter.',
  }])
  expect(semgrepCandidates(hits, 'crypto', ['kisa'], ROWS).map(candidate => candidate.items)).toEqual([['kisa 2-4 취약한 암호화 알고리즘 사용']])
  expect(semgrepCandidates(hits, 'injection', ['agent'], ROWS)).toEqual([])
})

test('a Semgrep candidate the lens already reported, on the same row a line or two away, is not added twice', () => {
  const lens = [{ items: ['kisa 1-1'], file: 'src/db.py', line: 3, claim: 'concatenates', missing_control: 'binding' }]
  const tool = semgrepCandidates([hit(), hit({ rule: 'kisa-1-1-other', line: 9 }), hit({ rule: 'kisa-2-4-weak-hash', kisa: '2-4', cwe: [], line: 4 })], 'injection', ['kisa'], ROWS)
  const merged = mergeCandidates(lens, tool)
  expect(merged.added.map(candidate => candidate.line)).toEqual([9])
  expect(merged.all.map(candidate => candidate.line)).toEqual([3, 9])
  const crypto = mergeCandidates(lens, semgrepCandidates([hit({ rule: 'kisa-2-4-weak-hash', kisa: '2-4', cwe: [], line: 4 })], 'crypto', ['kisa'], ROWS))
  expect(crypto.added.map(candidate => candidate.line)).toEqual([4])
})

test('the lens notes get one Semgrep section above the closing line, replaced on a second expansion', () => {
  const notes = '## Scope\nsrc/db.py\n## Candidates\n```json\n[]\n```\n## Judgment calls\nnone\nSecurity lens: done\n'
  const once = lensNotesWithSemgrep(notes, semgrepCandidates([hit()], 'injection', ['kisa'], ROWS))
  const twice = lensNotesWithSemgrep(once, [], 'semgrep could not run (timeout).')
  expect(once.trim().split('\n').at(-1)).toBe('Security lens: done')
  expect(once).toContain(`${SEMGREP_SECTION}\nAdded by the plugin`)
  expect(twice.split(SEMGREP_SECTION)).toHaveLength(2)
  expect(twice).toContain('Semgrep did not run, so no rule-based candidates were added: semgrep could not run (timeout).')
  expect(twice.trim().split('\n').at(-1)).toBe('Security lens: done')
})

// A semgrep stand-in: `--version` answers, a scan matches each line of its targets (read through the host, so from the
// test's files) against two patterns, and the guide references read as two rows. The test kit runs a plugin's register in
// its own environment, so everything the stub uses is written inside it, and since its answers never reach the harness's
// process log it records each scan as a file under SCANS.
const SCRATCH = '/tmp/scan-1'
const SCANS = '/semgrep-scans'
const scans = (h: ReturnType<typeof harness>) => [...h.files.entries()].flatMap(([path, text]) => path.startsWith(`${SCANS}/`) ? [JSON.parse(text) as { cwd: string; targets: string[] }] : [])
const SEMGREP: Plugin = {
  name: 'semgrep-stub',
  register(on) {
    const reply = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const patterns = [
      { match: /PASSWORD = "/, rule: 'kisa-2-6-hardcoded-secret', metadata: { kisa: '2-6', tier: 'block', cwe: ['CWE-259'] } },
      { match: /execute\(f"/, rule: 'kisa-1-1-sql-injection', metadata: { kisa: '1-1', tier: 'warn', cwe: ['CWE-89'] } },
    ]
    let count = 0
    on('process.run', async ($, e, next) => {
      if (e.argv[0] === 'mktemp') return reply('/tmp/scan-1\n')
      if (e.argv[0] !== 'semgrep') return next(e)
      if (e.argv[1] === '--version') return reply('1.181.0\n')
      const cwd = e.init?.cwd ?? '/work'
      const targets = e.argv.slice(e.argv.indexOf('--disable-nosem') + 1)
      await $.fs.write(`/semgrep-scans/${++count}`, JSON.stringify({ cwd, targets }))
      const results: ReturnType<typeof result>[] = []
      for (const target of targets) {
        const text = await $.fs.read(`${cwd}/${target}`).catch(() => '')
        text.split('\n').forEach((line, index) => {
          for (const pattern of patterns) {
            if (pattern.match.test(line)) results.push({ check_id: `rules.${pattern.rule}`, path: target, start: { line: index + 1 }, extra: { message: `${pattern.rule} message`, metadata: pattern.metadata } })
          }
        })
      }
      return reply(JSON.stringify({ results, errors: [] }))
    })
    on('fs.read', ($, e, next) => {
      if (/skills\/secure-coding\/references\/kisa\.md$/.test(e.path)) return { value: '| 1-1 | SQL 삽입 | 89 | `injection` | x |\n| 2-6 | 하드코드된 중요정보 | 259, 321 | `crypto` | x |' }
      if (/skills\/secure-coding\/references\/owasp\.md$/.test(e.path)) return { value: '' }
      return next(e)
    })
  },
}

const SECRET = 'Winter2026!'

test('a Write that adds a hard-coded secret is refused before it lands, and the refusal does not repeat the secret', { plugins: [SEMGREP] }, async ($, on) => {
  const h = harness(on)
  await boot($, 'off')
  const reply = await $.tool.call({ tool: 'Write', file_path: '/work/src/config.py', content: `import os\nDB_PASSWORD = "${SECRET}"\n` })
  expect(reply.deny).toContain('src/config.py:2 kisa 2-6 하드코드된 중요정보 [kisa-2-6-hardcoded-secret]')
  expect(reply.deny).not.toContain(SECRET)
  expect(h.files.has('/work/src/config.py')).toBe(false)
  expect(scans(h)).toEqual([{ cwd: SCRATCH, targets: ['src/config.py'] }])
  expect(h.processes.some(run => run.argv.join(' ') === `rm -rf ${SCRATCH}`)).toBe(true)
})

test('a session working in a worktree under .claude/ still scans its edits, by the path inside the worktree', { plugins: [SEMGREP] }, async ($, on) => {
  const h = harness(on)
  h.control.root = '/work/.claude/worktrees/x'
  await boot($, 'off')
  const reply = await $.tool.call({ tool: 'Write', file_path: '/work/.claude/worktrees/x/src/config.py', content: `import os\nDB_PASSWORD = "${SECRET}"\n` })
  expect(reply.deny).toContain('src/config.py:2 kisa 2-6 하드코드된 중요정보 [kisa-2-6-hardcoded-secret]')
  expect(scans(h)).toEqual([{ cwd: SCRATCH, targets: ['src/config.py'] }])
  // A file of the folder the session started in is still scanned; that folder's own .claude/ stays out.
  const main = await $.tool.call({ tool: 'Write', file_path: '/work/src/settings.py', content: `DB_PASSWORD = "${SECRET}"\n` })
  expect(main.deny).toContain('src/settings.py:1 kisa 2-6')
  const own = await $.tool.call({ tool: 'Write', file_path: '/work/.claude/notes/config.py', content: `DB_PASSWORD = "${SECRET}"\n` })
  expect(own.deny).toBeUndefined()
})

test('an Edit whose new line matches a warning rule lands and gets the hit back; an old hit in the file is not repeated', { plugins: [SEMGREP] }, async ($, on) => {
  const h = harness(on)
  await boot($, 'off')
  h.files.set('/work/src/users.py', 'def old(cur, a):\n    cur.execute(f"SELECT {a}")\n\ndef find(cur, name):\n    return cur.execute("SELECT 1")\n')
  const reply = await $.tool.call({ tool: 'Edit', file_path: '/work/src/users.py', old_string: 'cur.execute("SELECT 1")', new_string: 'cur.execute(f"SELECT * FROM users WHERE name = {name}")' })
  expect(reply.deny).toBeUndefined()
  const note = reply.context?.find(text => text.startsWith('[secure-scan]')) ?? ''
  expect(note).toContain('src/users.py:5 kisa 1-1 SQL 삽입 [kisa-1-1-sql-injection]')
  expect(note).not.toContain('src/users.py:2')
})

test('secure_scan off runs no scan', { options: { secure_scan: false }, plugins: [SEMGREP] }, async ($, on) => {
  const h = harness(on)
  await boot($, 'off')
  const reply = await $.tool.call({ tool: 'Write', file_path: '/work/src/config.py', content: `DB_PASSWORD = "${SECRET}"\n` })
  expect(reply.deny).toBeUndefined()
  expect(h.processes.some(run => run.argv[0] === 'semgrep')).toBe(false)
})

test('without semgrep the scan asks for it once and then stays out of the way', async ($, on) => {
  const h = harness(on)
  await boot($, 'off')
  const first = await $.tool.call({ tool: 'Write', file_path: '/work/src/a.py', content: `DB_PASSWORD = "${SECRET}"\n` })
  await $.tool.call({ tool: 'Write', file_path: '/work/src/b.py', content: 'x = 1\n' })
  expect(first.deny).toBeUndefined()
  expect(h.processes.flatMap(run => run.argv[0] === 'semgrep' ? [[...run.argv]] : [])).toEqual([['semgrep', '--version']])
  expect(h.processes.some(run => run.argv[0] === 'mktemp')).toBe(false)
})

const CHECK: VerificationCheck[] = [{ kind: 'command', argv: ['check-control'] }]
const NOTES = '/tmp/secure-scan-notes'
const LENSES = ['injection', 'resources', 'access', 'crypto', 'errors', 'memory', 'integrity']
const lensText = '## Scope\nsrc/db.py\n## Candidates\n```json\n[]\n```\n## Judgment calls\nnone\nSecurity lens: done'

test('a security review gives each Semgrep hit of a lens its own verifier and records it in that lens\'s notes', { options: { auto_recovery: false, max_concurrent: 20 }, plugins: [SEMGREP] }, async ($, on) => {
  const h = harness(on)
  h.control.git.set('-c core.quotePath=false diff -U0 --no-color --relative HEAD', 'diff --git a/src/db.py b/src/db.py\n--- a/src/db.py\n+++ b/src/db.py\n@@ -1,0 +2 @@\n+x\n')
  h.control.git.set('ls-files -z --others --exclude-standard', '')
  h.files.set('/work/src/db.py', 'def find(cur, name):\n    return cur.execute(f"SELECT * FROM users WHERE name = {name}")\n')
  await boot($)
  await start($, { key: 'gate', name: 'Gate', nodes: [{ id: 'a', prompt: 'Write a', verify: CHECK }], review: { request: 'Add search', notes: NOTES, security: ['kisa'] } })
  await finish($, h, 'agent-1')
  h.files.set(`${NOTES}/review-spec-notes.md`, '## Request sentences\n## Findings\nnone\nSpec verdict: PASS')
  h.files.set(`${NOTES}/review-standards-notes.md`, '## Rule sources\n## Rule breaches\nnone\n## Judgment calls\nnone\nStandards verdict: PASS')
  for (const lens of LENSES) h.files.set(`${NOTES}/security-${lens}-notes.md`, lensText)
  for (const description of ['Gate: Review: spec axis', 'Gate: Review: standards axis', ...LENSES.map(lens => `Gate: Security lens: ${lens}`)]) {
    await finish($, h, `agent-${h.spawns.findIndex(spawn => spawn.description === description) + 1}`)
  }
  const verifiers = h.spawns.filter(spawn => spawn.description.startsWith('Gate: Security check'))
  expect(verifiers.map(spawn => spawn.description)).toEqual(['Gate: Security check: injection 1'])
  expect(verifiers[0]?.prompt).toContain('location: src/db.py:2')
  expect(verifiers[0]?.prompt).toContain('Semgrep rule kisa-1-1-sql-injection matched src/db.py:2')
  const injection = h.files.get(`${NOTES}/security-injection-notes.md`) ?? ''
  expect(injection).toContain(`${SEMGREP_SECTION}\nAdded by the plugin`)
  expect(injection.trim().split('\n').at(-1)).toBe('Security lens: done')
  expect(h.files.get(`${NOTES}/security-crypto-notes.md`)).toContain(`${SEMGREP_SECTION}\nAdded by the plugin from the Semgrep rules in skills/secure-coding/rules; each has its own verifier like the candidates above.\n\`\`\`json\n[]`)
  expect(scans(h)).toEqual([{ cwd: '/work', targets: ['src/db.py'] }])
  expect(h.spawns.find(spawn => spawn.description === 'Gate: Security lens: injection')?.prompt).toContain('SEMGREP: when semgrep is installed')
})
