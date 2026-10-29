import { evidenceOutcome } from './check-eval.ts'
import { fail, TEXT_FIELDS, type CommandCheck, type CommandExpect, type Definition, type EngineError, type FileCheck, type Result, type Run, type TextExpect, type VerificationCheck } from './types.ts'

// The .claude segment is refused in any letter case: on macOS and Windows .CLAUDE/dag opens the run's own checkpoints.
export function projectPath(path: string): boolean {
  const parts = path.replaceAll('\\', '/').split('/').map(part => part.toLowerCase())
  return path.length > 0 && !path.startsWith('/') && !/^[A-Za-z]:/.test(path) &&
    !parts.includes('..') && !path.includes('\0') && !parts.includes('.claude')
}

// A file check may read outside the project through an absolute POSIX or Windows drive path, but never climb with ..
// or reach the run's own checkpoints: the segment pair .claude/dag is refused in any case, since macOS and Windows fold case.
export function readOnlyAbsolutePath(path: string): boolean {
  if (!/^(\/|[A-Za-z]:[\\/])/.test(path) || path.includes('\0')) return false
  const parts = path.replaceAll('\\', '/').split('/').filter(part => part !== '' && part !== '.').map(part => part.toLowerCase())
  return !parts.includes('..') && !parts.some((part, index) => part === '.claude' && parts[index + 1] === 'dag')
}

const MAX_CHECKS = 16

// A command check's time limit. $.process.run gives a child 30 s when timeoutMs is absent and refuses more than ten minutes
// (ProcessRunInit in the Claude Code typings), so the default and the upper bound are the host's own. The lower bound keeps a
// limit from expiring before a program has started.
export const MIN_COMMAND_TIMEOUT_MS = 1_000
export const MAX_COMMAND_TIMEOUT_MS = 600_000
export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000
const TIMEOUT_MESSAGE = `timeoutMs must be a whole number of milliseconds from ${MIN_COMMAND_TIMEOUT_MS} to ${MAX_COMMAND_TIMEOUT_MS} (default ${DEFAULT_COMMAND_TIMEOUT_MS}).`

// The host rejects $.process.run with "dag-workflow: $.process.run(<program>) aborted: still running after <limit>ms" when the
// child outlives its limit; a program that cannot start is rejected with a different message.
const RAN_PAST_LIMIT = /still running after \d+ms/

// What to add to a command check's not_run detail when the host's rejection says it ran past its limit; otherwise undefined.
export function timeoutAdvice(failure: string): string | undefined {
  return RAN_PAST_LIMIT.test(failure)
    ? `If this check is slow by nature, set timeoutMs on it, up to ${MAX_COMMAND_TIMEOUT_MS} milliseconds.`
    : undefined
}
// contains, absent and matches with empty text would hold for every text; lastLine and equals may be '' (an empty stderr is a real check).
const NONEMPTY_TEXT_FIELDS = new Set<string>(['contains', 'absent', 'matches'])
const FILE_FIELDS = new Set<string>(['kind', 'path', ...TEXT_FIELDS])
const COMMAND_FIELDS = new Set<string>(['kind', 'argv', 'expect', 'timeoutMs'])
const EXPECT_FIELDS = new Set<string>(['exit', 'stdout', 'stderr'])

// "contains, absent, matches, lastLine or equals", for messages that name every text field.
export const TEXT_FIELD_LIST = `${TEXT_FIELDS.slice(0, -1).join(', ')} or ${TEXT_FIELDS[TEXT_FIELDS.length - 1]}`

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string }

// The letter escapes a check's RegExp (m flag, no u flag) gives a meaning: \d \D \w \W \s \S \b \B \n \r \t \v \f, \cX, \xHH,
// \uHHHH and \k<name>. Any other backslash-letter is an identity escape that matches the letter itself, so PCRE's and Python's
// \A, \Z and \z compile and silently match "A", "Z" and "z", and \p{L} matches "p{L}". On 2026-10-10 two eval runs each lost
// 100-125 s to a `\A# ...` check that could never pass on a correct file: an Opus retry, the settle, an amend and a rerun.
const JS_LETTER_ESCAPES = new Set('dDwWsSbBnrtvfcxuk')
const POSIX_CLASS = /^\[:[a-z]+:\]/

