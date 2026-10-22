import { expect, test } from 'claude-code/testing'
import { commandDetail, evidenceOutcome, exitProblem, isCheckDefect, missingProgram, observedFailures, textProblem } from '../hooks/engine/check-eval.ts'
import type { VerificationCheck, VerificationEvidence } from '../hooks/engine/types.ts'
import { parseChecks } from '../hooks/engine/verification.ts'

const report = 'building\nok 1 parse\nok 2 lint\n\nPASS 2 of 2\n'

test('legacy failures remain unknown while explicit outcomes survive serialization', () => {
  const item: VerificationEvidence = { check: { kind: 'command', argv: ['test'] }, passed: false, checkedAt: 1, detail: '' }
  expect(evidenceOutcome(item)).toBe('unknown')
  expect(evidenceOutcome({ ...item, passed: true })).toBe('passed')
  for (const outcome of ['passed', 'failed', 'not_run', 'unknown'] as const) {
    const saved: VerificationEvidence = JSON.parse(JSON.stringify({ ...item, passed: outcome === 'passed', outcome }))
    expect(evidenceOutcome(saved)).toBe(outcome)
  }
})

test('a text expectation with every field holding has no problem', () => {
  expect(textProblem(report, {}, 'stdout')).toBeUndefined()
  expect(textProblem(report, { contains: 'ok 2 lint' }, 'stdout')).toBeUndefined()
  expect(textProblem(report, { absent: 'FAIL' }, 'stdout')).toBeUndefined()
  expect(textProblem(report, { matches: '^ok \\d+ lint$' }, 'stdout')).toBeUndefined()
  expect(textProblem(report, { lastLine: 'PASS 2 of 2' }, 'stdout')).toBeUndefined()
  expect(textProblem('PASS\n', { equals: 'PASS' }, 'stdout')).toBeUndefined()
  expect(textProblem(report, { contains: 'parse', absent: 'FAIL', matches: '^PASS', lastLine: 'PASS 2 of 2' }, 'stdout')).toBeUndefined()
})

test('contains fails when the text lacks it and names the field and label', () => {
  const problem = textProblem(report, { contains: 'ok 3' }, 'stdout')
  expect(problem).toContain('stdout')
  expect(problem).toContain('contains')
  expect(problem).toContain('ok 3')
})

test('absent fails when the text includes it and names the field and label', () => {
  const problem = textProblem('ok\nTODO: later\n', { absent: 'TODO' }, 'src/a.ts')
  expect(problem).toContain('src/a.ts')
  expect(problem).toContain('absent')
  expect(problem).toContain('TODO')
})

test('matches compiles with the m flag, so ^ and $ anchor each line', () => {
  expect(textProblem('first\nsecond\nthird', { matches: '^second$' }, 'stdout')).toBeUndefined()
  const problem = textProblem('first\nxsecond\nthird', { matches: '^second$' }, 'stdout')
  expect(problem).toContain('matches')
  expect(problem).toContain('stdout')
})

test('matches is case sensitive and has no global or dotall behaviour', () => {
  expect(textProblem('PASS', { matches: 'pass' }, 'stdout')).toContain('matches')
  expect(textProblem('a\nb', { matches: 'a.b' }, 'stdout')).toContain('matches')
})

test('an invalid matches source is a problem, not an exception', () => {
  expect(textProblem('anything', { matches: '(' }, 'stdout')).toContain('matches')
})

test('lastLine compares the last line after trailing whitespace is removed', () => {
  expect(textProblem('a\nPASS\n\n  \t\n', { lastLine: 'PASS' }, 'stdout')).toBeUndefined()
  expect(textProblem('a\r\nPASS\r\n', { lastLine: 'PASS' }, 'stdout')).toBeUndefined()
  expect(textProblem('PASS', { lastLine: 'PASS' }, 'stdout')).toBeUndefined()
})

test('lastLine fails on an earlier line, a different line or a leading-space difference', () => {
  const problem = textProblem('PASS\nFAIL 1', { lastLine: 'PASS' }, 'stdout')
  expect(problem).toContain('lastLine')
  expect(problem).toContain('stdout')
  expect(problem).toContain('FAIL 1')
  expect(textProblem('a\n  PASS', { lastLine: 'PASS' }, 'stdout')).toContain('lastLine')
  expect(textProblem('', { lastLine: 'PASS' }, 'stdout')).toContain('lastLine')
})

