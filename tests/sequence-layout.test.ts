import { expect, test } from 'claude-code/testing'
import type { SequenceBlock, SequenceStep } from '../hooks/engine/board-types.ts'
import { sequenceLines } from '../hooks/ui/sequence-layout.ts'
import { width, type Line } from '../hooks/ui/text.ts'

const text = (line: Line) => line.map(segment => segment.text).join('')

function sequence(labels: string[], steps: SequenceStep[]): SequenceBlock {
  return { id: 'b1', type: 'sequence', participants: labels.map((label, index) => ({ id: `p${index}`, label })), steps }
}

const step = (from: number, to: number, label: string, kind?: SequenceStep['kind']): SequenceStep =>
  ({ from: `p${from}`, to: `p${to}`, label, kind })

const LOGIN = sequence(['Client', 'Server', 'Store'], [
  step(0, 1, 'login', 'call'),
  step(1, 0, 'token', 'return'),
  step(1, 2, 'audit', 'async'),
  step(1, 1, 'validate'),
])

test('a sequence of call, return, async and self steps shows every label, arrow head and step number at 90 columns', async () => {
  const lines = sequenceLines(LOGIN, 90).map(text)
  const all = lines.join('\n')
  for (const label of ['Client', 'Server', 'Store', 'login', 'token', 'audit', 'validate']) expect(all).toContain(label)
  for (const mark of ['▶', '◀', '▷', '↺', '1.', '2.', '3.', '4.']) expect(all).toContain(mark)
})

test('a return arrow is dashed and a call arrow is solid', async () => {
  const lines = sequenceLines(LOGIN, 90).map(text)
  expect(lines.find(line => line.includes('◀'))).toContain('╌')
  expect(lines.find(line => line.includes('▶'))).not.toContain('╌')
  expect(lines.find(line => line.includes('▷'))).toContain('─')
})

test('a call and a return between two lanes put the head against the target lifeline', async () => {
  const lines = sequenceLines(sequence(['A', 'B'], [step(0, 1, 'hi'), step(1, 0, 'ok', 'return')]), 24).map(text)
  expect(lines).toEqual([
    '     A           B',
    '      │           │',
    '      │1. hi      │',
    '      │──────────▶│',
    '      │2. ok      │',
    '      │◀╌╌╌╌╌╌╌╌╌╌│',
  ])
})

test('arrows point left when the step goes from a lane on the right to a lane on the left', async () => {
  const lines = sequenceLines(sequence(['A', 'B', 'C'], [step(2, 0, 'call back'), step(2, 1, 'ping', 'async')]), 90).map(text)
  const arrows = lines.filter(line => /[◀▶◁▷]/.test(line))
  expect(arrows.length).toBe(2)
  expect(arrows[0]).toContain('◀')
  expect(arrows[0]).not.toContain('▶')
  expect(arrows[1]).toContain('◁')
  expect(arrows[1]).not.toContain('▷')
})

test('a note step renders its label in brackets on one line beside its lifeline', async () => {
  const lines = sequenceLines(sequence(['A', 'B'], [step(0, 0, 'cache hit', 'note')]), 40).map(text)
  expect(lines.length).toBe(3)
  expect(lines[2]).toContain('1. [cache hit]')
  expect(lines[2]?.indexOf('1. [cache hit]')).toBeGreaterThan(lines[2]?.indexOf('│') ?? 0)
})

test('a step to the same participant takes one line beside the lifeline, and the last lane puts it on the left', async () => {
  const lines = sequenceLines(sequence(['A', 'B'], [step(0, 0, 'x'), step(1, 1, 'y'), step(0, 0, 'n', 'note')]), 24).map(text)
  expect(lines.slice(2)).toEqual([
    '      │↺ 1. x     │',
    '      │     ↺ 2. y│',
    '      │3. [n]     │',
  ])
})

const withNote = (base: SequenceStep, note: string): SequenceStep => ({ ...base, note })

test('a step note draws on a dim line under the arrow, between the two lifelines', async () => {
  const lines = sequenceLines(sequence(['A', 'B'], [withNote(step(0, 1, 'hi'), 'later')]), 24)
  expect(lines.map(text)).toEqual([
    '     A           B',
    '      │           │',
    '      │1. hi      │',
    '      │──────────▶│',
    '      │later      │',
  ])
  const note = lines[4]?.find(segment => segment.text.includes('later'))
  expect(note?.dim).toBe(true)
})

test('a note on a self step takes a dim line under it, on the same side of the lifeline', async () => {
  const lines = sequenceLines(sequence(['A', 'B'], [withNote(step(0, 0, 'x'), 'why'), withNote(step(1, 1, 'y'), 'because')]), 24).map(text)
  expect(lines.slice(2)).toEqual([
    '      │↺ 1. x     │',
    '      │why        │',
    '      │     ↺ 2. y│',
    '      │    because│',
  ])
})

test('a note field on a note step adds its own dim line under the bracketed label', async () => {
  const lines = sequenceLines(sequence(['A', 'B'], [withNote(step(0, 0, 'cache hit', 'note'), 'ttl 5m')]), 40)
  expect(lines.map(text).slice(2)).toEqual([
    '          │1. [cache hit]     │',
    '          │ttl 5m             │',
  ])
  expect(lines[3]?.find(segment => segment.text.includes('ttl 5m'))?.dim).toBe(true)
})

