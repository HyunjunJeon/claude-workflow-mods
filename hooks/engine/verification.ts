import { fail, TEXT_FIELDS, type CommandExpect, type Definition, type EngineError, type Result, type TextExpect, type VerificationCheck } from './types.ts'

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
// contains, absent and matches with empty text would hold for every text; lastLine and equals may be '' (an empty stderr is a real check).
const NONEMPTY_TEXT_FIELDS = new Set<string>(['contains', 'absent', 'matches'])
const FILE_FIELDS = new Set<string>(['kind', 'path', ...TEXT_FIELDS])
const COMMAND_FIELDS = new Set<string>(['kind', 'argv', 'expect'])
const EXPECT_FIELDS = new Set<string>(['exit', 'stdout', 'stderr'])

// "contains, absent, matches, lastLine or equals", for messages that name every text field.
export const TEXT_FIELD_LIST = `${TEXT_FIELDS.slice(0, -1).join(', ')} or ${TEXT_FIELDS[TEXT_FIELDS.length - 1]}`

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string }

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
    if (unknown !== undefined) return { ok: false, message: `unknown field "${unknown}" in a command check; use argv and expect.` }
    const { argv } = raw
    if (!Array.isArray(argv) || !argv.every((arg: unknown): arg is string => typeof arg === 'string') || (argv[0] ?? '').trim() === '') {
      return { ok: false, message: 'argv must be a nonempty array of strings whose first item names the program.' }
    }
    if (raw.expect === undefined) return { ok: true, value: { kind: 'command', argv: [...argv] } }
    const expectation = parseExpect(raw.expect)
    if (!expectation.ok) return expectation
    return { ok: true, value: { kind: 'command', argv: [...argv], expect: expectation.value } }
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