const FOREIGN_HINTS: Readonly<Record<string, string>> = {
  A: 'use ^ for a line start, or (?<![\\s\\S]) for the start of the text',
  Z: 'use $ for a line end, or (?![\\s\\S]) for the end of the text',
  z: 'use $ for a line end, or (?![\\s\\S]) for the end of the text',
  p: 'Unicode property escapes need the u flag, which checks do not set; use a character class such as [A-Za-z]',
  P: 'Unicode property escapes need the u flag, which checks do not set; use a negated character class',
}

// The first construct of another regex dialect that compiles in JavaScript with a different meaning, with how to write it.
export function foreignRegexSyntax(pattern: string): string | undefined {
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]
    if (char === '\\') {
      const next = pattern[index + 1] ?? ''
      if (/^[A-Za-z]$/.test(next) && !JS_LETTER_ESCAPES.has(next)) {
        return `\\${next}, which JavaScript reads as the plain letter "${next}"; ${FOREIGN_HINTS[next] ?? 'write the character class or anchor JavaScript knows'}`
      }
      index++
      continue
    }
    // Any unescaped [ may open [:name:], so the negated and mixed forms ([^[:space:]], [a-z[:digit:]]) are caught too.
    const posix = char === '[' ? POSIX_CLASS.exec(pattern.slice(index)) : null
    if (posix) return `the POSIX class ${posix[0]}, which JavaScript reads as a set of single characters; use \\d, \\s, \\w or a range such as [A-Za-z]`
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function unknownField(raw: Record<string, unknown>, allowed: Set<string>): string | undefined {
  return Object.keys(raw).find(key => !allowed.has(key))
}

// Reads the text expectation fields of raw; where names the owner in messages ('' for a file check, 'expect.stdout.' for output).
function parseTextFields(raw: Record<string, unknown>, where: string): Parsed<TextExpect> {
  const parsed: TextExpect = {}
  for (const field of TEXT_FIELDS) {
    const value = raw[field]
    if (value === undefined) continue
    if (typeof value !== 'string') return { ok: false, message: `${where}${field} must be text.` }
    if (NONEMPTY_TEXT_FIELDS.has(field) && value === '') return { ok: false, message: `${where}${field} must be nonempty text.` }
    if (field === 'matches') {
      try {
        new RegExp(value, 'm')
      } catch (error) {
        return { ok: false, message: `${where}matches is not a valid regular expression (${error instanceof Error ? error.message : String(error)}).` }
      }
      const foreign = foreignRegexSyntax(value)
      if (foreign) return { ok: false, message: `${where}matches is a JavaScript regular expression (m flag) and uses ${foreign}.` }
    }
    parsed[field] = value
  }
  return { ok: true, value: parsed }
}

function parseOutput(raw: unknown, stream: 'stdout' | 'stderr'): Parsed<TextExpect> {
  const where = `expect.${stream}`
  const empty = { ok: false, message: `${where} must be an object with at least one of ${TEXT_FIELD_LIST}.` } as const
  if (!isRecord(raw)) return empty
  const unknown = unknownField(raw, new Set(TEXT_FIELDS))
  if (unknown !== undefined) return { ok: false, message: `unknown field "${unknown}" in ${where}; use ${TEXT_FIELD_LIST}.` }
  if (!TEXT_FIELDS.some(field => raw[field] !== undefined)) return empty
  return parseTextFields(raw, `${where}.`)
}

function exitCode(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255
}

function commandTimeout(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_COMMAND_TIMEOUT_MS && value <= MAX_COMMAND_TIMEOUT_MS
}