test('equals compares the whole text after trailing whitespace is removed', () => {
  expect(textProblem('one\ntwo  \n\n', { equals: 'one\ntwo' }, 'notes.md')).toBeUndefined()
  expect(textProblem('  \n', { equals: '' }, 'stderr')).toBeUndefined()
  expect(textProblem('', { equals: '' }, 'stderr')).toBeUndefined()
  const problem = textProblem('one\ntwo', { equals: 'one' }, 'notes.md')
  expect(problem).toContain('equals')
  expect(problem).toContain('notes.md')
  expect(textProblem('warning: x', { equals: '' }, 'stderr')).toContain('equals')
  expect(textProblem(' ok', { equals: 'ok' }, 'stdout')).toContain('equals')
})

// On 2026-10-22 a headless probe declared equals "A\n" for a file holding exactly A and a newline. The text side was trimmed
// and the expected side was not, so the check could never hold; the node failed and the main model rewrote the check.
test('trailing whitespace of the expected lastLine or equals is ignored as the text\'s is', () => {
  expect(textProblem('A\n', { equals: 'A\n' }, 'a.txt')).toBeUndefined()
  expect(textProblem('A', { equals: 'A\r\n' }, 'a.txt')).toBeUndefined()
  expect(textProblem('', { equals: ' \n' }, 'stderr')).toBeUndefined()
  expect(textProblem('a\nPASS\n', { lastLine: 'PASS\n' }, 'notes.md')).toBeUndefined()
  expect(textProblem('a\nPASS', { lastLine: 'PASS  ' }, 'notes.md')).toBeUndefined()
  // Only the end is trimmed: a leading or inner difference still fails, as does a different value.
  expect(textProblem('A\n', { equals: ' A\n' }, 'a.txt')).toContain('equals')
  expect(textProblem('A B\n', { equals: 'A  B\n' }, 'a.txt')).toContain('equals')
  expect(textProblem('B\n', { equals: 'A\n' }, 'a.txt')).toContain('equals')
  expect(textProblem('FAIL\n', { lastLine: 'PASS\n' }, 'notes.md')).toContain('lastLine')
})

test('with several fields the failing one is named even when the others hold', () => {
  const problem = textProblem(report, { contains: 'parse', absent: 'lint', lastLine: 'PASS 2 of 2' }, 'stdout')
  expect(problem).toContain('absent')
  expect(problem).not.toContain('lastLine')
  expect(textProblem(report, { contains: 'parse', lastLine: 'PASS 1 of 2' }, 'stdout')).toContain('lastLine')
})

test('a problem never quotes more than 120 characters of the text', () => {
  const long = 'x'.repeat(1_000)
  for (const textExpect of [{ equals: 'y' }, { lastLine: 'y' }, { contains: 'y' }, { matches: '^y$' }]) {
    const problem = textProblem(`${long}\n${long}`, textExpect, 'stdout') ?? ''
    expect(problem).not.toBe('')
    expect(problem).not.toContain('x'.repeat(121))
  }
  const absentProblem = textProblem(`${long}TODO${long}`, { absent: 'TODO' }, 'stdout') ?? ''
  expect(absentProblem).toContain('absent')
  expect(absentProblem).not.toContain('x'.repeat(121))
})

test('without an exit expectation only exit code 0 is accepted', () => {
  expect(exitProblem(0)).toBeUndefined()
  expect(exitProblem(0, {})).toBeUndefined()
  expect(exitProblem(0, { stdout: { contains: 'ok' } })).toBeUndefined()
  expect(exitProblem(1)).toContain('1')
  expect(exitProblem(2, { stdout: { contains: 'ok' } })).toContain('2')
})

test('a single accepted exit code replaces 0', () => {
  expect(exitProblem(1, { exit: 1 })).toBeUndefined()
  expect(exitProblem(0, { exit: 1 })).toContain('0')
})

test('a list of accepted exit codes accepts each of them and nothing else', () => {
  expect(exitProblem(0, { exit: [0, 1] })).toBeUndefined()
  expect(exitProblem(1, { exit: [0, 1] })).toBeUndefined()
  const problem = exitProblem(2, { exit: [0, 1] })
  expect(problem).toContain('2')
  expect(problem).toContain('0')
  expect(problem).toContain('1')
})

test('a program that did not run or timed out always fails', () => {
  expect(exitProblem(undefined)).not.toBeUndefined()
  expect(exitProblem(undefined, { exit: [0, 1, 2] })).not.toBeUndefined()
  expect(exitProblem(undefined, { exit: 1 })).toContain('did not run')
})

