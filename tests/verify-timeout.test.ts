import { expect, test, type Plugin } from 'claude-code/testing'
import { nodeFingerprint, parseDefinition } from '../hooks/engine/definition.ts'
import { INPUT_SCHEMA } from '../hooks/engine/tool-spec.ts'
import { DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS, MIN_COMMAND_TIMEOUT_MS, parseChecks, timeoutAdvice } from '../hooks/engine/verification.ts'
import { boot, checkpoint, dag, finish, harness, PROGRAMS, start } from './control-harness.ts'

// The limits below are written out on purpose: they are the contract (docs/reference.md, the dag tool schema), so a test
// that read them from the module under test would agree with any change to them.
const RANGE_MESSAGE = 'timeoutMs must be a whole number of milliseconds from 1000 to 600000 (default 30000).'

const parsedOne = (check: unknown) => parseChecks([check])
const refusal = (check: unknown) => {
  const parsed = parsedOne(check)
  if (parsed.ok) throw new Error(`accepted ${JSON.stringify(check)}`)
  expect(parsed.error.code).toBe('invalid_verification')
  return parsed.error.message
}

test('a command check keeps a timeoutMs from 1000 to 600000, edges included', () => {
  for (const timeoutMs of [1000, 30000, 120000, 599999, 600000]) {
    const check = { kind: 'command', argv: ['bun', 'test'], timeoutMs }
    const parsed = parsedOne(check)
    expect({ timeoutMs, value: parsed.ok ? parsed.value : parsed.error.message }).toEqual({ timeoutMs, value: [check] })
  }
  const withExpect = { kind: 'command', argv: ['bun', 'test'], expect: { exit: 1 }, timeoutMs: 90000 }
  const parsed = parsedOne(withExpect)
  expect(parsed.ok ? parsed.value : parsed.error.message).toEqual([withExpect])
})

test('a command check without timeoutMs parses to the same object as before, with no timeoutMs key', () => {
  for (const [check, expected] of [
    [{ kind: 'command', argv: ['bun', 'test'] }, { kind: 'command', argv: ['bun', 'test'] }],
    [{ kind: 'command', argv: ['bun', 'test'], expect: { exit: [1, 0] } }, { kind: 'command', argv: ['bun', 'test'], expect: { exit: [0, 1] } }],
    [{ kind: 'command', argv: ['bun', 'test'], timeoutMs: undefined }, { kind: 'command', argv: ['bun', 'test'] }],
  ] as const) {
    const parsed = parsedOne(check)
    if (!parsed.ok) throw new Error(parsed.error.message)
    expect(parsed.value).toEqual([expected])
    expect(Object.keys(parsed.value[0] ?? {})).toEqual(Object.keys(expected))
  }
})

test('a definition without timeoutMs keeps the fingerprint of the same node written by hand', () => {
  const node = { id: 'a', prompt: 'Make a', dependsOn: [], writes: ['a.txt'] }
  const parsed = parseDefinition({ key: 'k', nodes: [{ ...node, verify: [{ kind: 'command', argv: ['bun', 'test'], expect: { exit: 0 } }] }] })
  if (!parsed.ok) throw new Error(parsed.error.message)
  const [parsedNode] = parsed.value.nodes
  if (!parsedNode) throw new Error('Missing fixture node')
  expect(nodeFingerprint(parsedNode)).toBe(nodeFingerprint({ ...node, verify: [{ kind: 'command', argv: ['bun', 'test'], expect: { exit: 0 } }] }))
  const slow = parseDefinition({ key: 'k', nodes: [{ ...node, verify: [{ kind: 'command', argv: ['bun', 'test'], expect: { exit: 0 }, timeoutMs: 120000 }] }] })
  if (!slow.ok) throw new Error(slow.error.message)
  expect(slow.value.nodes[0]?.verify).toEqual([{ kind: 'command', argv: ['bun', 'test'], expect: { exit: 0 }, timeoutMs: 120000 }])
})

test('a command check refuses every timeoutMs outside 1000 to 600000 whole milliseconds, naming the range and the default', () => {
  for (const timeoutMs of [0, 999, 600001, -1000, 1.5, 1000.5, Number.NaN, Number.POSITIVE_INFINITY, '30000', null, true, [30000], { ms: 30000 }]) {
    const message = refusal({ kind: 'command', argv: ['bun', 'test'], timeoutMs })
    expect({ timeoutMs: String(timeoutMs), message }).toEqual({ timeoutMs: String(timeoutMs), message: `verify check 1: ${RANGE_MESSAGE}` })
  }
})

test('the exported limits are 1000, 600000 and 30000 milliseconds', () => {
  expect([MIN_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS, DEFAULT_COMMAND_TIMEOUT_MS]).toEqual([1000, 600000, 30000])
})

test('timeoutAdvice answers the host rejection for a child that outlived its limit and nothing else', () => {
  expect(timeoutAdvice('dag-workflow: $.process.run(bun) aborted: still running after 30000ms')).toBe('If this check is slow by nature, set timeoutMs on it, up to 600000 milliseconds.')
  expect(timeoutAdvice('dag-workflow: $.process.run(bun) aborted: still running after 600000ms')).toContain('timeoutMs')
  for (const failure of ['spawn bun ENOENT', 'dag-workflow: $.process.run: permission denied', 'still running after soon', '']) {
    expect({ failure, advice: timeoutAdvice(failure) }).toEqual({ failure, advice: undefined })
  }
})

