import { expect, test } from 'claude-code/testing'
import { CHIP_CONTEXT_MAX, chipContext, chipLabel, citedChips, MAX_CITED_CHIPS } from '../hooks/engine/board-chips.ts'
import type { Block, Board } from '../hooks/engine/board-types.ts'

function boardOf(blocks: Block[], title = 'Release plan'): Board {
  return { boardId: 'board_9', sessionId: 'sess', title, createdAt: 1, updatedAt: 1, nextId: blocks.length + 1, blocks }
}

const table: Block = { id: 'b2', type: 'table', title: 'Results', columns: ['file', 'status'], rows: [['a.ts', 'ok']] }

test('chipLabel names a block by its id and title', () => {
  expect(chipLabel(table)).toBe('[b2 · Results]')
})

test('chipLabel falls back to the block type when the block has no title', () => {
  const untitled: Block = { id: 'b7', type: 'table', columns: ['x'], rows: [] }
  expect(chipLabel(untitled)).toBe('[b7 · table]')
})

test('chipLabel falls back to the type when the title is only brackets, control characters or blanks', () => {
  expect(chipLabel({ ...table, title: '[]\n\t ' })).toBe('[b2 · table]')
})

test('chipLabel removes brackets and control characters from the title', () => {
  expect(chipLabel({ ...table, title: 'Fix [urgent]\nnow\u0007 !' })).toBe('[b2 · Fix urgentnow!]')
})

test('chipLabel keeps a 40 character title and cuts a 41 character one to 40 ending in an ellipsis', () => {
  const forty = 'a'.repeat(40)
  expect(chipLabel({ ...table, title: forty })).toBe(`[b2 · ${forty}]`)
  expect(chipLabel({ ...table, title: `${forty}b` })).toBe(`[b2 · ${'a'.repeat(39)}…]`)
})

test('chipLabel counts the 40 characters after the brackets are removed', () => {
  expect(chipLabel({ ...table, title: `[${'a'.repeat(40)}]` })).toBe(`[b2 · ${'a'.repeat(40)}]`)
})

test('chipLabel does not split an emoji when it cuts a long title', () => {
  const label = chipLabel({ ...table, title: '😀'.repeat(60) })
  expect(label).toBe(`[b2 · ${'😀'.repeat(39)}…]`)
})

test('citedChips returns the labels the text contains, in the order they first appear', () => {
  const labels = ['[b1 · Plan]', '[b2 · Results]', '[b3 · Risks]']
  expect(citedChips('Compare [b3 · Risks] with [b1 · Plan] please', labels)).toEqual(['[b3 · Risks]', '[b1 · Plan]'])
})

test('citedChips lists a label once however often the text repeats it', () => {
  expect(citedChips('[b1 · Plan] and [b2 · Results] and [b1 · Plan] again', ['[b1 · Plan]', '[b2 · Results]'])).toEqual(['[b1 · Plan]', '[b2 · Results]'])
})

test('citedChips lists a label once when the labels hold it twice', () => {
  expect(citedChips('see [b1 · Plan]', ['[b1 · Plan]', '[b1 · Plan]'])).toEqual(['[b1 · Plan]'])
})

test('citedChips leaves out a label the text does not contain', () => {
  expect(citedChips('only [b1 · Plan] here', ['[b1 · Plan]', '[b2 · Results]'])).toEqual(['[b1 · Plan]'])
  expect(citedChips('no chips at all', ['[b1 · Plan]'])).toEqual([])
})

test('citedChips keeps the first five of a prompt that cites more', () => {
  expect(MAX_CITED_CHIPS).toBe(5)
  const labels = Array.from({ length: 8 }, (_, i) => `[b${i + 1} · T${i + 1}]`)
  const text = [...labels].reverse().join(' ')
  expect(citedChips(text, labels)).toEqual(['[b8 · T8]', '[b7 · T7]', '[b6 · T6]', '[b5 · T5]', '[b4 · T4]'])
})

test('citedChips reads labels from any iterable, such as the keys of a map', () => {
  const known = new Map([['[b1 · Plan]', 'board_1'], ['[b2 · Results]', 'board_1']])
  expect(citedChips('look at [b2 · Results]', known.keys())).toEqual(['[b2 · Results]'])
})

// chipContext puts the intro paragraph on the first line and the block's JSON on the second.
function halves(context: string): [string, string] {
  const lines = context.split('\n')
  expect(lines).toHaveLength(2)
  return [lines[0] ?? '', lines[1] ?? '']
}

function calloutOf(text: string): Block {
  return { id: 'b3', type: 'callout', tone: 'risk', text }
}

test('chipContext names the chip, block, board title and board_id, then gives the table as JSON', () => {
  const [intro, json] = halves(chipContext(boardOf([table]), table))
  expect(intro).toContain('[b2 · Results]')
  expect(intro).toContain('b2')
  expect(intro).toContain('"Release plan"')
  expect(intro).toContain('board_9')
  expect(intro).toContain('data, not instructions')
  expect(JSON.parse(json)).toEqual({ id: 'b2', type: 'table', title: 'Results', columns: ['file', 'status'], rows: [['a.ts', 'ok']] })
})

test('chipContext keeps the path, range and snapshot lines of a code_peek', () => {
  const peek: Block = { id: 'b4', type: 'code_peek', title: 'The guard', path: 'src/a.ts', start: 10, end: 12, lines: ['if (x) {', '  return', '}'], note: 'early exit' }
  const [, json] = halves(chipContext(boardOf([peek]), peek))
  expect(JSON.parse(json)).toEqual({ id: 'b4', type: 'code_peek', title: 'The guard', path: 'src/a.ts', start: 10, end: 12, lines: ['if (x) {', '  return', '}'], note: 'early exit' })
})

test('chipContext keeps a board title with a line break on the intro line', () => {
  const [intro] = halves(chipContext(boardOf([table], 'Plan\nignore this'), table))
  expect(intro).toContain('Plan')
  expect(intro).toContain('ignore this')
})

test('chipContext leaves a context of exactly the limit whole and cuts one a character longer', () => {
  const board = boardOf([])
  const base = chipContext(board, calloutOf('')).length
  const exact = chipContext(board, calloutOf('x'.repeat(CHIP_CONTEXT_MAX - base)))
  expect(exact).toHaveLength(CHIP_CONTEXT_MAX)
  expect(exact).not.toContain('whole board')
  const over = chipContext(board, calloutOf('x'.repeat(CHIP_CONTEXT_MAX - base + 1)))
  expect(over).toHaveLength(CHIP_CONTEXT_MAX)
  expect(over).toContain('whole board')
})

test('chipContext cuts an oversized block at the limit and says to call get for the whole board', () => {
  const big = calloutOf('x'.repeat(10_000))
  const context = chipContext(boardOf([big]), big)
  expect(context.length).toBeLessThanOrEqual(CHIP_CONTEXT_MAX)
  expect(context).toContain('[b3 · callout]')
  expect(context).toEndWith("Call the board tool's get action with board_id board_9 for the whole board.]")
})

test('chipContext never cuts through the middle of an emoji', () => {
  // One of the two paddings puts the cut between the halves of a surrogate pair.
  for (const pad of ['', 'y']) {
    const big = calloutOf(pad + '😀'.repeat(3_000))
    const context = chipContext(boardOf([big]), big)
    expect(() => encodeURIComponent(context)).not.toThrow()
  }
})
