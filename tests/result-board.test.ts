import { expect, test } from 'claude-code/testing'
import { applyEdits, newBoard } from '../hooks/engine/board.ts'
import type { BlockInput, Board } from '../hooks/engine/board-types.ts'
import type { DecisionRecord } from '../hooks/engine/decisions.ts'
import { parseDefinition } from '../hooks/engine/definition.ts'
import { createRun, markFinished, markRunning } from '../hooks/engine/run.ts'
import type { NodeRun, Run, VerificationOutcome } from '../hooks/engine/types.ts'
import { drawsResult, factEdits, resultFacts, resultTitle, RESULT_SLOTS, type ResultFacts, type ResultSlot } from '../hooks/ui/result-board.ts'

type Spec = { id: string; dependsOn?: string[]; writes?: string[] }
type Finish = { state: 'completed' | 'failed'; model?: string; took?: number }

function runOf(specs: Spec[], name = 'Ship it', goal?: string): Run {
  const parsed = parseDefinition({
    key: 'result-board',
    name,
    ...(goal === undefined ? {} : { goal }),
    nodes: specs.map(spec => ({ id: spec.id, prompt: 'work', ...(spec.dependsOn ? { dependsOn: spec.dependsOn } : {}), ...(spec.writes ? { writes: spec.writes } : {}) })),
  })
  if (!parsed.ok) throw new Error(parsed.error.message)
  return createRun(parsed.value, { runId: 'dag_result', sessionId: 's1', now: 0 })
}

// Runs the nodes one after another from t=1s, each for `took` ms (default 1s), so the order of finishes is the order given.
function play(run: Run, finishes: Record<string, Finish>): Run {
  let at = 1_000
  let current = run
  for (const [id, finish] of Object.entries(finishes)) {
    current = markRunning(current, id, `agent-${id}`, at, finish.model)
    at += finish.took ?? 1_000
    current = markFinished(current, id, { state: finish.state }, at)
  }
  return current
}

function withChecks(run: Run, id: string, outcomes: VerificationOutcome[]): Run {
  const evidence = outcomes.map(outcome => ({ check: { kind: 'file' as const, path: 'a.txt' }, passed: outcome === 'passed', outcome, checkedAt: 1, detail: '' }))
  const nodes = run.nodes.map((node): NodeRun => (node.id === id ? { ...node, verification: { status: 'passed', evidence } } : node))
  return { ...run, nodes }
}

function allDone(specs: Spec[], name?: string, goal?: string): Run {
  return play(runOf(specs, name, goal), Object.fromEntries(specs.map(spec => [spec.id, { state: 'completed' as const }])))
}

const SMALL: Spec[] = [{ id: 'a', writes: ['src/a.ts'] }, { id: 'b', dependsOn: ['a'], writes: ['src/b.ts', 'src/a.ts'] }]

test('drawsResult is true once a node has started', () => {
  expect(drawsResult(markRunning(runOf(SMALL), 'a', 'agent-a', 1_000))).toBe(true)
  expect(drawsResult(allDone(SMALL))).toBe(true)
})

test('drawsResult is true for a node that only has an attempt on record', () => {
  const run = runOf(SMALL)
  expect(drawsResult({ ...run, nodes: run.nodes.map((node, index) => (index === 0 ? { ...node, attempt: 1 } : node)) })).toBe(true)
})

test('drawsResult is false for a run whose nodes never started', () => {
  expect(drawsResult(runOf(SMALL))).toBe(false)
})

test('drawsResult is false for a rejected run even when a node started', () => {
  const run = markRunning(runOf(SMALL), 'a', 'agent-a', 1_000)
  expect(drawsResult({ ...run, rejected: { at: 2_000, reason: 'no' } })).toBe(false)
})

test('resultTitle puts the run name after Result: in English and 결과: in Korean', () => {
  const run = runOf(SMALL, 'Ship it')
  expect(resultTitle(run, 'en')).toBe('Result: Ship it')
  expect(resultTitle(run, 'ko')).toBe('결과: Ship it')
})

test('resultTitle is cut to the 80 characters a board title may hold', () => {
  const title = resultTitle(runOf(SMALL, 'n'.repeat(120)), 'en')
  expect(title).toHaveLength(80)
  expect(title.startsWith('Result: nnn')).toBe(true)
  expect(newBoard({ boardId: 'b', sessionId: 's', title, now: 0 }).ok).toBe(true)
})

