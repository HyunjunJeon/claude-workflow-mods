import type { ClientElements, ClientSurface, JsonValue, RenderElement } from 'claude-code'
import { expect, test, type Mounted } from 'claude-code/testing'
import type { Block, Board } from '../hooks/engine/board-types.ts'
import { adjacentBoardId, buildBoardView, type BoardViewInput } from '../hooks/ui/board-model.ts'
import type { Language } from '../hooks/ui/i18n.ts'
import type { InspectorModel } from '../hooks/ui/inspector-model.ts'
import InspectorClient from '../hooks/ui/inspector-client.ts'
import { width, type Line } from '../hooks/ui/text.ts'
import { boot, command, harness, ROOT } from './control-harness.ts'

const LANGUAGES: readonly Language[] = ['en', 'ko']
const text = (line: Line) => line.map(segment => segment.text).join('')
const rows = (model: InspectorModel) => model.lines.map(text)
const ids = (model: InspectorModel) => model.actions.map(action => action.id)
// The hint is the last row of a page that shows blocks, so a page footer is the row before it.
const HINT = {
  en: 'Press a block header to cite that block in your prompt',
  ko: '블록 머리글을 누르면 프롬프트에 그 블록을 인용합니다',
}
// Each header button as [the row it sits on, the action it posts].
const headers = (model: InspectorModel) => (model.lineActions ?? []).map(({ line, action }) => [rows(model)[line], action])
const sectionHeaders = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => [`[b${from + i}] section · S${from + i}`, `chip:b${from + i}`])

function board(boardId: string, title: string, updatedAt: number, blocks: Block[] = []): Board {
  return { boardId, sessionId: 'me', title, createdAt: 1, updatedAt, nextId: blocks.length + 1, blocks }
}

function view(boards: readonly Board[], overrides: Partial<BoardViewInput> = {}): InspectorModel {
  return buildBoardView({ boards, columns: 100, language: 'en', page: 0, ...overrides })
}

const SIX: Block[] = [
  { id: 'b1', type: 'section', title: 'Plan', text: 'Ship the board tool' },
  { id: 'b2', type: 'callout', tone: 'risk', text: 'Files change under the pane' },
  { id: 'b3', type: 'table', title: 'Options', columns: ['name', 'cost'], rows: [['A', '1'], ['B', '2']] },
  { id: 'b4', type: 'code_peek', title: 'entry', path: 'src/main.ts', start: 10, end: 11, lines: ['const a = 1', 'const b = 2'] },
  {
    id: 'b5',
    type: 'flow',
    title: 'Retry',
    nodes: [{ id: 'a', label: 'Start', kind: 'terminal' }, { id: 'b', label: 'Done', kind: 'terminal' }],
    edges: [{ from: 'a', to: 'b' }],
  },
  {
    id: 'b6',
    type: 'sequence',
    participants: [{ id: 'u', label: 'User' }, { id: 's', label: 'Server' }],
    steps: [{ from: 'u', to: 's', label: 'ask' }, { from: 's', to: 'u', label: 'answer', kind: 'return' }],
  },
]

// Each section is a header line and a title line, so n of them fill a page with 2n + (n - 1) lines.
function sections(count: number): Block[] {
  return Array.from({ length: count }, (_, i): Block => ({ id: `b${i + 1}`, type: 'section', title: `S${i + 1}` }))
}

test('with no board the view says so in English and in Korean and offers no actions', async () => {
  const en = view([])
  expect(en.title).toBe('Board')
  expect(rows(en)).toEqual(['No board yet. The model draws one with the board tool.'])
  expect(en.lines[0]).toEqual([{ text: 'No board yet. The model draws one with the board tool.', dim: true }])
  expect(en.actions).toEqual([])
  const ko = view([], { language: 'ko' })
  expect(ko.title).toBe('보드')
  expect(rows(ko)).toEqual(['아직 보드가 없습니다. 모델이 board 툴로 그립니다.'])
  expect(ko.lines[0]).toEqual([{ text: '아직 보드가 없습니다. 모델이 board 툴로 그립니다.', dim: true }])
  expect(ko.actions).toEqual([])
})

