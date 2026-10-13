import { expect, test } from 'claude-code/testing'
import { boardToMarkdown } from '../hooks/engine/board-export.ts'
import type { Block, Board } from '../hooks/engine/board-types.ts'

function boardOf(blocks: Block[] = [], title = 'Plan'): Board {
  return { boardId: 'board_1', sessionId: 'sess', title, createdAt: 1, updatedAt: 1, nextId: blocks.length + 1, blocks }
}

// The expected documents are written line by line so a reader sees the markdown the model gets back.
const document = (...lines: string[]) => `${lines.join('\n')}\n`
const exportBlock = (block: Block) => boardToMarkdown(boardOf([block]))

const everyBlock: Block[] = [
  { id: 'b1', type: 'section', title: 'Goal', text: '- ship it\n- test it' },
  { id: 'b2', type: 'callout', tone: 'risk', title: 'Watch', text: 'first\n\nsecond' },
  { id: 'b3', type: 'table', columns: ['key', 'does'], rows: [['a|b', 'pipes'], ['c', 'plain']] },
  { id: 'b4', type: 'code_peek', path: 'src/a.ts', start: 8, end: 9, lines: ['const a = 1', 'const b = 2'], note: 'why' },
  { id: 'b5', type: 'code', language: 'ts', code: 'let x = 1\nlet y = 2', note: 'proposal' },
  { id: 'b6', type: 'trace', run: 'dag_1', node: 'build', part: 'output', lines: ['ok', 'done'], note: 'tail' },
  {
    id: 'b7',
    type: 'flow',
    nodes: [{ id: 'a', label: 'Start' }, { id: 'b', label: 'OK?', kind: 'decision' }, { id: 'c', label: 'Done', kind: 'terminal' }],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c', label: 'yes' }],
  },
  {
    id: 'b8',
    type: 'sequence',
    participants: [{ id: 'u', label: 'User' }, { id: 'h', label: 'Hook' }],
    steps: [
      { from: 'u', to: 'h', label: 'prompt' },
      { from: 'h', to: 'h', label: 'route', kind: 'note' },
      { from: 'h', to: 'u', label: 'answer', kind: 'return' },
      { from: 'u', to: 'h', label: 'poll', kind: 'async' },
    ],
  },
]

test('a board holding one of every block type exports as one markdown document', () => {
  expect(boardToMarkdown(boardOf(everyBlock))).toBe(document(
    '# Plan',
    '',
    '<!-- b1 -->',
    '## Goal',
    '- ship it',
    '- test it',
    '',
    '<!-- b2 -->',
    '> **risk — Watch**:',
    '> first',
    '>',
    '> second',
    '',
    '<!-- b3 -->',
    '| key | does |',
    '| --- | --- |',
    '| a\\|b | pipes |',
    '| c | plain |',
    '',
    '<!-- b4 -->',
    '`src/a.ts` (L8–L9)',
    '```',
    'const a = 1',
    'const b = 2',
    '```',
    '*why*',
    '',
    '<!-- b5 -->',
    '```ts',
    'let x = 1',
    'let y = 2',
    '```',
    '*proposal*',
    '',
    '<!-- b6 -->',
    '`build · output`',
    '```',
    'ok',
    'done',
    '```',
    '*tail*',
    '',
    '<!-- b7 -->',
    '```mermaid',
    'flowchart LR',
    'a["Start"]',
    'b{"OK?"}',
    'c(["Done"])',
    'a --> b',
    'b -->|yes| c',
    '```',
    '',
    '<!-- b8 -->',
    '```mermaid',
    'sequenceDiagram',
    'participant u as "User"',
    'participant h as "Hook"',
    'u->>h: prompt',
    'Note over h,h: route',
    'h-->>u: answer',
    'u-)h: poll',
    '```',
  ))
})

test('an empty board exports only its title', () => {
  expect(boardToMarkdown(boardOf())).toBe('# Plan\n')
})

test('a title with a double quote survives', () => {
  expect(boardToMarkdown(boardOf([], 'Why "fast" wins'))).toBe('# Why "fast" wins\n')
})

test('each block keeps its own anchor, in board order', () => {
  const sections: Block[] = [
    { id: 'b3', type: 'section', title: 'Third-made' },
    { id: 'b1', type: 'section', title: 'First-made' },
  ]
  expect(boardToMarkdown(boardOf(sections))).toBe(document('# Plan', '', '<!-- b3 -->', '## Third-made', '', '<!-- b1 -->', '## First-made'))
})

test('a decision node renders in braces, a terminal in a stadium and a plain node in a box', () => {
  const flow: Block = {
    id: 'b1',
    type: 'flow',
    nodes: [{ id: 'p', label: 'Work', kind: 'process' }, { id: 'd', label: 'Safe?', kind: 'decision' }, { id: 't', label: 'End', kind: 'terminal' }],
    edges: [],
  }
  expect(exportBlock(flow)).toContain('flowchart LR\np["Work"]\nd{"Safe?"}\nt(["End"])\n```')
})

