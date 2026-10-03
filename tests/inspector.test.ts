import { expect, test } from 'claude-code/testing'
import { addNote, emptyContext, recordRequest } from '../hooks/engine/context.ts'
import type { DecisionRecord } from '../hooks/engine/decisions.ts'
import type { SessionRecord } from '../hooks/engine/sessions.ts'
import type { Run } from '../hooks/engine/types.ts'
import type { Language } from '../hooks/ui/i18n.ts'
import { buildInspector, INSPECTOR_VIEWS, PAGE_SIZE, type InspectorInput, type InspectorModel } from '../hooks/ui/inspector-model.ts'
import { width, type Line } from '../hooks/ui/text.ts'

const root = '/project'
const now = 100_000
const LANGUAGES: readonly Language[] = ['en', 'ko']
const text = (line: Line) => line.map(segment => segment.text).join('')
const ids = (model: InspectorModel) => model.actions.map(action => action.id)
const flat = (model: InspectorModel) => model.lines.map(text).join('\n')
const squashed = (model: InspectorModel) => model.lines.map(text).join('').replace(/\s/g, '')
const lineWidth = (line: Line) => line.reduce((cells, segment) => cells + width(segment.text), 0)
const isHeading = (line: Line) => line[0]?.color === 'cyan' && line[0]?.bold === true
const section = (model: InspectorModel, index: number) => {
  const starts = model.lines.flatMap((line, i) => isHeading(line) ? [i] : [])
  return model.lines.slice((starts[index] ?? model.lines.length) + 1, starts[index + 1] ?? model.lines.length).filter(line => line.length > 0)
}

function input(overrides: Partial<InspectorInput> = {}): InspectorInput {
  return {
    view: 'decisions', columns: 80, language: 'en', decisions: [], context: emptyContext(root, 'me', 0),
    contextPath: '/project/.claude/dag/context.json', runs: [], sessions: [], projectRoot: root,
    sessionId: 'me', now, page: 0, ...overrides,
  }
}

function decision(n: number, overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: `d${n}`, at: 1_000 + n, sessionId: 'me', kind: 'routing', subject: `node-${n}`,
    proposed: 'quick', selected: 'deep-low', source: 'jev', outcome: 'applied',
    ruleset: 'dag-policy-2026-10-02-v1', threshold: 0.9, latencyMs: 412, stateHash: 'h'.repeat(64),
    confidence: 0.97, probabilities: { 'deep-low': 0.97, quick: 0.03 }, runId: 'r1', nodeId: 'a', ...overrides,
  }
}

function session(sessionId: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return { schemaVersion: 1, sessionId, projectRoot: root, updatedAt: now, status: 'active', runIds: ['r1'], writes: [], ...overrides }
}

function run(runId: string, sessionId: string, overrides: Partial<Run> = {}): Run {
  return {
    schemaVersion: 1, runId, key: runId, name: `Run ${runId}`, sessionId, status: 'running',
    createdAt: 1, updatedAt: 2, definitionHash: 'hash',
    definition: {
      key: runId, name: runId, goal: 'objective',
      nodes: [
        { id: 'a', prompt: 'A', dependsOn: [], writes: ['src/a.ts'], verify: [{ kind: 'command', argv: ['bun', 'test'] }] },
        { id: 'b', prompt: 'B', dependsOn: ['a'] },
        { id: 'c', prompt: 'C', dependsOn: [] },
      ],
    },
    nodes: [
      {
        id: 'a', label: 'A', state: 'completed', attempt: 1, fingerprint: 'fa', reportPath: '/reports/a.md',
        verification: { status: 'passed', evidence: [{ check: { kind: 'command', argv: ['bun', 'test'] }, passed: true, checkedAt: now - 3_000, exitCode: 0, detail: 'ok' }] },
      },
      { id: 'b', label: 'B', state: 'completed', attempt: 1, fingerprint: 'fb', output: 'ALL VERIFIED' },
      {
        id: 'c', label: 'C', state: 'failed', attempt: 2, fingerprint: 'fc', error: 'boom',
        verification: { status: 'failed', evidence: [{ check: { kind: 'file', path: 'src/c.ts' }, passed: false, checkedAt: now - 1_000, detail: 'missing' }] },
        recovery: { used: 1, kind: 'implementation', reason: 'fix', history: [{ at: 2, kind: 'implementation', reason: 'fix', attempt: 1 }] },
      },
    ],
    ...overrides,
  }
}