test('a board with one block of each type starts every block with a dim [id] type header', async () => {
  const model = view([board('bd1', 'Release plan', 5, SIX)])
  expect(model.title).toBe('Release plan (1/1)')
  const lines = rows(model)
  expect(lines).toContain('[b1] section · Plan')
  expect(lines).toContain('[b2] callout')
  expect(lines).toContain('[b3] table · Options')
  expect(lines).toContain('[b4] code_peek · entry')
  expect(lines).toContain('[b5] flow · Retry')
  expect(lines).toContain('[b6] sequence')
  const header = model.lines[lines.indexOf('[b3] table · Options')]
  expect(header).toEqual([{ text: '[b3] table · Options', dim: true }])
  // The renderers draw below each header: the callout's bar, the table cells, the code lines, the flow glyph, the lifelines.
  const joined = lines.join('\n')
  expect(joined).toContain('Ship the board tool')
  expect(joined).toContain('▌ ')
  expect(joined).toContain('Files change under the pane')
  expect(joined).toContain('cost')
  expect(joined).toContain('const b = 2')
  expect(joined).toContain('Start')
  expect(joined).toContain('Server')
  expect(ids(model)).toEqual([])
})

test('blocks on a page are separated by one blank line and each block comes after its header', async () => {
  const lines = rows(view([board('bd1', 'T', 1, sections(2))]))
  expect(lines).toEqual(['[b1] section · S1', 'S1', '', '[b2] section · S2', 'S2', HINT.en])
})

test('a page that shows blocks ends with a dim hint to press a block header, in English and in Korean', async () => {
  for (const language of LANGUAGES) {
    const model = view([board('bd1', 'T', 1, sections(2))], { language })
    expect(rows(model).at(-1)).toBe(HINT[language])
    expect(model.lines.at(-1)).toEqual([{ text: HINT[language], dim: true }])
  }
})

test('every page of a tall board ends with the hint, after its page footer', async () => {
  const tall = [board('bd1', 'T', 1, sections(45))]
  for (const page of [0, 1, 2]) {
    const model = view(tall, { page })
    expect(rows(model).slice(-2)).toEqual([`page ${page + 1}/3`, HINT.en])
  }
})

test('a board without blocks and the no-board view have no header buttons and no hint', async () => {
  for (const language of LANGUAGES) {
    for (const model of [view([], { language }), view([board('bd1', 'Empty', 1)], { language })]) {
      expect('lineActions' in model).toBe(false)
      expect(rows(model)).not.toContain(HINT[language])
    }
  }
})

test('every block header on a page is a chip button for that block at the row that draws it', async () => {
  expect(headers(view([board('bd1', 'T', 1, SIX)]))).toEqual([
    ['[b1] section · Plan', 'chip:b1'],
    ['[b2] callout', 'chip:b2'],
    ['[b3] table · Options', 'chip:b3'],
    ['[b4] code_peek · entry', 'chip:b4'],
    ['[b5] flow · Retry', 'chip:b5'],
    ['[b6] sequence', 'chip:b6'],
  ])
})

test('header buttons follow the blocks onto page 1, page 2 and page 3 of a long board', async () => {
  const tall = [board('bd1', 'T', 1, sections(45))]
  expect(headers(view(tall))).toEqual(sectionHeaders(1, 20))
  expect(headers(view(tall, { page: 1 }))).toEqual(sectionHeaders(21, 40))
  expect(headers(view(tall, { page: 2 }))).toEqual(sectionHeaders(41, 45))
})

test('header buttons keep pointing at their header rows when a narrow pane cuts or wraps the rows', async () => {
  // Each section is a header row, a title row and a blank row, so the headers sit on rows 0, 3, 6, ...
  const headerRows = (columns: number) => view([board('bd1', 'T', 1, sections(6))], { columns })
  for (const columns of [6, 12, 24]) {
    const model = headerRows(columns)
    expect(model.lineActions).toEqual([0, 1, 2, 3, 4, 5].map(i => ({ line: i * 3, action: `chip:b${i + 1}` })))
    for (const { line } of model.lineActions ?? []) expect(rows(model)[line]?.startsWith('[b')).toBe(true)
  }
  // One column wraps the title row "S1" onto two rows, which moves every later header down by one row.
  expect(headerRows(1).lineActions).toEqual([0, 1, 2, 3, 4, 5].map(i => ({ line: i * 4, action: `chip:b${i + 1}` })))
})

