import { expect, test, type Engine, type Plugin } from 'claude-code/testing'
import { boot, checkpoint, finish, harness, start } from './control-harness.ts'

type Harness = ReturnType<typeof harness>

// The harness answers `check-control` with one exit code and no output. This plugin sits above it and gives a verify
// command real output, a program that cannot start, and folders the harness cannot describe:
//   report <exit> [stdout] [stderr]  runs and answers those three
//   report-cut <exit> <stdout>       the same with stdout cut at the host's 4 MiB limit
//   missing-program                  cannot start, so the host rejects the call
//   fs.list /work/heavy              two files of 11 MB each (the harness lists every file as 1 byte)
//   fs.list /work/linked             one file, and one symbolic link (kind `other`, which must not be followed)
//   fs.list, fs.stat, fs.read        fold repeated separators and `.` segments first, as a real host does: the harness
//                                    matches paths exactly, so `/work/.claude//dag` would otherwise be a folder of its own
//                                    (a hook runs apart from this module, so each handler folds inline)
const PROGRAMS: Plugin = {
  name: 'check-runtime-programs',
  register(on) {
    on('fs.stat', ($, e, next) => next({ ...e, path: e.path.startsWith('/') ? `/${e.path.split('/').filter(part => part !== '' && part !== '.').join('/')}` : e.path }))
    on('fs.read', ($, e, next) => next({ ...e, path: e.path.startsWith('/') ? `/${e.path.split('/').filter(part => part !== '' && part !== '.').join('/')}` : e.path }))
    on('process.run', ($, e, next) => {
      if (e.argv[0] === 'report' || e.argv[0] === 'report-cut') {
        return { value: { exitCode: Number(e.argv[1]), stdout: e.argv[2] ?? '', stderr: e.argv[3] ?? '', isStdoutTruncated: e.argv[0] === 'report-cut', isStderrTruncated: false } }
      }
      if (e.argv[0] === 'missing-program') return { deny: 'spawn missing-program ENOENT' }
      return next(e)
    })
    on('fs.list', ($, e, next) => {
      const path = e.path.startsWith('/') ? `/${e.path.split('/').filter(part => part !== '' && part !== '.').join('/')}` : e.path
      if (path !== e.path) return next({ ...e, path })
      if (e.path === '/work/heavy') {
        return { value: ['one.bin', 'two.bin'].map(name => ({ name, kind: 'file' as const, size: 11 * 1024 * 1024, mtimeMs: 0, isLink: false })) }
      }
      if (e.path === '/work/linked') {
        return { value: [
          { name: 'real.ts', kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false },
          { name: 'loop', kind: 'other' as const, size: 0, mtimeMs: 0, isLink: true },
        ] }
      }
      return next(e)
    })
  },
}

const SETTINGS = { options: { auto_recovery: false }, plugins: [PROGRAMS] }

// Runs one node whose verify is `checks` to the end of its verification and reads the verdict back from the checkpoint.
async function verdict($: Engine, h: Harness, checks: unknown[]) {
  await boot($)
  const runId = await start($, { key: 'check-runtime', nodes: [{ id: 'a', prompt: 'Produce the artifact', verify: checks }] })
  await finish($, h)
  const verification = checkpoint(h, runId).nodes[0]?.verification
  if (!verification) throw new Error('The node was not verified')
  return verification
}

// A folder for the harness: its files are listed under it, and a lock makes `stat` answer `dir`.
function folder(h: Harness, path: string, files: Record<string, string>) {
  h.locks.add(path)
  for (const [name, text] of Object.entries(files)) h.files.set(`${path}/${name}`, text)
}

const REPORT = 'ok 1 parse\nok 2 lint\nPASS 2 of 2\n'

const FIELDS = [
  { field: 'contains', holds: 'ok 2 lint', breaks: 'ok 3 emit' },
  { field: 'absent', holds: 'FAIL', breaks: 'ok 1 parse' },
  { field: 'matches', holds: '^ok \\d lint$', breaks: '^FAIL' },
  { field: 'lastLine', holds: 'PASS 2 of 2', breaks: 'ok 2 lint' },
  { field: 'equals', holds: 'ok 1 parse\nok 2 lint\nPASS 2 of 2', breaks: 'PASS 2 of 2' },
]

