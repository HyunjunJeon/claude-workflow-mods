import { expect, test } from 'claude-code/testing'
import { lintDefinition } from '../hooks/engine/lint.ts'
import { previewDefinition } from '../hooks/engine/preview.ts'
import type { Definition, NodeDef } from '../hooks/engine/types.ts'

const full = 'TASK: do it. DELIVERABLE: x. SCOPE: y. VERIFY: z. STOP WHEN: done.'
const node = (id: string, dependsOn: string[] = [], extra: Partial<NodeDef> = {}): NodeDef => ({ id, prompt: full, dependsOn, ...extra })
const def = (nodes: NodeDef[]): Definition => ({ key: 'k', name: 'n', goal: 'a fixture goal', nodes })
const preview = (nodes: NodeDef[], maxConcurrent = 4) => previewDefinition(def(nodes), { maxConcurrent })
const diamond = () => [node('a'), node('b', ['a']), node('c', ['a']), node('d', ['b', 'c'])]

test('a diamond previews in three waves numbered from one', async () => {
  const p = preview(diamond())
  expect(p.waves).toEqual([['a'], ['b', 'c'], ['d']])
  expect(Object.fromEntries(p.nodes.map(n => [n.id, n.wave]))).toEqual({ a: 1, b: 2, c: 2, d: 3 })
  expect(p.node_count).toBe(4)
})

test('the critical path is the longest dependsOn chain, root first', async () => {
  const p = preview([node('a'), node('side', ['a']), node('b', ['a']), node('c', ['b']), node('d', ['c'])])
  expect(p.critical_path).toEqual(['a', 'b', 'c', 'd'])
})

test('equally long chains tie to the one defined first', async () => {
  const p = preview([node('a'), node('b'), node('c', ['a']), node('d', ['b'])])
  expect(p.critical_path).toEqual(['a', 'c'])
})

test('a single node is its own critical path', async () => {
  expect(preview([node('only')]).critical_path).toEqual(['only'])
})

test('a final audit proposed as quick previews as unspecified-low on sonnet', async () => {
  const nodes = [node('a'), node('b'), node('final-audit', ['a', 'b'], { category: 'quick' })]
  const audit = preview(nodes).nodes.find(n => n.id === 'final-audit')
  expect(audit?.category).toBe('unspecified-low')
  expect(audit?.model).toBe('sonnet')
})

test('a final audit without a category is treated as quick and shown as unspecified-low', async () => {
  const audit = preview([node('a'), node('b'), node('verify-all', ['a', 'b'])]).nodes.find(n => n.id === 'verify-all')
  expect(audit?.category).toBe('unspecified-low')
})

test('a node that is not a final audit keeps quick and an unset category shows quick', async () => {
  const p = preview([node('a', [], { category: 'quick' }), node('b')])
  expect(p.nodes.map(n => [n.category, n.model])).toEqual([['quick', 'sonnet'], ['quick', 'sonnet']])
})

test('unspecified-high previews on opus and an unregistered category on sonnet', async () => {
  const p = preview([node('a', [], { category: 'unspecified-high' }), node('b', [], { category: 'made-up' })])
  expect(p.nodes.map(n => [n.category, n.model])).toEqual([['unspecified-high', 'opus'], ['made-up', 'sonnet']])
})

test('a node reports its agent, dependencies, check count, writes and skills', async () => {
  const p = preview([
    node('a'),
    node('b', ['a'], {
      agent: 'reviewer',
      writes: ['src/'],
      load_skills: ['dag-workflow:testing'],
      verify: [{ kind: 'file', path: 'src/x.ts', contains: 'x' }, { kind: 'command', argv: ['bun', 'test'] }],
    }),
  ])
  expect(p.nodes[0]).toEqual({ id: 'a', wave: 1, category: 'quick', model: 'sonnet', agent: 'general-purpose', depends_on: [], checks: 0, writes: null, load_skills: [] })
  expect(p.nodes[1]).toEqual({
    id: 'b',
    wave: 2,
    category: 'quick',
    model: 'sonnet',
    agent: 'reviewer',
    depends_on: ['a'],
    checks: 2,
    writes: ['src/'],
    load_skills: ['dag-workflow:testing'],
  })
})

test('parallel nodes writing a folder and a file inside it conflict on the more specific path', async () => {
  const p = preview([node('a', [], { writes: ['hooks/'] }), node('b', [], { writes: ['hooks/register.ts'] })])
  expect(p.write_conflicts).toEqual([{ a: 'a', b: 'b', paths: ['hooks/register.ts'] }])
})

test('parallel nodes writing the same file conflict on that file', async () => {
  const p = preview([node('a', [], { writes: ['README.md'] }), node('b', [], { writes: ['README.md'] })])
  expect(p.write_conflicts).toEqual([{ a: 'a', b: 'b', paths: ['README.md'] }])
})

test('nodes ordered through a transitive dependency do not conflict', async () => {
  const p = preview([node('a', [], { writes: ['src/'] }), node('b', ['a']), node('c', ['b'], { writes: ['src/x.ts'] })])
  expect(p.write_conflicts).toEqual([])
})

