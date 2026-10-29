import { expect, test } from 'claude-code/testing'
import { boot, harness } from './control-harness.ts'

const FILE = '/work/src/a.ts'
const TEST_FILE = '/work/src/a.test.ts'
const TEST_BEFORE = "test('checks result', () => {\n  expect(load()).toBe(3)\n})"

for (const [request, warned] of [
  ['실제 API를 연동해주세요', true],
  ['실제 API를 호출하지 마세요', false],
] as const) {
  test(`the existing scan uses the latest explicit API request with warning=${warned}`, async ($, on) => {
    const h = harness(on)
    await boot($, 'off')
    await $.prompt.submit({ text: request, wait: false, origin: { kind: 'composer' } })
    h.files.set(FILE, "export async function load() {\n  return fetch('/api/items')\n}")
    const reply = await $.tool.call({ tool: 'Write', file_path: FILE, content: 'export async function load() {\n  return { ok: true }\n}' })
    expect(reply.context?.some(text => text.includes('requirement-substitution')) ?? false).toBe(warned)
    expect(reply.deny).toBeUndefined()
  })
}

for (const [pattern, after] of [
  ['test-skip', TEST_BEFORE.replace('test(', 'test.skip(')],
  ['test-disabled', TEST_BEFORE.replace('  expect(load()).toBe(3)\n', '')],
  ['test-tautology', TEST_BEFORE.replace('expect(load()).toBe(3)', 'expect(true).toBe(true)')],
  ['test-expectation-change', TEST_BEFORE.replace('toBe(3)', 'toBe(4)')],
] as const) {
  test(`an Edit returns ${pattern} as context using full before and after files`, async ($, on) => {
    const h = harness(on)
    await boot($, 'off')
    h.readOnce.set(TEST_FILE, TEST_BEFORE)
    h.files.set(TEST_FILE, after)
    const reply = await $.tool.call({ tool: 'Edit', file_path: TEST_FILE, old_string: TEST_BEFORE, new_string: after })
    expect(reply.context).toEqual([expect.stringContaining(pattern)])
  })
}

test('repository exceptions suppress expectation change candidates through the existing hook', async ($, on) => {
  const h = harness(on)
  await boot($, 'off')
  h.files.set('/work/AGENTS.md', 'anti-slop allow: test-expectation-change\n')
  h.files.set(TEST_FILE, TEST_BEFORE)
  const reply = await $.tool.call({ tool: 'Write', file_path: TEST_FILE, content: TEST_BEFORE.replace('toBe(3)', 'toBe(4)') })
  expect(reply.context).toBeUndefined()
})

test('configured skips suppress expectation change candidates through the existing hook', { options: { anti_slop_skip: ['test-expectation-change'] } }, async ($, on) => {
  const h = harness(on)
  await boot($, 'off')
  h.files.set(TEST_FILE, TEST_BEFORE)
  const reply = await $.tool.call({ tool: 'Write', file_path: TEST_FILE, content: TEST_BEFORE.replace('toBe(3)', 'toBe(4)') })
  expect(reply.context).toBeUndefined()
})

test('a worker Write reports test weakening through the existing context path', async ($, on) => {
  const h = harness(on)
  await boot($, 'off')
  h.files.set(TEST_FILE, TEST_BEFORE)
  const call = {
    tool: 'Write', file_path: TEST_FILE,
    content: TEST_BEFORE.replace('expect(load()).toBe(3)', 'expect(true).toBe(true)'), agentId: 'agent-1',
  } as const
  const reply = await $.tool.call(call)
  expect(reply.context).toEqual([expect.stringContaining('test-tautology')])
})

test('test assertion consolidation leaves Edit context absent', async ($, on) => {
  const h = harness(on)
  await boot($, 'off')
  h.readOnce.set(TEST_FILE, TEST_BEFORE)
  h.files.set(TEST_FILE, TEST_BEFORE.replace('expect(load()).toBe(3)', 'checkResult(load())'))
  const reply = await $.tool.call({ tool: 'Edit', file_path: TEST_FILE, old_string: 'expect(load()).toBe(3)', new_string: 'checkResult(load())' })
  expect(reply.context).toBeUndefined()
})

test('repository exceptions suppress test weakening through the existing hook', async ($, on) => {
  const h = harness(on)
  await boot($, 'off')
  h.files.set('/work/AGENTS.md', 'anti-slop allow: test-disabled\n')
  h.files.set(TEST_FILE, TEST_BEFORE)
  const reply = await $.tool.call({ tool: 'Write', file_path: TEST_FILE, content: TEST_BEFORE.replace('  expect(load()).toBe(3)\n', '') })
  expect(reply.context).toBeUndefined()
})