test('callout tones use the localized labels', async () => {
  const blocks: Block[] = [
    { id: 'b1', type: 'callout', tone: 'info', text: 'x' },
    { id: 'b2', type: 'callout', tone: 'decision', text: 'x' },
    { id: 'b3', type: 'callout', tone: 'risk', text: 'x' },
    { id: 'b4', type: 'callout', tone: 'warning', text: 'x' },
  ]
  const en = rows(view([board('bd1', 'T', 1, blocks)])).join('\n')
  for (const label of ['info', 'decision', 'risk', 'warning']) expect(en).toContain(`▌ ${label}`)
  const ko = rows(view([board('bd1', 'T', 1, blocks)], { language: 'ko' })).join('\n')
  for (const label of ['정보', '결정', '위험', '주의']) expect(ko).toContain(`▌ ${label}`)
})

test('a board without blocks shows a dim note instead of an empty pane', async () => {
  expect(rows(view([board('bd1', 'Empty', 1)]))).toEqual(['This board has no blocks yet.'])
  expect(rows(view([board('bd1', 'Empty', 1)], { language: 'ko' }))).toEqual(['이 보드에는 아직 블록이 없습니다.'])
})

test('without a selection the view shows the board updated last, and a selection or a stale id picks as named', async () => {
  const boards = [board('old', 'Old plan', 10), board('new', 'New plan', 30), board('mid', 'Mid plan', 20)]
  expect(view(boards).title).toBe('New plan (2/3)')
  expect(view(boards, { selectedBoardId: 'old' }).title).toBe('Old plan (1/3)')
  expect(view(boards, { selectedBoardId: 'mid' }).title).toBe('Mid plan (3/3)')
  expect(view(boards, { selectedBoardId: 'gone' }).title).toBe('New plan (2/3)')
})

test('boards updated at the same time resolve to the one created last', async () => {
  const boards = [board('a', 'First', 10), board('b', 'Second', 10)]
  expect(view(boards).title).toBe('Second (2/2)')
})

test('board:prev and board:next are offered only when there is more than one board, in both languages', async () => {
  expect(ids(view([board('a', 'A', 1)]))).toEqual([])
  const two = [board('a', 'A', 1), board('b', 'B', 2)]
  const en = view(two)
  expect(en.actions).toEqual([{ id: 'board:prev', label: 'prev board' }, { id: 'board:next', label: 'next board' }])
  const ko = view(two, { language: 'ko' })
  expect(ko.actions).toEqual([{ id: 'board:prev', label: '이전 보드' }, { id: 'board:next', label: '다음 보드' }])
})

test('adjacentBoardId steps through the boards and wraps around at both ends', async () => {
  const boards = [board('a', 'A', 1), board('b', 'B', 2), board('c', 'C', 3)]
  expect(adjacentBoardId(boards, 'a', 1)).toBe('b')
  expect(adjacentBoardId(boards, 'b', 1)).toBe('c')
  expect(adjacentBoardId(boards, 'c', 1)).toBe('a')
  expect(adjacentBoardId(boards, 'c', -1)).toBe('b')
  expect(adjacentBoardId(boards, 'a', -1)).toBe('c')
})

test('adjacentBoardId starts from the board the view shows when nothing valid is selected', async () => {
  const boards = [board('a', 'A', 30), board('b', 'B', 10), board('c', 'C', 20)]
  // The view shows a (the latest), so next is b and previous is c.
  expect(adjacentBoardId(boards, undefined, 1)).toBe('b')
  expect(adjacentBoardId(boards, 'gone', -1)).toBe('c')
})

test('adjacentBoardId has nothing to offer with no boards and stays on the only board', async () => {
  expect(adjacentBoardId([], undefined, 1)).toBeUndefined()
  expect(adjacentBoardId([], 'a', -1)).toBeUndefined()
  expect(adjacentBoardId([board('a', 'A', 1)], 'a', 1)).toBe('a')
  expect(adjacentBoardId([board('a', 'A', 1)], undefined, -1)).toBe('a')
})

test('twenty small blocks fill exactly one page of 59 lines and a twenty-first starts a second page', async () => {
  const one = view([board('bd1', 'T', 1, sections(20))])
  expect(one.lines).toHaveLength(59 + 1)
  expect(ids(one)).toEqual([])
  expect(rows(one).some(line => line.startsWith('page '))).toBe(false)
  const first = view([board('bd1', 'T', 1, sections(21))])
  expect(first.lines).toHaveLength(59 + 1 + 1)
  expect(rows(first)).toContain('[b20] section · S20')
  expect(rows(first)).not.toContain('[b21] section · S21')
  expect(rows(first).at(-2)).toBe('page 1/2')
  expect(first.lines.at(-2)).toEqual([{ text: 'page 1/2', dim: true }])
  expect(ids(first)).toEqual(['page:next'])
  expect(first.actions).toEqual([{ id: 'page:next', label: 'next page' }])
})