test('decisions paginate eight rows newest first with finite page actions', () => {
  const decisions = Array.from({ length: 20 }, (_, i) => decision(i + 1))
  const first = buildInspector(input({ decisions }))
  expect(ids(first)).toEqual([...Array.from({ length: PAGE_SIZE }, (_, i) => `decision:d${20 - i}`), 'page:next'])
  expect(text(first.lines[0] ?? []).startsWith('1 ')).toBe(true)
  expect(ids(buildInspector(input({ decisions, page: 1 })))).toEqual([...Array.from({ length: PAGE_SIZE }, (_, i) => `decision:d${12 - i}`), 'page:prev', 'page:next'])
  const last = buildInspector(input({ decisions, page: 2 }))
  expect(ids(last)).toEqual(['decision:d4', 'decision:d3', 'decision:d2', 'decision:d1', 'page:prev'])
  expect(ids(buildInspector(input({ decisions, page: 99 })))).toEqual(ids(last))
  expect(ids(buildInspector(input({ decisions, page: -5 })))).toEqual(ids(first))
  expect(ids(buildInspector(input({ decisions, page: Number.NaN })))).toEqual(ids(first))
  expect(first.title.includes('20')).toBe(true)
})

test('decision detail exposes the recorded fields and only a back action', () => {
  const { confidence, probabilities, ...rest } = decision(2)
  const baseline: DecisionRecord = { ...rest, source: 'baseline', outcome: 'ask', proposed: 'quick', selected: 'quick' }
  const decisions = [decision(1), baseline, decision(3)]
  const detail = buildInspector(input({ decisions, selectedDecisionId: 'd3', page: 7 }))
  expect(ids(detail)).toEqual(['decision:back'])
  expect(detail.title.includes('d3')).toBe(true)
  const body = flat(detail)
  for (const value of ['quick', 'deep-low', '0.97', '0.90', 'dag-policy-2026-10-02-v1', '412ms', 'r1 · a', '0.03']) expect(body.includes(value)).toBe(true)
  expect(squashed(detail).includes('h'.repeat(64))).toBe(true)
  expect(detail.lines.filter(line => line.some(segment => segment.text === 'deep-low' && segment.color === 'cyan' && segment.bold === true)).length).toBe(2)
  const narrow = buildInspector(input({ decisions, selectedDecisionId: 'd3', columns: 28 }))
  expect(squashed(narrow).includes('h'.repeat(64))).toBe(true)
  const plain = flat(buildInspector(input({ decisions, selectedDecisionId: 'd2' })))
  expect(plain.includes('undefined') || plain.includes('NaN')).toBe(false)
  expect(typeof confidence).toBe('number')
  expect(probabilities !== undefined).toBe(true)
  const missing = buildInspector(input({ decisions, selectedDecisionId: 'gone' }))
  expect(ids(missing)).toEqual(['decision:back', 'decision:d3', 'decision:d2', 'decision:d1'])
})

test('decision rows distinguish outcomes by icon and color and hide other sessions', () => {
  const decisions = [
    decision(1, { outcome: 'applied' }),
    decision(2, { outcome: 'ask' }),
    decision(3, { outcome: 'low-confidence' }),
    decision(4, { outcome: 'timeout' }),
    decision(5, { sessionId: 'other', subject: 'foreign-subject' }),
  ]
  const model = buildInspector(input({ decisions }))
  expect(ids(model)).toEqual(['decision:d4', 'decision:d3', 'decision:d2', 'decision:d1'])
  const rows = model.lines.filter(line => /^\d /.test(text(line)))
  expect(rows.map(row => row[1]?.color)).toEqual(['red', 'yellow', 'yellow', 'green'])
  expect(rows.map(row => row[1]?.text)).toEqual(['× ', '◌ ', '? ', '✓ '])
  expect(flat(model).includes('foreign-subject')).toBe(false)
  expect(model.title.includes('(4)')).toBe(true)
})

