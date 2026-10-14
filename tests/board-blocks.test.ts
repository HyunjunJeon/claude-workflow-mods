import { expect, test } from 'claude-code/testing'
import type { Block, CalloutBlock, CalloutTone, CodeBlock, CodePeekBlock, DiffBlock, SectionBlock, TableBlock, TraceBlock, TracePart } from '../hooks/engine/board-types.ts'
import { calloutLines, codeLines, codePeekLines, diffLines, sectionLines, tableLines, traceLines, wrapText, type CalloutLabels } from '../hooks/ui/board-blocks.ts'
import { buildBoardView } from '../hooks/ui/board-model.ts'
import { width, type Line } from '../hooks/ui/text.ts'

const text = (line: Line) => line.map(segment => segment.text).join('')
const texts = (lines: Line[]) => lines.map(text)
const lineWidth = (line: Line) => line.reduce((cells, segment) => cells + width(segment.text), 0)
const LABELS: CalloutLabels = { info: 'Info', decision: 'Decision', risk: 'Risk', warning: 'Warning' }

const section = (body: string, title = 'Plan'): SectionBlock => ({ id: 'b1', type: 'section', title, text: body })
const callout = (tone: CalloutTone, body: string, title?: string): CalloutBlock => ({ id: 'b2', type: 'callout', tone, text: body, ...(title ? { title } : {}) })
const table = (columns: string[], rows: string[][], title?: string): TableBlock => ({ id: 'b3', type: 'table', columns, rows, ...(title ? { title } : {}) })
const PARTS_EN: Record<TracePart, string> = { output: 'output', answer: 'answer', error: 'error', verification: 'verification' }
const PARTS_KO: Record<TracePart, string> = { output: '출력', answer: '답변', error: '오류', verification: '검증' }
const code = (body: string, extra: Partial<CodeBlock> = {}): CodeBlock => ({ id: 'b5', type: 'code', code: body, ...extra })
const trace = (lines: string[], extra: Partial<TraceBlock> = {}): TraceBlock => ({ id: 'b6', type: 'trace', run: 'dag_mv6fveyq_y06sr2', node: 'board-render', part: 'output', lines, ...extra })
const peek = (lines: string[], extra: Partial<CodePeekBlock> = {}): CodePeekBlock => ({ id: 'b4', type: 'code_peek', path: 'src/a.ts', start: 8, end: 7 + lines.length, lines, ...extra })
const diff = (lines: string[], extra: Partial<DiffBlock> = {}): DiffBlock => ({ id: 'b7', type: 'diff', ref: 'main..feature', lines, ...extra })

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

test('code_peek read from git names its ref after the path and keeps the line range last', () => {
  const lines = codePeekLines(peek(['one', 'two'], { ref: 'HEAD~1' }), 40)
  expect(texts(lines)).toEqual(['src/a.ts@HEAD~1:8-9', '8 │ one', '9 │ two'])
  expect(lines[0]).toEqual([{ text: 'src/a.ts@HEAD~1:8-9', bold: true }])
})

test('code_peek with a ref and a title shows both after the bold label', () => {
  const lines = codePeekLines(peek(['x'], { ref: 'v1.2.0', title: 'Before the rename' }), 60)
  expect(text(lines[0] ?? [])).toBe('src/a.ts@v1.2.0:8-8 · Before the rename')
  expect(lines[0]?.[0]).toEqual({ text: 'src/a.ts@v1.2.0:8-8', bold: true })
})

test('code_peek keeps the line range when the ref makes the label wider than the columns', () => {
  const lines = codePeekLines(peek(['x'], { ref: 'a'.repeat(40) }), 24)
  expect(text(lines[0] ?? []).endsWith(':8-8')).toBe(true)
  expect(lineWidth(lines[0] ?? [])).toBe(24)
})

