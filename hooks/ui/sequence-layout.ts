import type { SequenceBlock, SequenceStep, SequenceStepKind } from '../engine/board-types.ts'
import { ACCENT, fit, width, type Line, type Segment } from './text.ts'

type Style = Omit<Segment, 'text'>
// char is '' for the second cell of a double-width grapheme, so a row stays one entry per terminal cell.
type Cell = { char: string; style: Style }
// x is the lifeline's cell; before and after are the neighbouring lifelines (or the row's edges), which bound the room beside it.
type Lane = { x: number; before: number; after: number }
type Layout = { lanes: Map<string, Lane>; length: number }

// Two lifelines are one lane apart, so a lane of 10 leaves 9 cells between neighbours: the number "40. " and 5 cells of label.
// Below that a step label has no room, and the diagram gives way to a list.
const MIN_LANE_WIDTH = 10

const PLAIN: Style = {}
const BOLD: Style = { bold: true }
const DIM: Style = { dim: true }
const ARROW: Style = { color: ACCENT }

const ARROWS: Record<Exclude<SequenceStepKind, 'note'>, { shaft: string; left: string; right: string; list: string }> = {
  call: { shaft: '─', left: '◀', right: '▶', list: '→' },
  return: { shaft: '╌', left: '◀', right: '▶', list: '⇠' },
  async: { shaft: '─', left: '◁', right: '▷', list: '⇢' },
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function blank(length: number): Cell[] {
  return Array.from({ length }, () => ({ char: ' ', style: PLAIN }))
}

// text must already fit the cells from x on; callers size it with fit() against the room they know.
function paint(row: Cell[], x: number, text: string, style: Style): void {
  let at = x
  for (const { segment } of segmenter.segment(text)) {
    row[at] = { char: segment, style }
    if (width(segment) === 2) row[at + 1] = { char: '', style }
    at += width(segment)
  }
}

function toLine(row: Cell[]): Line {
  let end = row.length
  while (end > 0 && row[end - 1]?.char === ' ') end--
  const line: Line = []
  for (const { char, style } of row.slice(0, end)) {
    const last = line[line.length - 1]
    if (last && last.color === style.color && last.bold === style.bold && last.dim === style.dim) last.text += char
    else line.push({ text: char, ...style })
  }
  return line
}

function lifelineRow(layout: Layout): Cell[] {
  const row = blank(layout.length)
  for (const lane of layout.lanes.values()) row[lane.x] = { char: '│', style: DIM }
  return row
}

// Text next to a lifeline on the side with more room; the right side wins a tie. It stops at the neighbouring lifeline.
function beside(row: Cell[], lane: Lane, textFor: (room: number) => string): void {
  const right = lane.after - lane.x - 1
  const left = lane.x - lane.before - 1
  if (right >= left) {
    paint(row, lane.x + 1, textFor(right), PLAIN)
    return
  }
  const text = textFor(left)
  paint(row, lane.x - width(text), text, PLAIN)
}

// Board files are read from disk, so a step naming an unknown participant draws nothing rather than a wrong lane.
function stepLines(step: SequenceStep, number: number, layout: Layout): Line[] {
  const from = layout.lanes.get(step.from)
  if (!from) return []
  const kind = step.kind ?? 'call'
  if (kind === 'note') {
    const row = lifelineRow(layout)
    const prefix = `${number}. `
    beside(row, from, room => `${prefix}[${fit(step.label, room - width(prefix) - 2)}]`)
    return [toLine(row)]
  }
  const to = layout.lanes.get(step.to)
  if (!to) return []
  if (from === to) {
    const row = lifelineRow(layout)
    beside(row, from, room => fit(`↺ ${number}. ${step.label}`, room))
    return [toLine(row)]
  }
  const first = Math.min(from.x, to.x) + 1
  const last = Math.max(from.x, to.x) - 1
  const labelRow = lifelineRow(layout)
  paint(labelRow, first, fit(`${number}. ${step.label}`, last - first + 1), PLAIN)
  const arrowRow = lifelineRow(layout)
  const { shaft, left, right } = ARROWS[kind]
  for (let x = first; x <= last; x++) arrowRow[x] = { char: shaft, style: ARROW }
  arrowRow[to.x > from.x ? last : first] = { char: to.x > from.x ? right : left, style: ARROW }
  return [toLine(labelRow), toLine(arrowRow)]
}

// Too narrow for lanes: the same information as a list, one line per step. A note keeps the brackets it has in the
// diagram instead of a word like "note", because this file has no strings table and the pane switches language.
function listLines(block: SequenceBlock, columns: number): Line[] {
  const labels = new Map(block.participants.map(participant => [participant.id, participant.label]))
  const name = (id: string) => labels.get(id) ?? id
  const steps = block.steps.map((step, index) => {
    const kind = step.kind ?? 'call'
    if (kind === 'note') return `${index + 1}. ${name(step.from)}: [${step.label}]`
    return `${index + 1}. ${name(step.from)} ${ARROWS[kind].list} ${name(step.to)}: ${step.label}`
  })
  const participants = block.participants.map(participant => participant.label).join(', ')
  return [participants, ...steps].map(text => [{ text: fit(text, columns) }])
}

// A sequence diagram: one lane per participant, a lifeline down the middle of each, and per step a label line over
// the arrow that joins two lifelines. A note or a step to the same participant takes one line beside its lifeline.
export function sequenceLines(block: SequenceBlock, columns: number): Line[] {
  const count = block.participants.length
  if (columns <= 0 || count === 0) return []
  const laneWidth = Math.floor(columns / count)
  if (laneWidth < MIN_LANE_WIDTH) return listLines(block, columns)

  const layout: Layout = {
    length: laneWidth * count,
    lanes: new Map(block.participants.map((participant, index) => {
      const x = index * laneWidth + Math.floor(laneWidth / 2)
      const lane: Lane = { x, before: index === 0 ? -1 : x - laneWidth, after: index === count - 1 ? laneWidth * count : x + laneWidth }
      return [participant.id, lane] as const
    })),
  }
  const header = blank(layout.length)
  block.participants.forEach((participant, index) => {
    const label = fit(participant.label, laneWidth - 2)
    paint(header, index * laneWidth + Math.floor((laneWidth - width(label)) / 2), label, BOLD)
  })
  return [
    toLine(header),
    toLine(lifelineRow(layout)),
    ...block.steps.flatMap((step, index) => stepLines(step, index + 1, layout)),
  ]
}