test('an invalid matches source is refused at parse with invalid_verification', () => {
  for (const check of [
    { kind: 'file', path: 'a.md', matches: '(' },
    { kind: 'file', path: 'a.md', matches: '[a-' },
    { kind: 'command', argv: ['bun', 'test'], expect: { stdout: { matches: '*x' } } },
    { kind: 'command', argv: ['bun', 'test'], expect: { stderr: { matches: '(?<' } } },
  ]) {
    const parsed = parseChecks([check])
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.error.code).toBe('invalid_verification')
      expect(parsed.error.message).toContain('matches')
    }
  }
  expect(parseChecks([{ kind: 'file', path: 'a.md', matches: '^ok \\d+$' }]).ok).toBe(true)
})

test('missingProgram names a bare program the host could not start or a shell could not find, and nothing else', () => {
  const evidence = (check: VerificationCheck, detail: string, exitCode?: number): VerificationEvidence => ({ check, passed: false, checkedAt: 0, detail, ...(exitCode !== undefined ? { exitCode } : {}) })
  const sh: VerificationCheck = { kind: 'command', argv: ['bash', '-c', 'rg x'] }
  expect(missingProgram(evidence({ kind: 'command', argv: ['rg', 'x'] }, 'Verification could not run: spawn rg ENOENT'))).toBe('rg')
  expect(missingProgram(evidence(sh, 'exit code 127 is not accepted\n["bash"] exited 127\n\nbash: rg: command not found', 127))).toBe('rg')
  expect(missingProgram(evidence(sh, 'sh: 1: jq: not found', 127))).toBe('jq')
  expect(missingProgram(evidence(sh, 'zsh:1: command not found: fd', 127))).toBe('fd')
  // A path the node may have been meant to build, a timeout, an accepted 127 and another exit code are no check defect.
  expect(missingProgram(evidence({ kind: 'command', argv: ['./dist/cli'] }, 'Verification could not run: spawn ./dist/cli ENOENT'))).toBeUndefined()
  expect(missingProgram(evidence({ kind: 'command', argv: ['bun', 'test'] }, 'Verification could not run: timed out after 30000 ms'))).toBeUndefined()
  expect(missingProgram(evidence({ ...sh, expect: { exit: [1, 127] } }, 'bash: rg: command not found', 127))).toBeUndefined()
  expect(missingProgram(evidence(sh, 'bash: rg: command not found', 1))).toBeUndefined()
  expect(missingProgram({ ...evidence(sh, 'bash: rg: command not found', 127), passed: true })).toBeUndefined()
  expect([isCheckDefect('check-defect: rg'), isCheckDefect('  Check-Defect - x'), isCheckDefect('implementation'), isCheckDefect(undefined)]).toEqual([true, true, false, false])
})

test('observed command failures distinguish project inputs from dependency and environment hints', () => {
  const details = [
    "Error: Cannot find module './dist/cli'",
    "Error: Cannot find module 'sqlite3'",
    "ModuleNotFoundError: No module named 'requests'",
    'Error: connect ECONNREFUSED 127.0.0.1:5432',
    'Error: listen EADDRINUSE: address already in use',
    'EACCES: permission denied',
  ]
  const items: VerificationEvidence[] = details.map(detail => ({
    check: { kind: 'command', argv: ['bun', 'test'] }, outcome: 'failed', passed: false, checkedAt: 0,
    exitCode: 1, detail: `exit code 1 is not accepted\n["bun","test"] exited 1\n${detail}`,
  }))
  expect(observedFailures(items).map(item => [item.check, item.kind])).toEqual([
    [1, 'project-input'], [2, 'dependency'], [3, 'dependency'], [4, 'service-unavailable'], [5, 'port-conflict'], [6, 'permission'],
  ])
})

test('failure hints exclude claims, successful checks, timeouts and expectation text', () => {
  const item: VerificationEvidence = {
    check: { kind: 'command', argv: ['bun', 'test'] }, outcome: 'failed', passed: false, checkedAt: 0,
    exitCode: 1, detail: 'stdout: contains "ECONNREFUSED" not found\n["bun","test"] exited 1\nAssertion failed',
  }
  expect(observedFailures([
    item,
    { ...item, detail: 'Timed out after 30000 ms' },
    { ...item, detail: 'ECONNREFUSED', exitCode: 0 },
    { ...item, detail: 'ECONNREFUSED', passed: true, outcome: 'passed' },
    { ...item, detail: 'ECONNREFUSED', outcome: 'unknown' },
    { ...item, detail: 'ECONNREFUSED', check: { kind: 'file', path: 'result.txt' } },
  ])).toEqual([])
})

