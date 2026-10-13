import { mock, type Engine, type Plugin } from 'claude-code/testing'
import type { AgentInfo, EventOf, On } from 'claude-code'
import type { Run } from '../hooks/engine/types.ts'
import type { JevRequest } from '../hooks/engine/jev.ts'
import type { Enforcement } from '../hooks/engine/policy.ts'

export const ROOT = '/work/.claude/dag'
export const KEY = 'control-test-secret'
const TOOL = 'mcp__dag-workflow__dag'

export function harness(on: On, options: { home?: string; now?: number } = {}) {
  const clock = mock.clock(on, { now: options.now ?? 1_000 })
  const files = new Map<string, string>()
  const store = new Map<string, unknown>()
  const spawns: EventOf['agent.spawn'][] = []
  const completedTurns: EventOf['turn.complete'][] = []
  const processes: EventOf['process.run'][] = []
  const requests: JevRequest[] = []
  const reads: string[] = []
  const readOnce = new Map<string, string>()
  const writeErrors = new Map<string, string>()
  const logs: string[] = []
  const logOptions: ({ to?: string } | undefined)[] = []
  const stats: string[] = []
  const statuses: (string | undefined)[] = []
  const toasts: { text: string; timeoutMs?: number }[] = []
  const notices: { toolUseId: string; text: string | undefined }[] = []
  const sends: EventOf['session.send'][] = []
  const prompts: string[] = []
  // Every prompt that reached the host, with the context hooks attached and where it came from.
  const submits: { text: string; context: readonly string[]; origin: string }[] = []
  const locks = new Set<string>()
  const lockMtimes = new Map<string, number>()
  // permission: the Jev answer to a permission question; unset, the question gets the generic 'trivial' answer.
  const control = { sessionId: 'source', exitCode: 0, recovery: 'implementation', confidence: 0.99, httpStatus: 200, transportError: false, permission: undefined as { choice: string; confidence: number } | undefined, liveAgents: [] as AgentInfo[], beforeSpawn: undefined as (() => Promise<void>) | undefined }
  on('session.start', () => ({ cwd: '/work' }))
  on('session.id', () => ({ value: control.sessionId }))
  on('session.cwd', () => ({ value: '/work' }))
  on('env.get', ($, e) => ({ value: e.name === 'TYPESAFE_API_KEY' ? KEY : e.name === 'HOME' ? options.home : undefined }))
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => { store.set(e.key, e.value); return { value: undefined } })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('http.fetch', ($, e) => {
    const request: JevRequest = JSON.parse(e.init?.body ?? '{}')
    requests.push(request)
    if (control.transportError) throw new Error('mock transport failure')
    const answers = Object.fromEntries(Object.keys(request.questions).map(id => [id, id === 'permission' && control.permission
      ? { type: 'choice', ...control.permission }
      : {
        type: 'choice', choice: id === 'recovery' ? control.recovery : 'trivial',
        confidence: id === 'recovery' ? control.confidence : 0.99,
      }]))
    return { value: { status: control.httpStatus, ok: control.httpStatus === 200, headers: {}, text: JSON.stringify({ answers }) } }
  })
  on('process.run', ($, e) => {
    processes.push(e)
    let exitCode = e.argv[0] === 'check-control' ? control.exitCode : 0
    const path = e.argv.at(-1)
    if (e.argv[0] === 'sleep') return { deny: 'No wall-clock waits in tests' }
    if (options.home && e.argv[0] === 'mkdir' && e.argv.includes('-p') && path?.startsWith(options.home + '/')) locks.add(path)
    if (options.home && e.argv[0] === 'mv') {
      const source = e.argv.at(-2)
      const destination = e.argv.at(-1)
      const text = source ? files.get(source) : undefined
      if (source && destination && text !== undefined) {
        files.set(destination, text)
        files.delete(source)
      } else exitCode = 1
    }
    if (options.home && e.argv[0] === 'rm' && path) {
      files.delete(path)
      if (e.argv.includes('-rf')) {
        for (const file of files.keys()) if (file.startsWith(path + '/')) files.delete(file)
        locks.delete(path)
      }
    }
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
    const error = writeErrors.get(e.path) ?? writeErrors.get(e.path.replace(/\.[a-f0-9]+\.\d+\.tmp$/, ''))
    if (error !== undefined) throw new Error(error)
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('agent.list', () => ({ value: control.liveAgents }))
  on('agent.spawn', async ($, e) => {
    spawns.push(e)
    const agentId = `agent-${spawns.length}`
    await control.beforeSpawn?.()
    return { model: e.model ?? 'sonnet', agentId, result: { status: 'async_launched', agentId } }
  })
  on('session.send', ($, e) => { sends.push(e); return { isDelivered: true } })
  on('session.receive', () => ({ consumed: 'test host received' }))
  on('tool.register', () => ({ value: { tool: TOOL } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.log', ($, e) => { logs.push(e.text); logOptions.push('to' in e ? { to: e.to } : undefined); return { value: undefined } })
  on('ui.status', ($, e) => { statuses.push(e.text); return { value: undefined } })
  on('ui.toast', ($, e) => { toasts.push({ text: e.text, ...(e.timeoutMs === undefined ? {} : { timeoutMs: e.timeoutMs }) }); return { value: undefined } })
  on('ui.notice', ($, e) => { notices.push({ toolUseId: e.tool_use_id, text: e.text }); return { value: undefined } })
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)
    submits.push({ text: e.text, context: e.context ?? [], origin: e.origin.kind })
    return { text: e.text }
  })
  on('skill.prompt', ($, e) => ({ text: e.text }))
  on('turn.complete', ($, e) => { completedTurns.push(e); return { text: '' } })
  on('tool.call', () => ({ result: 'stopped' }))
  on('classic.SessionStart', () => ({}))
  on('classic.PermissionRequest', () => ({}))
  return { clock, files, store, spawns, completedTurns, processes, requests, reads, readOnce, writeErrors, logs, logOptions, stats, statuses, toasts, notices, sends, prompts, submits, locks, lockMtimes, control }
}

// The manifest's default enforcement is auto, which asks Jev about every user prompt. These suites were written for
// strict, so boot pins it; a test whose options choose a level passes null to keep that level.
export async function boot($: Engine, enforcement: Enforcement | null = 'strict') {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.skill.prompt({ skill: 'dag-workflow:planning', text: '# planning' })
  if (enforcement) await command($, `enforce ${enforcement}`)
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

// A folder for the harness: its files are listed under it, and a lock makes `stat` answer `dir`.
export function folder(h: ReturnType<typeof harness>, path: string, files: Record<string, string>): void {
  h.locks.add(path)
  for (const [name, text] of Object.entries(files)) h.files.set(`${path}/${name}`, text)
}

// The harness answers every program with exit 0 and no output. Load this plugin beside a test's harness
// (`{ plugins: [PROGRAMS] }`) for verify commands whose exit code, output or failure to start a check judges. It runs in
// its own layer, so it does not register process.run twice. Other programs pass through to the harness. Behaviour travels
// in argv:
//   report <exit> [stdout] [stderr]  runs and answers those three
//   report-cut <exit> <stdout>       the same with stdout cut at the host's 4 MiB limit
//   missing-program                  cannot start, so the host rejects the call
export const PROGRAMS: Plugin = {
  name: 'control-harness-programs',
  register(on) {
    on('process.run', ($, e, next) => {
      if (e.argv[0] === 'report' || e.argv[0] === 'report-cut') {
        return { value: { exitCode: Number(e.argv[1]), stdout: e.argv[2] ?? '', stderr: e.argv[3] ?? '', isStdoutTruncated: e.argv[0] === 'report-cut', isStderrTruncated: false } }
      }
      if (e.argv[0] === 'missing-program') return { deny: 'spawn missing-program ENOENT' }
      return next(e)
    })
  },
}
