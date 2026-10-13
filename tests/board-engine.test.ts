import { expect, test } from 'claude-code/testing'
import { BOARD_INPUT_SCHEMA, BOARD_TOOL_DESCRIPTION } from '../hooks/engine/board-spec.ts'
import { applyEdits, boardForModel, newBoard, parseBoardFile, parseEdits, peekKey, peeksNeeded } from '../hooks/engine/board.ts'
import type { Block, BlockInput, Board, BoardEdit, BoardFile } from '../hooks/engine/board-types.ts'
import { TOOL_DESCRIPTION_LIMIT } from '../hooks/engine/tool-spec.ts'
import type { Result } from '../hooks/engine/types.ts'

const NOW = 1_000
const NO_PEEKS: ReadonlyMap<string, string[]> = new Map()

function boardOf(blocks: Block[] = [], nextId = blocks.length + 1): Board {
  return { boardId: 'board_1', sessionId: 'sess', title: 'Plan', createdAt: 1, updatedAt: 1, nextId, blocks }
}

function apply(board: Board, edits: BoardEdit[], peeks: ReadonlyMap<string, string[]> = NO_PEEKS) {
  return applyEdits(board, edits, { now: NOW, peeks })
}

function insert(block: BlockInput, afterId?: string): BoardEdit {
  return afterId === undefined ? { op: 'insert', block } : { op: 'insert', block, afterId }
}

// The text a host read for src/a.ts lines start..end: "line <n>" for line n.
function fileText(path: string, start: number, end: number): ReadonlyMap<string, string[]> {
  return new Map([[peekKey({ path, start, end }), Array.from({ length: end - start + 1 }, (_, i) => `line ${start + i}`)]])
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
const flowOf = (edges: { from: string; to: string }[]): BlockInput => ({
  type: 'flow',
  nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }],
  edges,
})
const peekOf = (path: string, start: number, end: number): BlockInput => ({ type: 'code_peek', path, start, end })

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
  expect(unknownOp.message).toBe('edits[1]: op: must be one of insert, update, replace, remove')
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

test('the board input schema declares the five actions, and only action is required', () => {
  expect(BOARD_INPUT_SCHEMA.properties.action.enum).toEqual(['create', 'edit', 'get', 'list', 'open'])
  expect(BOARD_INPUT_SCHEMA.required).toEqual(['action'])
  expect(BOARD_INPUT_SCHEMA.properties.edits.maxItems).toBe(20)
})
