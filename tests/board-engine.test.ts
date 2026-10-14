import { expect, test } from 'claude-code/testing'
import { BOARD_INPUT_SCHEMA, BOARD_TOOL_DESCRIPTION } from '../hooks/engine/board-spec.ts'
import { applyEdits, boardForModel, diffKey, diffsNeeded, newBoard, parseBoardFile, parseEdits, peekKey, peeksNeeded, traceKey, tracesNeeded } from '../hooks/engine/board.ts'
import { boardToMarkdown } from '../hooks/engine/board-export.ts'
import type { Block, BlockInput, Board, BoardEdit, BoardFile, FlowEdge, TracePart } from '../hooks/engine/board-types.ts'
import { TOOL_DESCRIPTION_LIMIT } from '../hooks/engine/tool-spec.ts'
import type { Result } from '../hooks/engine/types.ts'

const NOW = 1_000
const NO_PEEKS: ReadonlyMap<string, string[]> = new Map()
const NO_TRACES: ReadonlyMap<string, string[]> = new Map()
const NO_DIFFS: ReadonlyMap<string, string[]> = new Map()

function boardOf(blocks: Block[] = [], nextId = blocks.length + 1): Board {
  return { boardId: 'board_1', sessionId: 'sess', title: 'Plan', createdAt: 1, updatedAt: 1, nextId, blocks }
}

function apply(
  board: Board,
  edits: BoardEdit[],
  peeks: ReadonlyMap<string, string[]> = NO_PEEKS,
  traces: ReadonlyMap<string, string[]> = NO_TRACES,
  diffs: ReadonlyMap<string, string[]> = NO_DIFFS,
  boardIds?: ReadonlySet<string>,
) {
  return applyEdits(board, edits, { now: NOW, peeks, traces, diffs, boardIds })
}

function insert(block: BlockInput, afterId?: string): BoardEdit {
  return afterId === undefined ? { op: 'insert', block } : { op: 'insert', block, afterId }
}

// The text a host read for src/a.ts lines start..end, from the worktree or at a git ref: "line <n>" for line n.
function fileText(path: string, start: number, end: number, ref?: string): ReadonlyMap<string, string[]> {
  return new Map([[peekKey({ path, ...(ref ? { ref } : {}), start, end }), Array.from({ length: end - start + 1 }, (_, i) => `line ${start + i}`)]])
}

// The text a host read from a run checkpoint for one part of one node.
function runText(run: string, node: string, part: TracePart, lines: string[]): ReadonlyMap<string, string[]> {
  return new Map([[traceKey({ run, node, part }), lines]])
}

// The output a host read from git for one diff: the whole diff of a ref, or the part for one path.
function gitText(ref: string, path: string | undefined, lines: string[]): ReadonlyMap<string, string[]> {
  return new Map([[diffKey({ ref, ...(path ? { path } : {}) }), lines]])
}

