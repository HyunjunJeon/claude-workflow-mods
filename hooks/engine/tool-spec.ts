import { CATEGORIES } from './node-prompt.ts'

// Claude Code passes the model only the first 2048 characters of a tool description, so the
// rules come first and tests/tool-spec.test.ts keeps the whole text under that limit.
export const TOOL_DESCRIPTION_LIMIT = 2048

export const TOOL_DESCRIPTION = [
  'The only way to get work done in this session: plan the task as a dependency-ordered DAG of subagent nodes and run it here.',
  'start returns at once. Do not poll: when the run settles you receive a summary with every node\'s output. Treat node completion claims as false until you verify them.',
  'Every node needs verify: one or more {kind:"file",path,contains?} or {kind:"command",argv:[...]} checks, run by the plugin before the node completes; start/amend refuse nodes without them.',
  'A node receives the outputs of the nodes in its dependsOn, so list exactly the nodes whose results it needs. Ready nodes run in parallel waves; a failed node skips its dependents.',
  'Definition: "key" (same key and definition returns the existing run; a different definition under that key is refused), "name", optional "goal" (shown to every node) and "nodes".',
  'Node: "id", a self-contained "prompt" saying what to do and produce, optional "dependsOn", "category" (model routing; Jev may override it), "agent" (subagent type such as Explore), "writes" (project-relative paths, for session conflict display), "label", "task_summary", "load_skills".',
  'Actions: start {definition} or start {path} (a project-relative .yaml/.yml/.json definition file); start {..., dryRun:true} validates and previews waves, models, write conflicts and warnings, starting nothing; list; context; decisions; sessions; snapshot {run_id}; wait {run_id} (current snapshot, never blocks); cancel {run_id, reason};',
  'retry {run_id, node_id|node_ids, prompt} (failed/cancelled nodes and their skipped dependents; completed nodes are reused); amend {run_id, definition} (re-runs changed nodes and their dependents, adds nodes);',
  'send {run_id, node_id, message} (steer a running node); attach {run_id} (adopt a run from another session).',
].join(' ')

const NODE_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: '1-64 letters, digits, "_", "-" or "."' },
    prompt: { type: 'string', description: 'Self-contained English task for the node agent, including what it must produce' },
    dependsOn: { type: 'array', items: { type: 'string' }, description: 'Nodes that must complete first; their outputs are passed to this node' },
    category: { type: 'string', description: `Model routing: ${CATEGORIES.join(', ')}` },
    agent: { type: 'string' },
    label: { type: 'string' },
    task_summary: { type: 'string' },
    description: { type: 'string' },
    load_skills: { type: 'array', items: { type: 'string' } },
    writes: { type: 'array', items: { type: 'string' }, description: 'Project-relative write scopes; [] for read-only work' },
    verify: {
      type: 'array',
      minItems: 1,
      maxItems: 16,
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['file', 'command'] },
          path: { type: 'string' },
          contains: { type: 'string' },
          argv: { type: 'array', items: { type: 'string' } },
        },
        required: ['kind'],
      },
    },
  },
  required: ['id', 'prompt'],
}

export const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['start', 'list', 'context', 'decisions', 'sessions', 'snapshot', 'wait', 'cancel', 'retry', 'amend', 'send', 'attach'] },
    definition: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        name: { type: 'string' },
        goal: { type: 'string', description: 'The overall objective; every node sees it' },
        nodes: { type: 'array', items: NODE_SCHEMA },
      },
      required: ['key', 'nodes'],
    },
    path: { type: 'string', description: 'start only: project-relative .yaml, .yml or .json definition file, instead of definition' },
    dryRun: { type: 'boolean', description: 'start only: true previews the definition (waves, critical path, models, write conflicts, warnings) and starts nothing' },
    run_id: { type: 'string' },
    node_id: { type: 'string' },
    node_ids: { type: 'array', items: { type: 'string' } },
    prompt: { type: 'string' },
    message: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['action'],
}