for (const { field, holds, breaks } of FIELDS) {
  test(`a file check passes when ${field} holds`, SETTINGS, async ($, on) => {
    const h = harness(on)
    h.files.set('/work/out/report.txt', REPORT)
    const verification = await verdict($, h, [{ kind: 'file', path: 'out/report.txt', [field]: holds }])
    expect(verification.status).toBe('passed')
  })

  test(`a file check fails when ${field} does not hold, and the detail names the field`, SETTINGS, async ($, on) => {
    const h = harness(on)
    h.files.set('/work/out/report.txt', REPORT)
    const verification = await verdict($, h, [{ kind: 'file', path: 'out/report.txt', [field]: breaks }])
    expect(verification.status).toBe('failed')
    expect(verification.evidence[0]?.passed).toBe(false)
    expect(verification.evidence[0]?.detail).toContain(`out/report.txt: ${field}`)
  })
}

test('a file check with several fields passes only when every one holds', SETTINGS, async ($, on) => {
  const h = harness(on)
  h.files.set('/work/out/report.txt', REPORT)
  const verification = await verdict($, h, [
    { kind: 'file', path: 'out/report.txt', contains: 'ok 1', absent: 'FAIL', lastLine: 'PASS 2 of 2' },
    { kind: 'file', path: 'out/report.txt', contains: 'ok 1', absent: 'ok 2' },
  ])
  expect(verification.evidence.map(item => item.passed)).toEqual([true, false])
})

test('a missing path fails an absent check instead of passing it', SETTINGS, async ($, on) => {
  const h = harness(on)
  const verification = await verdict($, h, [{ kind: 'file', path: 'nowhere/report.txt', absent: 'TODO' }])
  expect(verification.status).toBe('failed')
  expect(verification.evidence[0]?.detail).toContain('missing or unreadable')
  expect(verification.evidence[0]?.detail).toContain('nowhere/report.txt')
})

test('an absolute path outside the project is read as given', SETTINGS, async ($, on) => {
  const h = harness(on)
  h.files.set('/elsewhere/notes.txt', 'shared notes\nREADY\n')
  const verification = await verdict($, h, [{ kind: 'file', path: '/elsewhere/notes.txt', lastLine: 'READY' }])
  expect(verification.status).toBe('passed')
  expect(h.reads).toContain('/elsewhere/notes.txt')
  expect(h.reads).not.toContain('/work//elsewhere/notes.txt')
})

test('absent on a folder passes when no file below it has the text, hidden and nested files included', SETTINGS, async ($, on) => {
  const h = harness(on)
  folder(h, '/work/pkg', { 'a.ts': 'export const a = 1', 'sub/b.ts': 'export const b = 2', '.hidden/c.ts': 'export const c = 3' })
  const verification = await verdict($, h, [{ kind: 'file', path: 'pkg', absent: 'TODO' }])
  expect(verification.status).toBe('passed')
  expect(verification.evidence[0]?.detail).toContain('3 files')
  expect(h.reads).toEqual(expect.arrayContaining(['/work/pkg/a.ts', '/work/pkg/sub/b.ts', '/work/pkg/.hidden/c.ts']))
})

test('absent on a folder fails naming the first file with the text, not its contents', SETTINGS, async ($, on) => {
  const h = harness(on)
  folder(h, '/work/pkg', {
    'a.ts': 'clean',
    'sub/b.ts': 'first line\nTODO fix this\nclassified-body',
    'sub/c.ts': 'TODO as well',
  })
  const verification = await verdict($, h, [{ kind: 'file', path: 'pkg', absent: 'TODO' }])
  expect(verification.status).toBe('failed')
  const detail = verification.evidence[0]?.detail ?? ''
  expect(detail).toContain('pkg/sub/b.ts')
  expect(detail).not.toContain('pkg/sub/c.ts')
  expect(detail).not.toContain('classified-body')
})

test('a hidden file below a folder breaks absent', SETTINGS, async ($, on) => {
  const h = harness(on)
  folder(h, '/work/pkg', { 'a.ts': 'clean', '.secret/env': 'TOKEN=abc' })
  const verification = await verdict($, h, [{ kind: 'file', path: 'pkg', absent: 'TOKEN=' }])
  expect(verification.status).toBe('failed')
  expect(verification.evidence[0]?.detail).toContain('pkg/.secret/env')
})