test('nodes in different waves with no path between them still conflict', async () => {
  const p = preview([node('a'), node('b', ['a']), node('c', ['b']), node('d', [], { writes: ['src/'] }), node('e', ['c'], { writes: ['src/x.ts'] })])
  expect(p.write_conflicts).toEqual([{ a: 'd', b: 'e', paths: ['src/x.ts'] }])
})

test('disjoint paths and an undeclared scope never conflict', async () => {
  const p = preview([
    node('a', [], { writes: ['hooks/'] }),
    node('b', [], { writes: ['hooks2/x.ts', 'tests/'] }),
    node('c'),
    node('d', [], { writes: [] }),
  ])
  expect(p.write_conflicts).toEqual([])
})

test('paths are normalized before they are compared', async () => {
  const p = preview([node('a', [], { writes: ['./src/'] }), node('b', [], { writes: ['src/a.ts'] })])
  expect(p.write_conflicts).toEqual([{ a: 'a', b: 'b', paths: ['src/a.ts'] }])
})

test('the project root overlaps every declared path', async () => {
  const p = preview([node('a', [], { writes: ['.'] }), node('b', [], { writes: ['docs/guide.md'] })])
  expect(p.write_conflicts).toEqual([{ a: 'a', b: 'b', paths: ['docs/guide.md'] }])
})

test('conflicts list pairs in definition order with duplicate paths folded', async () => {
  const p = preview([
    node('p', [], { writes: ['src/', 'src/x.ts'] }),
    node('q', [], { writes: ['src/x.ts'] }),
    node('r', [], { writes: ['src/'] }),
  ])
  expect(p.write_conflicts).toEqual([
    { a: 'p', b: 'q', paths: ['src/x.ts'] },
    { a: 'p', b: 'r', paths: ['src', 'src/x.ts'] },
    { a: 'q', b: 'r', paths: ['src/x.ts'] },
  ])
})

test('warnings are the lint warnings of the definition', async () => {
  const noGoal: Definition = { key: 'k', name: 'n', nodes: [node('a', [], { writes: ['x.ts'], verify: [{ kind: 'command', argv: ['true'] }] }), node('b')] }
  const p = previewDefinition(noGoal, { maxConcurrent: 4 })
  expect(p.warnings).toEqual(lintDefinition(noGoal))
  expect(p.warnings.length).toBeGreaterThan(0)
  expect(preview(diamond()).warnings).toEqual(lintDefinition(def(diamond())))
})

test('an undeclared scope previews as writes null and is listed as unchecked when it has a parallel peer', async () => {
  const p = preview([node('a'), node('b', [], { writes: ['src/'] })])
  expect(p.nodes.map(n => n.writes)).toEqual([null, ['src/']])
  expect(p.unchecked_writes).toEqual(['a'])
  expect(p.write_conflicts).toEqual([])
})

test('writes [] is a declared read-only scope: it previews as [] and is not unchecked', async () => {
  const p = preview([node('a', [], { writes: [] }), node('b', [], { writes: ['src/'] })])
  expect(p.nodes.map(n => n.writes)).toEqual([[], ['src/']])
  expect(p.unchecked_writes).toEqual([])
})

test('a node ordered before or after every other node is not unchecked', async () => {
  expect(preview([node('only')]).unchecked_writes).toEqual([])
  expect(preview([node('a'), node('b', ['a']), node('c', ['b'])]).unchecked_writes).toEqual([])
})

test('unchecked nodes keep definition order and count peers in other waves', async () => {
  const p = preview([node('x'), node('y', ['x']), node('z'), node('w', ['z'], { writes: ['docs/'] })])
  expect(p.unchecked_writes).toEqual(['x', 'y', 'z'])
})

test('a diamond of undeclared scopes lists only the two nodes that run side by side', async () => {
  expect(preview(diamond()).unchecked_writes).toEqual(['b', 'c'])
})

test('the preview carries the routing note that Jev may reroute', async () => {
  expect(preview([node('a')]).routing_note).toBe('category and model are the definition\'s proposal after the final-audit rule; Jev may reroute a node when the run starts.')
})

test('an unknown category adds a warning after the lint warnings and still previews on sonnet', async () => {
  const nodes = [node('a', [], { category: 'deep-hgih' }), node('b', ['a'])]
  const p = preview(nodes)
  expect(p.nodes[0]?.model).toBe('sonnet')
  expect(p.warnings.slice(0, -1)).toEqual(lintDefinition(def(nodes)))
  expect(p.warnings.at(-1)).toBe('node "a": category "deep-hgih" is not a known category; it runs on sonnet.')
})

test('known categories, an unset category and the final-audit rule add no category warning', async () => {
  const nodes = [node('a', [], { category: 'architect' }), node('b', [], { category: 'deep-low' }), node('c'), node('final-audit', ['a', 'b', 'c'], { category: 'quick' })]
  expect(preview(nodes).warnings).toEqual(lintDefinition(def(nodes)))
})

test('widest_wave is the size of the largest wave and max_concurrent echoes the option', async () => {
  const p = preview([node('a'), node('b'), node('c'), node('d', ['a', 'b', 'c']), node('e', ['d'])], 2)
  expect(p.widest_wave).toBe(3)
  expect(p.max_concurrent).toBe(2)
  expect(preview(diamond(), 7).widest_wave).toBe(2)
  expect(preview(diamond(), 7).max_concurrent).toBe(7)
})