test('context shows the objective, paginated note indexes and the owned run scope', () => {
  let record = recordRequest(emptyContext(root, 'me', 0), { at: 5, text: 'Ship the inspector' })
  for (let i = 0; i < 10; i++) record = addNote(record, { at: 10 + i, text: `note-${i}` })
  const runs = [run('r1', 'me'), run('r2', 'other', { name: 'Foreign run' })]
  const first = buildInspector(input({ view: 'context', context: record, runs }))
  expect(ids(first)).toEqual(['page:next'])
  const body = flat(first)
  expect(body.includes('Ship the inspector')).toBe(true)
  for (let i = 0; i < PAGE_SIZE; i++) expect(body.includes(`#${i + 1} note-${i}`)).toBe(true)
  expect(body.includes('#9 ')).toBe(false)
  const second = buildInspector(input({ view: 'context', context: record, runs, page: 1 }))
  expect(ids(second)).toEqual(['page:prev'])
  expect(flat(second).includes('#10 note-9')).toBe(true)
  expect(body.includes('Foreign run')).toBe(false)
  expect(body.includes('ALL VERIFIED')).toBe(false)
  expect(body.includes('1/2')).toBe(true)
  expect(body.includes('bun test')).toBe(true)
  expect(body.includes('/project/.claude/dag/context.json')).toBe(true)
  expect(body.includes('/project/.claude/dag/runs/r1.json')).toBe(true)
  expect(body.includes('/reports/a.md')).toBe(true)
  const scope = section(first, 2)
  const nodeLine = (id: string) => scope.find(line => line.some(segment => segment.text === id && segment.bold === true)) ?? []
  const colors = (line: Line) => line.flatMap(segment => segment.color ? [segment.color] : [])
  expect(colors(nodeLine('a')).every(color => color === 'green')).toBe(true)
  expect(colors(nodeLine('b')).includes('yellow')).toBe(true)
  expect(colors(nodeLine('c')).includes('red')).toBe(true)
  expect(section(first, 3).length).toBe(2)
  const foreignSelection = buildInspector(input({ view: 'context', context: record, runs, selectedRunId: 'r2' }))
  expect(flat(foreignSelection).includes('/project/.claude/dag/runs/r1.json')).toBe(true)
  expect(flat(foreignSelection).includes('runs/r2.json')).toBe(false)
})

test('a foreign run names its shortened session id without a trailing period', () => {
  const owner = 'e8125de0-1111-2222-3333-444444444444'
  const model = buildInspector(input({ view: 'context', runs: [run('r2', owner)], selectedRunId: 'r2' }))
  const line = model.lines.map(text).find(value => value.includes('belongs to session'))
  expect(line).toBeDefined()
  expect(line?.includes('…')).toBe(true)
  expect(line?.trimEnd().endsWith('…')).toBe(true)
})

test('context never shows another identity record', () => {
  const foreign = recordRequest(emptyContext(root, 'other', 0), { at: 5, text: 'secret objective' })
  const otherProject = recordRequest(emptyContext('/elsewhere', 'me', 0), { at: 5, text: 'secret objective' })
  for (const record of [foreign, otherProject]) {
    const model = buildInspector(input({ view: 'context', context: record }))
    expect(flat(model).includes('secret objective')).toBe(false)
    expect(model.lines.some(line => line.some(segment => segment.color === 'yellow'))).toBe(true)
  }
})