test('configured pattern skips suppress test weakening through the existing hook', { options: { anti_slop_skip: ['test-skip'] } }, async ($, on) => {
  const h = harness(on)
  await boot($, 'off')
  h.files.set(TEST_FILE, TEST_BEFORE)
  const reply = await $.tool.call({ tool: 'Write', file_path: TEST_FILE, content: TEST_BEFORE.replace('test(', 'test.skip(') })
  expect(reply.context).toBeUndefined()
})

test('an Edit in the main conversation that adds a pattern gets the hit back as context, placed in the file', async ($, on) => {
  const h = harness(on)
  await boot($, 'off')
  h.readOnce.set(FILE, 'import x from "y"\n\nconst raw = input\n')
  h.files.set(FILE, 'import x from "y"\n\nconst raw = input as any\n')
  const reply = await $.tool.call({ tool: 'Edit', file_path: FILE, old_string: 'const raw = input', new_string: 'const raw = input as any' })
  expect(reply.context).toEqual([expect.stringContaining('- src/a.ts:3 top-type: `const raw = input as any`')])
})

test('an Edit sees the lines around it, so a SAFETY comment just above the edited line counts', async ($, on) => {
  const h = harness(on)
  await boot($, 'off')
  h.readOnce.set(FILE, '// SAFETY: parseUserId validated the id.\nconst id = value as UserId\n')
  h.files.set(FILE, '// SAFETY: parseUserId validated the id.\nconst id = raw as UserId\n')
  const reply = await $.tool.call({ tool: 'Edit', file_path: FILE, old_string: 'value as UserId', new_string: 'raw as UserId' })
  expect(reply.context).toBeUndefined()
})

test('a node worker writing a new file gets the same scan', async ($, on) => {
  harness(on)
  await boot($, 'off')
  const call = { tool: 'Write', file_path: '/work/b.py', content: 'import os\n\nx = load()  # type: ignore\n', agentId: 'agent-1' } as const
  const reply = await $.tool.call(call)
  expect(reply.context).toEqual([expect.stringContaining('- b.py:3 suppression-without-reason')])
})

test('a Write that keeps an old pattern and adds clean lines reports nothing', async ($, on) => {
  const h = harness(on)
  await boot($, 'off')
  h.files.set(FILE, 'const raw = input as any\n')
  const reply = await $.tool.call({ tool: 'Write', file_path: FILE, content: 'const raw = input as any\nexport const size = 3\n' })
  expect(reply.context).toBeUndefined()
})

test('a refused Edit is not scanned', async ($, on) => {
  const h = harness(on)
  await boot($)
  h.readOnce.set(FILE, 'a\n')
  h.files.set(FILE, 'const raw = input as any\n')
  const reply = await $.tool.call({ tool: 'Edit', file_path: FILE, old_string: 'a', new_string: 'const raw = input as any' })
  expect(reply.deny).toContain('dag-workflow refused Edit')
  expect(reply.context).toBeUndefined()
})

test('anti_slop_scan off turns the scan off', { options: { anti_slop_scan: false } }, async ($, on) => {
  const h = harness(on)
  await boot($, 'off')
  h.readOnce.set(FILE, 'a\n')
  h.files.set(FILE, 'const raw = input as any\n')
  const reply = await $.tool.call({ tool: 'Edit', file_path: FILE, old_string: 'a', new_string: 'const raw = input as any' })
  expect(reply.context).toBeUndefined()
})

test('anti_slop_skip drops the patterns it names and keeps the rest', { options: { anti_slop_skip: ['top-type'] } }, async ($, on) => {
  const h = harness(on)
  await boot($, 'off')
  h.readOnce.set(FILE, 'a\n')
  h.files.set(FILE, 'const raw = input as any\ndebugger\n')
  const reply = await $.tool.call({ tool: 'Edit', file_path: FILE, old_string: 'a', new_string: 'const raw = input as any\ndebugger' })
  expect(reply.context).toEqual([expect.stringContaining('debug-leftover')])
  expect(reply.context?.[0]).not.toContain('top-type')
})