test('a tall board splits into pages with the footer and only the page moves that are possible', async () => {
  const tall = [board('bd1', 'T', 1, sections(45))]
  const first = view(tall)
  const middle = view(tall, { page: 1 })
  const last = view(tall, { page: 2 })
  expect(rows(first).at(-2)).toBe('page 1/3')
  expect(rows(middle).at(-2)).toBe('page 2/3')
  expect(rows(last).at(-2)).toBe('page 3/3')
  expect(ids(first)).toEqual(['page:next'])
  expect(middle.actions).toEqual([{ id: 'page:prev', label: 'prev page' }, { id: 'page:next', label: 'next page' }])
  expect(ids(last)).toEqual(['page:prev'])
  expect(rows(middle)).toContain('[b21] section · S21')
  expect(rows(middle)).toContain('[b40] section · S40')
  expect(rows(middle)).not.toContain('[b41] section · S41')
  expect(rows(last)).toEqual([
    '[b41] section · S41', 'S41', '',
    '[b42] section · S42', 'S42', '',
    '[b43] section · S43', 'S43', '',
    '[b44] section · S44', 'S44', '',
    '[b45] section · S45', 'S45',
    'page 3/3',
    HINT.en,
  ])
})

test('the page number is clamped into range and a Korean pane gets the Korean footer and labels', async () => {
  const tall = [board('bd1', 'T', 1, sections(21))]
  expect(rows(view(tall, { page: 99 })).at(-2)).toBe('page 2/2')
  expect(rows(view(tall, { page: -4 })).at(-2)).toBe('page 1/2')
  expect(rows(view(tall, { page: Number.NaN })).at(-2)).toBe('page 1/2')
  const ko = view(tall, { language: 'ko', page: 1 })
  expect(rows(ko).at(-2)).toBe('페이지 2/2')
  expect(ko.actions).toEqual([{ id: 'page:prev', label: '이전 페이지' }])
})

test('page actions follow the board actions when there are several boards', async () => {
  const boards = [board('a', 'A', 1), board('b', 'B', 2, sections(21))]
  expect(ids(view(boards))).toEqual(['board:prev', 'board:next', 'page:next'])
  expect(ids(view(boards, { page: 1 }))).toEqual(['board:prev', 'board:next', 'page:prev'])
})

// A section whose text is 100 bullets draws a header, its title and 100 lines: 102 lines, 43 more than the 59 a page keeps.
const GIANT: Block = {
  id: 'b2',
  type: 'section',
  title: 'Giant',
  text: Array.from({ length: 100 }, (_, i) => `- item ${i + 1}`).join('\n'),
}

test('a block longer than a page gets a page of its own, cut with a dim more-lines line', async () => {
  const blocks: Block[] = [...sections(1), GIANT, { id: 'b3', type: 'section', title: 'After' }]
  const boards = [board('bd1', 'T', 1, blocks)]
  const before = view(boards)
  expect(rows(before)).toEqual(['[b1] section · S1', 'S1', 'page 1/3', HINT.en])
  const cut = view(boards, { page: 1 })
  expect(cut.lines).toHaveLength(60 + 1 + 1)
  expect(rows(cut)[0]).toBe('[b2] section · Giant')
  expect(rows(cut)[2]).toBe('• item 1')
  expect(rows(cut)[58]).toBe('• item 57')
  expect(rows(cut)[59]).toBe('… 43 more lines')
  expect(cut.lines[59]).toEqual([{ text: '… 43 more lines', dim: true }])
  expect(rows(cut)[60]).toBe('page 2/3')
  expect(rows(cut).join('\n')).not.toContain('item 58')
  expect(ids(cut)).toEqual(['page:prev', 'page:next'])
  expect(rows(view(boards, { page: 2 })).slice(0, 2)).toEqual(['[b3] section · After', 'After'])
})

