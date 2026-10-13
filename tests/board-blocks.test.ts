import { expect, test } from 'claude-code/testing'
import type { CalloutBlock, CalloutTone, CodePeekBlock, SectionBlock, TableBlock } from '../hooks/engine/board-types.ts'
import { calloutLines, codePeekLines, sectionLines, tableLines, wrapText, type CalloutLabels } from '../hooks/ui/board-blocks.ts'
import { width, type Line } from '../hooks/ui/text.ts'

const text = (line: Line) => line.map(segment => segment.text).join('')
const texts = (lines: Line[]) => lines.map(text)
const lineWidth = (line: Line) => line.reduce((cells, segment) => cells + width(segment.text), 0)
const LABELS: CalloutLabels = { info: 'Info', decision: 'Decision', risk: 'Risk', warning: 'Warning' }

const section = (body: string, title = 'Plan'): SectionBlock => ({ id: 'b1', type: 'section', title, text: body })
const callout = (tone: CalloutTone, body: string, title?: string): CalloutBlock => ({ id: 'b2', type: 'callout', tone, text: body, ...(title ? { title } : {}) })
const table = (columns: string[], rows: string[][], title?: string): TableBlock => ({ id: 'b3', type: 'table', columns, rows, ...(title ? { title } : {}) })
const peek = (lines: string[], extra: Partial<CodePeekBlock> = {}): CodePeekBlock => ({ id: 'b4', type: 'code_peek', path: 'src/a.ts', start: 8, end: 7 + lines.length, lines, ...extra })

test('section shows its title in bold accent', () => {
  expect(sectionLines(section('body'), 40)[0]).toEqual([{ text: 'Plan', color: 'cyan', bold: true }])
})

test('section renders # and ## headings as bold lines without the hashes', () => {
  const lines = sectionLines(section('# Goal\n## Steps\nplain'), 40)
  expect(texts(lines)).toEqual(['Plan', 'Goal', 'Steps', 'plain'])
  expect(lines[1]).toEqual([{ text: 'Goal', bold: true }])
  expect(lines[2]).toEqual([{ text: 'Steps', bold: true }])
  expect(lines[3]).toEqual([{ text: 'plain' }])
})

test('section turns - and * items into bullets with a hanging indent on wrapped lines', () => {
  const lines = sectionLines(section('- alpha beta gamma delta epsilon\n* short'), 20)
  expect(texts(lines).slice(1)).toEqual(['• alpha beta gamma', '  delta epsilon', '• short'])
})

test('section keeps the number of a numbered item and indents wrapped lines under the text', () => {
  const lines = sectionLines(section('1. first step that wraps\n10. tenth step that wraps'), 16)
  expect(texts(lines).slice(1)).toEqual(['1. first step', '   that wraps', '10. tenth step', '    that wraps'])
})

test('section collapses runs of blank lines to one and drops leading and trailing blanks', () => {
  const lines = sectionLines(section('\n\none\n\n\n\ntwo\n\n'), 40)
  expect(texts(lines)).toEqual(['Plan', 'one', '', 'two'])
})

test('section wraps a plain line at spaces within the columns', () => {
  const lines = sectionLines(section('one two three four'), 9)
  expect(texts(lines).slice(1)).toEqual(['one two', 'three', 'four'])
})

test('section without text is only its title', () => {
  expect(texts(sectionLines({ id: 'b1', type: 'section', title: 'Plan' }, 40))).toEqual(['Plan'])
})

test('callout paints every line with a bar in the color of its tone', () => {
  const colors: Record<CalloutTone, string> = { info: 'cyan', decision: 'green', risk: 'red', warning: 'yellow' }
  for (const tone of Object.keys(colors) as CalloutTone[]) {
    const lines = calloutLines(callout(tone, 'one two three four five six'), 12, LABELS)
    expect(lines.length > 2).toBe(true)
    for (const line of lines) expect(line[0]).toEqual({ text: '▌ ', color: colors[tone] })
    expect(text(lines[0] ?? [])).toBe(`▌ ${LABELS[tone]}`)
  }
})

test('callout puts the bold title after the label and wraps its text to the columns minus the bar', () => {
  const lines = calloutLines(callout('decision', 'use the local store for boards', 'Storage'), 20, LABELS)
  expect(texts(lines)).toEqual(['▌ Decision Storage', '▌ use the local', '▌ store for boards'])
  expect(lines[0]?.[1]).toEqual({ text: 'Decision', color: 'green', bold: true })
  expect(lines[0]?.[3]).toEqual({ text: 'Storage', bold: true })
})