test('empty states render lines without actions in both languages', () => {
  for (const language of LANGUAGES) {
    for (const view of INSPECTOR_VIEWS) {
      const model = buildInspector(input({ view, language }))
      expect(model.lines.length > 0).toBe(true)
      expect(model.actions).toEqual([])
      expect(model.title.length > 0).toBe(true)
    }
  }
  expect(buildInspector(input({ columns: 0 }))).toEqual({ title: '', lines: [], actions: [] })
})

test('sessions offer handoff only to fresh same-project peers for an owned run without a pending handoff', () => {
  const sessions = [
    session('me'), session('peer'), session('stale', { updatedAt: now - 60_001 }),
    session('closed', { status: 'closed' }), session('foreign', { projectRoot: '/elsewhere' }),
    session('future', { updatedAt: now + 1 }),
  ]
  const owned = run('r1', 'me')
  const base = input({ view: 'sessions', sessions, runs: [owned], selectedRunId: 'r1' })
  const model = buildInspector(base)
  expect(ids(model)).toEqual(['handoff:peer'])
  expect(model.title.includes('(5)')).toBe(true)
  expect(flat(model).includes('foreign')).toBe(false)
  const pending = run('r1', 'me', { handoff: { from: 'me', to: 'peer', requestedAt: now - 10, offeredAt: now - 5 } })
  expect(ids(buildInspector({ ...base, runs: [pending] }))).toEqual(['handoff-cancel:r1'])
  const draining = run('r1', 'me', { handoff: { from: 'me', to: 'peer', requestedAt: now - 10 } })
  expect(ids(buildInspector({ ...base, runs: [draining] }))).toEqual(['handoff-cancel:r1'])
  const { selectedRunId, ...unselected } = base
  expect(selectedRunId).toBe('r1')
  expect(ids(buildInspector(unselected))).toEqual([])
  expect(ids(buildInspector({ ...base, runs: [run('r1', 'other')] }))).toEqual([])
  expect(ids(buildInspector({ ...base, sessions: [session('me')] }))).toEqual([])
  const other = run('r2', 'me', { handoff: { from: 'me', to: 'peer', requestedAt: now - 10, offeredAt: now - 5 } })
  expect(ids(buildInspector({ ...base, runs: [owned, other] }))).toEqual(['handoff:peer', 'handoff-cancel:r2'])
})

test('incoming handoffs expose accept only when addressed here and offered', () => {
  const runs = [
    run('in1', 'peer', { handoff: { from: 'peer', to: 'me', requestedAt: now - 10, offeredAt: now - 5 } }),
    run('in2', 'peer', { handoff: { from: 'peer', to: 'me', requestedAt: now - 10 } }),
    run('in3', 'peer', { handoff: { from: 'peer', to: 'someone', requestedAt: now - 10, offeredAt: now - 5 } }),
  ]
  const model = buildInspector(input({ view: 'sessions', sessions: [session('me'), session('peer')], runs }))
  expect(ids(model)).toEqual(['accept:in1'])
  expect(flat(model).includes('Run in3')).toBe(false)
  const selectedIncoming = buildInspector(input({ view: 'sessions', sessions: [session('me'), session('peer')], runs, selectedRunId: 'in1' }))
  expect(ids(selectedIncoming)).toEqual(['accept:in1'])
})

test('sessions paginate eight rows with this session first and bound handoff targets to the page', () => {
  const peers = Array.from({ length: 20 }, (_, i) => session(`s${String(i + 1).padStart(2, '0')}`))
  const base = input({ view: 'sessions', sessions: [...peers, session('me')], runs: [run('r1', 'me')], selectedRunId: 'r1' })
  const first = buildInspector(base)
  expect(ids(first)).toEqual(['page:next', ...Array.from({ length: 7 }, (_, i) => `handoff:s${String(i + 1).padStart(2, '0')}`)])
  expect(text(first.lines.find(line => /^1 /.test(text(line))) ?? []).includes('me')).toBe(true)
  expect(ids(buildInspector({ ...base, page: 1 }))).toEqual(['page:prev', 'page:next', ...Array.from({ length: 8 }, (_, i) => `handoff:s${String(i + 8).padStart(2, '0')}`)])
  expect(ids(buildInspector({ ...base, page: 2 }))).toEqual(['page:prev', ...Array.from({ length: 5 }, (_, i) => `handoff:s${String(i + 16).padStart(2, '0')}`)])
  expect(ids(buildInspector({ ...base, page: 50 }))).toEqual(ids(buildInspector({ ...base, page: 2 })))
})