function accepted<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}: ${result.error.message}`)
  return result.value
}

function refused<T>(result: Result<T>) {
  if (result.ok) throw new Error('expected a refusal, got success')
  return result.error
}

const section = { type: 'section', title: 'Why', text: 'Because' } satisfies BlockInput
const callout = { type: 'callout', tone: 'risk', title: 'Watch', text: 'A loop never ends' } satisfies BlockInput
const flowOf = (edges: FlowEdge[]): BlockInput => ({
  type: 'flow',
  nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }],
  edges,
})
const peekOf = (path: string, start: number, end: number): BlockInput => ({ type: 'code_peek', path, start, end })
const snippetOf = (code: string): BlockInput => ({ type: 'code', code })
const traceOf = (run: string, node: string, part: TracePart): BlockInput => ({ type: 'trace', run, node, part })
const peekAt = (ref: string, path = 'src/a.ts', start = 3, end = 5): BlockInput => ({ type: 'code_peek', path, ref, start, end })
const diffOf = (ref: string, path?: string): BlockInput => ({ type: 'diff', ref, ...(path ? { path } : {}) })
// Raw input, as the model sends it: parseEdits is where a bad block is refused before any file or run is read.
const traceEdit = (fields: Record<string, unknown>) => parseEdits([{ op: 'insert', block: { type: 'trace', run: 'dag_1', node: 'build', part: 'output', ...fields } }])
const diffEdit = (fields: Record<string, unknown>) => parseEdits([{ op: 'insert', block: { type: 'diff', ref: 'main', ...fields } }])
const peekEdit = (fields: Record<string, unknown>) => parseEdits([{ op: 'insert', block: { type: 'code_peek', path: 'src/a.ts', start: 1, end: 2, ...fields } }])
const textLines = (count: number, width: number) => Array.from({ length: count }, () => 'x'.repeat(width)).join('\n')

test('insert adds a section with the next id and stamps updatedAt', () => {
  const { board, inserted } = accepted(apply(boardOf(), [insert(section)]))
  expect(inserted).toEqual(['b1'])
  expect(board.blocks).toEqual([{ id: 'b1', type: 'section', title: 'Why', text: 'Because' }])
  expect(board.nextId).toBe(2)
  expect(board.updatedAt).toBe(NOW)
})

test('insert adds a callout, trimming its strings', () => {
  const { board } = accepted(apply(boardOf(), [insert({ type: 'callout', tone: 'decision', text: '  Use a queue  ' })]))
  expect(board.blocks).toEqual([{ id: 'b1', type: 'callout', tone: 'decision', text: 'Use a queue' }])
})

test('insert adds a table whose rows match its columns', () => {
  const table: BlockInput = { type: 'table', title: 'Keys', columns: ['key', 'does'], rows: [['b', 'board'], ['g', 'graph']] }
  expect(accepted(apply(boardOf(), [insert(table)])).board.blocks).toEqual([{ id: 'b1', ...table }])
})

test('insert adds a code_peek with the lines the host read for its range', () => {
  const { board } = accepted(apply(boardOf(), [insert(peekOf('src/a.ts', 3, 5))], fileText('src/a.ts', 3, 5)))
  expect(board.blocks).toEqual([{ id: 'b1', type: 'code_peek', path: 'src/a.ts', start: 3, end: 5, lines: ['line 3', 'line 4', 'line 5'] }])
})

test('insert adds a flow and a sequence', () => {
  const flow = flowOf([{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }])
  const sequence: BlockInput = {
    type: 'sequence',
    participants: [{ id: 'user', label: 'User' }, { id: 'hook', label: 'Hook' }],
    steps: [{ from: 'user', to: 'hook', label: 'prompt' }, { from: 'hook', to: 'hook', label: 'route', kind: 'note' }],
  }
  const { board } = accepted(apply(boardOf(), [insert(flow), insert(sequence)]))
  expect(board.blocks).toEqual([{ id: 'b1', ...flow }, { id: 'b2', ...sequence }])
})

test('insert places a block after afterId and appends without one', () => {
  const start = boardOf([{ id: 'b1', ...section }, { id: 'b2', ...section }, { id: 'b3', ...section }])
  const middle = accepted(apply(start, [insert(callout, 'b1')]))
  expect(middle.board.blocks.map(block => block.id)).toEqual(['b1', 'b4', 'b2', 'b3'])
  expect(accepted(apply(start, [insert(callout)])).board.blocks.map(block => block.id)).toEqual(['b1', 'b2', 'b3', 'b4'])
})

test('insert after a block the board does not hold fails with unknown_block and lists what it holds', () => {
  const error = refused(apply(boardOf([{ id: 'b1', ...section }]), [insert(callout, 'b9')]))
  expect(error.code).toBe('unknown_block')
  expect(error.message).toContain('edits[0]')
  expect(error.message).toContain('b9')
  expect(error.message).toContain('b1')
})

test('a removed block id is never handed out again', () => {
  const first = accepted(apply(boardOf(), [insert(section), insert(callout)])).board
  const removed = accepted(apply(first, [{ op: 'remove', id: 'b2' }])).board
  expect(removed.blocks.map(block => block.id)).toEqual(['b1'])
  const next = accepted(apply(removed, [insert(callout)]))
  expect(next.inserted).toEqual(['b3'])
  expect(next.board.blocks.map(block => block.id)).toEqual(['b1', 'b3'])
})

test('remove of a block the board does not hold fails with unknown_block', () => {
  expect(refused(apply(boardOf(), [{ op: 'remove', id: 'b1' }])).code).toBe('unknown_block')
})

test('update merges the changes into the block and keeps the rest', () => {
  const start = boardOf([{ id: 'b1', type: 'callout', tone: 'info', title: 'Note', text: 'Old' }])
  const { board } = accepted(apply(start, [{ op: 'update', id: 'b1', changes: { text: 'New', tone: 'warning' } }]))
  expect(board.blocks).toEqual([{ id: 'b1', type: 'callout', tone: 'warning', title: 'Note', text: 'New' }])
})

test('update sending "" for an optional field clears it', () => {
  const start = boardOf([{ id: 'b1', type: 'callout', tone: 'info', title: 'Note', text: 'Old' }])
  const { board } = accepted(apply(start, [{ op: 'update', id: 'b1', changes: { title: '' } }]))
  expect(board.blocks).toEqual([{ id: 'b1', type: 'callout', tone: 'info', text: 'Old' }])
})

test('update validates the merged block', () => {
  const start = boardOf([{ id: 'b1', type: 'callout', tone: 'info', text: 'Old' }])
  const error = refused(apply(start, [{ op: 'update', id: 'b1', changes: { tone: 'loud' } }]))
  expect(error.code).toBe('invalid_board_edit')
  expect(error.message).toContain('edits[0]: tone')
  expect(refused(apply(start, [{ op: 'update', id: 'b1', changes: { text: '   ' } }])).message).toContain('text')
  expect(refused(apply(start, [{ op: 'update', id: 'b1', changes: { colour: 'red' } }])).message).toContain('colour')
})

test('update refuses a change of type, id or lines', () => {
  const start = boardOf([{ id: 'b1', type: 'code_peek', path: 'src/a.ts', start: 1, end: 1, lines: ['x'] }])
  for (const field of ['type', 'id', 'lines']) {
    const error = refused(apply(start, [{ op: 'update', id: 'b1', changes: { [field]: field === 'lines' ? ['y'] : 'b2' } }]))
    expect(error.code).toBe('invalid_board_edit')
    expect(error.message).toContain(`edits[0]: ${field}: cannot be changed`)
  }
})

test('update of a block the board does not hold fails with unknown_block', () => {
  expect(refused(apply(boardOf(), [{ op: 'update', id: 'b4', changes: { text: 'x' } }])).code).toBe('unknown_block')
})

test('update of a code_peek note keeps its lines, and of its range takes the new lines from the host', () => {
  const start = boardOf([{ id: 'b1', type: 'code_peek', path: 'src/a.ts', start: 1, end: 2, lines: ['old 1', 'old 2'] }])
  const noted = accepted(apply(start, [{ op: 'update', id: 'b1', changes: { note: 'why' } }])).board
  expect(noted.blocks).toEqual([{ id: 'b1', type: 'code_peek', path: 'src/a.ts', start: 1, end: 2, lines: ['old 1', 'old 2'], note: 'why' }])
  const moved = accepted(apply(noted, [{ op: 'update', id: 'b1', changes: { start: 10, end: 11 } }], fileText('src/a.ts', 10, 11))).board
  expect(moved.blocks).toEqual([{ id: 'b1', type: 'code_peek', path: 'src/a.ts', start: 10, end: 11, lines: ['line 10', 'line 11'], note: 'why' }])
  expect(refused(apply(noted, [{ op: 'update', id: 'b1', changes: { start: 10, end: 11 } }])).message).toContain('src/a.ts#L10-L11')
})

test('replace keeps the id and puts the new block in the same place', () => {
  const start = boardOf([{ id: 'b1', ...section }, { id: 'b2', ...section }, { id: 'b3', ...section }])
  const { board, inserted } = accepted(apply(start, [{ op: 'replace', id: 'b2', block: callout }]))
  expect(inserted).toEqual([])
  expect(board.blocks.map(block => block.id)).toEqual(['b1', 'b2', 'b3'])
  expect(board.blocks[1]).toEqual({ id: 'b2', ...callout })
  expect(board.nextId).toBe(4)
})

test('replace validates the new block and refuses an unknown id', () => {
  const start = boardOf([{ id: 'b1', ...section }])
  expect(refused(apply(start, [{ op: 'replace', id: 'b1', block: flowOf([{ from: 'a', to: 'z' }]) }])).code).toBe('invalid_board_edit')
  expect(refused(apply(start, [{ op: 'replace', id: 'b7', block: callout }])).code).toBe('unknown_block')
})

test('a valid edit followed by an invalid one changes nothing and the error names edits[1]', () => {
  const start = boardOf([{ id: 'b1', ...section }])
  const before = structuredClone(start)
  const error = refused(apply(start, [insert(callout), { op: 'update', id: 'b1', changes: { title: '' } }]))
  expect(error.code).toBe('invalid_board_edit')
  expect(error.message.startsWith('edits[1]: ')).toBe(true)
  expect(start).toEqual(before)
})

test('applying edits never changes the board it was given', () => {
  const start = boardOf([{ id: 'b1', ...section }])
  const before = structuredClone(start)
  const { board } = accepted(apply(start, [insert(callout), { op: 'remove', id: 'b1' }]))
  expect(board.blocks.map(block => block.id)).toEqual(['b2'])
  expect(start).toEqual(before)
})

test('a flow whose edges loop back is refused and the message names the cycle', () => {
  const error = refused(apply(boardOf(), [insert(flowOf([{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }]))]))
  expect(error.code).toBe('invalid_board_edit')
  expect(error.message).toContain('cycle a -> b -> a')
  expect(error.message).toContain('draw a loop as a note')
})

test('a three-step flow cycle reads in edge direction', () => {
  const error = refused(apply(boardOf(), [insert(flowOf([{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }]))]))
  expect(error.message).toContain('cycle a -> b -> c -> a')
})

test('a flow with branches that rejoin has no cycle', () => {
  const flow = flowOf([{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }, { from: 'b', to: 'c' }])
  expect(accepted(apply(boardOf(), [insert(flow)])).board.blocks).toHaveLength(1)
})

test('a flow edge naming a node that is not drawn is refused', () => {
  const error = refused(apply(boardOf(), [insert(flowOf([{ from: 'a', to: 'zzz' }]))]))
  expect(error.message).toContain('edits[0]: edges[0].to')
  expect(error.message).toContain('must name a node: a, b, c')
})

test('a flow edge from a node to itself, a repeated edge and a repeated node id are refused', () => {
  expect(refused(apply(boardOf(), [insert(flowOf([{ from: 'a', to: 'a' }]))])).message).toContain('itself')
  expect(refused(apply(boardOf(), [insert(flowOf([{ from: 'a', to: 'b' }, { from: 'a', to: 'b' }]))])).message).toContain('a -> b is drawn twice')
  const twice: BlockInput = { type: 'flow', nodes: [{ id: 'a', label: 'A' }, { id: 'a', label: 'Again' }], edges: [] }
  expect(refused(apply(boardOf(), [insert(twice)])).message).toContain('id a is used twice')
})

test('a flow node id outside letters, digits, underscore, dash and dot is refused', () => {
  const spaced: BlockInput = { type: 'flow', nodes: [{ id: 'two words', label: 'A' }], edges: [] }
  expect(refused(apply(boardOf(), [insert(spaced)])).message).toContain('nodes[0].id')
})

test('a flow holds 24 nodes and 48 edges at most', () => {
  const nodes = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `n${i}`, label: `N${i}` }))
  expect(accepted(apply(boardOf(), [insert({ type: 'flow', nodes: nodes(24), edges: [] })])).board.blocks).toHaveLength(1)
  expect(refused(apply(boardOf(), [insert({ type: 'flow', nodes: nodes(25), edges: [] })])).message).toContain('nodes: must hold 1-24 items')
  // 12 nodes give 66 forward pairs, none of which closes a cycle.
  const wide = nodes(12)
  const forward = wide.flatMap((from, i) => wide.slice(i + 1).map(to => ({ from: from.id, to: to.id })))
  expect(accepted(apply(boardOf(), [insert({ type: 'flow', nodes: wide, edges: forward.slice(0, 48) })])).board.blocks).toHaveLength(1)
  expect(refused(apply(boardOf(), [insert({ type: 'flow', nodes: wide, edges: forward.slice(0, 49) })])).message).toContain('edges: must hold 0-48 items')
})

test('a table row with the wrong number of cells is refused', () => {
  const table: BlockInput = { type: 'table', columns: ['a', 'b'], rows: [['1', '2'], ['3']] }
  const error = refused(apply(boardOf(), [insert(table)]))
  expect(error.message).toContain('edits[0]: rows[1]')
  expect(error.message).toContain('must hold 2 items, got 1')
})

test('a table holds 6 columns, 30 rows and cells of 80 characters at most', () => {
  expect(refused(apply(boardOf(), [insert({ type: 'table', columns: ['1', '2', '3', '4', '5', '6', '7'], rows: [] })])).message).toContain('columns')
  const rows = (count: number) => Array.from({ length: count }, () => ['x'])
  expect(accepted(apply(boardOf(), [insert({ type: 'table', columns: ['c'], rows: rows(30) })])).board.blocks).toHaveLength(1)
  expect(refused(apply(boardOf(), [insert({ type: 'table', columns: ['c'], rows: rows(31) })])).message).toContain('rows: must hold 0-30 items')
  expect(accepted(apply(boardOf(), [insert({ type: 'table', columns: ['c'], rows: [['x'.repeat(80)]] })])).board.blocks).toHaveLength(1)
  expect(refused(apply(boardOf(), [insert({ type: 'table', columns: ['c'], rows: [['x'.repeat(81)]] })])).message).toContain('rows[0][0]')
})

test('a code_peek of 40 lines is accepted and of 41 lines is refused', () => {
  expect(accepted(apply(boardOf(), [insert(peekOf('src/a.ts', 10, 49))], fileText('src/a.ts', 10, 49))).board.blocks).toHaveLength(1)
  const error = refused(apply(boardOf(), [insert(peekOf('src/a.ts', 10, 50))], fileText('src/a.ts', 10, 50)))
  expect(error.code).toBe('invalid_board_edit')
  expect(error.message).toContain('edits[0]: end')
  expect(error.message).toContain('at most 40 lines')
})

test('a code_peek range must start at line 1 or later and end at or after its start', () => {
  expect(refused(apply(boardOf(), [insert(peekOf('src/a.ts', 0, 3))])).message).toContain('start')
  expect(refused(apply(boardOf(), [insert(peekOf('src/a.ts', 5, 4))])).message).toContain('end')
  expect(refused(apply(boardOf(), [insert(peekOf('src/a.ts', 1.5, 3))])).message).toContain('start')
})

test('a code_peek path must stay inside the project and outside .claude', () => {
  for (const path of ['../secrets.txt', 'src/../../x', '/etc/passwd', '.claude/dag/runs/x.json', 'a/.CLAUDE/b', 'C:\\x']) {
    const error = refused(apply(boardOf(), [insert(peekOf(path, 1, 2))], fileText(path, 1, 2)))
    expect(error.message).toContain('edits[0]: path')
  }
})

test('a code_peek whose file text was not read is refused and the message names the range', () => {
  const error = refused(apply(boardOf(), [insert(peekOf('src/gone.ts', 4, 9))]))
  expect(error.code).toBe('invalid_board_edit')
  expect(error.message).toContain('src/gone.ts#L4-L9')
})

test('a code_peek reaching past the end of the file is refused', () => {
  const short = new Map([['src/a.ts#L1-L5', ['one', 'two']]])
  const error = refused(apply(boardOf(), [insert(peekOf('src/a.ts', 1, 5))], short))
  expect(error.message).toContain('2 of 5 lines exist')
})

test('a code_peek keeps each line to 240 characters', () => {
  const long = new Map([['src/a.ts#L1-L1', ['y'.repeat(500)]]])
  const { board } = accepted(apply(boardOf(), [insert(peekOf('src/a.ts', 1, 1))], long))
  const block = board.blocks[0]
  expect(block?.type === 'code_peek' && block.lines[0]?.length).toBe(240)
})

test('insert adds a code_peek at a git ref, naming the ref and holding the lines read at it', () => {
  const { board } = accepted(apply(boardOf(), [insert(peekAt(' main~2 '))], fileText('src/a.ts', 3, 5, 'main~2')))
  expect(board.blocks).toEqual([{ id: 'b1', type: 'code_peek', path: 'src/a.ts', ref: 'main~2', start: 3, end: 5, lines: ['line 3', 'line 4', 'line 5'] }])
})

test('a code_peek ref is a git ref or an a..b range of at most 64 characters, never an option or a path', () => {
  for (const ref of ['main', 'HEAD~3', 'origin/main', 'v1.2.3', 'main..feature', 'main...feature', '@{u}', 'HEAD^{commit}', 'a'.repeat(64)]) {
    expect(accepted(peekEdit({ ref }))).toHaveLength(1)
  }
  for (const ref of ['-x', '--output=/tmp/x', 'a b', 'a:b', 'a;b', '$(id)', 'a\nb', '.hidden', 'a'.repeat(65)]) {
    const error = refused(peekEdit({ ref }))
    expect(error.code).toBe('invalid_board_edit')
    expect(error.message).toContain('edits[0]: ref')
  }
  expect(refused(peekEdit({ ref: 7 })).message).toBe('edits[0]: ref: must be a string')
})

test('a code_peek read at a ref that the host could not read is refused, naming the ref', () => {
  const error = refused(apply(boardOf(), [insert(peekAt('v9', 'src/gone.ts', 4, 9))], fileText('src/gone.ts', 4, 9)))
  expect(error.message).toContain('src/gone.ts#L4-L9@v9')
  expect(error.message).toContain('at that ref')
})

test('update of a code_peek ref reads the lines again, and "" returns it to the worktree', () => {
  const start = boardOf([{ id: 'b1', type: 'code_peek', path: 'src/a.ts', start: 3, end: 5, lines: ['old 3', 'old 4', 'old 5'] }])
  const pinned = accepted(apply(start, [{ op: 'update', id: 'b1', changes: { ref: 'v1' } }], fileText('src/a.ts', 3, 5, 'v1'))).board
  expect(pinned.blocks).toEqual([{ id: 'b1', type: 'code_peek', path: 'src/a.ts', ref: 'v1', start: 3, end: 5, lines: ['line 3', 'line 4', 'line 5'] }])
  // Without the text for the new ref the old lines must not survive as if they came from it.
  const stale = refused(apply(start, [{ op: 'update', id: 'b1', changes: { ref: 'v2' } }]))
  expect(stale.message).toContain('src/a.ts#L3-L5@v2')
  const noted = accepted(apply(pinned, [{ op: 'update', id: 'b1', changes: { note: 'why' } }])).board
  expect(noted.blocks[0]).toEqual({ ...pinned.blocks[0], note: 'why' })
  const back = accepted(apply(pinned, [{ op: 'update', id: 'b1', changes: { ref: '' } }], new Map([['src/a.ts#L3-L5', ['wt 3', 'wt 4', 'wt 5']]]))).board
  expect(back.blocks).toEqual([{ id: 'b1', type: 'code_peek', path: 'src/a.ts', start: 3, end: 5, lines: ['wt 3', 'wt 4', 'wt 5'] }])
})

test('insert adds a code block that keeps its text as sent, indentation and trailing newline included', () => {
  const code = '  if (ok) {\n    go()\n  }\n'
  const { board } = accepted(apply(boardOf(), [insert({ type: 'code', title: ' Fix ', language: ' ts ', code, note: ' why ' })]))
  expect(board.blocks).toEqual([{ id: 'b1', type: 'code', title: 'Fix', language: 'ts', code, note: 'why' }])
})

test('a code block drops empty optional fields and needs no file or run text', () => {
  const { board } = accepted(apply(boardOf(), [insert({ type: 'code', code: 'x = 1', language: '', note: '', title: '' })]))
  expect(board.blocks).toEqual([{ id: 'b1', type: 'code', code: 'x = 1' }])
})

test('a code block of 40 lines is accepted, and of 41 lines is refused with the count', () => {
  expect(accepted(apply(boardOf(), [insert(snippetOf(textLines(40, 10)))])).board.blocks).toHaveLength(1)
  // A trailing newline ends the 40th line; it does not start a 41st.
  expect(accepted(apply(boardOf(), [insert(snippetOf(`${textLines(40, 10)}\n`))])).board.blocks).toHaveLength(1)
  const error = refused(apply(boardOf(), [insert(snippetOf(textLines(41, 10)))]))
  expect(error.code).toBe('invalid_board_edit')
  expect(error.message).toBe('edits[0]: code: at most 40 lines, got 41')
})

test('a code line of 240 characters is accepted, and of 241 is refused naming the line index', () => {
  expect(accepted(apply(boardOf(), [insert(snippetOf(`a\n${'x'.repeat(240)}`))])).board.blocks).toHaveLength(1)
  const error = refused(apply(boardOf(), [insert(snippetOf(`a\nb\n${'x'.repeat(241)}\nd`))]))
  expect(error.code).toBe('invalid_board_edit')
  expect(error.message).toContain('edits[0]: code: line 3 (index 2) has 241 characters')
  expect(error.message).toContain('at most 240')
})

test('a code block holds 4000 characters at most, counted as sent', () => {
  // 20 lines: one of 200 characters, nineteen of 199, nineteen newlines.
  const full = Array.from({ length: 20 }, (_, i) => 'x'.repeat(i === 0 ? 200 : 199)).join('\n')
  expect(full).toHaveLength(4000)
  expect(accepted(apply(boardOf(), [insert(snippetOf(full))])).board.blocks).toHaveLength(1)
  expect(refused(apply(boardOf(), [insert(snippetOf(`${full}x`))])).message).toBe('edits[0]: code: must be 1-4000 characters, got 4001')
})

test('a code block refuses empty code, whitespace-only code, a missing code and one that is not text', () => {
  expect(refused(apply(boardOf(), [insert(snippetOf(''))])).message).toBe('edits[0]: code: must be 1-4000 characters, got 0')
  expect(refused(apply(boardOf(), [insert(snippetOf('  \n\t '))])).message).toBe('edits[0]: code: must hold more than whitespace')
  expect(refused(parseEdits([{ op: 'insert', block: { type: 'code' } }])).message).toBe('edits[0]: code: must be a string')
  expect(refused(parseEdits([{ op: 'insert', block: { type: 'code', code: 5 } }])).message).toBe('edits[0]: code: must be a string')
})

test('a code block refuses an unknown field and a title, language or note over its limit', () => {
  expect(refused(parseEdits([{ op: 'insert', block: { type: 'code', code: 'x', path: 'a.ts' } }])).message).toContain('edits[0]: path: unknown field')
  expect(refused(parseEdits([{ op: 'insert', block: { type: 'code', code: 'x', lines: ['x'] } }])).message).toContain('edits[0]: lines: unknown field')
  const block = (extra: { language?: string; note?: string; title?: string }): BoardEdit => insert({ type: 'code', code: 'x', ...extra })
  expect(accepted(apply(boardOf(), [block({ language: 'l'.repeat(20) })])).board.blocks).toHaveLength(1)
  expect(refused(apply(boardOf(), [block({ language: 'l'.repeat(21) })])).message).toBe('edits[0]: language: must be at most 20 characters, got 21')
  expect(refused(apply(boardOf(), [block({ note: 'n'.repeat(201) })])).message).toContain('edits[0]: note')
  expect(refused(apply(boardOf(), [block({ title: 't'.repeat(81) })])).message).toContain('edits[0]: title')
})

test('update of a code block merges and checks the whole block, and keeps the snippet untrimmed', () => {
  const start = boardOf([{ id: 'b1', type: 'code', language: 'ts', code: 'old' }])
  const indented = accepted(apply(start, [{ op: 'update', id: 'b1', changes: { code: '    deeper\n', language: '' } }])).board
  expect(indented.blocks).toEqual([{ id: 'b1', type: 'code', code: '    deeper\n' }])
  expect(refused(apply(start, [{ op: 'update', id: 'b1', changes: { code: ' \n ' } }])).message).toContain('edits[0]: code')
  expect(refused(apply(start, [{ op: 'update', id: 'b1', changes: { lines: ['x'] } }])).message).toContain('edits[0]: lines: cannot be changed')
})

test('insert adds a trace with the lines the host read from the run checkpoint', () => {
  const read = new Map([['dag_1#build#output', ['ok 1', 'ok 2']]])
  const { board } = accepted(apply(boardOf(), [insert({ type: 'trace', title: ' Build ', run: ' dag_1 ', node: 'build', part: 'output', note: ' tail ' })], NO_PEEKS, read))
  expect(board.blocks).toEqual([{ id: 'b1', type: 'trace', title: 'Build', run: 'dag_1', node: 'build', part: 'output', lines: ['ok 1', 'ok 2'], note: 'tail' }])
})

test('a trace keeps the first 39 lines of an artifact plus a dropped-count marker, and cuts each to 240 characters', () => {
  const long = Array.from({ length: 55 }, (_, i) => `${i}:${'y'.repeat(500)}`)
  const { board } = accepted(apply(boardOf(), [insert(traceOf('dag_1', 'build', 'answer'))], NO_PEEKS, runText('dag_1', 'build', 'answer', long)))
  const block = board.blocks[0]
  expect(block?.type === 'trace' && block.lines).toHaveLength(40)
  expect(block?.type === 'trace' && block.lines[0]?.length).toBe(240)
  expect(block?.type === 'trace' && block.lines[38]?.startsWith('38:')).toBe(true)
  expect(block?.type === 'trace' && block.lines[39]).toBe('… +16 more lines')
})

test('a trace of exactly 40 lines needs no marker', () => {
  const { board } = accepted(apply(boardOf(), [insert(traceOf('dag_1', 'build', 'answer'))], NO_PEEKS, runText('dag_1', 'build', 'answer', Array.from({ length: 40 }, (_, i) => `line ${i}`))))
  const block = board.blocks[0]
  expect(block?.type === 'trace' && block.lines).toHaveLength(40)
  expect(block?.type === 'trace' && block.lines[39]?.startsWith('…')).toBe(false)
})

test('a trace whose artifact was not read is refused, naming run, node and part, and nothing is applied', () => {
  const start = boardOf([{ id: 'b1', ...section }])
  const before = structuredClone(start)
  const error = refused(apply(start, [insert(callout), insert(traceOf('dag_1', 'build', 'verification'))], NO_PEEKS, runText('dag_1', 'build', 'output', ['x'])))
  expect(error.code).toBe('invalid_board_edit')
  expect(error.message.startsWith('edits[1]: run: ')).toBe(true)
  for (const name of ['dag_1', 'build', 'verification', 'dag_1#build#verification']) expect(error.message).toContain(name)
  expect(start).toEqual(before)
})

test('a trace whose artifact is empty is refused rather than drawn as an empty quote', () => {
  const error = refused(apply(boardOf(), [insert(traceOf('dag_1', 'build', 'error'))], NO_PEEKS, runText('dag_1', 'build', 'error', [])))
  expect(error.code).toBe('invalid_board_edit')
  expect(error.message).toContain('edits[0]: part')
  expect(error.message).toContain('is empty')
})

test('a trace names its run, node and part: run and node are 1-64 characters and part is one of four', () => {
  expect(accepted(traceEdit({ run: 'r'.repeat(64), node: 'n'.repeat(64) }))).toHaveLength(1)
  expect(refused(traceEdit({ run: 'r'.repeat(65) })).message).toBe('edits[0]: run: must be 1-64 characters, got 65')
  expect(refused(traceEdit({ run: '  ' })).message).toContain('edits[0]: run')
  expect(refused(traceEdit({ node: 'n'.repeat(65) })).message).toBe('edits[0]: node: must be 1-64 characters, got 65')
  expect(refused(traceEdit({ node: undefined })).message).toContain('edits[0]: node')
  const schemaParts = BOARD_INPUT_SCHEMA.properties.edits.items.properties.block.properties.part.enum
  expect(refused(traceEdit({ part: 'log' })).message).toBe(`edits[0]: part: must be one of ${schemaParts.join(', ')}`)
  expect(refused(traceEdit({ note: 'n'.repeat(201) })).message).toContain('edits[0]: note')
  expect(refused(traceEdit({ title: 't'.repeat(81) })).message).toContain('edits[0]: title')
})

test('a trace takes no line range and no lines from the model', () => {
  for (const field of ['start', 'end', 'path', 'lines', 'code']) {
    expect(refused(traceEdit({ [field]: 1 })).message).toContain(`edits[0]: ${field}: unknown field`)
  }
})

test('update of a trace title or note keeps its lines, and of run, node or part reads them again', () => {
  const start = boardOf([{ id: 'b1', type: 'trace', run: 'dag_1', node: 'build', part: 'output', lines: ['old 1', 'old 2'] }])
  // No run text is supplied here: a title or note update must not need any.
  const noted = accepted(apply(start, [{ op: 'update', id: 'b1', changes: { title: 'Build tail', note: 'why' } }])).board
  expect(noted.blocks).toEqual([{ id: 'b1', type: 'trace', title: 'Build tail', run: 'dag_1', node: 'build', part: 'output', lines: ['old 1', 'old 2'], note: 'why' }])
  const parted = accepted(apply(noted, [{ op: 'update', id: 'b1', changes: { part: 'error' } }], NO_PEEKS, runText('dag_1', 'build', 'error', ['boom']))).board
  expect(parted.blocks).toEqual([{ id: 'b1', type: 'trace', title: 'Build tail', run: 'dag_1', node: 'build', part: 'error', lines: ['boom'], note: 'why' }])
  const moved = accepted(apply(parted, [{ op: 'update', id: 'b1', changes: { run: 'dag_2', node: 'test' } }], NO_PEEKS, runText('dag_2', 'test', 'error', ['fail 1']))).board
  expect(moved.blocks[0]).toEqual({ id: 'b1', type: 'trace', title: 'Build tail', run: 'dag_2', node: 'test', part: 'error', lines: ['fail 1'], note: 'why' })
})

test('update of a trace part without the new run text is refused and the board is not changed', () => {
  const start = boardOf([{ id: 'b1', type: 'trace', run: 'dag_1', node: 'build', part: 'output', lines: ['old'] }])
  const before = structuredClone(start)
  const error = refused(apply(start, [{ op: 'update', id: 'b1', changes: { part: 'answer' } }]))
  expect(error.code).toBe('invalid_board_edit')
  expect(error.message).toContain('dag_1#build#answer')
  expect(start).toEqual(before)
})

test('update refuses a trace change of lines or type', () => {
  const start = boardOf([{ id: 'b1', type: 'trace', run: 'dag_1', node: 'build', part: 'output', lines: ['old'] }])
  for (const field of ['lines', 'type']) {
    const error = refused(apply(start, [{ op: 'update', id: 'b1', changes: { [field]: field === 'lines' ? ['new'] : 'code' } }]))
    expect(error.message).toContain(`edits[0]: ${field}: cannot be changed`)
  }
})

test('replace turns a block into a trace with the host lines, and a trace into a code block without any', () => {
  const start = boardOf([{ id: 'b1', ...section }])
  const traced = accepted(apply(start, [{ op: 'replace', id: 'b1', block: traceOf('dag_1', 'build', 'output') }], NO_PEEKS, runText('dag_1', 'build', 'output', ['a']))).board
  expect(traced.blocks).toEqual([{ id: 'b1', type: 'trace', run: 'dag_1', node: 'build', part: 'output', lines: ['a'] }])
  const coded = accepted(apply(traced, [{ op: 'replace', id: 'b1', block: snippetOf('x') }])).board
  expect(coded.blocks).toEqual([{ id: 'b1', type: 'code', code: 'x' }])
})

test('insert adds a diff with the lines the host read from git, trimming its strings', () => {
  const edit = insert({ type: 'diff', title: ' Routing ', ref: ' main~1 ', path: ' hooks/a.ts ', note: ' why ' })
  const { board } = accepted(apply(boardOf(), [edit], NO_PEEKS, NO_TRACES, gitText('main~1', 'hooks/a.ts', ['@@ -1 +1 @@', '-old', '+new'])))
  expect(board.blocks).toEqual([{ id: 'b1', type: 'diff', title: 'Routing', ref: 'main~1', path: 'hooks/a.ts', lines: ['@@ -1 +1 @@', '-old', '+new'], note: 'why' }])
})

test('a diff without a path covers the whole ref, and "" for the path means none', () => {
  const read = gitText('main..feature', undefined, ['diff --git a/x b/x'])
  const whole = accepted(apply(boardOf(), [insert(diffOf('main..feature'))], NO_PEEKS, NO_TRACES, read)).board
  expect(whole.blocks).toEqual([{ id: 'b1', type: 'diff', ref: 'main..feature', lines: ['diff --git a/x b/x'] }])
  expect(accepted(apply(boardOf(), [insert({ type: 'diff', ref: 'main..feature', path: '' })], NO_PEEKS, NO_TRACES, read)).board.blocks).toEqual(whole.blocks)
})

test('a diff needs a ref that is a git ref or an a..b range, and refuses one that git could read as an option', () => {
  expect(refused(parseEdits([{ op: 'insert', block: { type: 'diff' } }])).message).toBe('edits[0]: ref: must be a string')
  expect(refused(diffEdit({ ref: '   ' })).message).toBe('edits[0]: ref: must be 1-64 characters, got 0')
  expect(refused(diffEdit({ ref: 'r'.repeat(65) })).message).toBe('edits[0]: ref: must be 1-64 characters, got 65')
  for (const ref of ['-p', '--stat', 'a b', 'a:b', 'HEAD;ls', '.git']) expect(refused(diffEdit({ ref })).message).toContain('edits[0]: ref: must be a git ref')
  for (const ref of ['main', 'HEAD~3', 'origin/main..HEAD', 'abc123', 'v1.0']) expect(accepted(diffEdit({ ref }))).toHaveLength(1)
})

test('a diff path stays inside the project and outside .claude, like a code_peek path', () => {
  for (const path of ['../secrets.txt', 'src/../../x', '/etc/passwd', '.claude/dag/runs/x.json', 'a/.CLAUDE/b', 'C:\\x']) {
    const error = refused(diffEdit({ path }))
    expect(error.code).toBe('invalid_board_edit')
    expect(error.message).toContain('edits[0]: path')
  }
  expect(refused(diffEdit({ path: 'p'.repeat(301) })).message).toContain('edits[0]: path')
  expect(refused(diffEdit({ path: 7 })).message).toBe('edits[0]: path: must be a string')
})

test('a diff takes no range, no lines and no code from the model, and limits its title and note', () => {
  for (const field of ['start', 'end', 'lines', 'code', 'run']) {
    expect(refused(diffEdit({ [field]: 1 })).message).toContain(`edits[0]: ${field}: unknown field`)
  }
  expect(refused(diffEdit({ note: 'n'.repeat(201) })).message).toContain('edits[0]: note')
  expect(refused(diffEdit({ title: 't'.repeat(81) })).message).toContain('edits[0]: title')
})

test('a diff whose git output was not read is refused, naming the ref and path, and nothing is applied', () => {
  const start = boardOf([{ id: 'b1', ...section }])
  const before = structuredClone(start)
  const error = refused(apply(start, [insert(callout), insert(diffOf('v9', 'src/a.ts'))], NO_PEEKS, NO_TRACES, gitText('v9', undefined, ['x'])))
  expect(error.code).toBe('invalid_board_edit')
  expect(error.message.startsWith('edits[1]: ref: ')).toBe(true)
  expect(error.message).toContain('v9::src/a.ts')
  expect(start).toEqual(before)
})

test('a diff with no changes is refused rather than drawn as an empty quote', () => {
  const error = refused(apply(boardOf(), [insert(diffOf('main'))], NO_PEEKS, NO_TRACES, gitText('main', undefined, [])))
  expect(error.code).toBe('invalid_board_edit')
  expect(error.message).toContain('edits[0]: ref')
  expect(error.message).toContain('is empty')
})

test('a diff keeps the first 39 lines plus a dropped-count marker, and cuts each to 240 characters', () => {
  const long = Array.from({ length: 55 }, (_, i) => `${i}:${'y'.repeat(500)}`)
  const { board } = accepted(apply(boardOf(), [insert(diffOf('main'))], NO_PEEKS, NO_TRACES, gitText('main', undefined, long)))
  const block = board.blocks[0]
  expect(block?.type === 'diff' && block.lines).toHaveLength(40)
  expect(block?.type === 'diff' && block.lines[0]?.length).toBe(240)
  expect(block?.type === 'diff' && block.lines[38]?.startsWith('38:')).toBe(true)
  expect(block?.type === 'diff' && block.lines[39]).toBe('… +16 more lines')
})

test('a diff of exactly 40 lines needs no marker', () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`)
  const { board } = accepted(apply(boardOf(), [insert(diffOf('main'))], NO_PEEKS, NO_TRACES, gitText('main', undefined, lines)))
  expect(board.blocks).toEqual([{ id: 'b1', type: 'diff', ref: 'main', lines }])
})

