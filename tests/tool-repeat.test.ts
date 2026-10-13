import { expect, test } from 'claude-code/testing'
import { failedCheckFingerprint, repeatCheck, verificationCommand } from '../hooks/engine/tool-repeat.ts'

test('only simple verification commands qualify for repeat observations', () => {
  for (const command of ['bun test tests/a.test.ts', 'npm run test -- --runInBand', 'pnpm test', 'command claude plugin test .', 'tsc -p . --noEmit']) {
    expect(verificationCommand(command)).toBe(true)
  }
  for (const command of ['bun test --watch', 'bun test -u', 'bun test --update-snapshots', 'npm install && npm test', 'bun test; touch a', 'bun test >out', 'X=1 bun test', 'echo bun test', 'bun test $(x)', 'bun run build', 'tsc']) {
    expect(verificationCommand(command)).toBe(false)
  }
})

test('only complete explicitly exited Bash failures have fingerprints', () => {
  const reply = { isError: true, text: 'Exit code 1\nAssertionError: expected 2, got 1' }
  expect(failedCheckFingerprint(reply)).toBeDefined()
  for (const invalid of [
    { ...reply, isError: false }, { ...reply, text: undefined }, { ...reply, text: 'permission denied' },
    { ...reply, text: 'Exit code 0\nok' }, { ...reply, text: 'Exit code 137\nkilled' },
    { ...reply, text: 'Exit code 1\noutput truncated' }, { ...reply, text: 'Exit code 1\nbackground task running' },
    { ...reply, result: { interrupted: true } }, { ...reply, result: { persistedOutputPath: '/tmp/full' } },
    { ...reply, text: 'Exit code 1\n' + 'x'.repeat(16_000) },
  ]) expect(failedCheckFingerprint(invalid)).toBeUndefined()
})

test('identical failures warn once and changed failures restart the observation', () => {
  const first = repeatCheck(undefined, 'a')
  const second = repeatCheck(first.record, 'a')
  const third = repeatCheck(second.record, 'a')
  const changed = repeatCheck(third.record, 'b')
  expect([first.warn, second.warn, third.warn, changed.warn]).toEqual([false, true, false, false])
  expect(first.record.noted).toBe(false)
  expect(repeatCheck(changed.record, 'b').warn).toBe(true)
})

test('colors and recognized runner timings do not change a failure fingerprint', () => {
  const text = 'Exit code 1\n(fail) arithmetic [12.3ms]\nExpected: 2\nReceived: 1\nRan 1 test across 1 file. [14.0ms]\nTime: 1.23 s\n2026-10-13T02:00:00.123Z ERROR arithmetic'
  const changed = text.replace('12.3ms', '98.1ms').replace('14.0ms', '101.2ms').replace('1.23 s', '2.00 s')
    .replace('02:00:00.123Z', '02:01:45.789Z')
  const before = failedCheckFingerprint({ isError: true, text })
  expect(before).toBeDefined()
  expect(failedCheckFingerprint({ isError: true, text: `\x1b[31m${changed}\x1b[0m` })).toBe(before)
  for (const difference of [
    text.replace('Expected: 2', 'Expected: 3'), text.replace('Received: 1', 'Received: 2'),
    text.replace('arithmetic', 'division'), text.replace('Ran 1 test', 'Ran 2 tests'),
    text.replace('Exit code 1', 'Exit code 2'),
  ]) expect(failedCheckFingerprint({ isError: true, text: difference })).not.toBe(before)
})

test('time-valued expectations, test names and unrecognized timestamps stay significant', () => {
  for (const pair of [
    ['Expected: 12ms', 'Expected: 13ms'],
    ['Received: 2026-10-13T00:00:00Z', 'Received: 2026-10-14T00:00:00Z'],
    ['(fail) timeout 5s [2ms]', '(fail) timeout 6s [3ms]'],
    ['value: [2ms]', 'value: [3ms]'],
  ]) {
    expect(failedCheckFingerprint({ isError: true, text: `Exit code 1\n${pair[0]}` }))
      .not.toBe(failedCheckFingerprint({ isError: true, text: `Exit code 1\n${pair[1]}` }))
  }
})
