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

test('the dag tool description tells the model start also takes a definition file path', () => {
  expect(TOOL_DESCRIPTION).toContain('start {definition} or start {path}')
  expect(TOOL_DESCRIPTION).toContain('.yaml/.yml/.json')
})

test('the dag tool schema declares a string path for start, and the definition stays optional', () => {
  expect(INPUT_SCHEMA.properties.path.type).toBe('string')
  expect(INPUT_SCHEMA.properties.path.description).toContain('start only')
  expect(INPUT_SCHEMA.properties.path.description).toContain('.yaml, .yml or .json')
  expect(INPUT_SCHEMA.required).toEqual(['action'])
})
