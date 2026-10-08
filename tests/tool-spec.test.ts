import { expect, test } from 'claude-code/testing'
import { INPUT_SCHEMA, TOOL_DESCRIPTION, TOOL_DESCRIPTION_LIMIT } from '../hooks/engine/tool-spec.ts'

test('the dag tool description fits within what Claude Code passes to the model', () => {
  expect(TOOL_DESCRIPTION.length).toBeLessThanOrEqual(TOOL_DESCRIPTION_LIMIT)
})

test('the dag tool description keeps the settle and verification rules', () => {
  expect(TOOL_DESCRIPTION).toContain('Do not poll')
  expect(TOOL_DESCRIPTION).toContain('Treat node completion claims as false until you verify them')
  expect(TOOL_DESCRIPTION).toContain('Every node needs verify')
})

test('the dag tool description names every action', () => {
  for (const action of INPUT_SCHEMA.properties.action.enum) expect(TOOL_DESCRIPTION).toContain(action)
})
