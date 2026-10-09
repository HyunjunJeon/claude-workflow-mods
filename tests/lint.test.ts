import { expect, test } from 'claude-code/testing'
import { parseDefinition } from '../hooks/engine/definition.ts'
import { lintDefinition } from '../hooks/engine/lint.ts'
import { verificationProblem } from '../hooks/engine/verification.ts'

// Every definition carries a goal unless a test passes undefined, so the goal warning stays out of the other tests.
const build = (nodes: unknown[], goal?: string) => {
  const r = parseDefinition({ key: 'k', ...(goal === undefined ? {} : { goal }), nodes })
  if (!r.ok) throw new Error(r.error.message)
  return r.value
}
const def = (nodes: unknown[]) => build(nodes, 'a fixture goal')
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

test('a definition without a goal gets the goal warning, after every other warning', async () => {
  const nodes = [{ id: 'x', prompt: 'TASK: only a task' }]
  for (const goal of [undefined, '', '   ']) {
    const warnings = lintDefinition(build(nodes, goal))
    expect({ goal, count: warnings.length }).toEqual({ goal, count: 2 })
    expect(warnings[0]).toContain('node "x": the prompt lacks STOP WHEN')
    expect(warnings[1]).toContain('the definition has no goal')
    expect(warnings[1]).toBe('the definition has no goal - set "goal" to one sentence naming the deliverable and its observable done condition; every node sees it.')
  }
  const alone = lintDefinition(build([{ id: 'x', prompt: full }]))
  expect(alone).toHaveLength(1)
  expect(alone[0]).toContain('the definition has no goal')
})

test('the same definition with a goal gets no goal warning', async () => {
  const nodes = [{ id: 'x', prompt: 'TASK: only a task' }]
  const withGoal = lintDefinition(build(nodes, 'One sentence naming the deliverable and when it is done.'))
  expect(withGoal).toHaveLength(1)
  expect(withGoal.some(warning => warning.includes('the definition has no goal'))).toBe(false)
  expect(lintDefinition(build([{ id: 'x', prompt: full }], 'One sentence naming the deliverable and when it is done.'))).toEqual([])
})

const fileCheck = (path: string) => ({ kind: 'file', path, contains: 'ok' })
const underSplit = (node: Record<string, unknown>) =>
  lintDefinition(def([{ id: 'x', prompt: full, ...node }])).filter(warning => warning.includes('one producer owns'))

test('under-split lint counts the files inside a declared folder, not the folder itself', async () => {
  expect(underSplit({
    writes: ['skills/x/'],
    verify: [fileCheck('skills/x/A.md'), fileCheck('skills/x/sub/B.md')],
  })).toEqual([])
})

test('under-split lint names the three files of a folder and not the folder', async () => {
  const warnings = underSplit({
    writes: ['src/'],
    verify: [fileCheck('src/a.ts'), fileCheck('src/b.ts'), fileCheck('src/c.ts')],
  })
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('node "x": one producer owns 3 files (src/a.ts, src/b.ts, src/c.ts)')
  expect(warnings[0]).not.toContain('(src,')
})

test('under-split lint still warns on three paths that are not nested', async () => {
  const warnings = underSplit({ writes: ['a/', 'b/', 'c.md'] })
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('node "x": one producer owns 3 files (a, b, c.md)')
})

test('under-split lint does not treat a shared name prefix as a folder', async () => {
  const warnings = underSplit({ writes: ['src', 'src2/x.ts', 'z.md'] })
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('node "x": one producer owns 3 files (src, src2/x.ts, z.md)')
})

test('under-split lint counts a folder spelled ./src/ and a file inside it as one deliverable', async () => {
  expect(underSplit({ writes: ['./src/', 'src/a.ts', 'b.md'] })).toEqual([])
})

test('under-split lint counts one file once whatever its spelling', async () => {
  expect(underSplit({
    writes: ['src//a.ts', './src/a.ts', 'src\\a.ts', 'src/./a.ts', 'b.md'],
    verify: [fileCheck('src/a.ts')],
  })).toEqual([])
})

test('under-split lint lists the normalized spelling of each path it counts', async () => {
  const warnings = underSplit({ writes: ['./a.md', 'b//c.md', 'd\\e.md'] })
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('node "x": one producer owns 3 files (a.md, b/c.md, d/e.md)')
})

test('under-split lint treats a bare tests folder as tests, not as a deliverable', async () => {
  expect(underSplit({ writes: ['tests/', 'a.ts', 'b.md'] })).toEqual([])
})

test('under-split lint treats a nested tests or __tests__ folder as tests', async () => {
  expect(underSplit({ writes: ['src/tests', 'src/__tests__/', 'a.ts', 'b.md'] })).toEqual([])
})

test('under-split lint treats test, tests/x.ts and a spec file as tests', async () => {
  expect(underSplit({ writes: ['test', 'tests/x.ts', 'src/a.spec.ts', 'a.ts', 'b.md'] })).toEqual([])
})

test('under-split lint does not treat names that merely contain test as tests', async () => {
  const warnings = underSplit({ writes: ['testsuite/a.ts', 'contest/b.ts', 'c.md'] })
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('node "x": one producer owns 3 files (testsuite/a.ts, contest/b.ts, c.md)')
})
