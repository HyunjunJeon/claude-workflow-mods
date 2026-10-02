import { expect, test } from 'claude-code/testing'
import { classifyShape, shapeOf } from '../eval/shape.ts'
import { parseDefinition } from '../hooks/engine/definition.ts'
import type { Definition } from '../hooks/engine/types.ts'

function graph(edges: Record<string, string[]>): Definition {
  const parsed = parseDefinition({ key: 'g', nodes: Object.entries(edges).map(([id, dependsOn]) => ({ id, prompt: 'p', dependsOn })) })
  if (!parsed.ok) throw new Error(parsed.error.message)
  return parsed.value
}

test('each topology gets its own shape class', async () => {
  const shape = (edges: Record<string, string[]>) => classifyShape(graph(edges).nodes)
  expect(shape({ a: [] })).toBe('single')
  expect(shape({ a: [], b: [], c: [] })).toBe('parallel')
  expect(shape({ a: [], b: ['a'], c: ['b'] })).toBe('chain')
  expect(shape({ a: [], b: ['a'], c: ['a'], d: ['b', 'c'] })).toBe('diamond')
  expect(shape({ a: [], b: [], c: [], d: ['a', 'b', 'c'] })).toBe('fan-out/fan-in')
  expect(shape({ a: [], b: ['a'], c: ['a'] })).toBe('fan-out')
  expect(shape({ a: [], b: ['a'], c: [], d: ['c'] })).toBe('mixed')
})

test('metrics report widths, joins and the producer shape without the verification node', async () => {
  const m = shapeOf(graph({ fix1: [], fix2: [], fix3: [], verify: ['fix1', 'fix2', 'fix3'] }))
  expect(m).toMatchObject({ nodes: 4, edges: 3, depth: 2, widths: [3, 1], maxWidth: 3, fanInNodes: 1, verify: true, shape: 'fan-out/fan-in', producerShape: 'parallel' })
  expect(m.categories).toEqual({ '(session)': 4 })
  expect(m.warnings).toBe(4)
  expect(shapeOf(graph({ build: [], verify: ['build'] })).producerShape).toBe('single')
})