test('a step without a note, or with an empty one, draws no extra line', async () => {
  const plain = sequenceLines(sequence(['A', 'B'], [step(0, 1, 'hi')]), 24)
  expect(sequenceLines(sequence(['A', 'B'], [withNote(step(0, 1, 'hi'), '')]), 24)).toEqual(plain)
})

test('a step note is cut with an ellipsis inside its room and never past the columns', async () => {
  const block = sequence(['클라이언트', '서버', '저장소'], [
    withNote(step(0, 1, '로그인'), '이 설명은 두 생명선 사이의 공간보다 훨씬 길게 이어집니다'),
    withNote(step(1, 1, '검증'), 'a note much longer than the room beside a lifeline in a narrow lane'),
    withNote(step(2, 2, '캐시', 'note'), '만료까지 오 분'),
  ])
  for (const columns of [30, 45, 60, 90, 120]) {
    for (const line of sequenceLines(block, columns)) expect(width(text(line))).toBeLessThanOrEqual(columns)
  }
  const long = sequenceLines(sequence(['A', 'B'], [withNote(step(0, 1, 'hi'), 'a note much longer than the room')]), 24).map(text)
  expect(long[4]).toBe('      │a note muc…│')
})

test('a lifeline an arrow crosses is covered, and one it does not reach stays drawn', async () => {
  const reaching = sequenceLines(sequence(['A', 'B', 'C'], [step(0, 2, 'far')]), 90).map(text)
  const near = sequenceLines(sequence(['A', 'B', 'C'], [step(0, 1, 'near')]), 90).map(text)
  expect(reaching[3]?.match(/│/g)?.length).toBe(2)
  expect(near[3]?.match(/│/g)?.length).toBe(3)
})

test('participant labels are bold and the lifelines are dim', async () => {
  const lines = sequenceLines(sequence(['A', 'B'], [step(0, 1, 'hi')]), 24)
  expect(lines[0]?.filter(segment => segment.text.trim() !== '').every(segment => segment.bold === true)).toBe(true)
  const lifelines = lines[1]?.filter(segment => segment.text === '│')
  expect(lifelines?.length).toBe(2)
  expect(lifelines?.every(segment => segment.dim === true)).toBe(true)
})

test('below a lane width of 10 cells the diagram becomes a list with arrows in text', async () => {
  const steps = [step(0, 1, 'login'), step(1, 0, 'token', 'return'), step(1, 2, 'audit', 'async'), step(2, 2, 'hit', 'note')]
  const lines = sequenceLines(sequence(['Web', 'API', 'DB'], steps), 20).map(text)
  expect(lines).toEqual([
    'Web, API, DB',
    '1. Web → API: login',
    '2. API ⇠ Web: token',
    '3. API ⇢ DB: audit',
    '4. DB: [hit]',
  ])
})

test('the list appends a step note after a dash and leaves a step without one alone', async () => {
  const steps = [withNote(step(0, 1, 'go'), 'ok'), step(1, 0, 'back', 'return'), withNote(step(1, 1, 'hit', 'note'), 'ttl')]
  expect(sequenceLines(sequence(['A', 'B'], steps), 19).map(text)).toEqual([
    'A, B',
    '1. A → B: go — ok',
    '2. B ⇠ A: back',
    '3. B: [hit] — ttl',
  ])
})

test('a lane of exactly 10 cells still draws lifelines and 9 falls back to the list', async () => {
  const block = sequence(['A', 'B'], [step(0, 1, 'hi')])
  expect(sequenceLines(block, 20).map(text)[1]).toBe('     │         │')
  expect(sequenceLines(block, 19).map(text)).toEqual(['A, B', '1. A → B: hi'])
})

test('Korean labels keep every line within the columns at any width', async () => {
  const block = sequence(['클라이언트', '서버', '저장소'], [
    step(0, 1, '로그인을 요청합니다 그리고 오래 기다립니다'),
    step(1, 0, '토큰을 돌려줍니다', 'return'),
    step(1, 2, '감사 기록을 남깁니다', 'async'),
    step(1, 1, '입력값을 검증합니다 매우 길게 길게'),
    step(2, 2, '캐시에 있습니다 이 문장은 아주 깁니다', 'note'),
  ])
  for (const columns of [10, 20, 29, 30, 45, 60, 90, 120]) {
    for (const line of sequenceLines(block, columns)) expect(width(text(line))).toBeLessThanOrEqual(columns)
  }
  expect(sequenceLines(block, 90).map(text).join('\n')).toContain('로그인을 요청합니다')
})

test('long English labels are cut with an ellipsis instead of overflowing', async () => {
  const block = sequence(['An extremely long participant name', 'B'], [step(0, 1, 'a label that is much longer than the space between two lifelines')])
  for (const line of sequenceLines(block, 30)) expect(width(text(line))).toBeLessThanOrEqual(30)
  expect(sequenceLines(block, 30).map(text).join('\n')).toContain('…')
})

test('no columns draws nothing and a step naming no participant draws no line', async () => {
  expect(sequenceLines(LOGIN, 0)).toEqual([])
  expect(sequenceLines(sequence(['A', 'B'], [{ from: 'p0', to: 'gone', label: 'lost' }]), 24).map(text)).toEqual(['     A           B', '      │           │'])
})
