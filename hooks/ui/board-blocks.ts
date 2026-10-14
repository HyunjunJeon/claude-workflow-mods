import type { BoardRefBlock, CalloutBlock, CalloutTone, CodeBlock, CodePeekBlock, DiffBlock, SectionBlock, TableBlock, TraceBlock, TracePart } from '../engine/board-types.ts'
import { ACCENT, clean, fit, fitTail, width, type Line, type Segment } from './text.ts'

// The text blocks of a board (section, callout, table, code_peek, code, trace, diff, board_ref, divider) as terminal lines. Every
// returned line is at most `columns` cells wide and holds no control characters, because block text comes from the model and the
// files it read.

export type CalloutLabels = Record<CalloutTone, string>

type Style = Omit<Segment, 'text'>

const TONE_COLOR: Record<CalloutTone, string> = { info: ACCENT, decision: 'green', risk: 'red', warning: 'yellow' }
const CALLOUT_BAR = '▌ '
const BULLET = '• '
const TABLE_SEPARATOR = ' │ '
const TABLE_RULE_JOIN = '─┼─'
const CODE_SEPARATOR = ' │ '
const TITLE_SEPARATOR = ' · '
const TAB = '  '
const RULE = '─'
const REF_ARROW = '→ '
// A narrower column shows too little of a cell to tell the rows apart.
const MIN_CELL = 4

const HEADING = /^#+\s+(.*)$/
const BULLET_ITEM = /^[-*]\s+(.*)$/
const NUMBERED_ITEM = /^(\d+[.)])\s+(.*)$/

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const strong = (text: string, style: Style = {}): Segment => ({ text, ...style, bold: true })
const faint = (text: string): Segment => ({ text, dim: true })
const at = (sizes: readonly number[], index: number): number => sizes[index] ?? 0

// Breaks at spaces, counting cells, and splits a word wider than `columns` where it overflows.
export function wrapText(text: string, columns: number): string[] {
  if (columns <= 0) return []
  const lines: string[] = []
  let current = ''
  for (const word of clean(text).split(/\s+/).filter(Boolean)) {
    const joined = current ? `${current} ${word}` : word
    if (width(joined) <= columns) {
      current = joined
      continue
    }
    if (current) lines.push(current)
    current = ''
    for (const { segment } of graphemes.segment(word)) {
      // A wide glyph in a one-cell column cannot be shown, so it becomes an ellipsis instead of looping forever.
      const piece = width(segment) > columns ? '…' : segment
      if (current && width(current + piece) > columns) {
        lines.push(current)
        current = ''
      }
      current += piece
    }
  }
  if (current) lines.push(current)
  return lines
}

// Layouts aim at `columns`; this trims what a very narrow pane leaves over, and strips control characters.
function clip(line: Line, columns: number): Line {
  const out: Line = []
  let used = 0
  for (const segment of line) {
    const text = clean(segment.text)
    if (!text) continue
    if (used + width(text) <= columns) {
      out.push({ ...segment, text })
      used += width(text)
      continue
    }
    const cut = fit(text, columns - used)
    if (cut) out.push({ ...segment, text: cut })
    break
  }
  return out
}

function clipAll(lines: Line[], columns: number): Line[] {
  return columns > 0 ? lines.map(line => clip(line, columns)) : []
}

function titleLines(title: string, columns: number, style: Style): Line[] {
  return wrapText(title, columns).map(part => [strong(part, style)])
}

// Renders each non-blank source line. A run of blank lines becomes one empty line, and none leads or trails.
function eachLine(text: string, render: (line: string) => Line[]): Line[] {
  const out: Line[] = []
  let gap = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) {
      gap = true
      continue
    }
    const rendered = render(line)
    if (gap && out.length > 0 && rendered.length > 0) out.push([])
    gap = false
    out.push(...rendered)
  }
  return out
}