test('contains on a folder holds when any one file has the text and fails when none does', SETTINGS, async ($, on) => {
  const h = harness(on)
  folder(h, '/work/pkg', { 'a.ts': 'export const a = 1', 'sub/b.ts': 'export function needle() {}' })
  const verification = await verdict($, h, [
    { kind: 'file', path: 'pkg', contains: 'function needle' },
    { kind: 'file', path: 'pkg', contains: 'function haystack' },
  ])
  expect(verification.evidence.map(item => item.passed)).toEqual([true, false])
  expect(verification.evidence[1]?.detail).toContain('pkg (2 files)')
  expect(verification.evidence[1]?.detail).toContain('function haystack')
})

test('contains and absent together on a folder need one file with the text and none with the other', SETTINGS, async ($, on) => {
  const h = harness(on)
  folder(h, '/work/pkg', { 'a.ts': 'export const a = 1', 'b.ts': 'export const b = 2' })
  const verification = await verdict($, h, [
    { kind: 'file', path: 'pkg', contains: 'const b', absent: 'TODO' },
    { kind: 'file', path: 'pkg', contains: 'const b', absent: 'const a' },
  ])
  expect(verification.evidence.map(item => item.passed)).toEqual([true, false])
})

test('a folder check with a field other than contains or absent fails and says why', SETTINGS, async ($, on) => {
  const h = harness(on)
  folder(h, '/work/pkg', { 'a.ts': 'export const a = 1' })
  const verification = await verdict($, h, [
    { kind: 'file', path: 'pkg', lastLine: 'export const a = 1' },
    { kind: 'file', path: 'pkg', contains: 'const', equals: 'x' },
  ])
  expect(verification.evidence.map(item => item.passed)).toEqual([false, false])
  expect(verification.evidence[0]?.detail).toContain('folder')
  expect(verification.evidence[0]?.detail).toContain('lastLine')
  expect(verification.evidence[1]?.detail).toContain('equals')
  expect(h.reads).toEqual([])
})

test('a folder past 2,000 files fails with a bound detail and reads none of them', SETTINGS, async ($, on) => {
  const h = harness(on)
  folder(h, '/work/many', Object.fromEntries(Array.from({ length: 2_001 }, (_, index) => [`f${index}.txt`, 'x'])))
  const verification = await verdict($, h, [{ kind: 'file', path: 'many', absent: 'TODO' }])
  expect(verification.status).toBe('failed')
  expect(verification.evidence[0]?.detail).toContain('more than 2000 files')
  expect(h.reads.filter(path => path.startsWith('/work/many/'))).toEqual([])
})

test('a folder of exactly 2,000 files is read in full', SETTINGS, async ($, on) => {
  const h = harness(on)
  folder(h, '/work/many', Object.fromEntries(Array.from({ length: 2_000 }, (_, index) => [`f${index}.txt`, 'x'])))
  const verification = await verdict($, h, [{ kind: 'file', path: 'many', absent: 'TODO' }])
  expect(verification.status).toBe('passed')
  expect(verification.evidence[0]?.detail).toContain('2000 files')
})

test('a folder past 20 MB in total fails with a bound detail and reads none of it', SETTINGS, async ($, on) => {
  const h = harness(on)
  h.locks.add('/work/heavy')
  const verification = await verdict($, h, [{ kind: 'file', path: 'heavy', absent: 'TODO' }])
  expect(verification.status).toBe('failed')
  expect(verification.evidence[0]?.detail).toContain('more than 20 MB')
  expect(h.reads.filter(path => path.startsWith('/work/heavy/'))).toEqual([])
})

test('a folder check does not follow a symbolic link', SETTINGS, async ($, on) => {
  const h = harness(on)
  h.locks.add('/work/linked')
  h.files.set('/work/linked/real.ts', 'clean')
  h.files.set('/work/linked/loop/leak.ts', 'TODO behind the link')
  const verification = await verdict($, h, [{ kind: 'file', path: 'linked', absent: 'TODO' }])
  expect(verification.status).toBe('passed')
  expect(h.reads).toContain('/work/linked/real.ts')
  expect(h.reads.filter(path => path.includes('loop'))).toEqual([])
})

