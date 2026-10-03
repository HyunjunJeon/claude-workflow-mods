import { mock, type Engine } from 'claude-code/testing'
import type { EventOf, On } from 'claude-code'
import type { Run } from '../hooks/engine/types.ts'
import type { JevRequest } from '../hooks/engine/jev.ts'

export const ROOT = '/work/.claude/dag'
export const KEY = 'control-test-secret'
const TOOL = 'mcp__dag-workflow__dag'

export function harness(on: On) {
  const clock = mock.clock(on, { now: 1_000 })
  const files = new Map<string, string>()
  const store = new Map<string, unknown>()
  const spawns: EventOf['agent.spawn'][] = []
  const processes: EventOf['process.run'][] = []
  const requests: JevRequest[] = []
  const reads: string[] = []
  const readOnce = new Map<string, string>()
  const writeErrors = new Map<string, string>()
  const logs: string[] = []
  const stats: string[] = []
  const sends: EventOf['session.send'][] = []
  const prompts: string[] = []
  const locks = new Set<string>()
  const lockMtimes = new Map<string, number>()
  const control = { sessionId: 'source', exitCode: 0, recovery: 'implementation', confidence: 0.99, httpStatus: 200, transportError: false }
  on('session.start', () => ({ cwd: '/work' }))
  on('session.id', () => ({ value: control.sessionId }))
  on('session.cwd', () => ({ value: '/work' }))
  on('env.get', ($, e) => ({ value: e.name === 'TYPESAFE_API_KEY' ? KEY : undefined }))
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => { store.set(e.key, e.value); return { value: undefined } })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('http.fetch', ($, e) => {
    const request: JevRequest = JSON.parse(e.init?.body ?? '{}')
    requests.push(request)
    if (control.transportError) throw new Error('mock transport failure')
    const answers = Object.fromEntries(Object.keys(request.questions).map(id => [id, {
      type: 'choice', choice: id === 'recovery' ? control.recovery : 'quick',
      confidence: id === 'recovery' ? control.confidence : 0.99,
    }]))
    return { value: { status: control.httpStatus, ok: control.httpStatus === 200, headers: {}, text: JSON.stringify({ answers }) } }
  })
  on('process.run', ($, e) => {
    processes.push(e)
    let exitCode = e.argv[0] === 'check-control' ? control.exitCode : 0
    const path = e.argv.at(-1)
    if (e.argv[0] === 'sleep') return { deny: 'No wall-clock waits in tests' }
    if (e.argv[0] === 'mkdir' && !e.argv.includes('-p') && path) {
      exitCode = locks.has(path) ? 1 : 0
      if (!exitCode) locks.add(path)
    }
    if (e.argv[0] === 'rmdir' && path) {
      exitCode = locks.delete(path) ? 0 : 1
    }
    return { value: { exitCode, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.list', ($, e) => {
    const prefix = e.path.replace(/\/$/, '') + '/'
    const names = new Set([...files.keys()].filter(path => path.startsWith(prefix)).map(path => path.slice(prefix.length).split('/')[0]))
    return { value: [...names].filter((name): name is string => name !== undefined).map(name => ({
      name, kind: files.has(prefix + name) ? 'file' as const : 'dir' as const,
      size: 1, mtimeMs: 0, isLink: false,
    })) }
  })
  on('fs.exists', ($, e) => {
    const path = e.path.replace(/\/$/, '')
    return { value: files.has(path) || locks.has(path) || [...files.keys()].some(file => file.startsWith(path + '/')) }
  })
  on('fs.read', ($, e) => {
    reads.push(e.path)
    const override = readOnce.get(e.path)
    if (override !== undefined) {
      readOnce.delete(e.path)
      return { value: override }
    }
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.stat', ($, e) => {
    stats.push(e.path)
    if (locks.has(e.path)) return { value: { kind: 'dir', size: 0, mtimeMs: lockMtimes.get(e.path) ?? 1_000, isLink: false } }
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'file', size: text.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.write', ($, e) => {
    const error = writeErrors.get(e.path)
    if (error !== undefined) throw new Error(error)
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('agent.list', () => ({ value: [] }))
  on('agent.spawn', ($, e) => {
    spawns.push(e)
    const agentId = `agent-${spawns.length}`
    return { model: e.model ?? 'sonnet', agentId, result: { status: 'async_launched', agentId } }
  })
  on('session.send', ($, e) => { sends.push(e); return { isDelivered: true } })
  on('session.receive', () => ({ consumed: 'test host received' }))
  on('tool.register', () => ({ value: { tool: TOOL } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.log', ($, e) => { logs.push(e.text); return { value: undefined } })
  on('prompt.submit', ($, e) => { prompts.push(e.text); return { text: e.text } })
  on('skill.prompt', ($, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: 'stopped' }))
  on('classic.SessionStart', () => ({}))
  return { clock, files, store, spawns, processes, requests, reads, readOnce, writeErrors, logs, stats, sends, prompts, locks, lockMtimes, control }
}

export async function boot($: Engine) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.skill.prompt({ skill: 'dag-workflow:dag-planning', text: '# planning' })
}

export async function dag($: Engine, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reply = await $.tool.call({ tool: TOOL, ...input })
  if (typeof reply.result !== 'string') throw new Error('Expected DAG JSON result')
  return JSON.parse(reply.result)
}

export async function start($: Engine, definition: unknown): Promise<string> {
  const result = await dag($, { action: 'start', definition })
  if (typeof result.run_id !== 'string') throw new Error(JSON.stringify(result))
  return result.run_id
}

export async function command($: Engine, args: string) {
  return $.command.run({ command: 'dag', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
}

export function checkpoint(h: ReturnType<typeof harness>, runId: string): Run {
  const text = h.files.get(`${ROOT}/runs/${runId}.json`)
  if (!text) throw new Error(`Missing checkpoint: ${runId}`)
  return JSON.parse(text)
}

export async function finish($: Engine, h: ReturnType<typeof harness>, agentId = 'agent-1', aborted = false) {
  await $.turn.complete({
    turnId: `turn-${agentId}`, agentId, reason: aborted ? 'aborted' : 'answer',
    isAborted: aborted, answer: aborted ? '' : 'DAG_NODE_STATUS: completed', durationMs: 1,
  })
  await h.clock.settle()
}