test('a pattern the repository allows in AGENTS.md is not reported, and editing AGENTS.md is read again', async ($, on) => {
  const h = harness(on)
  await boot($, 'off')
  h.files.set('/work/AGENTS.md', 'anti-slop allow: top-type\n')
  h.readOnce.set(FILE, 'a\n')
  h.files.set(FILE, 'function handle(input: any) {}\n')
  const allowed = await $.tool.call({ tool: 'Edit', file_path: FILE, old_string: 'a', new_string: 'function handle(input: any) {}' })
  expect(allowed.context).toBeUndefined()
  h.files.set('/work/AGENTS.md', '# no exceptions\n')
  await $.tool.call({ tool: 'Write', file_path: '/work/AGENTS.md', content: '# no exceptions\n' })
  h.readOnce.set(FILE, 'a\n')
  const reported = await $.tool.call({ tool: 'Edit', file_path: FILE, old_string: 'a', new_string: 'function handle(input: any) {}' })
  expect(reported.context).toEqual([expect.stringContaining('top-type')])
})

// A session that entered a worktree keeps editing files under it; the scan finds the folder each file belongs to.
const WORKTREE = '/work/.claude/worktrees/x'
const WORKTREE_FILE = `${WORKTREE}/src/a.ts`
const HANDLE = 'function handle(input: any) {}'

test('an allow line in the worktree\'s own AGENTS.md applies to the worktree files and not to the session folder\'s', async ($, on) => {
  const h = harness(on)
  h.control.root = WORKTREE
  await boot($, 'off')
  h.files.set(`${WORKTREE}/AGENTS.md`, 'anti-slop allow: top-type\n')
  h.readOnce.set(WORKTREE_FILE, 'a\n')
  h.files.set(WORKTREE_FILE, `${HANDLE}\n`)
  const inWorktree = await $.tool.call({ tool: 'Edit', file_path: WORKTREE_FILE, old_string: 'a', new_string: HANDLE })
  expect(inWorktree.context).toBeUndefined()
  h.readOnce.set('/work/src/b.ts', 'a\n')
  h.files.set('/work/src/b.ts', `${HANDLE}\n`)
  const inSession = await $.tool.call({ tool: 'Edit', file_path: '/work/src/b.ts', old_string: 'a', new_string: HANDLE })
  expect(inSession.context).toEqual([expect.stringContaining('top-type')])
})

test('an allow line in the session folder\'s AGENTS.md still applies to a worktree file', async ($, on) => {
  const h = harness(on)
  h.control.root = WORKTREE
  await boot($, 'off')
  h.files.set('/work/AGENTS.md', 'anti-slop allow: top-type\n')
  h.readOnce.set(WORKTREE_FILE, 'a\n')
  h.files.set(WORKTREE_FILE, `${HANDLE}\n`)
  const reply = await $.tool.call({ tool: 'Edit', file_path: WORKTREE_FILE, old_string: 'a', new_string: HANDLE })
  expect(reply.context).toBeUndefined()
})

test('the note for a worktree file shows the path inside the worktree', async ($, on) => {
  const h = harness(on)
  h.control.root = WORKTREE
  await boot($, 'off')
  h.readOnce.set(WORKTREE_FILE, 'a\n')
  h.files.set(WORKTREE_FILE, `${HANDLE}\n`)
  const reply = await $.tool.call({ tool: 'Edit', file_path: WORKTREE_FILE, old_string: 'a', new_string: HANDLE })
  expect(reply.context).toEqual([expect.stringContaining('- src/a.ts:1 top-type')])
  expect(reply.context?.[0]).not.toContain('.claude/worktrees')
})

test('editing the worktree\'s AGENTS.md is read again for the next worktree edit', async ($, on) => {
  const h = harness(on)
  h.control.root = WORKTREE
  await boot($, 'off')
  h.files.set(`${WORKTREE}/AGENTS.md`, 'anti-slop allow: top-type\n')
  h.readOnce.set(WORKTREE_FILE, 'a\n')
  h.files.set(WORKTREE_FILE, `${HANDLE}\n`)
  const allowed = await $.tool.call({ tool: 'Edit', file_path: WORKTREE_FILE, old_string: 'a', new_string: HANDLE })
  expect(allowed.context).toBeUndefined()
  h.files.set(`${WORKTREE}/AGENTS.md`, '# no exceptions\n')
  await $.tool.call({ tool: 'Write', file_path: `${WORKTREE}/AGENTS.md`, content: '# no exceptions\n' })
  h.readOnce.set(WORKTREE_FILE, 'a\n')
  const reported = await $.tool.call({ tool: 'Edit', file_path: WORKTREE_FILE, old_string: 'a', new_string: HANDLE })
  expect(reported.context).toEqual([expect.stringContaining('top-type')])
})