test('callout moves a title that does not fit beside the label onto its own lines', () => {
  const lines = calloutLines(callout('risk', 'body', 'Migration locks the whole table'), 20, LABELS)
  expect(texts(lines)).toEqual(['▌ Risk', '▌ Migration locks', '▌ the whole table', '▌ body'])
})

test('callout keeps a blank line between paragraphs under the bar', () => {
  expect(texts(calloutLines(callout('info', 'one\n\n\ntwo'), 20, LABELS))).toEqual(['▌ Info', '▌ one', '▌ ', '▌ two'])
})

test('table that fits shows aligned columns, a bold header and a rule', () => {
  const lines = tableLines(table(['Name', 'Role'], [['Ada', 'Lead'], ['Grace', 'Admiral']]), 40)
  expect(texts(lines)).toEqual(['Name  │ Role', '──────┼────────', 'Ada   │ Lead', 'Grace │ Admiral'])
  expect(lines[0]?.filter(segment => segment.bold).map(segment => segment.text.trim())).toEqual(['Name', 'Role'])
})

test('table shows its title in bold above the header', () => {
  const lines = tableLines(table(['A'], [['1']], 'Options'), 40)
  expect(texts(lines)).toEqual(['Options', 'A', '─', '1'])
  expect(lines[0]).toEqual([{ text: 'Options', bold: true }])
})

test('table shrinks columns proportionally and ends a cut cell with an ellipsis', () => {
  const lines = tableLines(table(['ID', 'Description'], [['a1', 'A very long description of the thing']]), 20)
  expect(texts(lines)).toEqual(['ID │ Description', '───┼────────────────', 'a1 │ A very long de…'])
  for (const line of lines) expect(lineWidth(line) <= 20).toBe(true)
})

test('table keeps a narrow column whole while the wide column gives up cells', () => {
  const lines = tableLines(table(['Key', 'Value'], [['k'.repeat(40), 'vvvv']]), 20)
  expect(text(lines[2] ?? [])).toBe(`${'k'.repeat(12)}… │ vvvv`)
})

test('table never shrinks a column below four cells', () => {
  const lines = tableLines(table(['Id', 'First', 'Second'], [['abcde', 'f'.repeat(100), 's'.repeat(100)]]), 24)
  expect(text(lines[2] ?? []).indexOf('│')).toBe(5)
  expect(text(lines[2] ?? []).startsWith('abc… │ ')).toBe(true)
  for (const line of lines) expect(lineWidth(line) <= 24).toBe(true)
})

// Cells before the first column separator, so a wide glyph counts for two.
const cellsBefore = (line: Line, glyph: string) => {
  const row = text(line)
  return width(row.slice(0, row.indexOf(glyph)))
}

test('table with Korean cells aligns its separators when everything fits', () => {
  const lines = tableLines(table(['이름', '역할'], [['김철수', '개발자'], ['이영희', '기획']]), 50)
  expect(texts(lines).slice(2)).toEqual(['김철수 │ 개발자', '이영희 │ 기획'])
  expect([lines[0], lines[2], lines[3]].map(line => cellsBefore(line ?? [], '│'))).toEqual([7, 7, 7])
  expect(cellsBefore(lines[1] ?? [], '┼')).toBe(7)
})

test('table with Korean cells stays within the columns and keeps the separators aligned when it shrinks', () => {
  const lines = tableLines(table(['이름', '역할'], [['김철수', '개발자와 디자이너를 위한 긴 설명'], ['이영희', '기획']]), 20)
  expect(lines.length).toBe(4)
  for (const line of lines) expect(lineWidth(line) <= 20).toBe(true)
  expect(text(lines[2] ?? []).includes('…')).toBe(true)
  expect([lines[0], lines[2], lines[3]].map(line => cellsBefore(line ?? [], '│'))).toEqual([5, 5, 5])
  expect(cellsBefore(lines[1] ?? [], '┼')).toBe(5)
})

test('table pads a short row and ignores cells beyond the header', () => {
  const lines = tableLines(table(['A', 'B'], [['1'], ['2', '3', '4']]), 20)
  expect(texts(lines).slice(2)).toEqual(['1 │ ', '2 │ 3'])
})

test('code_peek numbers lines from the start with a right-aligned dim gutter', () => {
  const lines = codePeekLines(peek(['one', 'two', 'three']), 40)
  expect(texts(lines)).toEqual(['src/a.ts:8-10', ' 8 │ one', ' 9 │ two', '10 │ three'])
  expect(lines[1]?.slice(0, 2)).toEqual([{ text: ' 8', dim: true }, { text: ' │ ', dim: true }])
  expect(lines[0]).toEqual([{ text: 'src/a.ts:8-10', bold: true }])
})