test('diff shows its ref in bold, the diff lines numbered from 1 with a dim gutter, and the note dim', () => {
  const lines = diffLines(diff(['@@ -1,2 +1,2 @@', '-const a = 1', '+const a = 2'], { note: 'The default changed' }), 40)
  expect(texts(lines)).toEqual(['main..feature', '1 │ @@ -1,2 +1,2 @@', '2 │ -const a = 1', '3 │ +const a = 2', 'The default changed'])
  expect(lines[0]).toEqual([{ text: 'main..feature', bold: true }])
  expect(lines[2]?.slice(0, 2)).toEqual([{ text: '2', dim: true }, { text: ' │ ', dim: true }])
  expect(lines[4]).toEqual([{ text: 'The default changed', dim: true }])
})

test('diff scoped to a path puts the path after the ref the way git takes its arguments', () => {
  const lines = diffLines(diff(['-a', '+b'], { ref: 'HEAD', path: 'src/a.ts' }), 40)
  expect(texts(lines)).toEqual(['HEAD -- src/a.ts', '1 │ -a', '2 │ +b'])
  expect(lines[0]).toEqual([{ text: 'HEAD -- src/a.ts', bold: true }])
})

test('diff adds the title after the bold ref and path', () => {
  const lines = diffLines(diff(['+x'], { path: 'src/a.ts', title: 'What changed' }), 60)
  expect(text(lines[0] ?? [])).toBe('main..feature -- src/a.ts · What changed')
  expect(lines[0]?.[0]).toEqual({ text: 'main..feature -- src/a.ts', bold: true })
})

test('diff right-aligns its gutter once it passes nine lines and cuts a long line with an ellipsis', () => {
  const rows = Array.from({ length: 10 }, (_, i) => `+row${i + 1}`)
  rows[0] = `+${'x'.repeat(50)}`
  const lines = diffLines(diff(rows), 20)
  expect(text(lines[1] ?? [])).toBe(` 1 │ +${'x'.repeat(13)}…`)
  expect(lineWidth(lines[1] ?? [])).toBe(20)
  expect(text(lines[10] ?? [])).toBe('10 │ +row10')
})

test('diff keeps the end of a ref and path label that is wider than the columns', () => {
  const lines = diffLines(diff(['+x'], { ref: 'release/2026-10..main', path: 'packages/very/deep/folder/file.ts' }), 24)
  expect(text(lines[0] ?? []).endsWith('folder/file.ts')).toBe(true)
  expect(lineWidth(lines[0] ?? [])).toBe(24)
})

test('diff lines are empty when there is no room', () => {
  expect(diffLines(diff(['+x']), 0)).toEqual([])
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
    codeLines(code('\tconst 값 = 1\nreturn', { language: 'typescript', title: 'Snippet', note: 'note text' }), columns),
    traceLines(trace(['\tFAIL 값이 다릅니다', 'second'], { node: 'board-render', title: 'Trace', note: 'note text', part: 'verification' }), columns, PARTS_KO),
    codePeekLines(peek(['\tconst 값 = 1'], { ref: 'release/2026-10', title: 'Past', note: 'note text' }), columns),
    diffLines(diff(['@@ -1 +1 @@', '-\tconst 값 = 1', '+return'], { path: 'src/값.ts', title: 'Diff', note: 'note text' }), columns),
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
    codeLines(code(dirty, { language: dirty, title: dirty, note: dirty }), 40),
    traceLines(trace([dirty], { node: dirty, title: dirty, note: dirty }), 40, PARTS_EN),
    codePeekLines(peek([dirty], { ref: dirty }), 40),
    diffLines(diff([dirty], { ref: dirty, path: dirty, title: dirty, note: dirty }), 40),
  ]
  for (const lines of rendered) expect(/[\x00-\x08\x0b-\x1f\x7f]/.test(texts(lines).join('\n'))).toBe(false)
})

test('code shows its language in bold, numbered rows from 1 with a dim gutter, and the note dim', () => {
  const lines = codeLines(code('const a = 1\nreturn a', { language: 'typescript', note: 'Returns early' }), 40)
  expect(texts(lines)).toEqual(['typescript', '1 │ const a = 1', '2 │ return a', 'Returns early'])
  expect(lines[0]).toEqual([{ text: 'typescript', bold: true }])
  expect(lines[1]?.slice(0, 2)).toEqual([{ text: '1', dim: true }, { text: ' │ ', dim: true }])
  expect(lines[3]).toEqual([{ text: 'Returns early', dim: true }])
})