test('a double quote in a flow or sequence label becomes a single quote', () => {
  const flow: Block = {
    id: 'b1',
    type: 'flow',
    nodes: [{ id: 'a', label: 'say "hi"' }, { id: 'b', label: 'B' }],
    edges: [{ from: 'a', to: 'b', label: 'the "yes" path' }],
  }
  const sequence: Block = {
    id: 'b2',
    type: 'sequence',
    participants: [{ id: 'u', label: 'The "User"' }, { id: 'h', label: 'Hook' }],
    steps: [{ from: 'u', to: 'h', label: 'asks "why"' }],
  }
  const text = boardToMarkdown(boardOf([flow, sequence]))
  expect(text).toContain('a["say \'hi\'"]')
  expect(text).toContain('a -->|the \'yes\' path| b')
  expect(text).toContain('participant u as "The \'User\'"')
  expect(text).toContain('u->>h: asks \'why\'')
})

test('a label that spans lines stays on one mermaid line', () => {
  const flow: Block = { id: 'b1', type: 'flow', nodes: [{ id: 'a', label: 'first\nsecond' }, { id: 'b', label: 'B' }], edges: [] }
  expect(exportBlock(flow)).toContain('a["first second"]')
})

test('a sequence step of kind call draws the same arrow as a step with no kind', () => {
  const sequence: Block = {
    id: 'b1',
    type: 'sequence',
    participants: [{ id: 'u', label: 'User' }, { id: 'h', label: 'Hook' }],
    steps: [{ from: 'u', to: 'h', label: 'plain' }, { from: 'u', to: 'h', label: 'named', kind: 'call' }],
  }
  expect(exportBlock(sequence)).toContain('u->>h: plain\nu->>h: named\n```')
})

test('a callout without a title labels itself with its tone only', () => {
  expect(exportBlock({ id: 'b1', type: 'callout', tone: 'info', text: 'one line' })).toBe(document('# Plan', '', '<!-- b1 -->', '> **info**:', '> one line'))
})

test('a section without text is only its heading', () => {
  expect(exportBlock({ id: 'b1', type: 'section', title: 'Goal' })).toBe(document('# Plan', '', '<!-- b1 -->', '## Goal'))
})

test('a pipe in a column header is escaped and a line break in a cell becomes <br>', () => {
  const table: Block = { id: 'b1', type: 'table', columns: ['a|b', 'c'], rows: [['one\ntwo', '']] }
  expect(exportBlock(table)).toBe(document('# Plan', '', '<!-- b1 -->', '| a\\|b | c |', '| --- | --- |', '| one<br>two |  |'))
})

test('a table with no rows exports its header and separator', () => {
  expect(exportBlock({ id: 'b1', type: 'table', columns: ['k'], rows: [] })).toBe(document('# Plan', '', '<!-- b1 -->', '| k |', '| --- |'))
})

test('a code block without a language opens a bare fence and without a note ends at the fence', () => {
  expect(exportBlock({ id: 'b1', type: 'code', code: 'x = 1' })).toBe(document('# Plan', '', '<!-- b1 -->', '```', 'x = 1', '```'))
})

test('a fence grows past the longest backtick run inside the quoted lines', () => {
  const trace: Block = { id: 'b1', type: 'trace', run: 'r', node: 'doc', part: 'answer', lines: ['Use:', '```ts', 'a()', '```'] }
  expect(exportBlock(trace)).toBe(document('# Plan', '', '<!-- b1 -->', '`doc · answer`', '````', 'Use:', '```ts', 'a()', '```', '````'))
})

test('a fence grows past a backtick run inside a code block too', () => {
  const code: Block = { id: 'b1', type: 'code', language: 'md', code: 'see `````x`````' }
  expect(exportBlock(code)).toBe(document('# Plan', '', '<!-- b1 -->', '``````md', 'see `````x`````', '``````'))
})

test('a title on a table, code, code_peek, trace, flow or sequence block shows above its content in bold', () => {
  const titled: Block[] = [
    { id: 'b1', type: 'table', title: 'Keys', columns: ['k'], rows: [] },
    { id: 'b2', type: 'code', title: 'Fix', code: 'x' },
    { id: 'b3', type: 'code_peek', title: 'Site', path: 'a.ts', start: 1, end: 1, lines: ['x'] },
    { id: 'b4', type: 'trace', title: 'Tail', run: 'r', node: 'n', part: 'error', lines: ['x'] },
    { id: 'b5', type: 'flow', title: 'Path', nodes: [], edges: [] },
    { id: 'b6', type: 'sequence', title: 'Calls', participants: [], steps: [] },
  ]
  // Line 0 is the board title, 1 is blank, 2 is the anchor, so line 3 is where a block's title goes.
  expect(titled.map(block => exportBlock(block).split('\n')[3])).toEqual(['**Keys**', '**Fix**', '**Site**', '**Tail**', '**Path**', '**Calls**'])
})

test('a title that spans lines stays on one heading line', () => {
  expect(boardToMarkdown(boardOf([{ id: 'b1', type: 'section', title: 'Goal\nand scope' }], 'Plan\nv2'))).toBe(
    document('# Plan v2', '', '<!-- b1 -->', '## Goal and scope'),
  )
})