test('update of a diff title or note keeps its lines, and of ref or path runs git again', () => {
  const start = boardOf([{ id: 'b1', type: 'diff', ref: 'main', path: 'src/a.ts', lines: ['-old', '+new'] }])
  // No git output is supplied here: a title or note update must not need any.
  const noted = accepted(apply(start, [{ op: 'update', id: 'b1', changes: { title: 'Change', note: 'why' } }])).board
  expect(noted.blocks).toEqual([{ id: 'b1', type: 'diff', title: 'Change', ref: 'main', path: 'src/a.ts', lines: ['-old', '+new'], note: 'why' }])
  const moved = accepted(apply(noted, [{ op: 'update', id: 'b1', changes: { ref: 'v1' } }], NO_PEEKS, NO_TRACES, gitText('v1', 'src/a.ts', ['+v1']))).board
  expect(moved.blocks[0]).toEqual({ id: 'b1', type: 'diff', title: 'Change', ref: 'v1', path: 'src/a.ts', lines: ['+v1'], note: 'why' })
  const whole = accepted(apply(moved, [{ op: 'update', id: 'b1', changes: { path: '' } }], NO_PEEKS, NO_TRACES, gitText('v1', undefined, ['+all']))).board
  expect(whole.blocks[0]).toEqual({ id: 'b1', type: 'diff', title: 'Change', ref: 'v1', lines: ['+all'], note: 'why' })
})

