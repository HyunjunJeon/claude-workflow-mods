import { expect, test } from 'claude-code/testing'
import { shareJevCall, type PendingJevCall } from '../hooks/engine/jev-calls.ts'
import type { JevEvaluation } from '../hooks/engine/jev.ts'

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('Promise not initialized') }
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

const ANSWER: JevEvaluation = { choices: new Map([['permission', { choice: 'allow', confidence: 1 }]]), outcome: 'answered', latencyMs: 1 }

test('identical outstanding calls share work but completed decisions are never reused', async () => {
  const calls = new Map<string, PendingJevCall>()
  const entered = deferred<void>()
  const result = deferred<JevEvaluation>()
  let starts = 0
  const start = () => { starts++; entered.resolve(); return result.promise }
  const first = shareJevCall(calls, 'same', start)
  const second = shareJevCall(calls, 'same', start)
  await entered.promise
  expect(starts).toBe(1)
  result.resolve(ANSWER)
  expect(await Promise.all([first, second])).toEqual([ANSWER, ANSWER])
  expect(calls.size).toBe(0)
  await shareJevCall(calls, 'same', start)
  expect(starts).toBe(2)
})

test('different request identities do not share work', async () => {
  const calls = new Map<string, PendingJevCall>()
  const result = deferred<JevEvaluation>()
  const entered = deferred<void>()
  let starts = 0
  const start = () => { if (++starts === 2) entered.resolve(); return result.promise }
  const first = shareJevCall(calls, 'scope-a', start)
  const second = shareJevCall(calls, 'scope-b', start)
  await entered.promise
  expect(starts).toBe(2)
  result.resolve(ANSWER)
  await Promise.all([first, second])
})

test('canceling one waiter leaves another waiter and the backend alive', async () => {
  const calls = new Map<string, PendingJevCall>()
  const entered = deferred<AbortSignal>()
  const result = deferred<JevEvaluation>()
  const controller = new AbortController()
  const start = (signal: AbortSignal) => { entered.resolve(signal); return result.promise }
  const first = shareJevCall(calls, 'same', start, controller.signal)
  const second = shareJevCall(calls, 'same', start)
  const backendSignal = await entered.promise
  controller.abort()
  expect((await first).outcome).toBe('timeout')
  expect(backendSignal.aborted).toBe(false)
  result.resolve(ANSWER)
  expect(await second).toEqual(ANSWER)
})

test('the last canceled waiter aborts shared work and late results cannot remove a replacement', async () => {
  const calls = new Map<string, PendingJevCall>()
  const entered = deferred<AbortSignal>()
  const oldResult = deferred<JevEvaluation>()
  const newResult = deferred<JevEvaluation>()
  const controller = new AbortController()
  const first = shareJevCall(calls, 'same', signal => { entered.resolve(signal); return oldResult.promise }, controller.signal)
  const backendSignal = await entered.promise
  controller.abort()
  expect((await first).outcome).toBe('timeout')
  expect(backendSignal.aborted).toBe(true)
  const nextEntered = deferred<void>()
  const second = shareJevCall(calls, 'same', () => { nextEntered.resolve(); return newResult.promise })
  await nextEntered.promise
  oldResult.resolve(ANSWER)
  await oldResult.promise
  expect(calls.size).toBe(1)
  newResult.resolve(ANSWER)
  expect(await second).toEqual(ANSWER)
})

test('a pre-aborted call never launches backend work', async () => {
  const calls = new Map<string, PendingJevCall>()
  const controller = new AbortController()
  controller.abort()
  let starts = 0
  const result = await shareJevCall(calls, 'same', async () => { starts++; return ANSWER }, controller.signal)
  expect([result.outcome, starts, calls.size]).toEqual(['timeout', 0, 0])
})
