import { hash } from './hash.ts'

// Deliberately excludes shell composition, substitutions, env assignments and watch/update modes.
// This identifies a check to observe, not a promise that running tests cannot change the workspace.
export function verificationCommand(command: string): boolean {
  if (command.length > 2_000 || !/^[\w./@:=,+ -]+$/.test(command)) return false
  const words = command.trim().split(/\s+/)
  if (words.some(word => /^(?:--watch(?:=.*)?|--update(?:-snapshots)?|-u|-w)$/.test(word))) return false
  return /^(?:bun test|(?:npm|pnpm|yarn) (?:test|run test)|command claude plugin test|claude plugin test)(?: |$)/.test(words.join(' '))
    || (words[0] === 'tsc' && words.includes('--noEmit'))
}

// Bash error results are untyped in the host contract. Only its complete model-facing error with an explicit exit
// qualifies; a generic isError, a running command, a truncated output or a signal is not a repeated test failure.
export function failedCheckFingerprint(reply: { readonly isError?: boolean; readonly text?: string; readonly result?: unknown }): string | undefined {
  if (!reply.isError || !reply.text || reply.text.length > 16_000) return undefined
  const result = reply.result
  if (result !== null && typeof result === 'object') {
    if ('backgroundTaskId' in result || 'persistedOutputPath' in result || 'rawOutputPath' in result
      || ('interrupted' in result && result.interrupted === true)) return undefined
  }
  if (/truncat|output too large|background|interrupt|timed out|SIG(?:KILL|TERM|INT)/i.test(reply.text)) return undefined
  const text = reply.text.replace(/\x1b\[[0-9;]*m/g, '')
  const exit = /^Exit code:?\s+(\d+)\s*$/m.exec(text)?.[1]
  if (!exit || Number(exit) === 0 || [124, 130, 137, 143].includes(Number(exit))) return undefined
  // Runner timings and log-prefix timestamps vary independently of failure identity. Expected/actual values,
  // error codes, stack locations, test counts and free-standing time values deliberately remain significant.
  const normalized = text
    .replace(/^(\((?:pass|fail|skip)\) .*) \[\d+(?:\.\d+)?(?:ms|s)\]$/gm, '$1 [duration]')
    .replace(/^(Ran \d+ tests? across \d+ files?\.) \[\d+(?:\.\d+)?(?:ms|s)\]$/gm, '$1 [duration]')
    .replace(/^Time: +\d+(?:\.\d+)? *(?:ms|s|seconds?)$/gm, 'Time: duration')
    .replace(/^\[?20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\]? (?=(?:INFO|WARN|ERROR|DEBUG|TRACE)\b)/gm, 'timestamp ')
  return hash(normalized)
}

export type RepeatedCheck = { readonly fingerprint: string; readonly noted: boolean }

export function repeatCheck(previous: RepeatedCheck | undefined, fingerprint: string): { readonly record: RepeatedCheck; readonly warn: boolean } {
  const same = previous?.fingerprint === fingerprint
  const warn = same && !previous.noted
  return { record: { fingerprint, noted: same ? previous.noted || warn : false }, warn }
}

export const REPEAT_CHECK_NOTE = '[dag-workflow:repeat-check] The same check returned the same failure without an intervening observed change. Change the cause or gather new evidence before rerunning it. This observation does not prove that files or external services are unchanged; declared completion checks still run.'
