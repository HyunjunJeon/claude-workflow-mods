import { expect, test } from 'claude-code/testing'
import { AUTOCOMPLETE_ROWS, autocompleteRows, autocompleteWant, type AutocompleteInput, type AutocompleteRun } from '../hooks/engine/autocomplete.ts'

// The box as the host reports it at the cursor: the token is the run of non-whitespace characters that ends there.
function typed(text: string, cursor = text.length): AutocompleteInput {
  const start = text.slice(0, cursor).search(/\S*$/)
  return { text, cursor, token: text.slice(start, cursor), start }
}

function run(runId: string, createdAt: number, name = `Run ${runId}`, status: AutocompleteRun['status'] = 'completed'): AutocompleteRun {
  return { runId, name, status, createdAt }
}

const RUNS = [run('dag_a', 100, 'Old fix'), run('dag_b', 300, 'Newest build', 'running'), run('dag_c', 200, 'Middle', 'failed'), run('other_d', 400, 'Not ours')]
const FILES = ['flows/improvement/p1.yaml', 'eval/fixtures/valid-definition.yaml', 'flows/improvement/p0.yaml', 'flows/improvement/notes.md', 'flows/plan.JSON', 'eval/fixtures/old.yml', 'eval/fixtures/data.txt']

test('after /dag status the first argument offers run ids that start with the token, newest first, each with its name and status', () => {
  const rows = autocompleteRows(typed('/dag status dag_'), FILES, RUNS)
  expect(rows).toEqual([
    { text: 'dag_b', description: 'Newest build · running' },
    { text: 'dag_c', description: 'Middle · failed' },
    { text: 'dag_a', description: 'Old fix · completed' },
  ])
})

test('every subcommand that takes a run offers run ids and nothing else', () => {
  for (const verb of ['status', 'cancel', 'retry', 'approve', 'reject', 'handoff', 'accept']) {
    const rows = autocompleteRows(typed(`/dag ${verb} dag_b`), FILES, RUNS)
    expect(rows.map(row => row.text)).toEqual(['dag_b'])
  }
})

test('after /dag run and /dag preview the argument offers definition files whose path starts with the token, sorted', () => {
  for (const verb of ['run', 'preview']) {
    const rows = autocompleteRows(typed(`/dag ${verb} flows/`), FILES, RUNS)
    expect(rows).toEqual([{ text: 'flows/improvement/p0.yaml' }, { text: 'flows/improvement/p1.yaml' }, { text: 'flows/plan.JSON' }])
  }
})

test('a file row takes only .yaml, .yml and .json files, in any letter case', () => {
  const rows = autocompleteRows(typed('/dag run '), FILES, RUNS)
  expect(rows.map(row => row.text)).toEqual(['eval/fixtures/old.yml', 'eval/fixtures/valid-definition.yaml', 'flows/improvement/p0.yaml', 'flows/improvement/p1.yaml', 'flows/plan.JSON'])
})

test('an empty argument offers the first 20 files in sorted order', () => {
  const many = Array.from({ length: 25 }, (_, index) => `flows/f${String(24 - index).padStart(2, '0')}.yaml`)
  const rows = autocompleteRows(typed('/dag run '), many, [])
  expect(rows.map(row => row.text)).toEqual(Array.from({ length: 20 }, (_, index) => `flows/f${String(index).padStart(2, '0')}.yaml`))
})

test('an empty argument after a run subcommand offers the 20 newest run ids', () => {
  const many = Array.from({ length: 25 }, (_, index) => run(`dag_${String(index).padStart(2, '0')}`, 1_000 + index))
  const rows = autocompleteRows(typed('/dag cancel '), FILES, many)
  expect(rows).toHaveLength(AUTOCOMPLETE_ROWS)
  expect(rows[0]?.text).toBe('dag_24')
  expect(rows[19]?.text).toBe('dag_05')
})