test('session ids stay fully readable at narrow widths and conflicts are flagged', () => {
  const id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
  const sessions = [session('me', { writes: ['src/'] }), session(id, { writes: ['src/file.ts'] })]
  const wide = buildInspector(input({ view: 'sessions', sessions }))
  expect(wide.lines.some(line => text(line).includes(id))).toBe(true)
  expect(flat(wide).includes('⚠')).toBe(true)
  const narrow = buildInspector(input({ view: 'sessions', sessions, columns: 28 }))
  expect(narrow.lines.some(line => text(line).includes(id))).toBe(false)
  expect(squashed(narrow).includes(id)).toBe(true)
  expect(narrow.lines.every(line => lineWidth(line) <= 28)).toBe(true)
  const calm = buildInspector(input({ view: 'sessions', sessions: [session('me', { writes: ['src/a.ts'] }), session(id, { writes: ['src/b.ts'] })] }))
  expect(flat(calm).includes('⚠')).toBe(false)
})

test('every view stays within 28, 48 and 80 columns in both languages with hostile text', () => {
  const hostile = `${'한글'.repeat(40)} \x1b[31mred\x07 ${'x'.repeat(120)}`
  let record = recordRequest(emptyContext(root, 'me', 0), { at: 5, text: `${hostile}\n${hostile}` })
  record = addNote(record, { at: 6, text: `note \u0000 ${hostile}` })
  const decisions = [decision(1, { subject: hostile, proposed: hostile, selected: hostile, ruleset: hostile, stateHash: hostile, probabilities: { [hostile]: 0.5, b: 0.5 } }), decision(2)]
  const sessions = [session('me'), session(`${'세션'.repeat(30)}\x1b`, { writes: [hostile] }), session('peer', { writes: [hostile] })]
  const runs = [run('r1', 'me', { name: hostile, handoff: { from: 'me', to: 'peer', requestedAt: 1, offeredAt: 2 } }), run('in', 'peer', { name: hostile, handoff: { from: 'peer', to: 'me', requestedAt: 1, offeredAt: 2 } })]
  const violations: string[] = []
  for (const language of LANGUAGES) {
    for (const columns of [28, 48, 80]) {
      for (const view of INSPECTOR_VIEWS) {
        for (const selectedDecisionId of [undefined, 'd1']) {
          const model = buildInspector({ ...input({ view, language, columns, decisions, context: record, sessions, runs, selectedRunId: 'r1', contextPath: `/${hostile}/context.json` }), ...(selectedDecisionId === undefined ? {} : { selectedDecisionId }) })
          const label = `${language}/${columns}/${view}/${selectedDecisionId ?? 'list'}`
          if (width(model.title) > columns || /[\x00-\x1f\x7f-\x9f]/.test(model.title)) violations.push(`${label}: title`)
          model.lines.forEach((line, index) => {
            if (lineWidth(line) > columns) violations.push(`${label}: line ${index} width ${lineWidth(line)}`)
            if (line.some(segment => /[\x00-\x1f\x7f-\x9f]/.test(segment.text))) violations.push(`${label}: line ${index} control`)
          })
          for (const action of model.actions) {
            if (width(action.label) > Math.min(32, columns) || /[\x00-\x1f\x7f-\x9f]/.test(action.label)) violations.push(`${label}: action ${action.id}`)
          }
          if (model.lines.length === 0) violations.push(`${label}: empty`)
        }
      }
    }
  }
  expect(violations).toEqual([])
})