test('a block cut short on a page of its own still has its header button', async () => {
  const boards = [board('bd1', 'T', 1, [...sections(1), GIANT, { id: 'b3', type: 'section', title: 'After' }])]
  expect(headers(view(boards))).toEqual([['[b1] section · S1', 'chip:b1']])
  expect(headers(view(boards, { page: 1 }))).toEqual([['[b2] section · Giant', 'chip:b2']])
  expect(headers(view(boards, { page: 2 }))).toEqual([['[b3] section · After', 'chip:b3']])
})

test('the cut line is Korean in a Korean pane', async () => {
  const model = view([board('bd1', 'T', 1, [GIANT])], { language: 'ko' })
  expect(rows(model)[59]).toBe('… 43줄 더')
  expect(rows(model)).toHaveLength(60 + 1)
  expect(ids(model)).toEqual([])
})

test('a block of exactly a page is not cut, and one line more is', async () => {
  const bullets = (count: number): Block => ({ ...GIANT, text: Array.from({ length: count }, (_, i) => `- item ${i + 1}`).join('\n') })
  const exact = view([board('bd1', 'T', 1, [bullets(58)])])
  expect(exact.lines).toHaveLength(60 + 1)
  expect(rows(exact).at(-2)).toBe('• item 58')
  const over = view([board('bd1', 'T', 1, [bullets(59)])])
  expect(over.lines).toHaveLength(60 + 1)
  expect(rows(over).at(-2)).toBe('… 2 more lines')
})

test('every line, title and action label stays within the columns for Korean blocks in a narrow pane', async () => {
  const korean: Block[] = [
    { id: 'b1', type: 'section', title: '배포 계획입니다', text: '- 먼저 테스트를 돌립니다\n- 그다음 배포합니다' },
    { id: 'b2', type: 'callout', tone: 'risk', title: '위험한 변경', text: '운영 데이터베이스를 건드립니다' },
    { id: 'b3', type: 'table', title: '선택지', columns: ['이름', '비용'], rows: [['첫째 방법', '낮음'], ['둘째 방법', '높음']] },
    { id: 'b4', type: 'code_peek', title: '진입점', path: 'src/아주/긴/경로/main.ts', start: 1, end: 1, lines: ['const 이름 = "값"'] },
    {
      id: 'b5',
      type: 'flow',
      title: '재시도',
      nodes: [{ id: 'a', label: '시작', kind: 'terminal' }, { id: 'b', label: '검사', kind: 'decision' }, { id: 'c', label: '끝', kind: 'terminal' }],
      edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c', label: '통과' }],
    },
    {
      id: 'b6',
      type: 'sequence',
      participants: [{ id: 'u', label: '사용자' }, { id: 's', label: '서버' }],
      steps: [{ from: 'u', to: 's', label: '요청합니다' }],
    },
  ]
  const boards = [board('bd1', '아주 긴 보드 제목이 여기에 들어갑니다', 1, korean), board('bd2', '둘째', 2)]
  for (const language of LANGUAGES) {
    for (const columns of [1, 6, 12, 24, 40]) {
      const model = view(boards, { columns, language, selectedBoardId: 'bd1' })
      expect(width(model.title)).toBeLessThanOrEqual(columns)
      for (const line of model.lines) expect(width(text(line))).toBeLessThanOrEqual(columns)
      for (const action of model.actions) expect(width(action.label)).toBeLessThanOrEqual(columns)
    }
  }
})

test('a long board title is cut but keeps its position among the boards', async () => {
  const model = view([board('a', 'A very long board title that does not fit', 1), board('b', 'B', 0)], { columns: 20 })
  expect(model.title).toBe('A very long b… (1/2)')
})

test('no columns returns an empty model like the other inspector views', async () => {
  for (const columns of [0, -3, Number.NaN]) {
    expect(view([board('a', 'A', 1, SIX)], { columns })).toEqual({ title: '', lines: [], actions: [] })
    expect(view([], { columns })).toEqual({ title: '', lines: [], actions: [] })
  }
})

test('control characters in a block id, title or board title never reach the pane', async () => {
  const hostile: Block = { id: 'b1\u001b[2J', type: 'section', title: 'Plan\u0007\nrest' }
  const model = view([board('bd1', 'Bo\u001b[31mard', 1, [hostile])])
  const everything = [model.title, ...rows(model)].join('')
  expect(everything).not.toMatch(/[\x00-\x1f\x7f-\x9f]/)
})