test('update of a diff ref without the new git output is refused and the board is not changed', () => {
  const start = boardOf([{ id: 'b1', type: 'diff', ref: 'main', lines: ['+x'] }])
  const before = structuredClone(start)
  const error = refused(apply(start, [{ op: 'update', id: 'b1', changes: { ref: 'v2', path: 'src/b.ts' } }]))
  expect(error.code).toBe('invalid_board_edit')
  expect(error.message).toContain('v2::src/b.ts')
  expect(start).toEqual(before)
})

test('update refuses a diff change of lines or type', () => {
  const start = boardOf([{ id: 'b1', type: 'diff', ref: 'main', lines: ['+x'] }])
  for (const field of ['lines', 'type']) {
    const error = refused(apply(start, [{ op: 'update', id: 'b1', changes: { [field]: field === 'lines' ? ['+y'] : 'code' } }]))
    expect(error.message).toContain(`edits[0]: ${field}: cannot be changed`)
  }
})

test('replace turns a code block into a diff with the host lines, and a diff into a section without any', () => {
  const start = boardOf([{ id: 'b1', type: 'code', code: 'x' }])
  const drawn = accepted(apply(start, [{ op: 'replace', id: 'b1', block: diffOf('main') }], NO_PEEKS, NO_TRACES, gitText('main', undefined, ['+a']))).board
  expect(drawn.blocks).toEqual([{ id: 'b1', type: 'diff', ref: 'main', lines: ['+a'] }])
  expect(accepted(apply(drawn, [{ op: 'replace', id: 'b1', block: section }])).board.blocks).toEqual([{ id: 'b1', ...section }])
})

test('a sequence needs 2 to 8 participants and steps between them, and allows a step to itself', () => {
  const people = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `p${i}`, label: `P${i}` }))
  const steps = [{ from: 'p0', to: 'p0', label: 'think' }]
  expect(accepted(apply(boardOf(), [insert({ type: 'sequence', participants: people(2), steps })])).board.blocks).toHaveLength(1)
  expect(refused(apply(boardOf(), [insert({ type: 'sequence', participants: people(1), steps })])).message).toContain('participants: must hold 2-8 items')
  expect(refused(apply(boardOf(), [insert({ type: 'sequence', participants: people(9), steps })])).message).toContain('participants')
  const stranger = [{ from: 'p0', to: 'nobody', label: 'call' }]
  expect(refused(apply(boardOf(), [insert({ type: 'sequence', participants: people(2), steps: stranger })])).message).toContain('steps[0].to')
  const twice = [{ id: 'p0', label: 'A' }, { id: 'p0', label: 'B' }]
  expect(refused(apply(boardOf(), [insert({ type: 'sequence', participants: twice, steps })])).message).toContain('id p0 is used twice')
})

test('string limits: section title 80, callout text 1000, empty required text', () => {
  expect(accepted(apply(boardOf(), [insert({ type: 'section', title: 't'.repeat(80) })])).board.blocks).toHaveLength(1)
  expect(refused(apply(boardOf(), [insert({ type: 'section', title: 't'.repeat(81) })])).message).toContain('title: must be 1-80 characters, got 81')
  expect(refused(apply(boardOf(), [insert({ type: 'section', title: '  ' })])).message).toContain('title')
  expect(refused(apply(boardOf(), [insert({ type: 'section', title: 'ok', text: 't'.repeat(4001) })])).message).toContain('text: must be at most 4000')
  expect(refused(apply(boardOf(), [insert({ type: 'callout', tone: 'info', text: 'x'.repeat(1001) })])).message).toContain('text')
  expect(refused(apply(boardOf(), [insert({ type: 'callout', tone: 'info', text: '' })])).message).toContain('text')
})

test('a board holds 60 blocks and the 61st insert is refused at its own edit', () => {
  const full = boardOf(Array.from({ length: 60 }, (_, i): Block => ({ id: `b${i + 1}`, ...section })))
  const error = refused(apply(full, [insert(callout)]))
  expect(error.message).toContain('edits[0]: a board holds at most 60 blocks')
  expect(accepted(apply(full, [{ op: 'remove', id: 'b1' }, insert(callout)])).board.blocks).toHaveLength(60)
})

test('peeksNeeded asks for the ranges an insert or a replace brings in, once each', () => {
  const board = boardOf([{ id: 'b1', ...section }])
  const edits: BoardEdit[] = [
    insert(peekOf('src/a.ts', 1, 3)),
    insert(section),
    { op: 'replace', id: 'b1', block: peekOf('src/b.ts', 5, 6) },
    insert(peekOf('src/a.ts', 1, 3)),
  ]
  expect(peeksNeeded(board, edits)).toEqual([{ path: 'src/a.ts', start: 1, end: 3 }, { path: 'src/b.ts', start: 5, end: 6 }])
})

test('peeksNeeded asks for an updated code_peek range with the unchanged fields filled in, and only then', () => {
  const board = boardOf([{ id: 'b1', type: 'code_peek', path: 'src/a.ts', start: 1, end: 3, lines: ['x', 'y', 'z'] }])
  expect(peeksNeeded(board, [{ op: 'update', id: 'b1', changes: { start: 2 } }])).toEqual([{ path: 'src/a.ts', start: 2, end: 3 }])
  expect(peeksNeeded(board, [{ op: 'update', id: 'b1', changes: { path: 'src/c.ts', end: 8 } }])).toEqual([{ path: 'src/c.ts', start: 1, end: 8 }])
  expect(peeksNeeded(board, [{ op: 'update', id: 'b1', changes: { note: 'why' } }])).toEqual([])
  expect(peeksNeeded(board, [{ op: 'update', id: 'b9', changes: { start: 2 } }])).toEqual([])
})

test('peeksNeeded never asks for a file the engine would refuse to show', () => {
  const board = boardOf([{ id: 'b1', type: 'code_peek', path: 'src/a.ts', start: 1, end: 3, lines: ['x', 'y', 'z'] }])
  const edits: BoardEdit[] = [
    insert(peekOf('../x', 1, 2)),
    insert(peekOf('.claude/dag/runs/r.json', 1, 2)),
    insert(peekOf('src/a.ts', 1, 41)),
    { op: 'update', id: 'b1', changes: { path: 7 } },
    { op: 'update', id: 'b1', changes: { path: '../../etc/passwd' } },
    { op: 'update', id: 'b1', changes: { start: 'two' } },
  ]
  expect(peeksNeeded(board, edits)).toEqual([])
})

test('peekKey joins path and range', () => {
  expect(peekKey({ path: 'hooks/register.ts', start: 12, end: 30 })).toBe('hooks/register.ts#L12-L30')
})

test('peekKey adds the ref after the range, and no ref, "" or a different ref gives another key', () => {
  const range = { path: 'hooks/register.ts', start: 12, end: 30 }
  expect(peekKey({ ...range, ref: 'main~2' })).toBe('hooks/register.ts#L12-L30@main~2')
  expect(peekKey({ ...range, ref: 'v1' })).not.toBe(peekKey({ ...range, ref: 'v2' }))
  expect(peekKey({ ...range, ref: 'v1' })).not.toBe(peekKey(range))
  // A worktree file named like a path plus a ref must not take the key of that ref's version.
  expect(peekKey({ path: 'logo@2x.png', start: 1, end: 2 })).not.toBe(peekKey({ path: 'logo', ref: '2x.png', start: 1, end: 2 }))
})

test('diffKey is the ref for a whole diff and ref::path for one file', () => {
  expect(diffKey({ ref: 'main..feature' })).toBe('main..feature')
  expect(diffKey({ ref: 'main', path: 'hooks/register.ts' })).toBe('main::hooks/register.ts')
  expect(diffKey({ ref: 'main', path: 'src/a.ts' })).not.toBe(diffKey({ ref: 'main', path: 'src/b.ts' }))
})

test('peeksNeeded keeps two quotes of one range at different refs apart, and both are drawn from their own text', () => {
  const board = boardOf([{ id: 'b1', ...section }])
  const edits: BoardEdit[] = [insert(peekAt('v1')), insert(peekAt('v2')), insert(peekOf('src/a.ts', 3, 5)), insert(peekAt('v1'))]
  expect(peeksNeeded(board, edits)).toEqual([
    { path: 'src/a.ts', ref: 'v1', start: 3, end: 5 },
    { path: 'src/a.ts', ref: 'v2', start: 3, end: 5 },
    { path: 'src/a.ts', start: 3, end: 5 },
  ])
  const read = new Map([
    ['src/a.ts#L3-L5@v1', ['one 3', 'one 4', 'one 5']],
    ['src/a.ts#L3-L5@v2', ['two 3', 'two 4', 'two 5']],
  ])
  const { board: drawn } = accepted(apply(boardOf(), edits.slice(0, 2), read))
  expect(drawn.blocks.map(block => block.type === 'code_peek' && block.lines[0])).toEqual(['one 3', 'two 3'])
})

test('peeksNeeded asks again when an update changes only the ref of a code_peek, and drops the ref when "" clears it', () => {
  const board = boardOf([{ id: 'b1', type: 'code_peek', path: 'src/a.ts', ref: 'v1', start: 1, end: 3, lines: ['x', 'y', 'z'] }])
  expect(peeksNeeded(board, [{ op: 'update', id: 'b1', changes: { ref: 'v2' } }])).toEqual([{ path: 'src/a.ts', ref: 'v2', start: 1, end: 3 }])
  expect(peeksNeeded(board, [{ op: 'update', id: 'b1', changes: { start: 2 } }])).toEqual([{ path: 'src/a.ts', ref: 'v1', start: 2, end: 3 }])
  const cleared = peeksNeeded(board, [{ op: 'update', id: 'b1', changes: { ref: '' } }])
  expect(cleared).toEqual([{ path: 'src/a.ts', start: 1, end: 3 }])
  expect('ref' in (cleared[0] ?? {})).toBe(false)
})

