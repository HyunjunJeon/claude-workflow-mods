import { expect, test } from 'claude-code/testing'
import { parseHoldPercent, resetMinutes, usageHold, usageHoldField, usageLimitReason } from '../hooks/engine/usage.ts'

const NOW = Date.parse('2026-10-23T10:00:00.000Z')
const PAST = '2026-10-23T09:59:00.000Z'
const FUTURE = '2026-10-23T11:30:00.000Z'

test('a window at 92% holds at a threshold of 90', () => {
  expect(usageHold([{ kind: 'five_hour', percentUsed: 92 }], 90, NOW)).toEqual({ kind: 'five_hour', percentUsed: 92 })
})

test('a window exactly at the threshold holds', () => {
  expect(usageHold([{ kind: 'five_hour', percentUsed: 90 }], 90, NOW)).toEqual({ kind: 'five_hour', percentUsed: 90 })
})

test('a window at 80% does not hold at a threshold of 90', () => {
  expect(usageHold([{ kind: 'five_hour', percentUsed: 80 }], 90, NOW)).toBeUndefined()
})

test('a window one tenth under the threshold does not hold', () => {
  expect(usageHold([{ kind: 'seven_day', percentUsed: 89.9 }], 90, NOW)).toBeUndefined()
})

test('no readings hold nothing', () => {
  expect(usageHold([], 90, NOW)).toBeUndefined()
})

test('a threshold of 0 turns the hold off even at 99%', () => {
  expect(usageHold([{ kind: 'five_hour', percentUsed: 99 }], 0, NOW)).toBeUndefined()
})

test('a window whose reset time has passed is ignored', () => {
  expect(usageHold([{ kind: 'five_hour', percentUsed: 97, resetsAt: PAST }], 90, NOW)).toBeUndefined()
})

test('a window that resets exactly now is ignored', () => {
  expect(usageHold([{ kind: 'five_hour', percentUsed: 97, resetsAt: new Date(NOW).toISOString() }], 90, NOW)).toBeUndefined()
})

test('a window that resets later holds and keeps its reset time', () => {
  expect(usageHold([{ kind: 'five_hour', percentUsed: 97, resetsAt: FUTURE }], 90, NOW)).toEqual({ kind: 'five_hour', percentUsed: 97, resetsAt: FUTURE })
})

test('of two windows that hold, the fuller one wins', () => {
  const windows = [{ kind: 'seven_day', percentUsed: 91 }, { kind: 'five_hour', percentUsed: 96.5, resetsAt: FUTURE }]
  expect(usageHold(windows, 90, NOW)).toEqual({ kind: 'five_hour', percentUsed: 96.5, resetsAt: FUTURE })
})

test('of two windows at the same percent, the first one wins', () => {
  const windows = [{ kind: 'seven_day', percentUsed: 93 }, { kind: 'five_hour', percentUsed: 93 }]
  expect(usageHold(windows, 90, NOW)?.kind).toBe('seven_day')
})

test('a passed window does not hide a lower one that still holds', () => {
  const windows = [{ kind: 'five_hour', percentUsed: 99, resetsAt: PAST }, { kind: 'seven_day', percentUsed: 91, resetsAt: FUTURE }]
  expect(usageHold(windows, 90, NOW)).toEqual({ kind: 'seven_day', percentUsed: 91, resetsAt: FUTURE })
})

test('an exceeded spend limit at 105% holds', () => {
  expect(usageHold([{ kind: 'spend_limit', percentUsed: 105 }], 90, NOW)).toEqual({ kind: 'spend_limit', percentUsed: 105 })
})

test('an unparsable reset time still holds, with no reset time to count down to', () => {
  expect(usageHold([{ kind: 'five_hour', percentUsed: 95, resetsAt: 'soon' }], 90, NOW)).toEqual({ kind: 'five_hour', percentUsed: 95 })
})

test('the minutes to a reset round up', () => {
  expect(resetMinutes({ kind: 'five_hour', percentUsed: 95, resetsAt: '2026-10-23T10:00:01.000Z' }, NOW)).toBe(1)
  expect(resetMinutes({ kind: 'five_hour', percentUsed: 95, resetsAt: '2026-10-23T10:42:00.000Z' }, NOW)).toBe(42)
  expect(resetMinutes({ kind: 'five_hour', percentUsed: 95, resetsAt: '2026-10-23T10:42:30.000Z' }, NOW)).toBe(43)
})

test('a hold without a reset time has no minutes to count', () => {
  expect(resetMinutes({ kind: 'five_hour', percentUsed: 95 }, NOW)).toBeUndefined()
})

test('the cancel reason names the window, its percent and its reset time when known', () => {
  expect(usageLimitReason({ kind: 'five_hour', percentUsed: 95.5, resetsAt: FUTURE })).toBe(`usage limit: five_hour at 95.5%, resets at ${FUTURE}`)
  expect(usageLimitReason({ kind: 'spend_limit', percentUsed: 105 })).toBe('usage limit: spend_limit at 105%')
})

test('the tool result field carries resets_at only when the reset time is known', () => {
  expect(usageHoldField({ kind: 'five_hour', percentUsed: 95, resetsAt: FUTURE })).toEqual({ kind: 'five_hour', percent_used: 95, resets_at: FUTURE })
  expect(usageHoldField({ kind: 'seven_day', percentUsed: 91 })).toEqual({ kind: 'seven_day', percent_used: 91 })
})

// The host refuses a usage_hold_percent that is not a number from 0 to 100 before the plugin loads, so this parser, which
// register() reads the option through, is where the keep-the-default rule is proven.
test('a usage_hold_percent from 0 to 100 is taken as it is, fractions included', () => {
  expect([0, 85.5, 100].map(parseHoldPercent)).toEqual([0, 85.5, 100])
})

test('a usage_hold_percent out of range, not finite, not a number or missing keeps the default 90', () => {
  expect([150, -5, 100.1, Number.NaN, Number.POSITIVE_INFINITY, '50', null, undefined].map(parseHoldPercent)).toEqual([90, 90, 90, 90, 90, 90, 90, 90])
})