test('code without a language or a title still renders, headed by code', () => {
  const lines = codeLines(code('x = 1'), 40)
  expect(texts(lines)).toEqual(['code', '1 │ x = 1'])
  expect(lines[0]).toEqual([{ text: 'code', bold: true }])
})

test('code adds the title after the bold language', () => {
  const lines = codeLines(code('x', { language: 'py', title: 'Entry point' }), 40)
  expect(text(lines[0] ?? [])).toBe('py · Entry point')
  expect(lines[0]?.[0]).toEqual({ text: 'py', bold: true })
})

test('code right-aligns its gutter once it passes nine rows', () => {
  const lines = codeLines(code(Array.from({ length: 10 }, (_, i) => `row${i + 1}`).join('\n')), 40)
  expect(texts(lines).slice(1, 3)).toEqual([' 1 │ row1', ' 2 │ row2'])
  expect(text(lines[10] ?? [])).toBe('10 │ row10')
})

test('code expands tabs, and a trailing newline does not add an empty numbered row', () => {
  expect(texts(codeLines(code('\tif (a) {\n\t\treturn\n'), 40))).toEqual(['code', '1 │   if (a) {', '2 │     return'])
})

test('code keeps a blank row inside the snippet and reads CRLF as one break', () => {
  expect(texts(codeLines(code('a\r\n\r\nb'), 40)).slice(1)).toEqual(['1 │ a', '2 │ ', '3 │ b'])
})

test('code cuts a long first line with an ellipsis instead of overflowing', () => {
  const lines = codeLines(code(`${'x'.repeat(50)}\nshort`), 20)
  expect(text(lines[1] ?? [])).toBe(`1 │ ${'x'.repeat(15)}…`)
  expect(lineWidth(lines[1] ?? [])).toBe(20)
  expect(text(lines[2] ?? [])).toBe('2 │ short')
})

test('code keeps the end of a language label that is wider than the columns', () => {
  const lines = codeLines(code('x', { language: 'a-very-long-language-label' }), 10)
  expect(text(lines[0] ?? [])).toBe('…age-label')
  expect(lineWidth(lines[0] ?? [])).toBe(10)
})

test('trace headers its rows with the node and the English part label', () => {
  const lines = traceLines(trace(['built ok', 'tests pass'], { note: 'Final output of the node' }), 40, PARTS_EN)
  expect(texts(lines)).toEqual(['board-render · output', '1 │ built ok', '2 │ tests pass', 'Final output of the node'])
  expect(lines[0]).toEqual([{ text: 'board-render · output', bold: true }])
  expect(lines[3]).toEqual([{ text: 'Final output of the node', dim: true }])
})

test('trace headers its rows with the Korean part label', () => {
  const lines = traceLines(trace(['빌드 성공']), 40, PARTS_KO)
  expect(texts(lines)).toEqual(['board-render · 출력', '1 │ 빌드 성공'])
})

test('trace labels each part from the table it is given', () => {
  const parts: TracePart[] = ['output', 'answer', 'error', 'verification']
  expect(parts.map(part => text(traceLines(trace(['x'], { part }), 40, PARTS_EN)[0] ?? []))).toEqual([
    'board-render · output',
    'board-render · answer',
    'board-render · error',
    'board-render · verification',
  ])
  expect(parts.map(part => text(traceLines(trace(['x'], { part }), 40, PARTS_KO)[0] ?? []))).toEqual([
    'board-render · 출력',
    'board-render · 답변',
    'board-render · 오류',
    'board-render · 검증',
  ])
})

test('trace adds the title after the bold header and never shows the run id', () => {
  const lines = traceLines(trace(['x'], { title: 'Why it failed', part: 'error' }), 60, PARTS_EN)
  expect(text(lines[0] ?? [])).toBe('board-render · error · Why it failed')
  expect(lines[0]?.[0]).toEqual({ text: 'board-render · error', bold: true })
  expect(texts(lines).join('\n').includes('dag_mv6fveyq')).toBe(false)
})