function calloutOf(block: BlockInput | undefined) {
  if (block?.type !== 'callout') throw new Error(`expected a callout, got ${block?.type}`)
  return block
}

function tableOf(block: BlockInput | undefined) {
  if (block?.type !== 'table') throw new Error(`expected a table, got ${block?.type}`)
  return block
}

function flowOf(block: BlockInput | undefined) {
  if (block?.type !== 'flow') throw new Error(`expected a flow, got ${block?.type}`)
  return block
}

const SEVEN: Spec[] = Array.from({ length: 7 }, (_, index) => ({ id: `n${index + 1}` }))

// n1 takes 714s and the other six 1s each, so the first start to the last finish is exactly 12 minutes.
const TWELVE_MINUTES: Record<string, Finish> = Object.fromEntries(SEVEN.map((spec, index) => [spec.id, { state: 'completed' as const, took: index === 0 ? 714_000 : 1_000 }]))

test('the summary of a completed run is an info callout with the status, the nodes done and the elapsed time', () => {
  const run = play(runOf(SEVEN, 'Ship it', 'Ship the release'), TWELVE_MINUTES)
  expect(calloutOf(resultFacts(run, 'en').summary)).toEqual({ type: 'callout', tone: 'info', title: 'completed · 7 of 7 nodes done · 12m', text: 'Ship the release' })
  expect(calloutOf(resultFacts(run, 'ko').summary)).toEqual({ type: 'callout', tone: 'info', title: '완료 · 노드 7개 중 7개 완료 · 12분', text: 'Ship the release' })
})

test('the summary of a failed run is a risk callout that counts only the completed nodes as done', () => {
  const run = play(runOf(SMALL), { a: { state: 'completed' }, b: { state: 'failed', took: 2_000 } })
  expect(calloutOf(resultFacts(run, 'en').summary)).toMatchObject({ tone: 'risk', title: 'failed · 1 of 2 nodes done · 3s' })
  expect(calloutOf(resultFacts(run, 'ko').summary)).toMatchObject({ tone: 'risk', title: '실패 · 노드 2개 중 1개 완료 · 3초' })
})

test('the summary of a run that is neither completed nor failed is a warning callout', () => {
  const run = { ...allDone(SMALL), status: 'cancelled' as const }
  expect(calloutOf(resultFacts(run, 'en').summary)).toMatchObject({ tone: 'warning', title: 'cancelled · 2 of 2 nodes done · 2s' })
  expect(calloutOf(resultFacts(run, 'ko').summary)).toMatchObject({ tone: 'warning', title: '취소 · 노드 2개 중 2개 완료 · 2초' })
})

test('the headline says node for a one-node run and leaves the time out when no node ran', () => {
  expect(calloutOf(resultFacts(allDone([{ id: 'a' }]), 'en').summary).title).toBe('completed · 1 of 1 node done · 1s')
  expect(calloutOf(resultFacts(runOf(SMALL), 'en').summary).title).toBe('running · 0 of 2 nodes done')
  expect(calloutOf(resultFacts(runOf(SMALL), 'ko').summary).title).toBe('실행 중 · 노드 2개 중 0개 완료')
})

test('the elapsed time reads in seconds, minutes, and hours with minutes, in both languages', () => {
  const lasting = (took: number) => play(runOf([{ id: 'a' }]), { a: { state: 'completed', took } })
  const headline = (took: number, language: 'en' | 'ko') => calloutOf(resultFacts(lasting(took), language).summary).title
  expect(headline(45_000, 'en')).toBe('completed · 1 of 1 node done · 45s')
  expect(headline(3_900_000, 'en')).toBe('completed · 1 of 1 node done · 1h 05m')
  expect(headline(45_000, 'ko')).toBe('완료 · 노드 1개 중 1개 완료 · 45초')
  expect(headline(3_900_000, 'ko')).toBe('완료 · 노드 1개 중 1개 완료 · 1시간 05분')
})

test('the summary text is the goal, else the run name, and stays within the 1000 characters a callout holds', () => {
  expect(calloutOf(resultFacts(allDone(SMALL, 'Ship it'), 'en').summary).text).toBe('Ship it')
  const long = calloutOf(resultFacts(allDone(SMALL, 'Ship it', 'g'.repeat(1_500)), 'en').summary).text
  expect(long).toHaveLength(1_000)
  expect(long.endsWith('…')).toBe(true)
})