test('peeksNeeded never asks for a ref the engine would refuse', () => {
  const board = boardOf([{ id: 'b1', type: 'code_peek', path: 'src/a.ts', start: 1, end: 3, lines: ['x', 'y', 'z'] }])
  const edits: BoardEdit[] = [
    insert(peekAt('--output=/tmp/x')),
    insert(peekAt('a:b')),
    insert(peekAt('r'.repeat(65))),
    { op: 'update', id: 'b1', changes: { ref: '-p' } },
    { op: 'update', id: 'b1', changes: { ref: 7 } },
  ]
  expect(peeksNeeded(board, edits)).toEqual([])
})

test('traceKey joins run, node and part', () => {
  expect(traceKey({ run: 'dag_1', node: 'build', part: 'output' })).toBe('dag_1#build#output')
})

test('tracesNeeded asks for the artifacts an insert or a replace brings in, once each, with run and node trimmed', () => {
  const board = boardOf([{ id: 'b1', ...section }])
  const edits: BoardEdit[] = [
    insert(traceOf('dag_1', 'build', 'output')),
    insert(section),
    { op: 'replace', id: 'b1', block: traceOf('dag_1', 'test', 'error') },
    insert(traceOf(' dag_1 ', ' build ', 'output')),
    insert(traceOf('dag_1', 'build', 'answer')),
  ]
  expect(tracesNeeded(board, edits)).toEqual([
    { run: 'dag_1', node: 'build', part: 'output' },
    { run: 'dag_1', node: 'test', part: 'error' },
    { run: 'dag_1', node: 'build', part: 'answer' },
  ])
})

test('tracesNeeded asks for an updated trace with the unchanged fields filled in, once, and only for run, node or part', () => {
  const board = boardOf([
    { id: 'b1', type: 'trace', run: 'dag_1', node: 'build', part: 'output', lines: ['x'] },
    { id: 'b2', type: 'code_peek', path: 'src/a.ts', start: 1, end: 1, lines: ['x'] },
  ])
  expect(tracesNeeded(board, [{ op: 'update', id: 'b1', changes: { part: 'verification' } }])).toEqual([{ run: 'dag_1', node: 'build', part: 'verification' }])
  expect(tracesNeeded(board, [{ op: 'update', id: 'b1', changes: { run: 'dag_2', node: 'test' } }])).toEqual([{ run: 'dag_2', node: 'test', part: 'output' }])
  const twice: BoardEdit[] = [{ op: 'update', id: 'b1', changes: { part: 'error' } }, { op: 'update', id: 'b1', changes: { part: 'error', note: 'again' } }]
  expect(tracesNeeded(board, twice)).toEqual([{ run: 'dag_1', node: 'build', part: 'error' }])
  expect(tracesNeeded(board, [{ op: 'update', id: 'b1', changes: { title: 'T', note: 'why' } }])).toEqual([])
  expect(tracesNeeded(board, [{ op: 'update', id: 'b2', changes: { part: 'error' } }])).toEqual([])
  expect(tracesNeeded(board, [{ op: 'update', id: 'b9', changes: { part: 'error' } }])).toEqual([])
})

test('tracesNeeded leaves the blocks of other types to peeksNeeded and never asks for an artifact the engine would refuse', () => {
  const board = boardOf([{ id: 'b1', type: 'trace', run: 'dag_1', node: 'build', part: 'output', lines: ['x'] }])
  const edits: BoardEdit[] = [
    insert(peekOf('src/a.ts', 1, 2)),
    insert(snippetOf('x')),
    insert(traceOf('', 'build', 'output')),
    insert(traceOf('r'.repeat(65), 'build', 'output')),
    insert(traceOf('dag_1', 'n'.repeat(65), 'output')),
    { op: 'update', id: 'b1', changes: { part: 'log' } },
    { op: 'update', id: 'b1', changes: { run: 7 } },
    { op: 'update', id: 'b1', changes: { node: '  ' } },
  ]
  expect(tracesNeeded(board, edits)).toEqual([])
  expect(peeksNeeded(board, [insert(traceOf('dag_1', 'build', 'output'))])).toEqual([])
})

test('diffsNeeded asks for the diffs an insert or a replace brings in, once each, with ref and path trimmed', () => {
  const board = boardOf([{ id: 'b1', ...section }])
  const edits: BoardEdit[] = [
    insert(diffOf('main')),
    insert(section),
    { op: 'replace', id: 'b1', block: diffOf('v1', 'src/a.ts') },
    insert(diffOf(' main ')),
    insert({ type: 'diff', ref: ' v1 ', path: ' src/a.ts ' }),
    insert(diffOf('v1', 'src/b.ts')),
    insert({ type: 'diff', ref: 'main', path: '' }),
  ]
  expect(diffsNeeded(board, edits)).toEqual([
    { ref: 'main' },
    { ref: 'v1', path: 'src/a.ts' },
    { ref: 'v1', path: 'src/b.ts' },
  ])
})

test('diffsNeeded asks for an updated diff with the unchanged fields filled in, once, and only for ref or path', () => {
  const board = boardOf([
    { id: 'b1', type: 'diff', ref: 'main', path: 'src/a.ts', lines: ['+x'] },
    { id: 'b2', type: 'code_peek', path: 'src/a.ts', start: 1, end: 1, lines: ['x'] },
  ])
  expect(diffsNeeded(board, [{ op: 'update', id: 'b1', changes: { ref: 'v1' } }])).toEqual([{ ref: 'v1', path: 'src/a.ts' }])
  expect(diffsNeeded(board, [{ op: 'update', id: 'b1', changes: { path: 'src/b.ts' } }])).toEqual([{ ref: 'main', path: 'src/b.ts' }])
  expect(diffsNeeded(board, [{ op: 'update', id: 'b1', changes: { path: '' } }])).toEqual([{ ref: 'main' }])
  const twice: BoardEdit[] = [{ op: 'update', id: 'b1', changes: { ref: 'v1' } }, { op: 'update', id: 'b1', changes: { ref: 'v1', note: 'again' } }]
  expect(diffsNeeded(board, twice)).toEqual([{ ref: 'v1', path: 'src/a.ts' }])
  expect(diffsNeeded(board, [{ op: 'update', id: 'b1', changes: { title: 'T', note: 'why' } }])).toEqual([])
  expect(diffsNeeded(board, [{ op: 'update', id: 'b2', changes: { ref: 'v1' } }])).toEqual([])
  expect(diffsNeeded(board, [{ op: 'update', id: 'b9', changes: { ref: 'v1' } }])).toEqual([])
})

test('diffsNeeded leaves the other types to their own collectors and never asks for a diff the engine would refuse', () => {
  const board = boardOf([{ id: 'b1', type: 'diff', ref: 'main', lines: ['+x'] }])
  const edits: BoardEdit[] = [
    insert(peekAt('v1')),
    insert(traceOf('dag_1', 'build', 'output')),
    insert(diffOf('-p')),
    insert(diffOf('a b')),
    insert(diffOf('r'.repeat(65))),
    insert(diffOf('main', '../x')),
    insert(diffOf('main', '.claude/dag/runs/r.json')),
    { op: 'update', id: 'b1', changes: { ref: 7 } },
    { op: 'update', id: 'b1', changes: { ref: '' } },
    { op: 'update', id: 'b1', changes: { path: '../../etc/passwd' } },
    { op: 'update', id: 'b1', changes: { path: 7 } },
  ]
  expect(diffsNeeded(board, edits)).toEqual([])
  expect(peeksNeeded(board, [insert(diffOf('main'))])).toEqual([])
  expect(tracesNeeded(board, [insert(diffOf('main'))])).toEqual([])
})

test('parseEdits returns typed edits and an optional afterId', () => {
  const edits = accepted(parseEdits([
    { op: 'insert', block: { type: 'section', title: ' Why ' }, afterId: 'b1' },
    { op: 'update', id: 'b2', changes: { text: 'x' } },
    { op: 'replace', id: 'b3', block: { type: 'callout', tone: 'info', text: 'y' } },
    { op: 'remove', id: 'b4' },
  ]))
  expect(edits).toEqual([
    { op: 'insert', block: { type: 'section', title: 'Why' }, afterId: 'b1' },
    { op: 'update', id: 'b2', changes: { text: 'x' } },
    { op: 'replace', id: 'b3', block: { type: 'callout', tone: 'info', text: 'y' } },
    { op: 'remove', id: 'b4' },
  ])
})

test('parseEdits takes 1 to 20 edits', () => {
  const one = { op: 'remove', id: 'b1' }
  expect(accepted(parseEdits(Array.from({ length: 20 }, () => one)))).toHaveLength(20)
  expect(refused(parseEdits(Array.from({ length: 21 }, () => one))).code).toBe('invalid_board_edit')
  expect(refused(parseEdits([])).code).toBe('invalid_board_edit')
  expect(refused(parseEdits('remove b1')).code).toBe('invalid_board_edit')
})

test('parseEdits refuses an unknown op, a missing field and an unknown field, naming the edit', () => {
  const unknownOp = refused(parseEdits([{ op: 'remove', id: 'b1' }, { op: 'delete', id: 'b1' }]))
  expect(unknownOp.code).toBe('invalid_board_edit')
  expect(unknownOp.message).toBe('edits[1]: op: must be one of insert, update, replace, remove, move')
  expect(refused(parseEdits([{ op: 'remove' }])).message).toContain('edits[0]: id')
  expect(refused(parseEdits([{ op: 'insert' }])).message).toContain('edits[0]: block')
  expect(refused(parseEdits([{ op: 'insert', block: { type: 'section', title: 'x' }, after_id: 'b1' }])).message).toContain('edits[0]: after_id: unknown field')
  expect(refused(parseEdits([{ op: 'update', id: 'b1', changes: {} }])).message).toContain('edits[0]: changes')
  expect(refused(parseEdits([null])).message).toContain('edits[0]')
})

test('parseEdits validates blocks, so a bad one is refused before any file is read', () => {
  const callout = { op: 'insert', block: { type: 'callout', tone: 'loud', text: 'x' } }
  expect(refused(parseEdits([callout])).message).toBe('edits[0]: tone: must be one of info, decision, risk, warning')
  const unknownBlockType = refused(parseEdits([{ op: 'insert', block: { type: 'chart' } }]))
  expect(unknownBlockType.message).toContain('edits[0]: type')
  const withId = refused(parseEdits([{ op: 'insert', block: { type: 'section', title: 'x', id: 'b9' } }]))
  expect(withId.message).toContain('edits[0]: id: unknown field')
  const withLines = refused(parseEdits([{ op: 'insert', block: { type: 'code_peek', path: 'a.ts', start: 1, end: 1, lines: ['x'] } }]))
  expect(withLines.message).toContain('edits[0]: lines: unknown field')
})

test('newBoard trims the title and starts empty at nextId 1', () => {
  const board = accepted(newBoard({ boardId: 'board_1', sessionId: 'sess', title: '  How routing works  ', now: NOW }))
  expect(board).toEqual({ boardId: 'board_1', sessionId: 'sess', title: 'How routing works', createdAt: NOW, updatedAt: NOW, nextId: 1, blocks: [] })
})

test('newBoard refuses an empty title and one over 80 characters', () => {
  expect(refused(newBoard({ boardId: 'b', sessionId: 's', title: '   ', now: NOW })).code).toBe('invalid_board_title')
  expect(accepted(newBoard({ boardId: 'b', sessionId: 's', title: 't'.repeat(80), now: NOW })).title).toHaveLength(80)
  expect(refused(newBoard({ boardId: 'b', sessionId: 's', title: 't'.repeat(81), now: NOW })).code).toBe('invalid_board_title')
})

test('boardForModel replaces the lines of a code_peek with their count', () => {
  const board = boardOf([{ id: 'b1', ...section }, { id: 'b2', type: 'code_peek', path: 'src/a.ts', start: 1, end: 2, lines: ['x', 'y'], note: 'n' }])
  const shown = boardForModel(board)
  expect(shown.blocks).toEqual([
    { id: 'b1', ...section },
    { id: 'b2', type: 'code_peek', path: 'src/a.ts', start: 1, end: 2, lineCount: 2, note: 'n' },
  ])
  expect(JSON.stringify(shown)).not.toContain('"lines"')
})

test('boardForModel replaces the lines of a trace with their count and returns a code block whole', () => {
  const code = '  indented()\n'
  const board = boardOf([
    { id: 'b1', type: 'code', language: 'ts', code },
    { id: 'b2', type: 'trace', run: 'dag_1', node: 'build', part: 'error', lines: ['x', 'y', 'z'], note: 'n' },
  ])
  const shown = boardForModel(board)
  expect(shown.blocks).toEqual([
    { id: 'b1', type: 'code', language: 'ts', code },
    { id: 'b2', type: 'trace', run: 'dag_1', node: 'build', part: 'error', lineCount: 3, note: 'n' },
  ])
  expect(JSON.stringify(shown)).not.toContain('"lines"')
})

