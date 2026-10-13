import { expect, test, type Engine, type Mounted } from 'claude-code/testing'
import type { EventOf, On } from 'claude-code'
import { parseBoardFile } from '../hooks/engine/board.ts'
import { boot, command, harness, ROOT } from './control-harness.ts'

const BOARD_TOOL = 'mcp__dag-workflow__board'
// The harness session id is 'source', so this session's boards live in source.json.
const BOARD_FILE = `${ROOT}/boards/source.json`
const SUM = 'export function sum(values: number[]): number {\n  let total = 0\n  for (const value of values) total += value\n  return total\n}\n'
const DAY = 86_400_000

const PANE = {
  plugin: 'dag-workflow', component: 'Pane', requestId: 'dag', surface: 'terminal', viewport: { columns: 140, rows: 40 },
  props: { title: 'DAG', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

type Reply = { value: Record<string, unknown>; isError: boolean }

async function board($: Engine, input: Record<string, unknown>): Promise<Reply> {
  const reply = await $.tool.call({ tool: BOARD_TOOL, ...input })
  if (typeof reply.result !== 'string') throw new Error('Expected a board JSON result')
  return { value: JSON.parse(reply.result), isError: reply.isError === true }
}

async function create($: Engine, title: string): Promise<string> {
  const reply = await board($, { action: 'create', title })
  if (typeof reply.value.board_id !== 'string') throw new Error(JSON.stringify(reply.value))
  return reply.value.board_id
}

function savedBoards(h: ReturnType<typeof harness>) {
  const text = h.files.get(BOARD_FILE)
  if (text === undefined) throw new Error(`Missing ${BOARD_FILE}`)
  const parsed = parseBoardFile(text, 'source')
  if (!parsed.ok) throw new Error(parsed.error.message)
  return parsed.value.boards
}

const SECTION = { op: 'insert', block: { type: 'section', title: 'What sum does', text: 'It adds the values.' } }
const FLOW = {
  op: 'insert',
  block: { type: 'flow', nodes: [{ id: 'in', label: 'values' }, { id: 'out', label: 'total', kind: 'terminal' }], edges: [{ from: 'in', to: 'out' }] },
}
const PEEK = { op: 'insert', block: { type: 'code_peek', path: 'src/sum.ts', start: 2, end: 4 } }

test('under strict the main conversation creates a board, draws a section, a flow and a code_peek and reads it back', async ($, on) => {
  const h = harness(on)
  h.files.set('/work/src/sum.ts', SUM)
  await boot($)
  const boardId = await create($, 'How sum works')
  expect(boardId).toMatch(/^board_[0-9a-z]+_[0-9a-z]+$/)

  const edited = await board($, { action: 'edit', board_id: boardId, edits: [SECTION, FLOW, PEEK] })
  expect(edited).toEqual({
    isError: false,
    value: { board_id: boardId, blocks: [{ id: 'b1', type: 'section' }, { id: 'b2', type: 'flow' }, { id: 'b3', type: 'code_peek' }], inserted: ['b1', 'b2', 'b3'] },
  })

  const read = await board($, { action: 'get', board_id: boardId })
  expect(read.value).toMatchObject({ boardId, title: 'How sum works', nextId: 4 })
  const blocks = read.value.blocks as Record<string, unknown>[]
  expect(blocks[2]).toEqual({ id: 'b3', type: 'code_peek', path: 'src/sum.ts', start: 2, end: 4, lineCount: 3 })

  const [saved] = savedBoards(h)
  expect(saved?.boardId).toBe(boardId)
  expect(saved?.blocks.map(block => block.id)).toEqual(['b1', 'b2', 'b3'])
  expect(saved?.blocks[2]).toMatchObject({ type: 'code_peek', lines: ['  let total = 0', '  for (const value of values) total += value', '  return total'] })
})

test('an invalid edit returns invalid_board_edit and leaves the board and its file unchanged', async ($, on) => {
  const h = harness(on)
  await boot($)
  const boardId = await create($, 'Plan')
  await board($, { action: 'edit', board_id: boardId, edits: [SECTION] })
  const before = h.files.get(BOARD_FILE)

  const refused = await board($, { action: 'edit', board_id: boardId, edits: [SECTION, { op: 'insert', block: { type: 'callout', tone: 'loud', text: 'x' } }] })
  expect(refused.isError).toBe(true)
  expect(refused.value.error).toMatchObject({ code: 'invalid_board_edit', message: expect.stringContaining('edits[1]') })
  expect(h.files.get(BOARD_FILE)).toBe(before)
  const read = await board($, { action: 'get', board_id: boardId })
  expect((read.value.blocks as unknown[]).length).toBe(1)
})

test('a code_peek of a missing file names the path, and one past the end names the line count', async ($, on) => {
  const h = harness(on)
  h.files.set('/work/src/sum.ts', SUM)
  await boot($)
  const boardId = await create($, 'Peeks')

  const missing = await board($, { action: 'edit', board_id: boardId, edits: [{ op: 'insert', block: { type: 'code_peek', path: 'src/gone.ts', start: 1, end: 2 } }] })
  expect(missing.isError).toBe(true)
  expect(missing.value.error).toMatchObject({ code: 'invalid_board_edit', message: expect.stringContaining('src/gone.ts') })

  const past = await board($, { action: 'edit', board_id: boardId, edits: [{ op: 'insert', block: { type: 'code_peek', path: 'src/sum.ts', start: 4, end: 9 } }] })
  expect(past.value.error).toMatchObject({ code: 'invalid_board_edit', message: expect.stringContaining('src/sum.ts') })
  expect((past.value.error as { message: string }).message).toContain('5 lines')
  expect(savedBoards(h)[0]?.blocks).toEqual([])
})

test('list returns this session\'s boards and an unknown board_id is unknown_board', async ($, on) => {
  harness(on)
  await boot($)
  const first = await create($, 'Interview')
  const second = await create($, 'Plan')
  await board($, { action: 'edit', board_id: second, edits: [SECTION] })

  const listed = await board($, { action: 'list' })
  expect(listed.value).toEqual({
    boards: [
      { board_id: first, title: 'Interview', blocks: 0, updatedAt: 1_000 },
      { board_id: second, title: 'Plan', blocks: 1, updatedAt: 1_000 },
    ],
  })
  for (const action of ['get', 'edit', 'open']) {
    const reply = await board($, { action, board_id: 'board_missing', edits: [SECTION] })
    expect(`${action}: ${reply.isError} ${(reply.value.error as { code: string }).code}`).toBe(`${action}: true unknown_board`)
  }
})

test('a saved board file is loaded at session start', async ($, on) => {
  const h = harness(on)
  const saved = { schemaVersion: 1, sessionId: 'source', boards: [{ boardId: 'board_saved', sessionId: 'source', title: 'Saved', createdAt: 5, updatedAt: 6, nextId: 2, blocks: [{ id: 'b1', type: 'section', title: 'Kept' }] }] }
  h.files.set(BOARD_FILE, JSON.stringify(saved))
  await boot($)
  expect((await board($, { action: 'list' })).value).toEqual({ boards: [{ board_id: 'board_saved', title: 'Saved', blocks: 1, updatedAt: 6 }] })
})

test('an unparsable board file is logged and the session starts with no boards', async ($, on) => {
  const h = harness(on)
  h.files.set(BOARD_FILE, '{"schemaVersion": 1, "sessionId": "source", "boards": [{"boardId": 7}]}')
  await boot($)
  expect(h.logs.some(line => line.includes('board file'))).toBe(true)
  expect((await board($, { action: 'list' })).value).toEqual({ boards: [] })
})

test('/dag inspect board shows the selected board in the Board section, whose tab key is b', async ($, on) => {
  harness(on)
  await boot($)
  const boardId = await create($, 'How sum works')
  await board($, { action: 'edit', board_id: boardId, edits: [SECTION] })
  await command($, 'inspect board')
  const ui = (await $.ui.mount(PANE)) as Mounted<'terminal', 'Pane'>
  expect(await ui.find({ type: 'Button', key: 'section-board' })).toMatchObject({ props: { hotkey: 'b', label: '> Board' } })
  expect(await ui.find({ type: 'Text', text: /^\[b1\] section · What sum does$/, in: 'inspector' })).toBeDefined()
  await ui.unmount()
})

function opening(on: On) {
  const opened: EventOf['ui.open'][] = []
  // Registered before the shared harness so this hook, not its catch-all ui.open, records the call.
  on('ui.open', { id: 'dag' }, ($, e) => {
    opened.push(e)
    return { value: { isPlaced: true } }
  })
  return { ...harness(on), opened }
}

test('open shows the board in the Board section without taking the keyboard, and the board buttons step through boards', async ($, on) => {
  const h = opening(on)
  await boot($)
  const first = await create($, 'Interview')
  await create($, 'Plan')
  await create($, 'Result')
  const opened = await board($, { action: 'open', board_id: first })
  expect(opened.value).toEqual({ board_id: first, shown: true })
  expect(h.opened.at(-1)).toEqual({ id: 'dag', title: 'DAG' })

  const ui = (await $.ui.mount(PANE)) as Mounted<'terminal', 'Pane'>
  expect(await ui.find({ type: 'Text', text: 'Interview (1/3)', in: 'inspector' })).toBeDefined()
  await ui.press({ key: 'board:next' })
  expect(await ui.find({ type: 'Text', text: 'Plan (2/3)', in: 'inspector' })).toBeDefined()
  await ui.press({ key: 'board:prev' })
  await ui.press({ key: 'board:prev' })
  expect(await ui.find({ type: 'Text', text: 'Result (3/3)', in: 'inspector' })).toBeDefined()
  await ui.unmount()
})

test('session start prunes an expired board file of a closed session and keeps this session\'s', async ($, on) => {
  const h = harness(on)
  on('store.delete', ($, e) => { h.store.delete(e.key); return { value: undefined } })
  await h.clock.set(30 * DAY)
  h.files.set(`${ROOT}/boards/gone.json`, '{}')
  h.files.set(BOARD_FILE, JSON.stringify({ schemaVersion: 1, sessionId: 'source', boards: [] }))
  await boot($)
  const removed = h.processes.filter(e => e.argv[0] === 'rm').map(e => [...e.argv])
  expect(removed).toContainEqual(['rm', '-f', `${ROOT}/boards/gone.json`])
  expect(removed.filter(argv => argv.some(arg => arg.endsWith('/source.json')))).toEqual([])
})