test('a run id or path that nothing starts with gives no rows', () => {
  expect(autocompleteRows(typed('/dag status zzz'), FILES, RUNS)).toEqual([])
  expect(autocompleteRows(typed('/dag run docs/'), FILES, RUNS)).toEqual([])
})

test('files and run ids are capped at 20 rows each', () => {
  const files = Array.from({ length: 30 }, (_, index) => `flows/many/f${String(index).padStart(2, '0')}.yaml`)
  const runs = Array.from({ length: 30 }, (_, index) => run(`dag_${String(index).padStart(2, '0')}`, index))
  expect(autocompleteRows(typed('/dag preview flows/many/'), files, [])).toHaveLength(20)
  expect(autocompleteRows(typed('/dag status dag_'), [], runs)).toHaveLength(20)
})

test('runs created at the same time keep a fixed order, the larger id first', () => {
  const rows = autocompleteRows(typed('/dag status dag_'), [], [run('dag_1', 5), run('dag_3', 5), run('dag_2', 5)])
  expect(rows.map(row => row.text)).toEqual(['dag_3', 'dag_2', 'dag_1'])
})

test('a run name on several lines shows on one line', () => {
  const rows = autocompleteRows(typed('/dag status '), [], [run('dag_1', 5, 'First\n  second\tthird')])
  expect(rows).toEqual([{ text: 'dag_1', description: 'First second third · completed' }])
})

test('a subcommand that takes neither a file nor a run adds nothing', () => {
  for (const verb of ['list', 'context', 'note', 'decisions', 'sessions', 'inspect', 'enforce', 'view', 'approval', 'learn', 'learning']) {
    expect(autocompleteRows(typed(`/dag ${verb} `), FILES, RUNS)).toEqual([])
    expect(autocompleteWant(typed(`/dag ${verb} d`))).toBeUndefined()
  }
})

test('only the first argument is completed: a later argument adds nothing', () => {
  expect(autocompleteRows(typed('/dag retry dag_a nod'), FILES, RUNS)).toEqual([])
  expect(autocompleteRows(typed('/dag retry dag_a '), FILES, RUNS)).toEqual([])
  expect(autocompleteRows(typed('/dag handoff dag_a ses'), FILES, RUNS)).toEqual([])
  expect(autocompleteRows(typed('/dag run flows/a.yaml fl'), FILES, RUNS)).toEqual([])
})

test('text that is not a /dag command adds nothing', () => {
  for (const text of ['run flows/', 'status dag_', 'please /dag status dag_', ' /dag status dag_', '/dagx status dag_', '/dag-ping status dag_', '/dag', '/dag stat', '/dag ', 'first line\n/dag status dag_']) {
    expect(autocompleteRows(typed(text), FILES, RUNS)).toEqual([])
  }
})

test('the caret must end the argument: inside a word nothing is offered, before a space or a line break rows are', () => {
  expect(autocompleteRows(typed('/dag status dag_b', 15), FILES, RUNS)).toEqual([])
  expect(autocompleteRows(typed('/dag status dag_ ', 16), FILES, RUNS).map(row => row.text)).toEqual(['dag_b', 'dag_c', 'dag_a'])
  expect(autocompleteRows(typed('/dag status dag_\nnext line', 16), FILES, RUNS).map(row => row.text)).toEqual(['dag_b', 'dag_c', 'dag_a'])
})

test('tabs between the words still count as the same command', () => {
  expect(autocompleteRows(typed('/dag\tstatus \tdag_b'), FILES, RUNS).map(row => row.text)).toEqual(['dag_b'])
})

test('autocompleteWant names the list a position needs', () => {
  expect(autocompleteWant(typed('/dag run fl'))).toBe('files')
  expect(autocompleteWant(typed('/dag preview '))).toBe('files')
  expect(autocompleteWant(typed('/dag accept d'))).toBe('runs')
  expect(autocompleteWant(typed('/dag list '))).toBeUndefined()
})