// a passes two of three checks in 61s on a haiku model, b fails after 2s with nothing recorded, and c is skipped without ever starting.
function mixedRun(): Run {
  const played = play(runOf([{ id: 'a' }, { id: 'b', dependsOn: ['a'] }, { id: 'c', dependsOn: ['b'] }]), {
    a: { state: 'completed', model: 'claude-haiku-4-5', took: 61_000 },
    b: { state: 'failed', model: 'opus', took: 2_000 },
  })
  return withChecks(played, 'a', ['passed', 'failed', 'passed'])
}

test('the nodes table lists id, state, passed checks, model and time per node in English', () => {
  expect(tableOf(resultFacts(mixedRun(), 'en').nodes)).toEqual({
    type: 'table',
    title: 'Nodes',
    columns: ['Node', 'State', 'Checks', 'Model', 'Time'],
    rows: [
      ['a', 'completed', '2/3', 'haiku-4-5', '1m 01s'],
      ['b', 'failed', '-', 'opus', '2s'],
      ['c', 'skipped', '-', '-', '-'],
    ],
  })
})

test('the nodes table speaks Korean with the same cells', () => {
  expect(tableOf(resultFacts(mixedRun(), 'ko').nodes)).toEqual({
    type: 'table',
    title: '노드',
    columns: ['노드', '상태', '검사', '모델', '시간'],
    rows: [
      ['a', '완료', '2/3', 'haiku-4-5', '1m 01s'],
      ['b', '실패', '-', 'opus', '2s'],
      ['c', '건너뜀', '-', '-', '-'],
    ],
  })
})

test('a node whose check evidence is empty shows no checks', () => {
  const run = withChecks(allDone([{ id: 'a' }]), 'a', [])
  expect(tableOf(resultFacts(run, 'en').nodes).rows[0]?.[2]).toBe('-')
})

const manyNodes = (count: number): Spec[] => Array.from({ length: count }, (_, index) => ({ id: `n${index + 1}` }))

test('a nodes table of exactly 30 nodes keeps every row', () => {
  const rows = tableOf(resultFacts(allDone(manyNodes(30)), 'en').nodes).rows
  expect(rows).toHaveLength(30)
  expect(rows[29]?.[0]).toBe('n30')
})

test('past 30 nodes the table keeps 29 rows and a last row that counts the rest, in both languages', () => {
  const run = allDone(manyNodes(40))
  const en = tableOf(resultFacts(run, 'en').nodes).rows
  expect(en).toHaveLength(30)
  expect(en[28]?.[0]).toBe('n29')
  expect(en[29]).toEqual(['… 11 more nodes', '', '', '', ''])
  const ko = tableOf(resultFacts(run, 'ko').nodes).rows
  expect(ko[29]).toEqual(['… 노드 11개 더', '', '', '', ''])
})

// The edges of a flow as "label -> label", so a test names nodes the way the pane shows them.
function edgesByLabel(flow: ReturnType<typeof flowOf>): string[] {
  const label = (id: string) => flow.nodes.find(node => node.id === id)?.label ?? `?${id}`
  return flow.edges.map(edge => `${label(edge.from)} -> ${label(edge.to)}`)
}

test('the run graph draws a node per run node with its state and checks, and an edge per dependency', () => {
  const flow = flowOf(resultFacts(mixedRun(), 'en').graph)
  expect(flow.title).toBe('Run graph')
  expect(flow.nodes.map(({ label, kind, note }) => ({ label, kind, note }))).toEqual([
    { label: 'a', kind: 'terminal', note: 'completed · 2/3 checks' },
    { label: 'b', kind: 'decision', note: 'failed' },
    { label: 'c', kind: 'process', note: 'skipped' },
  ])
  expect(edgesByLabel(flow)).toEqual(['a -> b', 'b -> c'])
})

test('the run graph speaks Korean', () => {
  const flow = flowOf(resultFacts(mixedRun(), 'ko').graph)
  expect(flow.title).toBe('실행 그래프')
  expect(flow.nodes.map(node => node.note)).toEqual(['완료 · 검사 2/3', '실패', '건너뜀'])
})