test('a file check refuses timeoutMs as an unknown field, and a command check lists timeoutMs among its fields', () => {
  expect(refusal({ kind: 'file', path: 'a.txt', contains: 'x', timeoutMs: 60000 })).toContain('unknown field "timeoutMs" in a file check')
  expect(refusal({ kind: 'command', argv: ['bun', 'test'], retries: 2 })).toBe('verify check 1: unknown field "retries" in a command check; use argv, expect and timeoutMs.')
})

test('the dag tool schema documents timeoutMs as an integer from 1000 to 600000 in milliseconds for command checks', () => {
  const verifyItem = INPUT_SCHEMA.properties.definition.properties.nodes.items.properties.verify.items
  const { timeoutMs } = verifyItem.properties
  expect(timeoutMs).toMatchObject({ type: 'integer', minimum: 1000, maximum: 600000 })
  expect(timeoutMs.description).toContain('command')
  expect(timeoutMs.description).toContain('milliseconds')
  expect(timeoutMs.description).toContain('30000')
})

const definition = (verify: unknown[]) => ({ key: 'verify-timeout', nodes: [{ id: 'a', prompt: 'Produce artifact', verify }] })

test('start refuses a timeoutMs out of range and a timeoutMs on a file check before spawning anything', async ($, on) => {
  const h = harness(on)
  await boot($)
  for (const verify of [
    [{ kind: 'command', argv: ['check-control'], timeoutMs: 600001 }],
    [{ kind: 'command', argv: ['check-control'], timeoutMs: '30000' }],
    [{ kind: 'file', path: 'artifact.txt', contains: 'x', timeoutMs: 60000 }],
  ]) {
    expect(await dag($, { action: 'start', definition: definition(verify) })).toMatchObject({ error: { code: 'invalid_verification' } })
  }
  expect(h.spawns).toHaveLength(0)
})

test('a command check passes its own timeoutMs to process.run, and a check without one still gets 30000', { options: { auto_recovery: false } }, async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = await start($, definition([
    { kind: 'command', argv: ['check-long'], timeoutMs: 120000 },
    { kind: 'command', argv: ['check-max'], timeoutMs: 600000 },
    { kind: 'command', argv: ['check-default'] },
  ]))
  await finish($, h)
  expect(checkpoint(h, runId).nodes[0]).toMatchObject({ state: 'completed', verification: { status: 'passed' } })
  expect(h.processes.filter(e => e.argv[0]?.startsWith('check-'))).toMatchObject([
    { argv: ['check-long'], init: { cwd: '/work', timeoutMs: 120_000 } },
    { argv: ['check-max'], init: { cwd: '/work', timeoutMs: 600_000 } },
    { argv: ['check-default'], init: { cwd: '/work', timeoutMs: 30_000 } },
  ])
})

// The host rejects $.process.run with this message when the child outlives timeoutMs (Claude Code 2.1.306):
//   dag-workflow: $.process.run(<program>) aborted: still running after <timeoutMs>ms
// A deny from the harness reaches the plugin as `dag-workflow: $.process.run: <deny>`, so the deny carries the tail the
// plugin reads: the limit the check ran under, which is what the host prints.
const HOST_PROGRAMS: Plugin = {
  name: 'verify-timeout-programs',
  register(on) {
    on('process.run', ($, e, next) => {
      if (e.argv[0] === 'slow-check') return { deny: `aborted: still running after ${e.init?.timeoutMs ?? 30_000}ms` }
      return next(e)
    })
  },
}
const SETTINGS = { options: { auto_recovery: false }, plugins: [PROGRAMS, HOST_PROGRAMS] }

function evidenceOf(h: ReturnType<typeof harness>, runId: string) {
  const evidence = checkpoint(h, runId).nodes[0]?.verification?.evidence
  if (!evidence) throw new Error('Missing verification evidence')
  return evidence
}

test('a check that ran past its limit says it can set timeoutMs up to 600000, whether the limit was the default or its own', SETTINGS, async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = await start($, definition([
    { kind: 'command', argv: ['slow-check'] },
    { kind: 'command', argv: ['slow-check', '--own-limit'], timeoutMs: 90000 },
  ]))
  await finish($, h)
  const [byDefault, own] = evidenceOf(h, runId)
  expect(byDefault).toMatchObject({ outcome: 'not_run', passed: false })
  expect(byDefault?.detail).toContain('still running after 30000ms')
  expect(byDefault?.detail).toContain('If this check is slow by nature, set timeoutMs on it, up to 600000 milliseconds.')
  expect(own).toMatchObject({ outcome: 'not_run', passed: false })
  expect(own?.detail).toContain('still running after 90000ms')
  expect(own?.detail).toContain('If this check is slow by nature, set timeoutMs on it, up to 600000 milliseconds.')
})

test('a not_run command that did not time out keeps its detail without the timeoutMs hint', SETTINGS, async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = await start($, definition([{ kind: 'command', argv: ['missing-program'] }]))
  await finish($, h)
  const [item] = evidenceOf(h, runId)
  expect(item).toMatchObject({ outcome: 'not_run', passed: false })
  expect(item?.detail).toMatch(/^Verification could not run: .*spawn missing-program ENOENT$/)
})