test('a folder without a text field passes as present, and a missing folder fails', SETTINGS, async ($, on) => {
  const h = harness(on)
  folder(h, '/work/pkg', { 'a.ts': 'x' })
  const verification = await verdict($, h, [{ kind: 'file', path: 'pkg' }, { kind: 'file', path: 'gone' }])
  expect(verification.evidence.map(item => item.passed)).toEqual([true, false])
})

// The run's own checkpoint under .claude/dag stores the definition, so it holds the text of every check in it.
const NEVER_WRITTEN = 'MARKER-NEVER-WRITTEN-7f3'

function checkpointHolds(h: Harness, text: string): boolean {
  return [...h.files].some(([path, content]) => path.startsWith('/work/.claude/dag/runs/') && content.includes(text))
}

test('contains on the project folder fails when the text exists only in the run checkpoint', SETTINGS, async ($, on) => {
  const h = harness(on)
  h.locks.add('/work')
  h.files.set('/work/src/a.ts', 'export const a = 1')
  const verification = await verdict($, h, [
    { kind: 'file', path: '.', contains: NEVER_WRITTEN },
    { kind: 'file', path: './', contains: NEVER_WRITTEN },
    { kind: 'file', path: '/work', contains: NEVER_WRITTEN },
  ])
  expect(checkpointHolds(h, NEVER_WRITTEN)).toBe(true)
  expect(verification.status).toBe('failed')
  expect(verification.evidence.map(item => item.passed)).toEqual([false, false, false])
  expect(verification.evidence[0]?.detail).toContain('. (1 files)')
  expect(h.reads.filter(path => path.startsWith('/work/.claude/dag/'))).toEqual([])
})

test('absent on the project folder passes when the forbidden text exists only in the run checkpoint', SETTINGS, async ($, on) => {
  const h = harness(on)
  h.locks.add('/work')
  h.files.set('/work/src/a.ts', 'export const a = 1')
  const verification = await verdict($, h, [
    { kind: 'file', path: '.', absent: NEVER_WRITTEN },
    { kind: 'file', path: '/work', absent: NEVER_WRITTEN },
  ])
  expect(checkpointHolds(h, NEVER_WRITTEN)).toBe(true)
  expect(verification.evidence.map(item => item.passed)).toEqual([true, true])
  expect(verification.evidence[0]?.detail).toContain('(1 files)')
  expect(h.reads.filter(path => path.startsWith('/work/.claude/dag/'))).toEqual([])
})

test('a folder walk below the project .claude folder still skips its dag folder', SETTINGS, async ($, on) => {
  const h = harness(on)
  h.locks.add('/work/.claude')
  h.files.set('/work/.claude/agents/review.md', 'a reviewer')
  const verification = await verdict($, h, [
    { kind: 'file', path: '/work/.claude', contains: NEVER_WRITTEN },
    { kind: 'file', path: '/work/.claude', absent: NEVER_WRITTEN },
  ])
  expect(checkpointHolds(h, NEVER_WRITTEN)).toBe(true)
  expect(verification.evidence.map(item => item.passed)).toEqual([false, true])
  expect(h.reads.filter(path => path.startsWith('/work/.claude/dag/'))).toEqual([])
})

// The same folder spelled with a trailing separator or a `.` segment is still /work/.claude: appending `dag` to it gives
// `/work/.claude//dag` or `/work/.claude/./dag`, which must still be recognised as the checkpoint store.
for (const spelling of ['/work/.claude/', '/work/.claude/.', '/work/.claude//', '/work/.claude/./']) {
  test(`${spelling}: contains fails and absent passes when the text exists only under dag, and nothing under dag is read`, SETTINGS, async ($, on) => {
    const h = harness(on)
    h.locks.add('/work/.claude')
    h.files.set('/work/.claude/agents/review.md', 'a reviewer')
    const verification = await verdict($, h, [
      { kind: 'file', path: spelling, contains: NEVER_WRITTEN },
      { kind: 'file', path: spelling, absent: NEVER_WRITTEN },
    ])
    expect(checkpointHolds(h, NEVER_WRITTEN)).toBe(true)
    expect(verification.evidence.map(item => item.passed)).toEqual([false, true])
    expect(verification.evidence[0]?.detail).toContain('(1 files)')
    expect(verification.evidence[1]?.detail).toContain('(1 files)')
    expect(h.reads.filter(path => path.startsWith('/work/.claude/dag/'))).toEqual([])
    expect(h.reads).toContain('/work/.claude/agents/review.md')
  })
}

