import type { Block, Board } from '../engine/board-types.ts'
import { calloutLines, codePeekLines, sectionLines, tableLines, type CalloutLabels } from './board-blocks.ts'
import { flowLines, type FlowLabels } from './flow-layout.ts'
import type { Language } from './i18n.ts'
import type { InspectorAction, InspectorLineAction, InspectorModel } from './inspector-model.ts'
import { sequenceLines } from './sequence-layout.ts'
import { clean, fit, width, type Line } from './text.ts'

// The Board section of the /dag pane: the shown board's blocks as lines, in pages, drawn by the inspector client.

export type BoardViewInput = {
  boards: readonly Board[]
  selectedBoardId?: string
  columns: number
  language: Language
  page: number
}

// One screenful: the pane shows about this many rows, so a page never needs scrolling inside the client.
const PAGE_LINES = 60
const HEADER_SEPARATOR = ' · '

type BoardStrings = {
  title: string
  noBoard: string
  emptyBoard: string
  prevBoard: string
  nextBoard: string
  prevPage: string
  nextPage: string
  pageOf: (index: number, count: number) => string
  moreLines: (count: number) => string
  chipHint: string
  tones: CalloutLabels
  flow: FlowLabels
}

const EN: BoardStrings = {
  title: 'Board',
  noBoard: 'No board yet. The model draws one with the board tool.',
  emptyBoard: 'This board has no blocks yet.',
  prevBoard: 'prev board',
  nextBoard: 'next board',
  prevPage: 'prev page',
  nextPage: 'next page',
  pageOf: (index, count) => `page ${index}/${count}`,
  moreLines: count => `… ${count} more lines`,
  chipHint: 'Press a block header to cite that block in your prompt',
  tones: { info: 'info', decision: 'decision', risk: 'risk', warning: 'warning' },
  flow: { sameFrontier: 'Same frontier', more: '+{n} more' },
}

const KO: BoardStrings = {
  title: '보드',
  noBoard: '아직 보드가 없습니다. 모델이 board 툴로 그립니다.',
  emptyBoard: '이 보드에는 아직 블록이 없습니다.',
  prevBoard: '이전 보드',
  nextBoard: '다음 보드',
  prevPage: '이전 페이지',
  nextPage: '다음 페이지',
  pageOf: (index, count) => `페이지 ${index}/${count}`,
  moreLines: count => `… ${count}줄 더`,
  chipHint: '블록 머리글을 누르면 프롬프트에 그 블록을 인용합니다',
  tones: { info: '정보', decision: '결정', risk: '위험', warning: '주의' },
  flow: { sameFrontier: '같은 층', more: '+{n}개 더' },
}

const dim = (text: string): Line => [{ text, dim: true }]

// Index of the board the view shows: the selected one, else the most recently updated (the later one on a tie).
function shownIndex(boards: readonly Board[], selectedBoardId: string | undefined): number {
  const selected = boards.findIndex(board => board.boardId === selectedBoardId)
  if (selected >= 0) return selected
  let latest = -1
  boards.forEach((board, i) => {
    const best = boards[latest]
    if (!best || board.updatedAt >= best.updatedAt) latest = i
  })
  return latest
}

// Boards keep their creation order, so stepping past either end wraps around.
export function adjacentBoardId(boards: readonly Board[], selectedBoardId: string | undefined, step: 1 | -1): string | undefined {
  const current = shownIndex(boards, selectedBoardId)
  if (current < 0) return undefined
  return boards[(current + step + boards.length) % boards.length]?.boardId
}

// Security boundary: block text comes from the model, so strip control characters and bound every line's width.
function clip(line: Line, columns: number): Line {
  const out: Line = []
  let used = 0
  for (const segment of line) {
    const text = clean(segment.text)
    if (!text) continue
    const size = width(text)
    if (used + size <= columns) {
      out.push({ ...segment, text })
      used += size
      continue
    }
    const cut = fit(text, columns - used)
    if (cut) out.push({ ...segment, text: cut })
    break
  }
  return out
}