test('boardForModel replaces the lines of a diff with their count, and keeps the ref of a code_peek', () => {
  const board = boardOf([
    { id: 'b1', type: 'diff', ref: 'main', path: 'src/a.ts', lines: ['-x', '+y', '+z'], note: 'n' },
    { id: 'b2', type: 'code_peek', path: 'src/a.ts', ref: 'v1', start: 1, end: 2, lines: ['x', 'y'] },
  ])
  const shown = boardForModel(board)
  expect(shown.blocks).toEqual([
    { id: 'b1', type: 'diff', ref: 'main', path: 'src/a.ts', lineCount: 3, note: 'n' },
    { id: 'b2', type: 'code_peek', path: 'src/a.ts', ref: 'v1', start: 1, end: 2, lineCount: 2 },
  ])
  expect(JSON.stringify(shown)).not.toContain('"lines"')
})

function savedFile(): BoardFile {
  const first = accepted(apply(boardOf(), [insert(section), insert(peekOf('src/a.ts', 1, 2)), insert(flowOf([{ from: 'a', to: 'b' }]))], fileText('src/a.ts', 1, 2))).board
  return { schemaVersion: 1, sessionId: 'sess', boards: [first, { ...boardOf([], 1), boardId: 'board_2', title: 'Empty' }] }
}

test('parseBoardFile reads back what was saved', () => {
  const file = savedFile()
  expect(accepted(parseBoardFile(JSON.stringify(file), 'sess'))).toEqual(file)
})

test('parseBoardFile refuses a file of another session, another schema or broken JSON with invalid_board_file', () => {
  const text = JSON.stringify(savedFile())
  const otherSession = refused(parseBoardFile(text, 'someone-else'))
  expect(otherSession.code).toBe('invalid_board_file')
  expect(otherSession.message).toContain('sessionId')
  const file = savedFile()
  const foreignBoard = JSON.stringify({ ...file, boards: [{ ...file.boards[0], sessionId: 'someone-else' }] })
  expect(refused(parseBoardFile(foreignBoard, 'sess')).message).toContain('boards[0].sessionId')
  expect(refused(parseBoardFile(text.replace('"sessionId":"sess"', '"sessionId":"someone-else"'), 'sess')).message).toBe('board file: sessionId: must be sess')
  expect(refused(parseBoardFile(text.replace('"schemaVersion":1', '"schemaVersion":2'), 'sess')).code).toBe('invalid_board_file')
  expect(refused(parseBoardFile('{"schemaVersion":1,', 'sess')).code).toBe('invalid_board_file')
  expect(refused(parseBoardFile('[]', 'sess')).code).toBe('invalid_board_file')
})

test('parseBoardFile checks every block again: a stored cycle, a short lines array and a reused id are refused', () => {
  const file = savedFile()
  const cyclic = JSON.stringify(file).replace('"edges":[{"from":"a","to":"b"}]', '"edges":[{"from":"a","to":"b"},{"from":"b","to":"a"}]')
  const cycle = refused(parseBoardFile(cyclic, 'sess'))
  expect(cycle.code).toBe('invalid_board_file')
  expect(cycle.message).toContain('boards[0].blocks[2].edges')
  expect(cycle.message).toContain('cycle')
  const shortLines = JSON.stringify(file).replace('"lines":["line 1","line 2"]', '"lines":["line 1"]')
  expect(refused(parseBoardFile(shortLines, 'sess')).message).toContain('boards[0].blocks[1].lines')
  const reused = JSON.stringify(file).replace('"nextId":4', '"nextId":3')
  expect(refused(parseBoardFile(reused, 'sess')).message).toContain('nextId')
})

const SNIPPET = 'const a = 1\n  indented()\n'

// A board of one code block and one trace, as the engine saves them.
function richFile(): BoardFile {
  const edits = [insert({ type: 'code', language: 'ts', code: SNIPPET }), insert(traceOf('dag_1', 'build', 'output'))]
  const board = accepted(apply(boardOf(), edits, NO_PEEKS, runText('dag_1', 'build', 'output', ['ok 1', 'ok 2']))).board
  return { schemaVersion: 1, sessionId: 'sess', boards: [board] }
}

// The rich file as JSON text with one stored block's fields overridden; an undefined value drops the field.
function richFileText(index: number, patch: Record<string, unknown>): string {
  const file = richFile()
  const board = file.boards[0]!
  return JSON.stringify({ ...file, boards: [{ ...board, blocks: board.blocks.map((block, at) => (at === index ? { ...block, ...patch } : block)) }] })
}

test('parseBoardFile reads back a code block and a trace with its lines', () => {
  const file = richFile()
  expect(file.boards[0]?.blocks).toEqual([
    { id: 'b1', type: 'code', language: 'ts', code: SNIPPET },
    { id: 'b2', type: 'trace', run: 'dag_1', node: 'build', part: 'output', lines: ['ok 1', 'ok 2'] },
  ])
  expect(accepted(parseBoardFile(JSON.stringify(file), 'sess'))).toEqual(file)
})

test('parseBoardFile refuses stored trace lines that are missing, empty, not text, over 40 or over 240 characters', () => {
  const tooMany = Array.from({ length: 41 }, () => 'x')
  for (const lines of [undefined, [], 'ok', [1], tooMany, ['x'.repeat(241)]]) {
    const error = refused(parseBoardFile(richFileText(1, { lines }), 'sess'))
    expect(error.code).toBe('invalid_board_file')
    expect(error.message).toContain('boards[0].blocks[1].lines')
  }
  expect(accepted(parseBoardFile(richFileText(1, { lines: Array.from({ length: 40 }, () => 'x'.repeat(240)) }), 'sess')).boards).toHaveLength(1)
})

test('parseBoardFile checks a stored code block and trace again: size, unknown part, stray lines', () => {
  const tooLong = refused(parseBoardFile(richFileText(0, { code: textLines(41, 5) }), 'sess'))
  expect(tooLong.code).toBe('invalid_board_file')
  expect(tooLong.message).toContain('boards[0].blocks[0].code: at most 40 lines')
  expect(refused(parseBoardFile(richFileText(0, { lines: ['x'] }), 'sess')).message).toContain('boards[0].blocks[0].lines: unknown field')
  expect(refused(parseBoardFile(richFileText(1, { part: 'log' }), 'sess')).message).toContain('boards[0].blocks[1].part')
  expect(refused(parseBoardFile(richFileText(1, { run: '' }), 'sess')).message).toContain('boards[0].blocks[1].run')
})

// A board of one code_peek at a ref and one diff of a path, as the engine saves them.
function pinnedFile(): BoardFile {
  const edits = [insert(peekAt('v1')), insert(diffOf('main..feature', 'src/a.ts'))]
  const board = accepted(apply(boardOf(), edits, fileText('src/a.ts', 3, 5, 'v1'), NO_TRACES, gitText('main..feature', 'src/a.ts', ['@@ -1 +1 @@', '-old', '+new']))).board
  return { schemaVersion: 1, sessionId: 'sess', boards: [board] }
}

function pinnedFileText(index: number, patch: Record<string, unknown>): string {
  const file = pinnedFile()
  const board = file.boards[0]!
  return JSON.stringify({ ...file, boards: [{ ...board, blocks: board.blocks.map((block, at) => (at === index ? { ...block, ...patch } : block)) }] })
}

test('parseBoardFile reads back a diff and a code_peek at a ref with their lines', () => {
  const file = pinnedFile()
  expect(file.boards[0]?.blocks).toEqual([
    { id: 'b1', type: 'code_peek', path: 'src/a.ts', ref: 'v1', start: 3, end: 5, lines: ['line 3', 'line 4', 'line 5'] },
    { id: 'b2', type: 'diff', ref: 'main..feature', path: 'src/a.ts', lines: ['@@ -1 +1 @@', '-old', '+new'] },
  ])
  expect(accepted(parseBoardFile(JSON.stringify(file), 'sess'))).toEqual(file)
})

test('parseBoardFile refuses stored diff lines that are missing, empty, not text, over 40 or over 240 characters', () => {
  const tooMany = Array.from({ length: 41 }, () => 'x')
  for (const lines of [undefined, [], '+x', [1], tooMany, ['x'.repeat(241)]]) {
    const error = refused(parseBoardFile(pinnedFileText(1, { lines }), 'sess'))
    expect(error.code).toBe('invalid_board_file')
    expect(error.message).toContain('boards[0].blocks[1].lines')
  }
  expect(accepted(parseBoardFile(pinnedFileText(1, { lines: Array.from({ length: 40 }, () => 'x'.repeat(240)) }), 'sess')).boards).toHaveLength(1)
})

test('parseBoardFile checks a stored diff and a stored ref again: option-like or missing ref, escaping path, stray range', () => {
  expect(refused(parseBoardFile(pinnedFileText(1, { ref: '--stat' }), 'sess')).message).toContain('boards[0].blocks[1].ref')
  expect(refused(parseBoardFile(pinnedFileText(1, { ref: undefined }), 'sess')).message).toContain('boards[0].blocks[1].ref')
  expect(refused(parseBoardFile(pinnedFileText(1, { path: '../x' }), 'sess')).message).toContain('boards[0].blocks[1].path')
  expect(refused(parseBoardFile(pinnedFileText(1, { start: 1 }), 'sess')).message).toContain('boards[0].blocks[1].start: unknown field')
  expect(refused(parseBoardFile(pinnedFileText(0, { ref: 'a b' }), 'sess')).message).toContain('boards[0].blocks[0].ref')
  expect(refused(parseBoardFile(pinnedFileText(0, { lines: ['only one'] }), 'sess')).message).toContain('boards[0].blocks[0].lines')
})

const RUN_LINK = { runId: 'dag_mv6bifi0_ggt9of', facts: { summary: 'b1', nodes: 'b2', graph: 'b3', writes: 'b9' } }

// The saved file with the first board linked to a run, as JSON text so a test can break one field of it.
function linkedFileText(run: unknown): string {
  const file = savedFile()
  return JSON.stringify({ ...file, boards: [{ ...file.boards[0], run }, file.boards[1]] })
}

test('result board link: a stored board with a run link reads back, whether or not the fact blocks still exist', () => {
  // b9 is not on the board: the model may have removed the block, and the next settle then draws it again.
  const file = savedFile()
  const linked: BoardFile = { ...file, boards: [{ ...file.boards[0]!, run: RUN_LINK }, file.boards[1]!] }
  const read = accepted(parseBoardFile(JSON.stringify(linked), 'sess'))
  expect(read).toEqual(linked)
  expect(read.boards[0]?.run).toEqual(RUN_LINK)
})

test('result board link: a board without the link reads back without a run field', () => {
  const read = accepted(parseBoardFile(JSON.stringify(savedFile()), 'sess'))
  expect('run' in read.boards[0]!).toBe(false)
})

test('result board link: a run id of 64 characters and 8 fact slots are accepted', () => {
  const facts = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((key, index) => [key, `b${index + 1}`]))
  const run = { runId: 'r'.repeat(64), facts }
  expect(accepted(parseBoardFile(linkedFileText(run), 'sess')).boards[0]?.run).toEqual(run)
  expect(accepted(parseBoardFile(linkedFileText({ runId: 'r', facts: {} }), 'sess')).boards[0]?.run).toEqual({ runId: 'r', facts: {} })
})

test('result board link: a bad run id is refused as invalid_board_file naming runId', () => {
  for (const runId of ['', 'r'.repeat(65), 7, null]) {
    const error = refused(parseBoardFile(linkedFileText({ ...RUN_LINK, runId }), 'sess'))
    expect(error.code).toBe('invalid_board_file')
    expect(error.message).toContain('boards[0].run.runId')
  }
  expect(refused(parseBoardFile(linkedFileText({ facts: RUN_LINK.facts }), 'sess')).message).toContain('boards[0].run.runId')
})

test('result board link: a bad fact key is refused as invalid_board_file naming facts', () => {
  for (const key of ['', 'Summary', 'node1', 'with space', 'k'.repeat(17)]) {
    const error = refused(parseBoardFile(linkedFileText({ ...RUN_LINK, facts: { [key]: 'b1' } }), 'sess'))
    expect(error.code).toBe('invalid_board_file')
    expect(error.message).toContain('boards[0].run.facts')
  }
})

test('result board link: a fact value that is not a block id is refused, naming the slot', () => {
  for (const value of ['summary', 'b0', 'b01', 'B1', 'b1 ', 4, null]) {
    const error = refused(parseBoardFile(linkedFileText({ ...RUN_LINK, facts: { summary: value } }), 'sess'))
    expect(error.code).toBe('invalid_board_file')
    expect(error.message).toContain('boards[0].run.facts.summary')
  }
})

test('result board link: more than 8 fact slots, a non-object facts, a missing facts and an unknown run field are refused', () => {
  const nine = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map((key, index) => [key, `b${index + 1}`]))
  expect(refused(parseBoardFile(linkedFileText({ ...RUN_LINK, facts: nine }), 'sess')).message).toContain('boards[0].run.facts')
  expect(refused(parseBoardFile(linkedFileText({ ...RUN_LINK, facts: ['b1'] }), 'sess')).message).toContain('boards[0].run.facts')
  expect(refused(parseBoardFile(linkedFileText({ runId: RUN_LINK.runId }), 'sess')).message).toContain('boards[0].run.facts')
  expect(refused(parseBoardFile(linkedFileText({ ...RUN_LINK, status: 'done' }), 'sess')).message).toContain('boards[0].run.status')
  expect(refused(parseBoardFile(linkedFileText('dag_1'), 'sess')).message).toContain('boards[0].run')
  expect(refused(parseBoardFile(linkedFileText(null), 'sess')).message).toContain('boards[0].run')
})

