import type { CommandExpect, TextExpect } from './types.ts'

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
