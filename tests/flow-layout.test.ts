import { expect, test } from 'claude-code/testing'
import type { FlowBlock } from '../hooks/engine/board-types.ts'
import { flowLines } from '../hooks/ui/flow-layout.ts'
import { fit, width, type Line } from '../hooks/ui/text.ts'

const text = (line: Line) => line.map(s => s.text).join('')

const LABELS = { sameFrontier: 'Same frontier', more: '+{n} more' }

const DIAMOND: FlowBlock = {
  id: 'b1',
  type: 'flow',
  nodes: [
    { id: 'start', label: 'Begin', kind: 'terminal' },
    { id: 'check', label: 'Valid?', kind: 'decision', note: 'is the config valid' },
    { id: 'yes', label: 'Apply' },
    { id: 'no', label: 'Reject', kind: 'process' },
    { id: 'end', label: 'Finish', kind: 'terminal' },
  ],
  edges: [
    { from: 'start', to: 'check' },
    { from: 'check', to: 'yes', label: 'yes' },
    { from: 'check', to: 'no', label: 'no' },
    { from: 'yes', to: 'end' },
    { from: 'no', to: 'end' },
  ],
}

test('a diamond draws one box per node with its glyph, incoming edges and edge labels, and no DAG markers', async () => {
  const lines = flowLines(DIAMOND, 110, LABELS).map(text)
  const joined = lines.join('\n')
  for (const label of ['Begin', 'Valid?', 'Apply', 'Reject', 'Finish']) expect(joined).toContain(`│ ${label} `)
  expect(joined).toContain('│ ◇ is the config valid')
  expect(joined).toContain('← Valid? (yes)')
  expect(joined).toContain('← Valid? (no)')
  expect(joined).toContain('← Apply, Reject')
  expect(joined).toContain('← Begin ')
  expect(joined).not.toContain('← Begin (')
  expect(joined).not.toContain('[+]')
  expect(joined).not.toContain('[-]')
  expect(lines.find(line => line.includes('│ Begin '))?.trim()).toBe(`│ ${fit('Begin', 30, true)} │`)
  expect(lines.filter(line => line.includes('▼'))).toHaveLength(3)
  for (const line of lines) expect(width(line)).toBeLessThanOrEqual(110)
})

// The same diamond with the branch into Reject and the edge out of it marked optional.
const WITH_DASHED: FlowBlock = {
  ...DIAMOND,
  edges: [
    { from: 'start', to: 'check' },
    { from: 'check', to: 'yes', label: 'yes' },
    { from: 'check', to: 'no', label: 'no', style: 'dashed' },
    { from: 'yes', to: 'end' },
    { from: 'no', to: 'end', style: 'dashed' },
  ],
}

test('a dashed edge marks its source in the box it leads into and a solid edge stays plain', async () => {
  const joined = flowLines(WITH_DASHED, 110, LABELS).map(text).join('\n')
  expect(joined).toContain('← ╌Valid? (no)')
  expect(joined).toContain('← Apply, ╌Reject')
  expect(joined).toContain('← Valid? (yes)')
  expect(joined).not.toContain('╌Valid? (yes)')
  expect(joined).not.toContain('╌Apply')
  expect(flowLines(DIAMOND, 110, LABELS).map(text).join('\n')).not.toContain('╌')
})

test('the list draws a dashed edge with a dashed arrow and a solid edge with a plain one', async () => {
  const lines = flowLines(WITH_DASHED, 30, LABELS).map(text)
  expect(lines.slice(5)).toEqual([
    'Begin → Valid?',
    'Valid? → Apply (yes)',
    'Valid? ⇢ Reject (no)',
    'Apply → Finish',
    'Reject ⇢ Finish',
  ])
})

test('a pane too narrow for the branches side by side lists nodes then edges', async () => {
  const lines = flowLines(DIAMOND, 30, LABELS)
  expect(lines.map(text)).toEqual([
    '○ Begin',
    '◇ Valid? — is the config valid',
    '□ Apply',
    '□ Reject',
    '○ Finish',
    'Begin → Valid?',
    'Valid? → Apply (yes)',
    'Valid? → Reject (no)',
    'Apply → Finish',
    'Reject → Finish',
  ])
  for (const line of lines) expect(width(text(line))).toBeLessThanOrEqual(30)
})

test('the list cuts a long line with an ellipsis inside the width', async () => {
  const lines = flowLines(DIAMOND, 12, LABELS).map(text)
  expect(lines[1]).toBe('◇ Valid? — …')
  for (const line of lines) expect(width(line)).toBeLessThanOrEqual(12)
})

test('a Korean label keeps every line within the width in the diagram and in the list', async () => {
  const korean: FlowBlock = {
    id: 'b2',
    type: 'flow',
    nodes: [
      { id: 'a', label: '검증 단계', kind: 'decision', note: '입력값을 확인합니다' },
      { id: 'b', label: '배포 단계', note: '운영 환경에 반영' },
      { id: 'c', label: '롤백' },
      { id: 'd', label: '완료', kind: 'terminal' },
    ],
    edges: [
      { from: 'a', to: 'b', label: '통과' },
      { from: 'a', to: 'c', label: '실패' },
      { from: 'b', to: 'd' },
      { from: 'c', to: 'd' },
    ],
  }
  expect(flowLines(korean, 110, LABELS).map(text).join('\n')).toContain('│ 검증 단계 ')
  expect(flowLines(korean, 20, LABELS).map(text)[0]).toBe('◇ 검증 단계 — 입력…')
  for (const columns of [110, 60, 40, 30, 20, 12, 5, 1]) {
    for (const line of flowLines(korean, columns, LABELS)) expect(width(text(line))).toBeLessThanOrEqual(columns)
  }
})

test('a single node renders one box', async () => {
  const lines = flowLines({ id: 'b3', type: 'flow', nodes: [{ id: 'only', label: 'Only step', kind: 'terminal' }], edges: [] }, 60, LABELS).map(text)
  expect(lines).toHaveLength(5)
  expect(lines[0]!.trim()).toBe(`╭${'─'.repeat(32)}╮`)
  expect(lines[1]).toContain('│ Only step ')
  expect(lines[2]).toContain('│ ○ ')
  expect(lines[3]!.trim()).toBe(`│${' '.repeat(32)}│`)
  expect(lines[4]!.trim()).toBe(`╰${'─'.repeat(32)}╯`)
})

test('a block with no nodes, or no room, draws nothing', async () => {
  expect(flowLines({ id: 'b4', type: 'flow', nodes: [], edges: [] }, 60, LABELS)).toEqual([])
  expect(flowLines(DIAMOND, 0, LABELS)).toEqual([])
})