function parseExpect(raw: unknown): Parsed<CommandExpect> {
  const empty = { ok: false, message: 'expect must be an object with at least one of exit, stdout or stderr.' } as const
  if (!isRecord(raw)) return empty
  const unknown = unknownField(raw, EXPECT_FIELDS)
  if (unknown !== undefined) return { ok: false, message: `unknown field "${unknown}" in expect; use exit, stdout or stderr.` }
  if (![...EXPECT_FIELDS].some(field => raw[field] !== undefined)) return empty
  const parsed: CommandExpect = {}
  if (raw.exit !== undefined) {
    const { exit } = raw
    if (exitCode(exit)) parsed.exit = exit
    // A list is kept sorted and without repeats, so [1, 0] and [0, 1, 1] fingerprint as the same check.
    else if (Array.isArray(exit) && exit.length > 0 && exit.every(exitCode)) parsed.exit = [...new Set(exit)].sort((a, b) => a - b)
    else return { ok: false, message: 'expect.exit must be an exit code 0-255 or a nonempty array of them.' }
  }
  for (const stream of ['stdout', 'stderr'] as const) {
    if (raw[stream] === undefined) continue
    const output = parseOutput(raw[stream], stream)
    if (!output.ok) return output
    parsed[stream] = output.value
  }
  return { ok: true, value: parsed }
}

function parseCheck(raw: unknown): Parsed<VerificationCheck> {
  if (!isRecord(raw)) return { ok: false, message: 'must be an object.' }
  if (raw.kind === 'file') {
    const unknown = unknownField(raw, FILE_FIELDS)
    if (unknown !== undefined) return { ok: false, message: `unknown field "${unknown}" in a file check; use path, ${TEXT_FIELD_LIST}.` }
    const { path } = raw
    if (typeof path !== 'string' || !(projectPath(path) || readOnlyAbsolutePath(path))) {
      return { ok: false, message: 'path must be project-relative outside .claude, or absolute with no ".." segment and outside .claude/dag.' }
    }
    const text = parseTextFields(raw, '')
    if (!text.ok) return text
    return { ok: true, value: { kind: 'file', path, ...text.value } }
  }
  if (raw.kind === 'command') {
    const unknown = unknownField(raw, COMMAND_FIELDS)
    if (unknown !== undefined) return { ok: false, message: `unknown field "${unknown}" in a command check; use argv, expect and timeoutMs.` }
    const { argv } = raw
    if (!Array.isArray(argv) || !argv.every((arg: unknown): arg is string => typeof arg === 'string') || (argv[0] ?? '').trim() === '') {
      return { ok: false, message: 'argv must be a nonempty array of strings whose first item names the program.' }
    }
    const parsed: CommandCheck = { kind: 'command', argv: [...argv] }
    if (raw.expect !== undefined) {
      const expectation = parseExpect(raw.expect)
      if (!expectation.ok) return expectation
      parsed.expect = expectation.value
    }
    if (raw.timeoutMs !== undefined) {
      if (!commandTimeout(raw.timeoutMs)) return { ok: false, message: TIMEOUT_MESSAGE }
      parsed.timeoutMs = raw.timeoutMs
    }
    return { ok: true, value: parsed }
  }
  return { ok: false, message: 'kind must be "file" or "command".' }
}

export function parseChecks(value: unknown): Result<VerificationCheck[]> {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CHECKS) {
    return fail('invalid_verification', `verify must contain 1-${MAX_CHECKS} file or command checks.`)
  }
  const checks: VerificationCheck[] = []
  for (const [index, raw] of value.entries()) {
    const parsed = parseCheck(raw)
    if (!parsed.ok) return fail('invalid_verification', `verify check ${index + 1}: ${parsed.message}`)
    checks.push(parsed.value)
  }
  return { ok: true, value: checks }
}

