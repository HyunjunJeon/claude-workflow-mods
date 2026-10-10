import { findCycle } from './graph.ts'
import { hash, stableStringify } from './hash.ts'
import { expandStages } from './stages.ts'
import { fail, type Definition, type NodeDef, type Result } from './types.ts'
import { parseChecks, projectPath } from './verification.ts'

const NODE_ID = /^[A-Za-z0-9_.-]{1,64}$/
const OPTIONAL_TEXT = ['category', 'agent', 'label', 'task_summary', 'description'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function parseNode(raw: unknown, index: number): Result<NodeDef> {
  if (!isRecord(raw)) return fail('invalid_node', `nodes[${index}] must be an object.`)
  const { id, prompt, dependsOn = [], load_skills } = raw
  if (typeof id !== 'string' || !NODE_ID.test(id)) {
    return fail('invalid_node', `nodes[${index}].id must be 1-64 letters, digits, "_", "-" or ".".`)
  }
  if (typeof prompt !== 'string' || prompt.trim() === '') return fail('invalid_node', `Node "${id}" needs a non-empty prompt.`)
  if (!isStringArray(dependsOn)) return fail('invalid_node', `Node "${id}": dependsOn must be an array of node ids.`)
  if (load_skills !== undefined && !isStringArray(load_skills)) {
    return fail('invalid_node', `Node "${id}": load_skills must be an array of skill names.`)
  }
  const node: NodeDef = { id, prompt, dependsOn: [...new Set(dependsOn)] }
  for (const field of OPTIONAL_TEXT) {
    const value = raw[field]
    if (value === undefined) continue
    if (typeof value !== 'string') return fail('invalid_node', `Node "${id}": ${field} must be a string.`)
    if (value.trim() !== '') node[field] = value.trim()
  }
  if (node.agent === 'fork') {
    return fail('invalid_node', `Node "${id}": fork inherits its parent model and cannot enforce the Sonnet worker minimum; use a non-fork agent type.`)
  }
  if (load_skills !== undefined && load_skills.length > 0) node.load_skills = load_skills
  if (raw.verify !== undefined) {
    const parsed = parseChecks(raw.verify)
    if (!parsed.ok) return parsed
    node.verify = parsed.value
  }
  if (raw.writes !== undefined) {
    if (!isStringArray(raw.writes) || !raw.writes.every(projectPath)) return fail('invalid_node', `Node "${id}": writes must be project-relative paths outside .claude.`)
    node.writes = [...new Set(raw.writes)]
  }
  return { ok: true, value: node }
}

export function parseDefinition(input: unknown): Result<Definition> {
  if (!isRecord(input)) return fail('invalid_definition', 'The definition must be an object with "key" and "nodes".')
  const { key, name, goal, nodes } = input
  if (typeof key !== 'string' || key.trim() === '') return fail('invalid_definition', 'definition.key must be a non-empty string.')
  if (name !== undefined && typeof name !== 'string') return fail('invalid_definition', 'definition.name must be a string.')
  if (goal !== undefined && typeof goal !== 'string') return fail('invalid_definition', 'definition.goal must be a string.')
  if (!Array.isArray(nodes) || nodes.length === 0) return fail('invalid_definition', 'definition.nodes must be a non-empty array.')

  const parsed: NodeDef[] = []
  const ids = new Set<string>()
  for (const [index, raw] of nodes.entries()) {
    const node = parseNode(raw, index)
    if (!node.ok) return node
    if (ids.has(node.value.id)) return fail('duplicate_node', `Duplicate node id "${node.value.id}".`)
    ids.add(node.value.id)
    parsed.push(node.value)
  }
  for (const node of parsed) {
    for (const dep of node.dependsOn) {
      if (dep === node.id) return fail('invalid_dependency', `Node "${node.id}" depends on itself.`)
      if (!ids.has(dep)) return fail('unknown_dependency', `Node "${node.id}" depends on unknown node "${dep}".`)
    }
  }
  const cycle = findCycle(parsed)
  if (cycle) return fail('cycle', `Dependency cycle: ${cycle.join(' -> ')}.`)

  const trimmedKey = key.trim()
  const trimmedGoal = goal?.trim()
  // review and commit expand into ordinary nodes after the user's nodes are valid, so a user node can never depend on a
  // generated one. The expansion is a pure function of this input, so the same input gives the same nodes and fingerprints:
  // an amend sends the original review and commit fields with the user's nodes, never the generated nodes.
  return expandStages(
    { key: trimmedKey, name: name?.trim() || trimmedKey, ...(trimmedGoal ? { goal: trimmedGoal } : {}), nodes: parsed },
    { review: input.review, commit: input.commit },
  )
}

export function definitionHash(definition: Definition): string {
  return hash(stableStringify(definition))
}

export function nodeFingerprint(node: NodeDef): string {
  return hash(stableStringify({
    prompt: node.prompt,
    category: node.category ?? null,
    agent: node.agent ?? null,
    dependsOn: [...node.dependsOn].sort(),
    verify: node.verify ?? null,
    writes: node.writes ?? null,
  }))
}