test('a nested .Claude/DAG folder is skipped at any depth and in any letter case, and is not counted', SETTINGS, async ($, on) => {
  const h = harness(on)
  folder(h, '/work/pkg', {
    'a.ts': 'clean',
    '.Claude/DAG/runs/x.json': 'TODO in a nested store',
    'deep/er/.claude/dag/y.json': 'TODO again',
    'deep/er/b.ts': 'also clean',
  })
  const verification = await verdict($, h, [
    { kind: 'file', path: 'pkg', absent: 'TODO' },
    { kind: 'file', path: 'pkg', contains: 'TODO' },
  ])
  expect(verification.evidence.map(item => item.passed)).toEqual([true, false])
  expect(verification.evidence[0]?.detail).toContain('(2 files)')
  expect(h.reads.filter(path => path.includes('x.json') || path.includes('y.json'))).toEqual([])
  expect(h.reads).toEqual(expect.arrayContaining(['/work/pkg/a.ts', '/work/pkg/deep/er/b.ts']))
})

test('only the exact .claude/dag pair is skipped: look-alike folders are still walked', SETTINGS, async ($, on) => {
  const h = harness(on)
  folder(h, '/work/pkg', { 'old.claude/dag/a.ts': 'TODO in a look-alike' })
  folder(h, '/work/pkg2', { '.claude/dags/b.ts': 'TODO in dags' })
  folder(h, '/work/pkg3', { '.claude/agents/c.ts': 'TODO in agents' })
  const verification = await verdict($, h, [
    { kind: 'file', path: 'pkg', absent: 'TODO' },
    { kind: 'file', path: 'pkg2', absent: 'TODO' },
    { kind: 'file', path: 'pkg3', absent: 'TODO' },
  ])
  expect(verification.evidence.map(item => item.passed)).toEqual([false, false, false])
  expect(verification.evidence[0]?.detail).toContain('pkg/old.claude/dag/a.ts')
  expect(verification.evidence[1]?.detail).toContain('pkg2/.claude/dags/b.ts')
  expect(verification.evidence[2]?.detail).toContain('pkg3/.claude/agents/c.ts')
})

test('expect.exit [1] passes a command that exits 1 and fails one that exits 0', SETTINGS, async ($, on) => {
  const h = harness(on)
  const verification = await verdict($, h, [
    { kind: 'command', argv: ['report', '1'], expect: { exit: [1] } },
    { kind: 'command', argv: ['report', '0'], expect: { exit: [1] } },
  ])
  expect(verification.evidence.map(item => item.passed)).toEqual([true, false])
  expect(verification.evidence[1]?.detail).toContain('exit code 0 is not accepted (expected 1)')
})

test('a command without expect still passes only on exit 0, and the detail leads with the failed condition', SETTINGS, async ($, on) => {
  const h = harness(on)
  const verification = await verdict($, h, [
    { kind: 'command', argv: ['report', '0', 'fine'] },
    { kind: 'command', argv: ['report', '2', 'partial output', 'boom'] },
  ])
  expect(verification.evidence.map(item => item.passed)).toEqual([true, false])
  const detail = verification.evidence[1]?.detail ?? ''
  expect(detail.startsWith('exit code 2 is not accepted (expected 0)')).toBe(true)
  expect(detail).toContain('["report","2","partial output","boom"] exited 2')
  expect(detail).toContain('partial output')
  expect(detail).toContain('boom')
})

test('the evidence keeps the exit code whether the command passed or failed', SETTINGS, async ($, on) => {
  const h = harness(on)
  const verification = await verdict($, h, [
    { kind: 'command', argv: ['report', '1'], expect: { exit: [0, 1] } },
    { kind: 'command', argv: ['report', '3'] },
  ])
  expect(verification.evidence.map(item => item.exitCode)).toEqual([1, 3])
})