test('result board link: applyEdits and boardForModel keep the link as it is', () => {
  const linked: Board = { ...boardOf(), run: RUN_LINK }
  const { board } = accepted(apply(linked, [insert(section)]))
  expect(board.run).toEqual(RUN_LINK)
  expect(boardForModel(board).run).toEqual(RUN_LINK)
})

test('result board link: an edit cannot set it, on the edit or on a block', () => {
  const run = { runId: 'dag_1', facts: { summary: 'b1' } }
  expect(refused(parseEdits([{ op: 'insert', block: section, run }])).code).toBe('invalid_board_edit')
  const drawn = accepted(apply(boardOf(), [insert(section)])).board
  const update = refused(apply(drawn, [{ op: 'update', id: 'b1', changes: { run } }]))
  expect(update.code).toBe('invalid_board_edit')
  expect(update.message).toContain('run')
})

test('the board tool description fits within what Claude Code passes to the model', () => {
  expect(BOARD_TOOL_DESCRIPTION.length).toBeLessThanOrEqual(TOOL_DESCRIPTION_LIMIT)
})

test('the board tool description names every action and the drawing rules', () => {
  for (const action of BOARD_INPUT_SCHEMA.properties.action.enum) expect(BOARD_TOOL_DESCRIPTION).toContain(action)
  expect(BOARD_TOOL_DESCRIPTION).toContain('Board section (key b)')
  expect(BOARD_TOOL_DESCRIPTION).toContain('call open once after the first edit')
  expect(BOARD_TOOL_DESCRIPTION).toContain('Read the board back with get before you finish')
  expect(BOARD_TOOL_DESCRIPTION).toContain('may not form a cycle')
  expect(BOARD_TOOL_DESCRIPTION).toContain('at most 40 lines')
})

test('the board tool description names the code and trace blocks and the export action', () => {
  expect(BOARD_TOOL_DESCRIPTION).toContain('export {board_id} returns markdown')
  expect(BOARD_TOOL_DESCRIPTION).toContain('code {code 1-4000')
  expect(BOARD_TOOL_DESCRIPTION).toContain('trace {run, node, part output|answer|error|verification')
})

test('the block schema and the description name exactly the block types and trace parts the engine accepts', () => {
  const { type, part } = BOARD_INPUT_SCHEMA.properties.edits.items.properties.block.properties
  const unknownType = refused(parseEdits([{ op: 'insert', block: { type: 'chart' } }]))
  expect(unknownType.message).toBe(`edits[0]: type: must be one of ${type.enum.join(', ')}`)
  for (const name of type.enum) expect(BOARD_TOOL_DESCRIPTION).toContain(`${name} {`)
  for (const name of part.enum) expect(BOARD_TOOL_DESCRIPTION).toContain(name)
})

test('the board input schema declares the six actions, and only action is required', () => {
  expect(BOARD_INPUT_SCHEMA.properties.action.enum).toEqual(['create', 'edit', 'get', 'list', 'open', 'export'])
  expect(BOARD_INPUT_SCHEMA.required).toEqual(['action'])
  expect(BOARD_INPUT_SCHEMA.properties.edits.maxItems).toBe(20)
})

test('the markdown export names the ref of a code_peek and fences a diff as diff, naming its ref and path', () => {
  const board: Board = boardOf([
    { id: 'b1', type: 'code_peek', path: 'src/a.ts', ref: 'main~2', start: 8, end: 9, lines: ['const a = 1', 'const b = 2'] },
    { id: 'b2', type: 'diff', title: 'Routing', ref: 'main..feature', path: 'src/a.ts', lines: ['@@ -1 +1 @@', '-old', '+new'], note: 'why' },
    { id: 'b3', type: 'diff', ref: 'v1', lines: ['+only'] },
  ])
  expect(boardToMarkdown(board)).toBe([
    '# Plan',
    '',
    '<!-- b1 -->',
    '`src/a.ts` (L8–L9 at main~2)',
    '```',
    'const a = 1',
    'const b = 2',
    '```',
    '',
    '<!-- b2 -->',
    '**Routing**',
    '`main..feature · src/a.ts`',
    '```diff',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    '```',
    '*why*',
    '',
    '<!-- b3 -->',
    '`v1`',
    '```diff',
    '+only',
    '```',
    '',
  ].join('\n'))
})

test('the board tool description and schema name the diff block and the ref field', () => {
  const { type, ref, path } = BOARD_INPUT_SCHEMA.properties.edits.items.properties.block.properties
  expect(type.enum).toContain('diff')
  expect(ref.description).toContain('diff (required)')
  expect(path.description).toContain('diff (optional)')
  expect(BOARD_TOOL_DESCRIPTION).toContain('code_peek {path, ref?')
  expect(BOARD_TOOL_DESCRIPTION).toContain('diff {ref, path?')
  expect(BOARD_TOOL_DESCRIPTION).toContain('quotes a git diff the host runs')
})

// A board_id looks like board_<time>_<random>; the session holds these three, and the board being edited is the first.
const OWN_BOARD = 'board_m0_ownown'
const OTHER_BOARD = 'board_m1_aaaaaa'
const THIRD_BOARD = 'board_m2_bbbbbb'
const MISSING_BOARD = 'board_zz_missing'
const SESSION_BOARDS: ReadonlySet<string> = new Set([OWN_BOARD, OTHER_BOARD, THIRD_BOARD])
const NO_BOARDS: ReadonlySet<string> = new Set()
const ownBoard = (blocks: Block[] = []): Board => ({ ...boardOf(blocks), boardId: OWN_BOARD })
const linkTo = (board: string, title?: string): BlockInput => ({ type: 'board_ref', board, ...(title ? { title } : {}) })
const divider: BlockInput = { type: 'divider' }
// Applies edits as a host that knows the three boards of the session would.
const applyInSession = (board: Board, edits: BoardEdit[], boardIds: ReadonlySet<string> = SESSION_BOARDS) =>
  apply(board, edits, NO_PEEKS, NO_TRACES, NO_DIFFS, boardIds)

test('insert adds a board_ref to another board of the session, trimming its title', () => {
  const { board } = accepted(applyInSession(ownBoard(), [insert(linkTo(OTHER_BOARD, '  Result  '))]))
  expect(board.blocks).toEqual([{ id: 'b1', type: 'board_ref', board: OTHER_BOARD, title: 'Result' }])
})

test('a board_ref without a title keeps only its board', () => {
  const { board } = accepted(applyInSession(ownBoard(), [insert(linkTo(OTHER_BOARD)), insert({ type: 'board_ref', board: THIRD_BOARD, title: '   ' })]))
  expect(board.blocks).toEqual([{ id: 'b1', type: 'board_ref', board: OTHER_BOARD }, { id: 'b2', type: 'board_ref', board: THIRD_BOARD }])
})

test('a board_ref to a board the session does not hold is refused, naming the board and the list action', () => {
  const error = refused(applyInSession(ownBoard(), [insert(linkTo(MISSING_BOARD))]))
  expect(error.code).toBe('invalid_board_edit')
  expect(error.message).toContain('edits[0]: board:')
  expect(error.message).toContain(MISSING_BOARD)
  expect(error.message).toContain('list')
})

test('a board_ref is refused when the caller knows of no boards, whether it passes none or an empty set', () => {
  const missing = refused(apply(ownBoard(), [insert(linkTo(OTHER_BOARD))]))
  expect(missing.code).toBe('invalid_board_edit')
  expect(missing.message).toContain(OTHER_BOARD)
  expect(refused(applyInSession(ownBoard(), [insert(linkTo(OTHER_BOARD))], NO_BOARDS)).code).toBe('invalid_board_edit')
})

test('a board_ref cannot point at the board it is drawn on, even when the session lists that board', () => {
  const error = refused(applyInSession(ownBoard(), [insert(linkTo(OWN_BOARD))]))
  expect(error.code).toBe('invalid_board_edit')
  expect(error.message).toContain('edits[0]: board:')
  expect(error.message).toContain('own board')
})

test('a board_ref refused later in the edits changes nothing, and the error names that edit', () => {
  const start = ownBoard()
  const error = refused(applyInSession(start, [insert(linkTo(OTHER_BOARD)), insert(linkTo(MISSING_BOARD))]))
  expect(error.message.startsWith('edits[1]: board:')).toBe(true)
  expect(start.blocks).toEqual([])
})

test('a board_ref board must look like a board_id, and only board and title are fields', () => {
  for (const board of ['board_1', 'main', '', 'Board_a_b', 'board_a_', 'board__b', '../board_a_b', 'board_a_b_c', `board_a_${'b'.repeat(60)}`, 7, null]) {
    const error = refused(parseEdits([{ op: 'insert', block: { type: 'board_ref', board } }]))
    expect(error.code).toBe('invalid_board_edit')
    expect(error.message).toContain('edits[0]: board:')
  }
  expect(refused(parseEdits([{ op: 'insert', block: { type: 'board_ref' } }])).message).toContain('edits[0]: board:')
  expect(refused(parseEdits([{ op: 'insert', block: { type: 'board_ref', board: OTHER_BOARD, text: 'x' } }])).message).toContain('edits[0]: text: unknown field')
  expect(refused(parseEdits([{ op: 'insert', block: { type: 'board_ref', board: OTHER_BOARD, title: 't'.repeat(81) } }])).message).toContain('edits[0]: title')
  expect(accepted(parseEdits([{ op: 'insert', block: { type: 'board_ref', board: OTHER_BOARD } }]))).toHaveLength(1)
})

test('update of a board_ref board checks the target again, and of its title does not', () => {
  const start = ownBoard([{ id: 'b1', type: 'board_ref', board: OTHER_BOARD }])
  const titled = accepted(applyInSession(start, [{ op: 'update', id: 'b1', changes: { title: 'Result' } }], NO_BOARDS)).board
  expect(titled.blocks).toEqual([{ id: 'b1', type: 'board_ref', board: OTHER_BOARD, title: 'Result' }])
  const moved = accepted(applyInSession(start, [{ op: 'update', id: 'b1', changes: { board: THIRD_BOARD } }])).board
  expect(moved.blocks).toEqual([{ id: 'b1', type: 'board_ref', board: THIRD_BOARD }])
  const missing = refused(applyInSession(start, [{ op: 'update', id: 'b1', changes: { board: MISSING_BOARD } }]))
  expect(missing.message).toContain('edits[0]: board:')
  expect(missing.message).toContain(MISSING_BOARD)
  expect(refused(applyInSession(start, [{ op: 'update', id: 'b1', changes: { board: OWN_BOARD } }])).message).toContain('own board')
  expect(refused(applyInSession(start, [{ op: 'update', id: 'b1', changes: { board: 'main' } }])).message).toContain('edits[0]: board:')
})

test('replace turns a section into a board_ref and checks its target', () => {
  const start = ownBoard([{ id: 'b1', ...section }])
  const replaced = accepted(applyInSession(start, [{ op: 'replace', id: 'b1', block: linkTo(OTHER_BOARD, 'Result') }])).board
  expect(replaced.blocks).toEqual([{ id: 'b1', type: 'board_ref', board: OTHER_BOARD, title: 'Result' }])
  expect(refused(applyInSession(start, [{ op: 'replace', id: 'b1', block: linkTo(MISSING_BOARD) }])).message).toContain('edits[0]: board:')
  expect(refused(applyInSession(start, [{ op: 'replace', id: 'b1', block: linkTo(OWN_BOARD) }])).message).toContain('own board')
})

test('insert adds a divider that holds no field', () => {
  const { board } = accepted(apply(boardOf(), [insert(section), insert(divider), insert(callout)]))
  expect(board.blocks).toEqual([{ id: 'b1', ...section }, { id: 'b2', type: 'divider' }, { id: 'b3', ...callout }])
})

test('a divider refuses every field on insert, and an update to it has nothing to change', () => {
  const field = refused(parseEdits([{ op: 'insert', block: { type: 'divider', title: 'x' } }]))
  expect(field.message).toContain('edits[0]: title: unknown field')
  const start = boardOf([{ id: 'b1', type: 'divider' }])
  for (const changes of [{ title: 'x' }, { text: '' }, { board: OTHER_BOARD }]) {
    const error = refused(apply(start, [{ op: 'update', id: 'b1', changes }]))
    expect(error.code).toBe('invalid_board_edit')
    expect(error.message).toContain('unknown field')
  }
  expect(refused(apply(start, [{ op: 'update', id: 'b1', changes: { type: 'divider' } }])).message).toContain('type: cannot be changed')
  expect(refused(parseEdits([{ op: 'update', id: 'b1', changes: {} }])).message).toContain('edits[0]: changes')
})

