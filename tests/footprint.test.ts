import { expect, test, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { emptyContext } from '../hooks/engine/context.ts'
import { hash } from '../hooks/engine/hash.ts'
import { createRun } from '../hooks/engine/run.ts'
import type { Run, VerificationCheck } from '../hooks/engine/types.ts'
import { boot, harness, ROOT, start } from './control-harness.ts'

const DAY = 86_400_000
const CHECK: VerificationCheck[] = [{ kind: 'command', argv: ['check-control'] }]
const DEFINITION = { key: 'footprint', nodes: [{ id: 'a', prompt: 'Produce artifact', verify: CHECK }] }
const PREFIX = `dag-session:${hash('/work')}:`

function footprint(on: On) {
  const h = harness(on)
  on('store.delete', ($, e) => { h.store.delete(e.key); return { value: undefined } })
  return h
}

function dagWrites(h: ReturnType<typeof harness>): string[] {
  return [...h.files.keys()].filter(path => path.startsWith(ROOT))
}

function dagMkdirs(h: ReturnType<typeof harness>): string[][] {
  return h.processes.filter(e => e.argv[0] === 'mkdir' && e.argv.some(arg => arg.startsWith(ROOT))).map(e => [...e.argv])
}

function oldRun(runId: string, sessionId: string): Run {
  const run = createRun({ key: runId, name: runId, nodes: [{ id: 'a', prompt: 'A', dependsOn: [] }] }, { runId, sessionId, now: 1 })
  return { ...run, status: 'paused', updatedAt: 1 }
}

function record(sessionId: string, status: 'active' | 'closed', updatedAt: number) {
  return { schemaVersion: 1, sessionId, projectRoot: '/work', updatedAt, status, runIds: [], writes: [] }
}

test('a plain conversation in a fresh project leaves nothing under .claude/dag', async ($, on) => {
  const h = footprint(on)
  await boot($)
  await $.prompt.submit({ text: 'Explain this repository', wait: false, origin: { kind: 'composer' } })
  expect(dagWrites(h)).toEqual([])
  expect(dagMkdirs(h)).toEqual([])
})

test('the first run creates runs/, the .gitignore and the context file', async ($, on) => {
  const h = footprint(on)
  await boot($)
  await $.prompt.submit({ text: 'Build artifact TOKEN', wait: false, origin: { kind: 'composer' } })
  expect(h.files.has(`${ROOT}/context/source.json`)).toBe(false)
  await start($, DEFINITION)
  expect(dagMkdirs(h)).toContainEqual(['mkdir', '-p', `${ROOT}/runs`])
  expect(h.files.get(`${ROOT}/.gitignore`)).toBe('# dag-workflow run checkpoints and node reports\n*\n')
  expect(h.files.get(`${ROOT}/context/source.json`)).toContain('Build artifact TOKEN')
})

test('session start prunes expired artifacts and keeps current and active peer files', async ($, on) => {
  const h = footprint(on)
  const now = 30 * DAY
  await h.clock.set(now)
  h.files.set(`${ROOT}/runs/dag_old.json`, JSON.stringify(oldRun('dag_old', 'gone')))
  h.files.set(`${ROOT}/runs/dag_old/a.md`, 'old report')
  h.files.set(`${ROOT}/runs/dag_orphan/a.md`, 'orphan report')
  h.files.set(`${ROOT}/runs/dag_broken.json`, '{not json')
  h.files.set(`${ROOT}/runs/dag_broken/a.md`, 'report of an unreadable checkpoint')
  h.files.set(`${ROOT}/context/gone.json`, '{}')
  h.files.set(`${ROOT}/decisions/gone.json`, '{}')
  h.files.set(`${ROOT}/context/source.json`, JSON.stringify(emptyContext('/work', 'source', 1)))
  h.files.set(`${ROOT}/context/peer.json`, '{}')
  h.files.set(`${ROOT}/decisions/peer.json`, '{}')
  h.store.set(`${PREFIX}gone`, record('gone', 'closed', 1))
  h.store.set(`${PREFIX}peer`, record('peer', 'active', now))
  await boot($)
  const removed = h.processes.filter(e => e.argv[0] === 'rm').map(e => [...e.argv])
  expect(removed).toContainEqual(['rm', '-f', `${ROOT}/runs/dag_old.json`])
  expect(removed).toContainEqual(['rm', '-rf', `${ROOT}/runs/dag_old`])
  expect(removed).toContainEqual(['rm', '-rf', `${ROOT}/runs/dag_orphan`])
  expect(removed).toContainEqual(['rm', '-f', `${ROOT}/context/gone.json`])
  expect(removed).toContainEqual(['rm', '-f', `${ROOT}/decisions/gone.json`])
  expect(removed.filter(argv => argv.some(arg => arg.endsWith('/source.json') || arg.endsWith('/peer.json')))).toEqual([])
  expect(removed.filter(argv => argv.some(arg => arg.includes('/dag_broken')))).toEqual([])
  expect(h.store.has(`${PREFIX}gone`)).toBe(false)
  expect(h.store.has(`${PREFIX}peer`)).toBe(true)
})

// Registered before the shared harness so this gate, not its catch-all tool.call, answers Write.
function writeGate(on: On, $: Engine) {
  on('tool.check', () => ({ decision: 'ask' }))
  on('tool.call', { tool: 'Write' }, async (_engine, e) => {
    const verdict = await $.tool.check({ tool: e.tool, input: { file_path: e.file_path, content: e.content }, tool_use_id: e.tool_use_id })
    if (verdict.decision !== 'allow') return { deny: verdict.reason ?? verdict.decision }
    return { result: { type: 'create', filePath: e.file_path, content: e.content, structuredPatch: [], originalFile: null } }
  })
}

test('dag permission scope skips Jev for main-loop asks but still evaluates node asks', { options: { jev_permission_scope: 'dag' } }, async ($, on) => {
  writeGate(on, $)
  const h = footprint(on)
  await boot($)
  await start($, DEFINITION)
  const before = h.requests.length
  const decisionsBefore = h.files.get(`${ROOT}/decisions/source.json`)
  expect(await $.tool.check({ tool: 'Write', input: { file_path: '/work/a', content: 'x' } })).toEqual({ decision: 'ask' })
  expect(h.requests).toHaveLength(before)
  expect(h.files.get(`${ROOT}/decisions/source.json`)).toBe(decisionsBefore)
  const call = { tool: 'Write', file_path: '/work/a', content: 'x', agentId: 'agent-1', tool_use_id: 'node-call' } as const
  expect(await $.tool.call(call)).toHaveProperty('deny')
  expect(h.requests).toHaveLength(before + 1)
  expect(h.requests.at(-1)?.state).toMatchObject({ task: 'Produce artifact' })
})

test('default permission scope still evaluates a main-loop ask', async ($, on) => {
  writeGate(on, $)
  const h = footprint(on)
  await boot($)
  const before = h.requests.length
  await $.tool.check({ tool: 'Write', input: { file_path: '/work/a', content: 'x' } })
  expect(h.requests).toHaveLength(before + 1)
  expect(Object.keys(h.requests.at(-1)?.questions ?? {})).toEqual(['permission'])
})