test('code_peek adds the title after the bold range', () => {
  const lines = codePeekLines(peek(['x'], { title: 'Entry point' }), 40)
  expect(text(lines[0] ?? [])).toBe('src/a.ts:8-8 · Entry point')
  expect(lines[0]?.[0]).toEqual({ text: 'src/a.ts:8-8', bold: true })
})

test('code_peek expands each tab to two spaces and keeps indentation', () => {
  const lines = codePeekLines(peek(['\tif (a) {', '\t\treturn']), 40)
  expect(texts(lines).slice(1)).toEqual(['8 │   if (a) {', '9 │     return'])
})

test('code_peek cuts a long line with an ellipsis inside the columns', () => {
  const lines = codePeekLines(peek(['x'.repeat(50)]), 20)
  expect(text(lines[1] ?? [])).toBe(`8 │ ${'x'.repeat(15)}…`)
  expect(lineWidth(lines[1] ?? [])).toBe(20)
})

test('code_peek keeps the line range when the path is too long for the columns', () => {
  const lines = codePeekLines(peek(['x'], { path: 'packages/very/deep/folder/name/file.ts' }), 24)
  expect(text(lines[0] ?? []).endsWith('file.ts:8-8')).toBe(true)
  expect(lineWidth(lines[0] ?? [])).toBe(24)
})

test('code_peek ends with the note as a dim line', () => {
  const lines = codePeekLines(peek(['a', 'b'], { note: 'The guard runs before the write' }), 40)
  expect(texts(lines).slice(-1)).toEqual(['The guard runs before the write'])
  expect(lines[lines.length - 1]).toEqual([{ text: 'The guard runs before the write', dim: true }])
})

test('code_peek shows Korean source text within the columns', () => {
  const lines = codePeekLines(peek(['// 한글로 쓴 아주 긴 설명 주석입니다 한글로 쓴 아주 긴 설명']), 24)
  expect(lineWidth(lines[1] ?? []) <= 24).toBe(true)
  expect(text(lines[1] ?? []).endsWith('…')).toBe(true)
})

test('wrapText breaks at spaces by cell width', () => {
  expect(wrapText('aa bb cc dd', 5)).toEqual(['aa bb', 'cc dd'])
  expect(wrapText('가나 다라 마바', 5)).toEqual(['가나', '다라', '마바'])
})

test('wrapText hard-breaks a word wider than the columns', () => {
  expect(wrapText('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij'])
  expect(wrapText('ab abcdefgh', 4)).toEqual(['ab', 'abcd', 'efgh'])
  expect(wrapText('가나다라마', 4)).toEqual(['가나', '다라', '마'])
})

test('wrapText returns nothing for empty text or no room', () => {
  expect(wrapText('   ', 10)).toEqual([])
  expect(wrapText('abc', 0)).toEqual([])
})

test('every block fits a narrow pane without throwing', () => {
  const blocks = (columns: number): Line[][] => [
    sectionLines(section('# Heading\n- 가나다라 마바사 list item\n1. numbered item\nplain words here', 'A title'), columns),
    calloutLines(callout('warning', '가나다라 body text that wraps', 'Title'), columns, LABELS),
    tableLines(table(['이름', 'Role'], [['김철수', 'Lead role']], 'Table'), columns),
    codePeekLines(peek(['\tconst 값 = 1'], { title: 'Peek', note: 'note text' }), columns),
  ]
  for (const columns of [1, 2, 3, 5, 8, 13, 21]) {
    for (const lines of blocks(columns)) {
      expect(lines.length > 0).toBe(true)
      for (const line of lines) expect(lineWidth(line) <= columns).toBe(true)
    }
  }
  for (const lines of blocks(0)) expect(lines).toEqual([])
})

test('control characters in block text never reach the output', () => {
  const dirty = 'bad\x1b[31m red \x07 text'
  const rendered = [
    sectionLines(section(dirty, dirty), 40),
    calloutLines(callout('info', dirty, dirty), 40, LABELS),
    tableLines(table([dirty], [[dirty]], dirty), 40),
    codePeekLines(peek([dirty], { path: dirty, title: dirty, note: dirty }), 40),
  ]
  for (const lines of rendered) expect(/[\x00-\x08\x0b-\x1f\x7f]/.test(texts(lines).join('\n'))).toBe(false)
})