test('a node id the board would refuse as a flow id still gets a unique valid flow id and a label cut to 40', () => {
  const long = 'x'.repeat(50)
  const run = allDone([{ id: long }, { id: 'b', dependsOn: [long] }, { id: 'c', dependsOn: [long, 'b'] }])
  const flow = flowOf(resultFacts(run, 'en').graph)
  const ids = flow.nodes.map(node => node.id)
  expect(new Set(ids).size).toBe(3)
  expect(ids.every(id => /^[A-Za-z0-9_.-]{1,32}$/.test(id))).toBe(true)
  expect(flow.nodes[0]?.label).toBe(`${'x'.repeat(39)}…`)
  expect(edgesByLabel(flow)).toEqual([`${'x'.repeat(39)}… -> b`, `${'x'.repeat(39)}… -> c`, 'b -> c'])
})

test('a run of 24 nodes has a run graph and a run of 25 has none', () => {
  const chain = (count: number): Spec[] => Array.from({ length: count }, (_, index) => (index === 0 ? { id: 'n1' } : { id: `n${index + 1}`, dependsOn: [`n${index}`] }))
  expect(resultFacts(allDone(chain(24)), 'en').graph).not.toBeUndefined()
  expect(resultFacts(allDone(chain(25)), 'en').graph).toBeUndefined()
})

test('a run with more than 48 dependencies has no run graph', () => {
  const dense: Spec[] = Array.from({ length: 12 }, (_, index) => ({ id: `n${index + 1}`, dependsOn: Array.from({ length: index }, (_, before) => `n${before + 1}`) }))
  expect(resultFacts(allDone(dense), 'en').graph).toBeUndefined()
  expect(resultFacts(allDone(dense.slice(0, 10)), 'en').graph).not.toBeUndefined()
})

test('the writes table lists each declared path of the completed nodes once with the nodes that declared it, sorted by path', () => {
  const run = allDone([{ id: 'a', writes: ['src/b.ts'] }, { id: 'b', writes: ['src/a.ts', 'src/b.ts'] }])
  expect(tableOf(resultFacts(run, 'en').writes)).toEqual({
    type: 'table',
    title: 'Declared writes',
    columns: ['Path', 'Node'],
    rows: [['src/a.ts', 'b'], ['src/b.ts', 'a, b']],
  })
  expect(tableOf(resultFacts(run, 'ko').writes)).toMatchObject({ title: '선언된 쓰기 범위', columns: ['경로', '노드'] })
})

test('the writes table leaves out the paths of nodes that did not complete', () => {
  const run = play(runOf([{ id: 'a', writes: ['src/a.ts'] }, { id: 'b', writes: ['src/b.ts'] }]), { a: { state: 'completed' }, b: { state: 'failed' } })
  expect(tableOf(resultFacts(run, 'en').writes).rows).toEqual([['src/a.ts', 'a']])
})

test('a run without declared writes of completed nodes has no writes table', () => {
  expect(resultFacts(allDone([{ id: 'a' }]), 'en').writes).toBeUndefined()
  const failed = play(runOf([{ id: 'a', writes: ['src/a.ts'] }]), { a: { state: 'failed' } })
  expect(resultFacts(failed, 'en').writes).toBeUndefined()
})

test('past 30 paths the writes table keeps 29 rows sorted by path and a last row that counts the rest', () => {
  const specs: Spec[] = Array.from({ length: 31 }, (_, index) => ({ id: `n${index + 1}`, writes: [`f${index + 1}.ts`] }))
  const en = tableOf(resultFacts(allDone(specs), 'en').writes).rows
  expect(en).toHaveLength(30)
  expect(en.slice(0, 3).map(row => row[0])).toEqual(['f1.ts', 'f10.ts', 'f11.ts'])
  expect(en[29]).toEqual(['… 2 more paths', ''])
  expect(tableOf(resultFacts(allDone(specs), 'ko').writes).rows[29]).toEqual(['… 경로 2개 더', ''])
})

