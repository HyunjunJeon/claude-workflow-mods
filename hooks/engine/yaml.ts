export class YamlError extends Error {}

type Row = { indent: number; content: string; line: number }

const BLOCK_SCALAR = /^([|>])([-+]?)$/
const MAPPING_ENTRY = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"[\]{},:-][^:]*?|-[^\s:][^:]*?)\s*:(?:\s+(.*))?$/

function stripComment(text: string): string {
  let quote: string | undefined
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\' && quote === '"') i++
      else if (ch === quote) quote = undefined
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '#' && (i === 0 || /\s/.test(text[i - 1] ?? ''))) return text.slice(0, i).trimEnd()
  }
  return text.trimEnd()
}

function isSequenceItem(content: string): boolean {
  return content === '-' || content.startsWith('- ')
}

class Parser {
  private index = 0
  private override: Row | undefined

  constructor(private readonly lines: string[]) {}

  fail(line: number, message: string): never {
    throw new YamlError(`YAML line ${line}: ${message}`)
  }

  peek(): Row | undefined {
    if (this.override) return this.override
    while (this.index < this.lines.length) {
      const raw = this.lines[this.index] as string
      if (/^\s*\t/.test(raw)) this.fail(this.index + 1, 'tabs are not allowed for indentation')
      const content = stripComment(raw.trim())
      if (content !== '') return { indent: raw.length - raw.trimStart().length, content, line: this.index + 1 }
      this.index++
    }
    return undefined
  }

  advance(): void {
    if (this.override) this.override = undefined
    else this.index++
  }

  value(indent: number): unknown {
    const row = this.peek()
    if (!row) return null
    if (row.indent !== indent) this.fail(row.line, `expected indentation ${indent}, found ${row.indent}`)
    return isSequenceItem(row.content) ? this.sequence(indent) : this.mapping(indent)
  }

  sequence(indent: number): unknown[] {
    const items: unknown[] = []
    for (let row = this.peek(); row && row.indent === indent && isSequenceItem(row.content); row = this.peek()) {
      const rest = row.content.slice(1).trimStart()
      const column = indent + (row.content.length - rest.length)
      if (rest === '') {
        this.advance()
        const next = this.peek()
        items.push(next && next.indent > indent ? this.value(next.indent) : null)
      } else if (BLOCK_SCALAR.test(rest)) {
        this.advance()
        items.push(this.blockScalar(indent, rest))
      } else if (MAPPING_ENTRY.test(rest) && !rest.startsWith('[')) {
        this.advance()
        this.override = { indent: column, content: rest, line: row.line }
        items.push(this.mapping(column))
      } else {
        this.advance()
        items.push(this.scalar(rest, row.line))
      }
    }
    return items
  }

  mapping(indent: number): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    for (let row = this.peek(); row && row.indent === indent && !isSequenceItem(row.content); row = this.peek()) {
      const match = MAPPING_ENTRY.exec(row.content)
      if (!match) this.fail(row.line, `expected "key: value", found "${row.content}"`)
      const key = this.key(match[1] as string, row.line)
      if (Object.hasOwn(result, key)) this.fail(row.line, `duplicate key "${key}"`)
      const rest = match[2]?.trim() ?? ''
      this.advance()
      if (rest === '') {
        const next = this.peek()
        if (next && next.indent > indent) result[key] = this.value(next.indent)
        else if (next && next.indent === indent && isSequenceItem(next.content)) result[key] = this.sequence(indent)
        else result[key] = null
      } else if (BLOCK_SCALAR.test(rest)) {
        result[key] = this.blockScalar(indent, rest)
      } else {
        result[key] = this.scalar(rest, row.line)
      }
    }
    return result
  }

  key(raw: string, line: number): string {
    const value = this.scalar(raw, line)
    return String(value)
  }

  blockScalar(parentIndent: number, header: string): string {
    const [, style, chomp] = BLOCK_SCALAR.exec(header) as RegExpExecArray
    const collected: string[] = []
    let contentIndent: number | undefined
    while (this.index < this.lines.length) {
      const raw = this.lines[this.index] as string
      const indent = raw.length - raw.trimStart().length
      if (raw.trim() !== '' && indent <= parentIndent) break
      if (raw.trim() !== '' && contentIndent === undefined) contentIndent = indent
      collected.push(raw)
      this.index++
    }
    const lines = collected.map(raw => (raw.trim() === '' ? '' : raw.slice(contentIndent ?? 0)))
    while (lines.length > 0 && lines.at(-1) === '' && chomp !== '+') lines.pop()
    const body = style === '|'
      ? lines.join('\n')
      : lines.reduce((acc, line, i) => (i === 0 ? line : line === '' ? acc + '\n' : acc.endsWith('\n') ? acc + line : `${acc} ${line}`), '')
    return chomp === '-' ? body : `${body}\n`
  }

  scalar(text: string, line: number): unknown {
    if (text.startsWith('"')) {
      try {
        return JSON.parse(text) as string
      } catch {
        this.fail(line, `invalid double-quoted string ${text}`)
      }
    }
    if (text.startsWith("'")) {
      if (!text.endsWith("'") || text.length < 2) this.fail(line, `unterminated single-quoted string ${text}`)
      return text.slice(1, -1).replaceAll("''", "'")
    }
    if (text.startsWith('[')) {
      if (!text.endsWith(']')) this.fail(line, `unterminated flow sequence ${text}`)
      const inner = text.slice(1, -1).trim()
      if (inner === '') return []
      return this.splitFlow(inner, line).map(part => this.scalar(part.trim(), line))
    }
    if (text.startsWith('{')) this.fail(line, 'flow mappings ({...}) are not supported; use indented keys')
    if (text === 'true') return true
    if (text === 'false') return false
    if (text === 'null' || text === '~') return null
    if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text)
    return text
  }

  splitFlow(inner: string, line: number): string[] {
    const parts: string[] = []
    let quote: string | undefined
    let start = 0
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i]
      if (quote) {
        if (ch === '\\' && quote === '"') i++
        else if (ch === quote) quote = undefined
      } else if (ch === '"' || ch === "'") quote = ch
      else if (ch === '[' || ch === '{') this.fail(line, 'nested flow collections are not supported')
      else if (ch === ',') {
        parts.push(inner.slice(start, i))
        start = i + 1
      }
    }
    parts.push(inner.slice(start))
    return parts
  }

  finish(): void {
    const row = this.peek()
    if (row) this.fail(row.line, `unexpected content "${row.content}"`)
  }
}

export function parseYaml(source: string): unknown {
  const parser = new Parser(source.replace(/\r\n?/g, '\n').split('\n'))
  const first = parser.peek()
  if (!first) return null
  const value = parser.value(first.indent)
  parser.finish()
  return value
}