// The marker leads the first line and the wrapped lines sit under the text, not under the marker.
function hanging(marker: string, text: string, columns: number): Line[] {
  const indent = ' '.repeat(width(marker))
  return wrapText(text, Math.max(1, columns - width(marker))).map((part, index) => [{ text: index === 0 ? marker : indent }, { text: part }])
}

function markdownLines(line: string, columns: number): Line[] {
  const heading = HEADING.exec(line)
  if (heading) return wrapText(heading[1] ?? '', columns).map(part => [strong(part)])
  const bullet = BULLET_ITEM.exec(line)
  if (bullet) return hanging(BULLET, bullet[1] ?? '', columns)
  const numbered = NUMBERED_ITEM.exec(line)
  if (numbered) return hanging(`${numbered[1]} `, numbered[2] ?? '', columns)
  return wrapText(line, columns).map(part => [{ text: part }])
}

export function sectionLines(block: SectionBlock, columns: number): Line[] {
  const title = titleLines(block.title, columns, { color: ACCENT })
  return clipAll([...title, ...eachLine(block.text ?? '', line => markdownLines(line, columns))], columns)
}

export function calloutLines(block: CalloutBlock, columns: number, labels: CalloutLabels): Line[] {
  const color = TONE_COLOR[block.tone]
  const inner = Math.max(1, columns - width(CALLOUT_BAR))
  const label = strong(fit(labels[block.tone], inner), { color })
  const parts = wrapText(block.title ?? '', inner)
  const [first] = parts
  // The title shares the label's line when it fits there, so a titled callout costs no extra row.
  const sameLine = first !== undefined && parts.length === 1 && width(label.text) + 1 + width(first) <= inner
  const head: Line[] = sameLine ? [[label, { text: ' ' }, strong(first)]] : [[label], ...parts.map(part => [strong(part)])]
  const body = eachLine(block.text, line => wrapText(line, inner).map(part => [{ text: part }]))
  return clipAll([...head, ...body].map(line => [{ text: CALLOUT_BAR, color }, ...line]), columns)
}

// Settles `sizes` on `budget` cells: add to the column furthest below its natural width, or take from the widest one.
function settle(sizes: number[], natural: readonly number[], budget: number): void {
  let sum = sizes.reduce((cells, size) => cells + size, 0)
  while (sum !== budget) {
    const grow = sum < budget
    let best = -1
    let top = 0
    sizes.forEach((size, index) => {
      const score = grow ? at(natural, index) - size : size - MIN_CELL
      if (score > top) {
        best = index
        top = score
      }
    })
    if (best < 0) return
    const step = grow ? 1 : -1
    sizes[best] = at(sizes, best) + step
    sum += step
  }
}

function columnWidths(natural: readonly number[], columns: number): number[] {
  const budget = columns - width(TABLE_SEPARATOR) * (natural.length - 1)
  const total = natural.reduce((cells, size) => cells + size, 0)
  if (total <= budget) return [...natural]
  // A proportional share, but never under MIN_CELL and never over the widest cell. Flooring loses cells and the
  // MIN_CELL clamp adds some, so settle() corrects the sum.
  const sizes = natural.map(size => Math.min(size, Math.max(MIN_CELL, Math.floor(size * budget / total))))
  settle(sizes, natural, budget)
  return sizes
}

function rowLine(cells: readonly string[], sizes: readonly number[], style: Style): Line {
  const line: Line = []
  sizes.forEach((size, index) => {
    if (index > 0) line.push(faint(TABLE_SEPARATOR))
    line.push({ text: fit(cells[index] ?? '', size, index < sizes.length - 1), ...style })
  })
  return line
}

export function tableLines(block: TableBlock, columns: number): Line[] {
  const title = titleLines(block.title ?? '', columns, {})
  if (block.columns.length === 0) return clipAll(title, columns)
  const rows = block.rows.map(row => block.columns.map((_, index) => row[index] ?? ''))
  const natural = block.columns.map((_, index) => Math.max(width(block.columns[index] ?? ''), ...rows.map(row => width(row[index] ?? ''))))
  const sizes = columnWidths(natural, columns)
  const rule = faint(sizes.map(size => '─'.repeat(size)).join(TABLE_RULE_JOIN))
  return clipAll([...title, rowLine(block.columns, sizes, { bold: true }), [rule], ...rows.map(row => rowLine(row, sizes, {}))], columns)
}

