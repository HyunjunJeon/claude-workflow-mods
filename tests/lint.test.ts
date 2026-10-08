import { expect, test } from 'claude-code/testing'
import { parseDefinition } from '../hooks/engine/definition.ts'
import { lintDefinition } from '../hooks/engine/lint.ts'
import { verificationProblem } from '../hooks/engine/verification.ts'

const def = (nodes: unknown[]) => {
  const r = parseDefinition({ key: 'k', nodes })
  if (!r.ok) throw new Error(r.error.message)
  return r.value
}
const full = 'TASK: do it. DELIVERABLE: x. SCOPE: y. VERIFY: z. STOP WHEN: done.'
const lintVerify = (verify: unknown[]) => lintDefinition(def([{ id: 'x', prompt: full, verify }]))
const command = (...argv: string[]) => ({ kind: 'command', argv })

test('vacuous verify V1 warns about a file check without contains', async () => {
  const warnings = lintVerify([{ kind: 'file', path: 'out.md' }])
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('node "x"')
  expect(warnings[0]).toContain('vacuous verify')
  expect(warnings[0]).toContain('check 1 is a file check without contains, so it only proves the file exists (touch passes it)')
})

test('vacuous verify V1 stays silent when the file check has contains', async () => {
  expect(lintVerify([{ kind: 'file', path: 'out.md', contains: 'heading' }])).toEqual([])
})

test('vacuous verify V2 warns about every program that always passes', async () => {
  for (const program of ['true', ':', 'echo', 'printf', 'exit', 'yes', 'sleep']) {
    const warnings = lintVerify([command(program, 'x')])
    expect({ program, count: warnings.length }).toEqual({ program, count: 1 })
    expect(warnings[0]).toContain('vacuous verify')
    expect(warnings[0]).toContain(`check 1 runs ${program}, which always passes`)
  }
  const byPath = lintVerify([{ kind: 'file', path: 'out.md', contains: 'heading' }, command('/bin/true')])
  expect(byPath).toHaveLength(1)
  expect(byPath[0]).toContain('check 2 runs true, which always passes')
  const windows = lintVerify([command('C:\\tools\\echo', 'ok')])
  expect(windows).toHaveLength(1)
  expect(windows[0]).toContain('check 1 runs echo, which always passes')
})

test('vacuous verify V2 stays silent on commands that can fail', async () => {
  expect(lintVerify([command('bun', 'test')])).toEqual([])
  expect(lintVerify([command('git', 'diff', '--check')])).toEqual([])
})

test('vacuous verify V3 warns about bare existence tests and path-only programs', async () => {
  const existence: string[][] = [
    ['test', '-e', 'x'],
    ['test', '-f', 'x'],
    ['test', '-d', 'x'],
    ['test', '-s', 'x'],
    ['[', '-f', 'x', ']'],
    ['/usr/bin/test', '-f', 'x'],
    ['ls', 'x'],
    ['stat', 'x'],
    ['cat', 'x'],
  ]
  for (const argv of existence) {
    const warnings = lintVerify([command(...argv)])
    expect({ argv, count: warnings.length }).toEqual({ argv, count: 1 })
    expect(warnings[0]).toContain('vacuous verify')
    expect(warnings[0]).toContain('check 1 only tests that a path exists')
  }
})

test('vacuous verify V3 stays silent on tests that look at content or have no existence flag', async () => {
  expect(lintVerify([command('test', '-n', 'x')])).toEqual([])
  expect(lintVerify([command('test', '-r', 'x')])).toEqual([])
  expect(lintVerify([command('[', '-z', 'x', ']')])).toEqual([])
  expect(lintVerify([command('test', '-f', 'a', '-a', '-f', 'b')])).toEqual([])
  expect(lintVerify([command('test', 'a', '=', 'b')])).toEqual([])
  expect(lintVerify([command('grep', '-q', 'x', 'a.md')])).toEqual([])
})

test('vacuous verify collects every offending check of one node into one warning', async () => {
  const definition = def([
    {
      id: 'x',
      prompt: full,
      verify: [{ kind: 'file', path: 'out.md' }, { kind: 'file', path: 'out.md', contains: 'heading' }, command('true')],
    },
    { id: 'verify-x', prompt: full, dependsOn: ['x'], verify: [{ kind: 'file', path: 'y.md', contains: 'ok' }, command('bun', 'test')] },
  ])
  const warnings = lintDefinition(definition)
  expect(warnings).toEqual([
    'node "x": vacuous verify - check 1 is a file check without contains, so it only proves the file exists (touch passes it); check 3 runs true, which always passes - declare a file check with nonempty contains text, or a command that exits nonzero when the deliverable is wrong.',
  ])
  expect(warnings[0]).not.toContain('check 2')
  expect(verificationProblem(definition)).toBeUndefined()
})
