import { expect, test } from 'claude-code/testing'
import { exitProblem, textProblem } from '../hooks/engine/check-eval.ts'
import { parseChecks } from '../hooks/engine/verification.ts'

const report = 'building\nok 1 parse\nok 2 lint\n\nPASS 2 of 2\n'

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