test('a table cell over 80 characters is cut, so a long node list does not make the board refuse the table', () => {
  const ids = ['a', 'b', 'c'].map(letter => letter.repeat(40))
  const run = allDone(ids.map(id => ({ id, writes: ['shared.ts'] })))
  const cell = tableOf(resultFacts(run, 'en').writes).rows[0]?.[1] ?? ''
  expect(cell).toHaveLength(80)
  expect(cell.startsWith(`${'a'.repeat(40)}, bbb`)).toBe(true)
  expect(cell.endsWith('…')).toBe(true)
})

// A decision record of the run 'dag_result' that runOf builds; a test overrides only what it is about.
function decision(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: 'd1',
    at: 1_000,
    sessionId: 's1',
    kind: 'routing',
    subject: 'Ship it',
    proposed: 'dag',
    selected: 'dag',
    source: 'jev',
    outcome: 'applied',
    ruleset: 'test-ruleset',
    threshold: 0.8,
    latencyMs: 12,
    stateHash: 'h1',
    runId: 'dag_result',
    ...overrides,
  }
}

test('the decisions table lists the run records oldest first and leaves out the records of another run', () => {
  const records = [
    decision({ id: 'd2', at: 3_000, kind: 'recovery', subject: 'node b failed', selected: 'retry', outcome: 'low-confidence' }),
    decision({ id: 'd3', at: 2_000, kind: 'routing', subject: 'other run prompt', selected: 'direct', runId: 'dag_other' }),
    decision({ id: 'd1', at: 1_000, kind: 'routing', subject: 'Ship it', selected: 'dag', outcome: 'applied' }),
  ]
  expect(tableOf(resultFacts(allDone(SMALL), 'en', records).decisions)).toEqual({
    type: 'table',
    title: 'Decisions',
    columns: ['Kind', 'Subject', 'Picked', 'Outcome'],
    rows: [
      ['routing', 'Ship it', 'dag', 'applied'],
      ['recovery', 'node b failed', 'retry', 'low-confidence'],
    ],
  })
})

test('the decisions table speaks Korean in its title and columns and keeps the same cells', () => {
  const records = [decision({ kind: 'recovery', subject: 'node b failed', selected: 'retry', outcome: 'ask' })]
  expect(tableOf(resultFacts(allDone(SMALL), 'ko', records).decisions)).toEqual({
    type: 'table',
    title: '결정',
    columns: ['종류', '대상', '선택', '결과'],
    rows: [['recovery', 'node b failed', 'retry', 'ask']],
  })
})

test('a run with no decision records of its own has no decisions table', () => {
  const run = allDone(SMALL)
  expect(resultFacts(run, 'en').decisions).toBeUndefined()
  expect(resultFacts(run, 'en', []).decisions).toBeUndefined()
  expect(resultFacts(run, 'en', [decision({ runId: 'dag_other' })]).decisions).toBeUndefined()
  expect(resultFacts(run, 'en', [decision({ runId: undefined })]).decisions).toBeUndefined()
})

const manyDecisions = (count: number): DecisionRecord[] => Array.from({ length: count }, (_, index) => decision({ id: `d${index + 1}`, at: index, subject: `subject ${index + 1}` }))

test('a decisions table of exactly 30 records keeps every row', () => {
  const rows = tableOf(resultFacts(allDone(SMALL), 'en', manyDecisions(30)).decisions).rows
  expect(rows).toHaveLength(30)
  expect(rows[29]?.[1]).toBe('subject 30')
})

test('past 30 records the decisions table keeps 29 rows and a last row that counts the rest, in both languages', () => {
  const run = allDone(SMALL)
  const en = tableOf(resultFacts(run, 'en', manyDecisions(40)).decisions).rows
  expect(en).toHaveLength(30)
  expect(en[28]?.[1]).toBe('subject 29')
  expect(en[29]).toEqual(['… 11 more decisions', '', '', ''])
  expect(tableOf(resultFacts(run, 'ko', manyDecisions(40)).decisions).rows[29]).toEqual(['… 결정 11개 더', '', '', ''])
})

test('a decision subject or choice over 80 characters is cut so the board accepts the table', () => {
  const records = [decision({ subject: 's'.repeat(120), selected: 'c'.repeat(120) })]
  const row = tableOf(resultFacts(allDone(SMALL), 'en', records).decisions).rows[0] ?? []
  expect(row[1]).toBe(`${'s'.repeat(79)}…`)
  expect(row[2]).toBe(`${'c'.repeat(79)}…`)
})