test('trace cuts a long first line with an ellipsis instead of overflowing', () => {
  const lines = traceLines(trace(['y'.repeat(60), 'next']), 20, PARTS_EN)
  expect(text(lines[1] ?? [])).toBe(`1 │ ${'y'.repeat(15)}…`)
  expect(lineWidth(lines[1] ?? [])).toBe(20)
})

test('trace keeps the part label when the node name is wider than the columns', () => {
  const lines = traceLines(trace(['x'], { node: 'a-node-with-a-very-long-name' }), 16, PARTS_KO)
  expect(text(lines[0] ?? []).endsWith(' · 출력')).toBe(true)
  expect(lineWidth(lines[0] ?? [])).toBeLessThanOrEqual(16)
})

test('code and trace lines stay within 20 columns, Korean text included', () => {
  const lines = [
    ...codeLines(code('// 한글로 쓴 아주 긴 설명 주석입니다\n\tconst long = "' + 'z'.repeat(40) + '"', { language: 'typescript', title: '긴 제목이 붙은 스니펫', note: '한글 메모가 두 줄로 이어집니다 정말로' }), 20),
    ...traceLines(trace(['오류: 한글로 쓴 아주 긴 실패 메시지입니다', 'z'.repeat(40)], { node: 'board-render', title: '긴 제목이 붙은 인용', part: 'error', note: '한글 메모가 두 줄로 이어집니다 정말로' }), 20, PARTS_KO),
  ]
  expect(lines.length > 6).toBe(true)
  for (const line of lines) expect(lineWidth(line)).toBeLessThanOrEqual(20)
})

test('code and trace lines are empty when there is no room', () => {
  expect(codeLines(code('x'), 0)).toEqual([])
  expect(traceLines(trace(['x']), 0, PARTS_EN)).toEqual([])
})

// The pane draws these blocks through the board view, in the pane's language.
const viewRows = (blocks: Block[], language: 'en' | 'ko') => {
  const board = { boardId: 'bd1', sessionId: 's1', title: 'Trace board', createdAt: 1, updatedAt: 1, nextId: 3, blocks }
  return buildBoardView({ boards: [board], columns: 60, language, page: 0 }).lines.map(text)
}
const CODE_AND_TRACE: Block[] = [
  { id: 'b1', type: 'code', language: 'ts', code: 'const a = 1' },
  { id: 'b2', type: 'trace', run: 'dag_x', node: 'build', part: 'verification', lines: ['exit 0'] },
]

test('the board view draws code and trace blocks with their header and rows', () => {
  expect(viewRows(CODE_AND_TRACE, 'en').slice(0, 7)).toEqual([
    '[b1] code', 'ts', '1 │ const a = 1', '', '[b2] trace', 'build · verification', '1 │ exit 0',
  ])
})

test('the board view labels a trace part in Korean when the pane is Korean', () => {
  expect(viewRows(CODE_AND_TRACE, 'ko')[5]).toBe('build · 검증')
})

// The ref is git's own text, so the header reads the same in either language; only the pane's hint line is translated.
const REF_BLOCKS: Block[] = [
  { id: 'b1', type: 'code_peek', path: 'src/a.ts', ref: 'abc123', start: 3, end: 3, lines: ['x'] },
  { id: 'b2', type: 'diff', ref: 'main', path: 'src/a.ts', lines: ['-old', '+new'] },
]
const REF_ROWS = ['[b1] code_peek', 'src/a.ts@abc123:3-3', '3 │ x', '', '[b2] diff', 'main -- src/a.ts', '1 │ -old', '2 │ +new']

test('the board view draws a code_peek ref and a diff header in English', () => {
  expect(viewRows(REF_BLOCKS, 'en').slice(0, REF_ROWS.length)).toEqual(REF_ROWS)
})

test('the board view keeps diff as the block type and names the ref when the pane is Korean', () => {
  expect(viewRows(REF_BLOCKS, 'ko').slice(0, REF_ROWS.length)).toEqual(REF_ROWS)
})

test('the board view puts a diff title after the block type in the header', () => {
  const rows = viewRows([{ id: 'b3', type: 'diff', ref: 'main', title: 'Scope', lines: ['+x'] }], 'ko')
  expect(rows.slice(0, 2)).toEqual(['[b3] diff · Scope', 'main · Scope'])
})
