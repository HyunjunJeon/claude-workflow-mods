import type { JevEvaluation } from './jev.ts'

// A mutable accumulator for outstanding calls only, never a cache of resolved permission decisions.
export type PendingJevCall = {
  readonly controller: AbortController
  readonly promise: Promise<JevEvaluation>
  waiters: number
}

export function shareJevCall(calls: Map<string, PendingJevCall>, key: string, start: (signal: AbortSignal) => Promise<JevEvaluation>, signal?: AbortSignal): Promise<JevEvaluation> {
  const stopped = (): JevEvaluation => ({ choices: new Map(), outcome: 'timeout', latencyMs: 0 })
  if (signal?.aborted) return Promise.resolve(stopped())
  let pending = calls.get(key)
  if (!pending) {
    const controller = new AbortController()
    // Launch on the next microtask so a waiter can cancel before any backend work starts.
    const promise = Promise.resolve().then(() => controller.signal.aborted ? stopped() : start(controller.signal))
    pending = { controller, promise, waiters: 0 }
    calls.set(key, pending)
    const entry = pending
    const remove = () => { if (calls.get(key) === entry) calls.delete(key) }
    promise.then(remove, remove)
  }
  const entry = pending
  entry.waiters++
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (result: JevEvaluation | undefined, error?: unknown) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      entry.controller.signal.removeEventListener('abort', abort)
      entry.waiters--
      if (entry.waiters === 0) {
        if (calls.get(key) === entry) calls.delete(key)
        entry.controller.abort()
      }
      if (result) resolve(result)
      else reject(error)
    }
    const abort = () => finish(stopped())
    signal?.addEventListener('abort', abort, { once: true })
    entry.controller.signal.addEventListener('abort', abort, { once: true })
    entry.promise.then(result => finish(result), error => finish(undefined, error))
  })
}