// What a bun run prints: passing lines, then a failing test with its error, then more passing lines and the totals last.
const passing = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => `(pass) payments > case ${from + index} [0.12ms]`)
const FAILED_TEST = '(fail) payments > refunds a partial amount [3.1ms]'
const ASSERTION = 'AssertionError: expected 5 to equal 6'
const MARKER = /^\[\.\.\. (\d+) characters left out \.\.\.\]$/m

test('text within the limit comes back unchanged', () => {
  const text = ['["bun","test"] exited 1', FAILED_TEST, ASSERTION, ' 1 fail'].join('\n')
  expect(commandDetail(text)).toBe(text)
  expect(commandDetail('x'.repeat(4_000))).toBe('x'.repeat(4_000))
  expect(commandDetail('')).toBe('')
})

test('a long output keeps its first line, the failure lines from the middle and the totals at the end', () => {
  const lines = ['["claude","plugin","test","."] exited 1', ...passing(0, 150), FAILED_TEST, ASSERTION, ...passing(150, 300), ' 299 pass', ' 1 fail']
  const text = lines.join('\n')
  expect(text.length).toBeGreaterThan(10_000)
  const detail = commandDetail(text)
  expect(detail.length).toBeLessThanOrEqual(4_000)
  expect(detail.startsWith('["claude","plugin","test","."] exited 1\n')).toBe(true)
  expect(detail.endsWith('\n 299 pass\n 1 fail')).toBe(true)
  expect(detail).toMatch(MARKER)
  // The three parts keep their order: head, then the marker, then the failure lines, then the tail.
  const at = [detail.indexOf('exited 1'), detail.search(MARKER), detail.indexOf(FAILED_TEST), detail.indexOf(ASSERTION), detail.lastIndexOf(' 299 pass')]
  expect(at.every((place, index) => place >= 0 && (index === 0 || place > (at[index - 1] ?? 0)))).toBe(true)
  // Passing lines from the middle are what gets left out.
  expect(detail).not.toContain('payments > case 100 ')
  // What the marker counts is every character no part shows: the head, the two failure lines and the tail are shown.
  const [before = '', count = '', after = ''] = detail.split(MARKER)
  const tail = after.slice(`\n${FAILED_TEST}\n${ASSERTION}\n`.length)
  expect(Number(count)).toBe(text.length - (before.length - 1) - FAILED_TEST.length - ASSERTION.length - tail.length)
})

test('the marker counts exactly the characters of the output that no part shows', () => {
  const text = 'x'.repeat(10_000)
  const [head = '', marker = '', tail = ''] = commandDetail(text).split('\n')
  expect(head.length).toBeGreaterThan(900)
  expect(head.length).toBeLessThanOrEqual(1_000)
  expect(Number(MARKER.exec(marker)?.[1])).toBe(text.length - head.length - tail.length)
})

test('a long output without failure lines keeps its head and its tail only', () => {
  const text = Array.from({ length: 2_000 }, (_, index) => `line ${index + 1}`).join('\n')
  const detail = commandDetail(text)
  expect(detail.length).toBeLessThanOrEqual(4_000)
  expect(detail.startsWith('line 1\nline 2\n')).toBe(true)
  expect(detail.endsWith('\nline 1999\nline 2000')).toBe(true)
  const parts = detail.split(MARKER)
  expect(parts.length).toBe(3)
  expect(detail).not.toContain('line 1000\n')
  // With nothing to show from the middle, the tail takes the budget the failure lines would have had.
  expect(parts[2]?.length).toBeGreaterThan(2_500)
})

test('a failure line is kept once, even when the longer tail would have reached it', () => {
  const late = '(fail) payments > late failure [1ms]'
  const text = [...passing(0, 230), late, ...passing(230, 300), ' 1 fail'].join('\n')
  const detail = commandDetail(text)
  expect(detail.length).toBeLessThanOrEqual(4_000)
  expect(detail.split(late).length - 1).toBe(1)
  expect(detail.endsWith(' 1 fail')).toBe(true)
})