function renderBlock(block: Block, columns: number, t: BoardStrings): Line[] {
  switch (block.type) {
    case 'section': return sectionLines(block, columns)
    case 'callout': return calloutLines(block, columns, t.tones)
    case 'table': return tableLines(block, columns)
    case 'code_peek': return codePeekLines(block, columns)
    case 'flow': return flowLines(block, columns, t.flow)
    case 'sequence': return sequenceLines(block, columns)
  }
}

// The header is the first line of a block's lines.
type BlockLines = { id: string; lines: Line[] }
// `headers` holds one button per block header on the page, indexed into `lines`.
type Page = { lines: Line[]; headers: InspectorLineAction[] }

function blockLines(block: Block, columns: number, t: BoardStrings): BlockLines {
  const header = `[${block.id}] ${block.type}${block.title ? `${HEADER_SEPARATOR}${block.title}` : ''}`
  return { id: block.id, lines: [dim(header), ...renderBlock(block, columns, t)] }
}

const chip = (blockId: string, line: number): InspectorLineAction => ({ line, action: `chip:${blockId}` })

// Whole blocks fill a page in order, a blank line between them. A block taller than a page stands alone, cut short.
function pack(blocks: readonly BlockLines[], t: BoardStrings): Page[] {
  const pages: Page[] = []
  let current: Page = { lines: [], headers: [] }
  for (const { id, lines } of blocks) {
    if (lines.length > PAGE_LINES) {
      if (current.lines.length > 0) pages.push(current)
      pages.push({
        lines: [...lines.slice(0, PAGE_LINES - 1), dim(t.moreLines(lines.length - (PAGE_LINES - 1)))],
        headers: [chip(id, 0)],
      })
      current = { lines: [], headers: [] }
      continue
    }
    if (current.lines.length > 0 && current.lines.length + 1 + lines.length > PAGE_LINES) {
      pages.push(current)
      current = { lines: [], headers: [] }
    }
    if (current.lines.length > 0) current.lines.push([])
    current.headers.push(chip(id, current.lines.length))
    current.lines.push(...lines)
  }
  if (current.lines.length > 0) pages.push(current)
  return pages
}

function emptyView(t: BoardStrings): InspectorModel {
  return { title: t.title, lines: [dim(t.noBoard)], actions: [] }
}

export function buildBoardView(input: BoardViewInput): InspectorModel {
  const { boards, columns } = input
  if (!(columns > 0)) return { title: '', lines: [], actions: [] }
  const t = input.language === 'ko' ? KO : EN
  const shown = shownIndex(boards, input.selectedBoardId)
  const board = boards[shown]
  const model = board ? boardView(board, shown, boards.length, input, t) : emptyView(t)
  const { lineActions } = model
  return {
    title: fit(model.title, columns),
    lines: model.lines.map(line => clip(line, columns)),
    actions: model.actions.map(action => ({ id: action.id, label: fit(action.label, columns) })),
    ...(lineActions ? { lineActions } : {}),
  }
}

function boardView(board: Board, index: number, count: number, input: BoardViewInput, t: BoardStrings): InspectorModel {
  const pages = pack(board.blocks.map(block => blockLines(block, input.columns, t)), t)
  const pageCount = Math.max(1, pages.length)
  const page = Math.min(Math.max(Number.isFinite(input.page) ? Math.trunc(input.page) : 0, 0), pageCount - 1)
  const shownPage = pages[page]
  const footer = pageCount > 1 ? [dim(t.pageOf(page + 1, pageCount))] : []
  // The hint comes last, after the page footer, and only where there is a header to press.
  const hint = shownPage ? [dim(t.chipHint)] : []
  const lines = [...(shownPage?.lines ?? [dim(t.emptyBoard)]), ...footer, ...hint]
  const actions: InspectorAction[] = []
  if (count > 1) actions.push({ id: 'board:prev', label: t.prevBoard }, { id: 'board:next', label: t.nextBoard })
  if (page > 0) actions.push({ id: 'page:prev', label: t.prevPage })
  if (page < pageCount - 1) actions.push({ id: 'page:next', label: t.nextPage })
  // The count stays visible when a long board title is cut.
  const suffix = ` (${index + 1}/${count})`
  const title = fit(board.title, Math.max(0, input.columns - width(suffix))) + suffix
  return { title, lines, actions, ...(shownPage ? { lineActions: shownPage.headers } : {}) }
}
