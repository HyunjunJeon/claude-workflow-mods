import { expect, test } from 'claude-code/testing'
import { boot, harness } from './control-harness.ts'

const FILE = '/work/src/a.ts'

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