test('a flood of failure lines leaves the totals and a run of the last lines intact', () => {
  const text = [...Array.from({ length: 400 }, (_, index) => `(fail) suite > case ${index} [1ms]`), ' 400 fail'].join('\n')
  const detail = commandDetail(text)
  expect(detail.length).toBeLessThanOrEqual(4_000)
  expect(detail).toMatch(MARKER)
  // The failure lines take a quarter of the limit at most, so the tail still holds the last 59 cases and the totals unbroken.
  expect(detail.split('\n').slice(-60)).toEqual([...Array.from({ length: 59 }, (_, index) => `(fail) suite > case ${341 + index} [1ms]`), ' 400 fail'])
})

test('a failure line is recognised by its start or by the error it names, and only in the middle', () => {
  const runner = ['FAIL  tests/a.test.ts', 'not ok 7 - parses', 'TypeError: x is not a function', 'AssertionError [ERR_ASSERTION]: boom', '  (fail) indented']
  const noise = ['(pass) fine', 'ok 1 fine', 'a failing word and a Fail without the colon', 'unfail', 'error: lower case']
  const text = ['head', ...passing(0, 100), ...runner, ...noise.flatMap(line => [line, ...passing(0, 1)]), ...passing(100, 300), 'tail'].join('\n')
  const detail = commandDetail(text)
  for (const line of runner) expect(detail).toContain(line)
  for (const line of noise) expect(detail).not.toContain(`${line}\n`)
})

test('a pytest FAILED line from the middle is kept next to the FAIL lines of other runners', () => {
  const pytest = 'FAILED tests/test_pay.py::test_refund - assert 5 == 6'
  const text = ['============ test session starts ============', ...passing(0, 150), pytest, ...passing(150, 300), '1 failed, 299 passed in 4.21s'].join('\n')
  const detail = commandDetail(text)
  expect(detail.length).toBeLessThanOrEqual(4_000)
  expect(detail).toContain(`\n${pytest}\n`)
  expect(detail.endsWith('\n1 failed, 299 passed in 4.21s')).toBe(true)
})

test('a first line longer than the head share is kept whole, up to half of what the detail can show', () => {
  const command = `["bash","-c","${'x'.repeat(1_400)}"] exited 1`
  const detail = commandDetail([command, ...passing(0, 300), ' 1 fail'].join('\n'))
  expect(detail.length).toBeLessThanOrEqual(4_000)
  expect(detail.startsWith(`${command}\n`)).toBe(true)
  expect(detail.endsWith('\n 1 fail')).toBe(true)
  // A first line past the bound is cut there, so it cannot take the room of the failure lines and the totals.
  const huge = commandDetail(['y'.repeat(5_000), FAILED_TEST, ...passing(0, 300), ' 1 fail'].join('\n'))
  expect(huge.length).toBeLessThanOrEqual(4_000)
  expect(huge).toContain(`\n${FAILED_TEST}\n`)
  expect(huge.endsWith('\n 1 fail')).toBe(true)
  expect(huge.startsWith('y'.repeat(1_900))).toBe(true)
  expect(huge).not.toContain('y'.repeat(2_000))
})

test('a long failure line is clipped, so it neither floods the failure lines nor hides the next one', () => {
  const second = '(fail) payments > second failure [1ms]'
  const text = [...passing(0, 100), `AssertionError: ${'y'.repeat(2_000)}`, second, ...passing(100, 300), ' 2 fail'].join('\n')
  const detail = commandDetail(text)
  expect(detail.length).toBeLessThanOrEqual(4_000)
  expect(detail).toContain(`AssertionError: ${'y'.repeat(100)}`)
  expect(detail).not.toContain('y'.repeat(300))
  expect(detail).toContain(`\n${second}\n`)
})

test('a line the head cut in two is not shown again as a failure line', () => {
  const text = ['Error: boom '.repeat(100), ...passing(0, 300)].join('\n')
  const [head = '', , afterMarker = ''] = commandDetail(text).split(MARKER)
  expect(head.startsWith('Error: boom Error: boom ')).toBe(true)
  expect(afterMarker).not.toContain('Error: boom')
})

test('a smaller limit is kept too, and a limit within the text changes nothing', () => {
  const text = Array.from({ length: 300 }, (_, index) => `line ${index}`).join('\n')
  const detail = commandDetail(text, 600)
  expect(detail.length).toBeLessThanOrEqual(600)
  expect(detail.endsWith('\nline 299')).toBe(true)
  expect(commandDetail(text, text.length)).toBe(text)
})