// The strong first line of a source block: the label, then ` · title` when room is left. A long label loses its head, so
// the end that tells the blocks apart (a line range, a part) stays.
function sourceHeader(label: string, title: string | undefined, columns: number): Line {
  const head = fitTail(label, columns)
  const room = columns - width(head)
  const rest: Line = title && room > width(TITLE_SEPARATOR) ? [{ text: fit(`${TITLE_SEPARATOR}${title}`, room) }] : []
  return [strong(head), ...rest]
}

// `start` is the number of the first row; the gutter is as wide as the last number, so the separators line up.
function numberedLines(rows: readonly string[], start: number, columns: number): Line[] {
  const gutter = width(String(start + rows.length - 1))
  const textColumns = columns - gutter - width(CODE_SEPARATOR)
  return rows.map((text, index): Line => [
    faint(String(start + index).padStart(gutter)),
    faint(CODE_SEPARATOR),
    { text: fit(text.replace(/\t/g, TAB), textColumns) },
  ])
}

function noteLines(note: string | undefined, columns: number): Line[] {
  return wrapText(note ?? '', columns).map((part): Line => [faint(part)])
}

// A file read from git names its ref after the path (`src/a.ts@main:8-10`), so a quote of a past version is not mistaken for
// the worktree file, and the line range still ends the label.
export function codePeekLines(block: CodePeekBlock, columns: number): Line[] {
  const file = block.ref ? `${block.path}@${block.ref}` : block.path
  const header = sourceHeader(`${file}:${block.start}-${block.end}`, block.title, columns)
  return clipAll([header, ...numberedLines(block.lines, block.start, columns), ...noteLines(block.note, columns)], columns)
}

// A snippet's own text. One trailing newline ends the last row instead of adding an empty numbered one.
export function codeLines(block: CodeBlock, columns: number): Line[] {
  const rows = block.code.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n')
  const header = sourceHeader(block.language || 'code', block.title, columns)
  return clipAll([header, ...numberedLines(rows, 1, columns), ...noteLines(block.note, columns)], columns)
}

// The run id stays out of the header: the block header above it is the place for ids, and a run id is long.
export function traceLines(block: TraceBlock, columns: number, parts: Record<TracePart, string>): Line[] {
  const header = sourceHeader(`${block.node}${TITLE_SEPARATOR}${parts[block.part]}`, block.title, columns)
  return clipAll([header, ...numberedLines(block.lines, 1, columns), ...noteLines(block.note, columns)], columns)
}

// The header spells the git arguments (`main..feature -- src/a.ts`), so a scoped diff reads as the command that produced it.
// The rows are the diff's own lines, numbered from 1 like a trace, because the pane has no colour for + and - lines.
export function diffLines(block: DiffBlock, columns: number): Line[] {
  const header = sourceHeader(block.path ? `${block.ref} -- ${block.path}` : block.ref, block.title, columns)
  return clipAll([header, ...numberedLines(block.lines, 1, columns), ...noteLines(block.note, columns)], columns)
}

// A rule across the whole pane between groups of blocks. It carries no model text, so it needs no clip.
export function dividerLines(columns: number): Line[] {
  return columns > 0 ? [[faint(RULE.repeat(columns))]] : []
}

// One row, because the pane draws the row as a button that selects the board. The engine stores only the id of the target board,
// so a board_ref names it by the block's title and falls back to the id when no title is set.
export function boardRefLines(block: BoardRefBlock, columns: number, label: string): Line[] {
  const name = block.title?.trim() || block.board
  return clipAll([[{ text: REF_ARROW, color: ACCENT }, faint(`${label}: `), strong(name, { color: ACCENT })]], columns)
}