const FIVE_IDS = { summary: 'b1', nodes: 'b2', graph: 'b3', writes: 'b4', decisions: 'b5' }
const FIVE_BLOCKS = ['b1', 'b2', 'b3', 'b4', 'b5']

test('the first draw inserts the five blocks in slot order, each at the end of the board', () => {
  const facts = resultFacts(allDone(SMALL), 'en', [decision()])
  const { edits, insertedSlots } = factEdits(facts, {}, [])
  expect(RESULT_SLOTS).toEqual(['summary', 'nodes', 'graph', 'writes', 'decisions'])
  expect(insertedSlots).toEqual(['summary', 'nodes', 'graph', 'writes', 'decisions'])
  expect(edits).toEqual([
    { op: 'insert', block: facts.summary },
    { op: 'insert', block: facts.nodes },
    { op: 'insert', block: facts.graph },
    { op: 'insert', block: facts.writes },
    { op: 'insert', block: facts.decisions },
  ])
})

test('the first draw of a run with no decision records inserts only the four other blocks', () => {
  const { insertedSlots } = factEdits(resultFacts(allDone(SMALL), 'en'), {}, [])
  expect(insertedSlots).toEqual(['summary', 'nodes', 'graph', 'writes'])
})

test('a refresh replaces each block under the id it already has and inserts nothing', () => {
  const facts = resultFacts(allDone(SMALL), 'en', [decision()])
  const { edits, insertedSlots } = factEdits(facts, FIVE_IDS, FIVE_BLOCKS)
  expect(insertedSlots).toEqual([])
  expect(edits).toEqual([
    { op: 'replace', id: 'b1', block: facts.summary },
    { op: 'replace', id: 'b2', block: facts.nodes },
    { op: 'replace', id: 'b3', block: facts.graph },
    { op: 'replace', id: 'b4', block: facts.writes },
    { op: 'replace', id: 'b5', block: facts.decisions },
  ])
})

test('a slot that has no block any more removes the block it held', () => {
  const facts: ResultFacts = { ...resultFacts(allDone(SMALL), 'en'), graph: undefined, writes: undefined, decisions: undefined }
  const { edits, insertedSlots } = factEdits(facts, FIVE_IDS, FIVE_BLOCKS)
  expect(insertedSlots).toEqual([])
  expect(edits.map(edit => [edit.op, 'id' in edit ? edit.id : undefined])).toEqual([['replace', 'b1'], ['replace', 'b2'], ['remove', 'b3'], ['remove', 'b4'], ['remove', 'b5']])
})

test('a block whose remembered id is gone from the board is inserted again, and a missing block with a gone id needs no edit', () => {
  const facts: ResultFacts = { ...resultFacts(allDone(SMALL), 'en', [decision()]), writes: undefined }
  const { edits, insertedSlots } = factEdits(facts, FIVE_IDS, ['b1', 'b2'])
  expect(insertedSlots).toEqual(['graph', 'decisions'])
  expect(edits.map(edit => edit.op)).toEqual(['replace', 'replace', 'insert', 'insert'])
})

test('a slot with neither a block nor a remembered id is left alone', () => {
  const facts: ResultFacts = { summary: undefined, nodes: undefined, graph: undefined, writes: undefined, decisions: undefined }
  expect(factEdits(facts, {}, ['b1'])).toEqual({ edits: [], insertedSlots: [] })
})

// The ids applyEdits handed out, matched to the slots factEdits said it inserted.
function remembered(slots: ResultSlot[], inserted: string[]): Partial<Record<ResultSlot, string>> {
  const ids: Partial<Record<ResultSlot, string>> = {}
  slots.forEach((slot, index) => {
    const id = inserted[index]
    if (id !== undefined) ids[slot] = id
  })
  return ids
}

function drawn(board: Board, run: Run, previous: Partial<Record<ResultSlot, string>>, records: readonly DecisionRecord[] = []) {
  const { edits, insertedSlots } = factEdits(resultFacts(run, 'en', records), previous, board.blocks.map(block => block.id))
  const applied = applyEdits(board, edits, { now: 2_000, peeks: new Map(), traces: new Map(), diffs: new Map() })
  if (!applied.ok) throw new Error(`${applied.error.code}: ${applied.error.message}`)
  return { board: applied.value.board, ids: { ...previous, ...remembered(insertedSlots, applied.value.inserted) } }
}