test('parseBoardFile reads back a board_ref and a divider, and keeps a ref whose board is gone', () => {
  const drawn = accepted(applyInSession(ownBoard(), [insert(section), insert(linkTo(OTHER_BOARD, 'Result')), insert(divider)])).board
  const file: BoardFile = { schemaVersion: 1, sessionId: 'sess', boards: [drawn] }
  expect(accepted(parseBoardFile(JSON.stringify(file), 'sess'))).toEqual(file)
})

test('parseBoardFile checks a stored board_ref and a stored divider again', () => {
  const drawn = accepted(applyInSession(ownBoard(), [insert(linkTo(OTHER_BOARD)), insert(divider)])).board
  const text = JSON.stringify({ schemaVersion: 1, sessionId: 'sess', boards: [drawn] })
  const notAnId = refused(parseBoardFile(text.replace(`"board":"${OTHER_BOARD}"`, '"board":"main"'), 'sess'))
  expect(notAnId.code).toBe('invalid_board_file')
  expect(notAnId.message).toContain('boards[0].blocks[0].board')
  const withField = refused(parseBoardFile(text.replace('{"id":"b2","type":"divider"}', '{"id":"b2","type":"divider","title":"x"}'), 'sess'))
  expect(withField.message).toContain('boards[0].blocks[1].title')
})

test('a flow edge may be dashed, and a solid edge stays bare', () => {
  const flow: BlockInput = {
    type: 'flow',
    nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }],
    edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'c', label: 'maybe', style: 'dashed' }],
  }
  const { board } = accepted(apply(boardOf(), [insert(flow)]))
  expect(board.blocks).toEqual([{ id: 'b1', ...flow }])
  const edges = board.blocks[0]?.type === 'flow' ? board.blocks[0].edges : []
  expect(edges.map(edge => Object.keys(edge))).toEqual([['from', 'to'], ['from', 'to', 'label', 'style']])
})

test('a flow edge style is dashed or absent, and anything else is refused naming the field', () => {
  const nodes = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]
  for (const style of ['solid', 'dotted', 'DASHED', '', 1, null]) {
    const error = refused(parseEdits([{ op: 'insert', block: { type: 'flow', nodes, edges: [{ from: 'a', to: 'b', style }] } }]))
    expect(error.code).toBe('invalid_board_edit')
    expect(error.message).toBe('edits[0]: edges[0].style: must be one of dashed')
  }
})

test('a dashed edge still joins nodes without repeating or looping', () => {
  const twice = refused(apply(boardOf(), [insert(flowOf([{ from: 'a', to: 'b' }, { from: 'a', to: 'b', style: 'dashed' }]))]))
  expect(twice.message).toContain('a -> b is drawn twice')
  const loop = refused(apply(boardOf(), [insert(flowOf([{ from: 'a', to: 'b' }, { from: 'b', to: 'a', style: 'dashed' }]))]))
  expect(loop.message).toContain('cycle')
})

const calls = [{ id: 'user', label: 'User' }, { id: 'hook', label: 'Hook' }]
const sequenceWith = (step: Record<string, unknown>) => parseEdits([{ op: 'insert', block: { type: 'sequence', participants: calls, steps: [{ from: 'user', to: 'hook', label: 'prompt', ...step }] } }])

test('a sequence step may carry a note of at most 80 characters, trimmed, and an empty one is dropped', () => {
  const noted: BlockInput = { type: 'sequence', participants: calls, steps: [{ from: 'user', to: 'hook', label: 'prompt', kind: 'call', note: 'sent before the gate' }] }
  expect(accepted(apply(boardOf(), [insert(noted)])).board.blocks).toEqual([{ id: 'b1', ...noted }])
  const trimmed = accepted(sequenceWith({ note: '  short  ' }))[0]
  expect(trimmed?.op === 'insert' && trimmed.block.type === 'sequence' ? trimmed.block.steps : []).toEqual([{ from: 'user', to: 'hook', label: 'prompt', note: 'short' }])
  const blank = accepted(sequenceWith({ note: '   ' }))[0]
  expect(blank?.op === 'insert' && blank.block.type === 'sequence' ? Object.keys(blank.block.steps[0] ?? {}) : []).toEqual(['from', 'to', 'label'])
  expect(accepted(sequenceWith({ note: 'n'.repeat(80) }))).toHaveLength(1)
})

test('a sequence step note over 80 characters or not text is refused naming the step', () => {
  const long = refused(sequenceWith({ note: 'n'.repeat(81) }))
  expect(long.code).toBe('invalid_board_edit')
  expect(long.message).toBe('edits[0]: steps[0].note: must be at most 80 characters, got 81')
  for (const note of [5, ['x']]) expect(refused(sequenceWith({ note })).message).toBe('edits[0]: steps[0].note: must be a string')
})

const threeSections = () => boardOf([{ id: 'b1', type: 'section', title: 'One' }, { id: 'b2', type: 'section', title: 'Two' }, { id: 'b3', type: 'section', title: 'Three' }])
const orderOf = (board: Board) => board.blocks.map(block => block.id)
const move = (id: string, afterId?: string): BoardEdit => (afterId === undefined ? { op: 'move', id } : { op: 'move', id, afterId })

test('move places a block directly after the given block, whether that block comes before or after it', () => {
  expect(orderOf(accepted(apply(threeSections(), [move('b1', 'b3')])).board)).toEqual(['b2', 'b3', 'b1'])
  expect(orderOf(accepted(apply(threeSections(), [move('b3', 'b1')])).board)).toEqual(['b1', 'b3', 'b2'])
  expect(orderOf(accepted(apply(threeSections(), [move('b1', 'b2')])).board)).toEqual(['b2', 'b1', 'b3'])
})

test('move without afterId puts the block at the end', () => {
  expect(orderOf(accepted(apply(threeSections(), [move('b1')])).board)).toEqual(['b2', 'b3', 'b1'])
  expect(orderOf(accepted(apply(threeSections(), [move('b2')])).board)).toEqual(['b1', 'b3', 'b2'])
})

test('move changes only the order: the block, its id, nextId and the inserted list stay as they were', () => {
  const start = threeSections()
  const { board, inserted } = accepted(apply(start, [move('b2', 'b3')]))
  expect(board.blocks).toEqual([start.blocks[0], start.blocks[2], start.blocks[1]])
  expect(board.nextId).toBe(start.nextId)
  expect(board.updatedAt).toBe(NOW)
  expect(inserted).toEqual([])
})

test('a move that changes nothing is still a valid edit', () => {
  const start = threeSections()
  expect(orderOf(accepted(apply(start, [move('b2', 'b1')])).board)).toEqual(['b1', 'b2', 'b3'])
  expect(orderOf(accepted(apply(start, [move('b3')])).board)).toEqual(['b1', 'b2', 'b3'])
  expect(orderOf(accepted(apply(boardOf([{ id: 'b1', ...section }]), [move('b1')])).board)).toEqual(['b1'])
})

test('move refuses an unknown id, an unknown afterId and a block placed after itself, naming the edit', () => {
  const unknownId = refused(apply(threeSections(), [move('b9', 'b1')]))
  expect(unknownId.code).toBe('unknown_block')
  expect(unknownId.message).toContain('edits[0]')
  expect(unknownId.message).toContain('b9')
  const unknownAfter = refused(apply(threeSections(), [move('b1', 'b9')]))
  expect(unknownAfter.code).toBe('unknown_block')
  expect(unknownAfter.message).toContain('b9')
  const itself = refused(apply(threeSections(), [move('b2', 'b2')]))
  expect(itself.code).toBe('invalid_board_edit')
  expect(itself.message).toContain('edits[0]: afterId')
})

test('moves run in order inside one atomic apply, and a bad one changes nothing', () => {
  const start = threeSections()
  const drawn = accepted(apply(start, [insert(callout), move('b4', 'b1'), move('b1')])).board
  expect(orderOf(drawn)).toEqual(['b4', 'b2', 'b3', 'b1'])
  const error = refused(apply(start, [move('b1'), move('b1', 'b9')]))
  expect(error.message.startsWith('edits[1]: ')).toBe(true)
  expect(orderOf(start)).toEqual(['b1', 'b2', 'b3'])
})

test('parseEdits reads a move with its id and an optional afterId, and refuses a missing id or a stray field', () => {
  expect(accepted(parseEdits([{ op: 'move', id: ' b1 ', afterId: 'b2' }, { op: 'move', id: 'b3' }]))).toEqual([{ op: 'move', id: 'b1', afterId: 'b2' }, { op: 'move', id: 'b3' }])
  expect(refused(parseEdits([{ op: 'move' }])).message).toContain('edits[0]: id')
  expect(refused(parseEdits([{ op: 'move', id: 'b1', after_id: 'b2' }])).message).toContain('edits[0]: after_id: unknown field')
  expect(refused(parseEdits([{ op: 'move', id: 'b1', block: section }])).message).toContain('edits[0]: block: unknown field')
  expect(refused(parseEdits([{ op: 'move', id: 'b1', afterId: '' }])).message).toContain('edits[0]: afterId')
})

test('a move asks the host to read nothing', () => {
  const board = threeSections()
  expect(peeksNeeded(board, [move('b1', 'b2')])).toEqual([])
  expect(tracesNeeded(board, [move('b1')])).toEqual([])
  expect(diffsNeeded(board, [move('b1')])).toEqual([])
})

test('the markdown export draws a divider as a rule and a board_ref as a quote naming the board', () => {
  const board: Board = boardOf([
    { id: 'b1', ...section },
    { id: 'b2', type: 'divider' },
    { id: 'b3', type: 'board_ref', board: OTHER_BOARD, title: 'Result\nof run' },
    { id: 'b4', type: 'board_ref', board: THIRD_BOARD },
  ])
  expect(boardToMarkdown(board)).toBe([
    '# Plan',
    '',
    '<!-- b1 -->',
    '## Why',
    'Because',
    '',
    '<!-- b2 -->',
    '---',
    '',
    '<!-- b3 -->',
    '> Board: [Result of run]',
    '',
    '<!-- b4 -->',
    `> Board: [${THIRD_BOARD}]`,
    '',
  ].join('\n'))
})

test('the markdown export draws a dashed flow edge as a dotted mermaid arrow, labelled or not, and a solid edge as before', () => {
  const board: Board = boardOf([{
    id: 'b1',
    type: 'flow',
    nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }],
    edges: [{ from: 'a', to: 'b', label: 'ok' }, { from: 'a', to: 'c', style: 'dashed' }, { from: 'b', to: 'c', label: 'maybe', style: 'dashed' }],
  }])
  expect(boardToMarkdown(board)).toBe([
    '# Plan',
    '',
    '<!-- b1 -->',
    '```mermaid',
    'flowchart LR',
    'a["A"]',
    'b["B"]',
    'c["C"]',
    'a -->|ok| b',
    'a -.-> c',
    'b -.->|maybe| c',
    '```',
    '',
  ].join('\n'))
})

test('the markdown export puts a step note on a Note over line after its step, and leaves a step without one alone', () => {
  const board: Board = boardOf([{
    id: 'b1',
    type: 'sequence',
    participants: [{ id: 'user', label: 'User' }, { id: 'hook', label: 'Hook' }],
    steps: [
      { from: 'user', to: 'hook', label: 'prompt', note: 'before the gate\nruns' },
      { from: 'hook', to: 'user', label: 'verdict', kind: 'return' },
      { from: 'hook', to: 'hook', label: 'route', kind: 'note', note: 'cached' },
    ],
  }])
  expect(boardToMarkdown(board)).toBe([
    '# Plan',
    '',
    '<!-- b1 -->',
    '```mermaid',
    'sequenceDiagram',
    'participant user as "User"',
    'participant hook as "Hook"',
    'user->>hook: prompt',
    'Note over user,hook: before the gate runs',
    'hook-->>user: verdict',
    'Note over hook,hook: route',
    'Note over hook,hook: cached',
    '```',
    '',
  ].join('\n'))
})

test('the schema and the description name board_ref, divider, move, dashed edges and step notes, and the schema lists what the engine accepts', () => {
  const { op, block } = BOARD_INPUT_SCHEMA.properties.edits.items.properties
  expect(refused(parseEdits([{ op: 'delete', id: 'b1' }])).message).toBe(`edits[0]: op: must be one of ${op.enum.join(', ')}`)
  expect(op.enum).toContain('move')
  expect(block.properties.type.enum).toEqual(expect.arrayContaining(['board_ref', 'divider']))
  expect(block.properties.board.description).toContain('board_ref')
  const style = block.properties.edges.items.properties.style
  const nodes = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]
  for (const value of style.enum) expect(accepted(parseEdits([{ op: 'insert', block: { type: 'flow', nodes, edges: [{ from: 'a', to: 'b', style: value }] } }]))).toHaveLength(1)
  expect(block.properties.steps.items.properties.note.description).toContain('80')
  expect(BOARD_TOOL_DESCRIPTION).toContain('board_ref {board} links another board of this session')
  expect(BOARD_TOOL_DESCRIPTION).toContain('divider {}')
  expect(BOARD_TOOL_DESCRIPTION).toContain('{op:"move", id, afterId?}')
  expect(BOARD_TOOL_DESCRIPTION).toContain('style? dashed')
  expect(BOARD_TOOL_DESCRIPTION).toContain('note? 80}]}')
})
