import { expect, test } from 'claude-code/testing'
import { readOnlyDisagreement } from '../hooks/engine/policy.ts'
import { boot, harness } from './control-harness.ts'

const NONE = new Set<string>()

test('isReadOnly from the host is compared with the plugin judgment and only a difference gives a line', () => {
  const cases: { name: string; tool: string; input: Record<string, unknown>; host: boolean; expected: string | undefined }[] = [
    {
      name: 'host read-only, plugin refuses the Bash command',
      tool: 'Bash', input: { command: 'python3 -c "print(1)"' }, host: true,
      expected: 'read-only disagreement: Bash host=read-only plugin=refused: python3 is not on the read-only command list',
    },
    {
      name: 'host silent, plugin holds the Bash command read-only',
      tool: 'Bash', input: { command: 'git status' }, host: false,
      expected: 'read-only disagreement: Bash host=not stated plugin=read-only',
    },
    {
      name: 'host read-only, plugin refuses a tool outside the main-loop list',
      tool: 'WebSearch2', input: {}, host: true,
      expected: 'read-only disagreement: WebSearch2 host=read-only plugin=refused: WebSearch2 changes state or delegates work',
    },
    { name: 'both read-only Bash', tool: 'Bash', input: { command: 'ls -la' }, host: true, expected: undefined },
    { name: 'both refuse Bash', tool: 'Bash', input: { command: 'npm install left-pad' }, host: false, expected: undefined },
    { name: 'both refuse another tool', tool: 'Edit', input: { file_path: '/a', old_string: 'a', new_string: 'b' }, host: false, expected: undefined },
    { name: 'a main-loop tool is not compared', tool: 'Read', input: { file_path: '/a' }, host: false, expected: undefined },
  ]
  for (const c of cases) expect(`${c.name}: ${readOnlyDisagreement(c.tool, c.input, c.host, NONE)}`).toBe(`${c.name}: ${c.expected}`)
})

test('the refusal reason in the line stops at 80 characters', () => {
  const line = readOnlyDisagreement('Bash', { command: `${'x'.repeat(200)} --version extra` }, true, NONE)
  expect(line?.length).toBeLessThanOrEqual('read-only disagreement: Bash host=read-only plugin=refused: '.length + 80)
})

test('a disagreeing main-conversation check logs one debug line and the verdict stays', async ($, on) => {
  const h = harness(on)
  on('tool.check', () => ({ decision: 'allow' }))
  await boot($)
  const input = { command: 'python3 -c "print(1)"' }
  const plain = await $.tool.check({ tool: 'Bash', input })
  // SAFETY: the host sends isReadOnly on tool.check from 2.1.304; the installed type declarations may predate it, so only the event type is widened.
  const hostSaidReadOnly = await $.tool.check({ tool: 'Bash', input, isReadOnly: true } as Parameters<typeof $.tool.check>[0])
  expect(hostSaidReadOnly).toEqual(plain)
  const lines = h.logs.filter(log => log.includes('read-only disagreement'))
  expect(lines).toEqual(['dag-workflow: read-only disagreement: Bash host=read-only plugin=refused: python3 is not on the read-only command list'])
  const call = await $.tool.call({ tool: 'Bash', command: 'python3 -c "print(1)"' })
  expect(call.deny).toContain('not read-only')
})
