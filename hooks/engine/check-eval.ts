import type { CommandExpect, TextExpect, VerificationEvidence } from './types.ts'

// A problem quotes at most this many characters of any one text, so a large stdout or file cannot flood the report.
const QUOTE_LIMIT = 120

function quote(text: string): string {
  const chars = [...text]
  return JSON.stringify(chars.length > QUOTE_LIMIT ? `${chars.slice(0, QUOTE_LIMIT).join('')}...` : text)
}

// The text a check compares: trailing whitespace (spaces, tabs, CR and LF) is not part of it.
function trimEnd(text: string): string {
  return text.replace(/\s+$/, '')
}

// Undefined when every given field holds; otherwise the first failing field, in the order contains, absent, matches, lastLine, equals.
export function textProblem(text: string, expect: TextExpect, label: string): string | undefined {
  if (expect.contains !== undefined && !text.includes(expect.contains)) {
    return `${label}: contains ${quote(expect.contains)} not found`
  }
  if (expect.absent !== undefined) {
    const at = text.indexOf(expect.absent)
    if (at >= 0) return `${label}: absent ${quote(expect.absent)} found on line ${text.slice(0, at).split('\n').length}`
  }
  if (expect.matches !== undefined) {
    let pattern: RegExp
    try {
      pattern = new RegExp(expect.matches, 'm')
    } catch {
      return `${label}: matches ${quote(expect.matches)} is not a valid regular expression`
    }
    if (!pattern.test(text)) return `${label}: matches /${expect.matches.slice(0, QUOTE_LIMIT)}/m found no match`
  }
  const trimmed = trimEnd(text)
  if (expect.lastLine !== undefined) {
    const last = trimmed.slice(trimmed.lastIndexOf('\n') + 1)
    if (last !== expect.lastLine) return `${label}: lastLine expected ${quote(expect.lastLine)}, got ${quote(last)}`
  }
  if (expect.equals !== undefined && trimmed !== expect.equals) {
    return `${label}: equals expected ${quote(expect.equals)}, got ${quote(trimmed)}`
  }
  return undefined
}

// code undefined: the program did not start or timed out, which no expectation accepts. Without expect.exit only 0 passes.
export function exitProblem(code: number | undefined, expect?: CommandExpect): string | undefined {
  if (code === undefined) return 'the program did not run or timed out'
  const accepted = expect?.exit === undefined ? [0] : Array.isArray(expect.exit) ? expect.exit : [expect.exit]
  return accepted.includes(code) ? undefined : `exit code ${code} is not accepted (expected ${accepted.join(' or ')})`
}

// A failure that starts with this word is a defect of the check, not of the node's work: a retry, even on Opus, runs the
// same check and fails again. On 2026-10-10 two eval runs spent 94 s and 117 s on such Opus retries before an amend fixed
// the check. Recovery leaves these nodes failed, and the settle message asks the main conversation to amend the check.
export const CHECK_DEFECT = 'check-defect'

export function isCheckDefect(error: string | undefined): boolean {
  return error !== undefined && error.trimStart().toLowerCase().startsWith(CHECK_DEFECT)
}

const NAME = '([A-Za-z_][\\w.+-]*)'
// How bash, dash and zsh say a script called a command they cannot find; each exits 127.
const SHELL_NOT_FOUND = [new RegExp(`\\b${NAME}: command not found`), new RegExp(`command not found: ${NAME}`), new RegExp(`: \\d+: ${NAME}: not found`)]
const START_FAILED = /ENOENT|not found|no such file/i

// The bare-named program a failed command check could not find: the host could not start argv[0], or the check's shell
// exited 127 naming a command it could not find. A path such as ./dist/cli is left out, since producing it may have been
// the node's job and a retry can still help; so is a check that lists 127 among its accepted exit codes.
export function missingProgram(item: VerificationEvidence): string | undefined {
  if (item.passed || item.check.kind !== 'command') return undefined
  const program = item.check.argv[0] ?? ''
  if (item.exitCode === undefined) {
    return /^[A-Za-z_][\w.+-]*$/.test(program) && item.detail.startsWith('Verification could not run') && START_FAILED.test(item.detail) ? program : undefined
  }
  const accepted = item.check.expect?.exit
  if (item.exitCode !== 127 || accepted === 127 || (Array.isArray(accepted) && accepted.includes(127))) return undefined
  for (const pattern of SHELL_NOT_FOUND) {
    const name = pattern.exec(item.detail)?.[1]
    if (name) return name
  }
  return undefined
}