const PANE = {
  plugin: 'dag-workflow', component: 'Pane', requestId: 'dag', surface: 'terminal', viewport: { columns: 140, rows: 40 },
  props: { title: 'DAG', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

test('the Board pane draws each block header as one pressable button instead of a text row', async ($, on) => {
  const h = harness(on)
  const saved = [
    { id: 'b1', type: 'section', title: 'Goal', text: 'Ship it' },
    { id: 'b2', type: 'callout', tone: 'risk', text: 'Files change under the pane' },
  ]
  h.files.set(`${ROOT}/boards/source.json`, JSON.stringify({
    schemaVersion: 1,
    sessionId: 'source',
    boards: [{ boardId: 'board_a', sessionId: 'source', title: 'Plan', createdAt: 1, updatedAt: 2, nextId: 3, blocks: saved }],
  }))
  await boot($)
  await command($, 'inspect board')
  const ui = (await $.ui.mount(PANE)) as Mounted<'terminal', 'Pane'>
  const header = await ui.find({ type: 'Button', key: 'chip:b1', in: 'inspector' })
  expect(header).toMatchObject({ props: { label: '[b1] section · Goal', plain: true } })
  expect(await ui.find({ type: 'Button', key: 'chip:b2', in: 'inspector' })).toMatchObject({ props: { label: '[b2] callout' } })
  // The header is the button, not a Text row drawn as well.
  expect(await ui.find({ type: 'Text', text: '[b1] section · Goal', in: 'inspector' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Ship it', in: 'inspector' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: HINT.en, in: 'inspector' })).toBeDefined()
  await ui.unmount()
})

type ButtonCall = Parameters<ClientElements['Button']>[0]

// Runs the inspector client against a surface that records the Buttons and Texts it draws and the data it posts.
function drawInspector(model: InspectorModel) {
  const buttons: ButtonCall[] = []
  const texts: string[] = []
  const posts: JsonValue[] = []
  const blank: RenderElement = { type: 'Text', props: { children: ' ' } }
  const surface: ClientSurface<number> = {
    elements: {
      Box: () => blank,
      Text: props => { texts.push(String(props.children)); return blank },
      Button: props => { buttons.push(props); return blank },
      Input: () => blank, Select: () => blank, Link: () => blank, Code: () => blank, Markdown: () => blank,
    },
    state: 80, columns: 80, rows: 24,
    setState: () => {}, every: () => () => {}, onPointer: () => () => {}, onKey: () => () => {},
    post: data => { posts.push(data) },
  }
  InspectorClient(model, surface)
  // SAFETY: the client's onPress callbacks ignore the press they are handed.
  const press = (key: string) => buttons.find(button => button.key === key)?.onPress(undefined as never)
  return { buttons, texts, posts, press }
}

test('the inspector client draws a row named in lineActions as one plain Button that posts its action', async () => {
  const blocks: Block[] = [{ id: 'b1', type: 'section', title: 'Goal', text: 'Ship it' }, { id: 'b2', type: 'section', title: 'Next' }]
  const drawn = drawInspector(view([board('bd1', 'Plan', 1, blocks), board('bd2', 'Other', 0)]))
  expect(drawn.buttons.map(({ key, label, plain }) => [key, label, plain])).toEqual([
    ['chip:b1', '[b1] section · Goal', true],
    ['chip:b2', '[b2] section · Next', true],
    ['board:prev', 'prev board', true],
    ['board:next', 'next board', true],
  ])
  // The header is the Button, not a Text row as well; the rows around it stay Text.
  expect(drawn.texts).not.toContain('[b1] section · Goal')
  expect(drawn.texts).toContain('Ship it')
  drawn.press('chip:b2')
  drawn.press('board:next')
  expect(drawn.posts).toEqual([{ action: 'chip:b2' }, { action: 'board:next' }])
})

test('the inspector client draws every row as Text when the model has no lineActions', async () => {
  const model: InspectorModel = { title: 'Decisions', lines: [[{ text: 'a row' }]], actions: [{ id: 'page:next', label: 'next page' }] }
  const drawn = drawInspector(model)
  expect(drawn.buttons.map(button => button.key)).toEqual(['page:next'])
  expect(drawn.texts).toContain('a row')
  drawn.press('page:next')
  expect(drawn.posts).toEqual([{ action: 'page:next' }])
})