const empty = (): Board => {
  const created = newBoard({ boardId: 'board_1', sessionId: 's1', title: 'Result: Ship it', now: 1_000 })
  if (!created.ok) throw new Error(created.error.message)
  return created.value
}

test('the facts of a small completed run draw on a new board, refresh under the same ids and drop a block that is no longer true', () => {
  const first = drawn(empty(), allDone(SMALL), {})
  expect(first.board.blocks.map(block => block.type)).toEqual(['callout', 'table', 'flow', 'table'])
  expect(first.ids).toEqual({ summary: 'b1', nodes: 'b2', graph: 'b3', writes: 'b4' })

  const again = drawn(first.board, allDone(SMALL), first.ids)
  expect(again.board.blocks.map(block => block.id)).toEqual(['b1', 'b2', 'b3', 'b4'])
  expect(again.board.nextId).toBe(first.board.nextId)

  const withoutWrites = drawn(again.board, allDone([{ id: 'a' }, { id: 'b', dependsOn: ['a'] }]), again.ids)
  expect(withoutWrites.board.blocks.map(block => block.id)).toEqual(['b1', 'b2', 'b3'])
})

test('a decisions table draws at settle on the board, is replaced under its id when the run settles again, and is dropped when its records are gone', () => {
  const run = allDone(SMALL)
  const first = drawn(empty(), run, {}, [decision()])
  expect(first.board.blocks.map(block => block.type)).toEqual(['callout', 'table', 'flow', 'table', 'table'])
  expect(first.ids).toEqual(FIVE_IDS)

  const again = drawn(first.board, run, first.ids, [decision(), decision({ id: 'd2', at: 2_000, kind: 'recovery', subject: 'node b failed', selected: 'retry' })])
  expect(again.board.blocks.map(block => block.id)).toEqual(FIVE_BLOCKS)
  expect(again.board.nextId).toBe(first.board.nextId)
  const decisions = again.board.blocks[4]
  expect(decisions?.type === 'table' ? decisions.rows.map(row => row[0]) : []).toEqual(['routing', 'recovery'])

  const withoutRecords = drawn(again.board, run, again.ids)
  expect(withoutRecords.board.blocks.map(block => block.id)).toEqual(['b1', 'b2', 'b3', 'b4'])
})

// 40 nodes in a chain: ids up to 64 characters, write paths past the 80-character cell limit, and the last node fails.
function failedFortyNodes(): Run {
  const ids = Array.from({ length: 40 }, (_, index) => (index % 5 === 0 ? `${'long'.repeat(15)}-${index}` : `n${index + 1}`))
  const specs: Spec[] = ids.map((id, index) => ({ id, ...(index > 0 ? { dependsOn: [ids[index - 1] ?? ''] } : {}), writes: [`${'dir/'.repeat(18)}file${index}.ts`] }))
  return play(runOf(specs, 'Forty nodes', 'Forty nodes in a chain'), Object.fromEntries(ids.map((id, index) => [id, { state: index === 39 ? ('failed' as const) : ('completed' as const), model: 'claude-sonnet-5-5' }])))
}

test('the facts of a 40-node failed run pass the board engine: tables cut to 30 rows, cells to 80, and no run graph', () => {
  const run = failedFortyNodes()
  const first = drawn(empty(), run, {})
  expect(first.board.blocks.map(block => block.type)).toEqual(['callout', 'table', 'table'])
  expect(first.ids).toEqual({ summary: 'b1', nodes: 'b2', writes: 'b3' })
  const nodes = first.board.blocks[1]
  expect(nodes?.type === 'table' ? nodes.rows : []).toHaveLength(30)

  const again = drawn(first.board, run, first.ids)
  expect(again.board.blocks.map(block => block.id)).toEqual(['b1', 'b2', 'b3'])
})

test('a decisions table of 40 records with 120-character cells passes the board engine cut to 30 rows', () => {
  const records = manyDecisions(40).map(record => ({ ...record, subject: 's'.repeat(120), selected: 'c'.repeat(120) }))
  const first = drawn(empty(), allDone(SMALL), {}, records)
  const decisions = first.board.blocks[4]
  expect(decisions?.type === 'table' ? decisions.rows : []).toHaveLength(30)
})