export function verificationProblem(definition: Definition): EngineError | undefined {
  const missing = definition.nodes.filter(node => !node.verify?.length)
  return missing.length ? {
    code: 'verification_required',
    message: `Declare verify checks for nodes: ${missing.map(node => node.id).join(', ')}. A completion report alone is not evidence; provide file or command checks.`,
  } : undefined
}

// The exit codes a command check accepts; without exit only 0 passes (exitProblem in check-eval.ts).
function acceptedExits(expect: CommandExpect | undefined): number[] {
  return expect?.exit === undefined ? [0] : Array.isArray(expect.exit) ? expect.exit : [expect.exit]
}

// How each text field of before weakened in after, prefixed by owner ('' or 'stdout.'). A field added, or made stricter
// (contains lengthened around the old text, absent shortened to part of it), is not a change worth a warning.
function textLoosening(before: TextExpect, after: TextExpect, owner: string): string[] {
  return TEXT_FIELDS.flatMap(field => {
    const old = before[field]
    const now = after[field]
    if (old === undefined || now === old) return []
    if (now === undefined) return [`loosened: ${owner}${field} removed`]
    if (field === 'contains' && old.includes(now)) return [`loosened: ${owner}contains shortened`]
    if (field === 'contains' && now.includes(old)) return []
    if (field === 'absent' && now.includes(old)) return [`loosened: ${owner}absent lengthened`]
    if (field === 'absent' && old.includes(now)) return []
    return [`replaced: ${owner}${field} changed`]
  })
}

function commandLoosening(before: CommandCheck, after: CommandCheck): string[] {
  const old = acceptedExits(before.expect)
  const now = acceptedExits(after.expect)
  // The same or a narrower set is no warning; a strict superset accepts more failures; any other set is a replacement.
  const exit = now.every(code => old.includes(code))
    ? []
    : [`${old.every(code => now.includes(code)) ? 'loosened' : 'replaced'}: exit [${old.join(',')}] -> [${now.join(',')}]`]
  const streams = (['stdout', 'stderr'] as const).flatMap(stream => {
    const was = before.expect?.[stream]
    if (was === undefined) return []
    const is = after.expect?.[stream]
    return is === undefined ? [`loosened: ${stream} removed`] : textLoosening(was, is, `${stream}.`)
  })
  return [...exit, ...streams]
}

// What weakened between a check and its pair in the amended node (same argv, or same path); undefined when it has no pair.
function pairedLoosening(check: VerificationCheck, amended: VerificationCheck[]): string[] | undefined {
  if (check.kind === 'file') {
    const pair = amended.find((other): other is FileCheck => other.kind === 'file' && other.path === check.path)
    return pair && textLoosening(check, pair, '')
  }
  const pair = amended.find((other): other is CommandCheck =>
    other.kind === 'command' && other.argv.length === check.argv.length && other.argv.every((arg, index) => arg === check.argv[index]))
  return pair && commandLoosening(check, pair)
}

// One warning per node whose amended verify weakens a check that failed on the node's latest verification: the check is
// what proves the deliverable, so loosening it can turn a wrong result into a pass. Checks that passed, did not run or
// could not be judged are ignored, since amending a defective or unrunnable check is the prescribed recovery.
export function checkLoosening(run: Run, definition: Definition): string[] {
  return run.nodes.flatMap(node => {
    // A declared definition never carries runtime-expanded children (amendRun), so their absence is not a removal.
    if (run.definition.nodes.find(def => def.id === node.id)?.expandedFrom !== undefined) return []
    const amended = definition.nodes.find(def => def.id === node.id)?.verify ?? []
    // verifyNode records one evidence item per declared check, in order, so the index is the check's position.
    const items = (node.verification?.evidence ?? []).flatMap((item, index) => {
      if (evidenceOutcome(item) !== 'failed') return []
      const changes = pairedLoosening(item.check, amended)
      return changes === undefined ? [`check ${index + 1} removed`] : changes.map(change => `check ${index + 1} ${change}`)
    })
    return items.length ? [`node "${node.id}": verify loosened - ${items.join('; ')}`] : []
  })
}