test('stdout lastLine is applied to the command output', SETTINGS, async ($, on) => {
  const h = harness(on)
  const verification = await verdict($, h, [
    { kind: 'command', argv: ['report', '0', 'building\nPASS 2 of 2\n'], expect: { stdout: { lastLine: 'PASS 2 of 2' } } },
    { kind: 'command', argv: ['report', '0', 'PASS 2 of 2\nFAIL 1\n'], expect: { stdout: { lastLine: 'PASS 2 of 2' } } },
  ])
  expect(verification.evidence.map(item => item.passed)).toEqual([true, false])
  expect(verification.evidence[1]?.detail).toContain('stdout: lastLine')
  expect(verification.evidence[1]?.detail).toContain('FAIL 1')
})

test('stderr contains is applied to the command output', SETTINGS, async ($, on) => {
  const h = harness(on)
  const verification = await verdict($, h, [
    { kind: 'command', argv: ['report', '0', '', 'warn: deprecated flag'], expect: { stderr: { contains: 'deprecated' } } },
    { kind: 'command', argv: ['report', '0', '', 'warn: deprecated flag'], expect: { stderr: { contains: 'fatal' } } },
  ])
  expect(verification.evidence.map(item => item.passed)).toEqual([true, false])
  expect(verification.evidence[1]?.detail).toContain('stderr: contains "fatal" not found')
})

test('an expected exit code does not excuse output that breaks its expectation', SETTINGS, async ($, on) => {
  const h = harness(on)
  const verification = await verdict($, h, [
    { kind: 'command', argv: ['report', '1', 'rejected: bad input'], expect: { exit: 1, stdout: { contains: 'rejected' }, stderr: { equals: '' } } },
    { kind: 'command', argv: ['report', '1', 'accepted'], expect: { exit: 1, stdout: { contains: 'rejected' } } },
  ])
  expect(verification.evidence.map(item => item.passed)).toEqual([true, false])
})

test('a program that cannot start fails even when expect.exit lists its code', SETTINGS, async ($, on) => {
  const h = harness(on)
  const verification = await verdict($, h, [{ kind: 'command', argv: ['missing-program'], expect: { exit: [0, 1, 126, 127] } }])
  expect(verification.status).toBe('failed')
  expect(verification.evidence[0]?.passed).toBe(false)
  expect(verification.evidence[0]?.detail).toContain('Verification could not run')
  expect(verification.evidence[0]?.exitCode).toBeUndefined()
})

test('an expectation on output that the host cut cannot be judged and fails', SETTINGS, async ($, on) => {
  const h = harness(on)
  const verification = await verdict($, h, [
    { kind: 'command', argv: ['report-cut', '0', 'PASS'], expect: { stdout: { lastLine: 'PASS' } } },
    { kind: 'command', argv: ['report-cut', '0', 'PASS'] },
  ])
  expect(verification.evidence.map(item => item.passed)).toEqual([false, true])
  expect(verification.evidence[0]?.detail).toContain('cut at 4 MiB')
})

test('the evidence file records the failed condition of each failed check', SETTINGS, async ($, on) => {
  const h = harness(on)
  h.files.set('/work/out/report.txt', REPORT)
  const verification = await verdict($, h, [
    { kind: 'file', path: 'out/report.txt', lastLine: 'PASS 3 of 3' },
    { kind: 'command', argv: ['report', '0', 'nothing here'], expect: { stdout: { contains: 'PASS' } } },
  ])
  expect(verification.status).toBe('failed')
  if (!verification.reportPath) throw new Error('Missing separate verification evidence')
  const saved: { status: string; evidence: { passed: boolean; detail: string }[] } = JSON.parse(h.files.get(verification.reportPath) ?? 'null')
  expect(saved.status).toBe('failed')
  expect(saved.evidence[0]?.detail).toContain('out/report.txt: lastLine expected "PASS 3 of 3", got "PASS 2 of 2"')
  expect(saved.evidence[1]?.detail).toContain('stdout: contains "PASS" not found')
})
