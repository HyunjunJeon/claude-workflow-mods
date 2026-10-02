import { expect, test } from 'claude-code/testing'
import { parseDefinition } from '../hooks/engine/definition.ts'
import { parseYaml, YamlError } from '../hooks/engine/yaml.ts'

const DAG_YAML = `# A fan-in review
key: review-fan-in
name: "Review: fan in"
nodes:
  - id: navigation
    category: quick
    prompt: Audit the navigation module.
  - id: gate-wiring
    label: 'Gate wiring'
    load_skills: [code-review, "security"]
    prompt: |
      Check every gate is wired.
      Report each missing one.
  - id: verify   # runs last
    dependsOn:
      - navigation
      - gate-wiring
    prompt: >-
      Verify the evidence
      from both audits.
`

test('a DAG definition written in YAML parses into the same shape as JSON', async () => {
  const value = parseYaml(DAG_YAML)
  expect(value).toEqual({
    key: 'review-fan-in',
    name: 'Review: fan in',
    nodes: [
      { id: 'navigation', category: 'quick', prompt: 'Audit the navigation module.' },
      { id: 'gate-wiring', label: 'Gate wiring', load_skills: ['code-review', 'security'], prompt: 'Check every gate is wired.\nReport each missing one.\n' },
      { id: 'verify', dependsOn: ['navigation', 'gate-wiring'], prompt: 'Verify the evidence from both audits.' },
    ],
  })
  const parsed = parseDefinition(value)
  expect(parsed.ok).toBe(true)
})

test('scalars, empty values and keys with sequences at the same indent', async () => {
  expect(parseYaml('a: 1\nb: true\nc: ~\nd:\ne: "x # not a comment"\nf: it\'s\n')).toEqual({ a: 1, b: true, c: null, d: null, e: 'x # not a comment', f: "it's" })
  expect(parseYaml('deps:\n- a\n- b\nnext: []\n')).toEqual({ deps: ['a', 'b'], next: [] })
  expect(parseYaml("q: 'say ''hi'''\n")).toEqual({ q: "say 'hi'" })
})

test('a block scalar right after a sequence item key reads its own lines', async () => {
  expect(parseYaml('nodes:\n  - prompt: |\n      line one\n      line two\n    id: a\n')).toEqual({ nodes: [{ prompt: 'line one\nline two\n', id: 'a' }] })
})

test('block scalars honour chomping indicators', async () => {
  expect(parseYaml('a: |\n  one\n\n  two\n\nb: x\n')).toEqual({ a: 'one\n\ntwo\n', b: 'x' })
  expect(parseYaml('a: |-\n  one\n')).toEqual({ a: 'one' })
  expect(parseYaml('a: >\n  one\n  two\n\n  three\n')).toEqual({ a: 'one two\nthree\n' })
})

test('malformed YAML reports the line and the problem', async () => {
  const message = (source: string) => {
    try {
      parseYaml(source)
      return 'parsed'
    } catch (error) {
      return error instanceof YamlError ? error.message : `unexpected ${String(error)}`
    }
  }
  expect(message('a: 1\n  b: 2\n')).toContain('line 2')
  expect(message('a: 1\na: 2\n')).toBe('YAML line 2: duplicate key "a"')
  expect(message('a: {b: 1}\n')).toContain('flow mappings')
  expect(message('a:\n\tb: 1\n')).toContain('tabs')
  expect(message('just a sentence\n')).toContain('expected "key: value"')
})
