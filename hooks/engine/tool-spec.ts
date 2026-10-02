import { CATEGORIES } from './node-prompt.ts'

export const TOOL_DESCRIPTION = [
  'The only way to get work done in this session: plan the task as a dependency-ordered DAG of subagent nodes and run it here (like omo mass-ulw).',
  'A definition has a stable "key" (idempotency: starting the same key and definition again returns the existing run; a different definition under an old key is refused),',
  'a "name", an optional "goal" (the overall objective, shown to every node) and "nodes".',
  'Each node has an "id", a self-contained "prompt" saying what to do and what to produce, optional "dependsOn" (node ids that must complete first),',
  `optional "category" for model routing (${CATEGORIES.join(', ')}), optional "agent" (a subagent type such as Explore), "label", "task_summary" and "load_skills".`,
  'Every node automatically receives the outputs of the nodes in its dependsOn, so list as dependencies exactly the nodes whose results it needs.',
  'Ready nodes run in parallel waves; a failed node skips its dependents. Each node\'s full report is saved and its output reaches its dependents and the final summary.',
  'Actions: start {definition}; list; snapshot {run_id}; wait {run_id} (returns the current snapshot, it cannot block);',
  'cancel {run_id, reason}; retry {run_id, node_id|node_ids, prompt} (failed/cancelled nodes and their skipped dependents; completed nodes are reused);',
  'amend {run_id, definition} (re-runs only changed nodes and their dependents; also adds nodes); send {run_id, node_id, message} (steer a running node); attach {run_id} (adopt a run from another session).',
  'start returns at once. Do not poll: you receive a summary with every node\'s output when the run settles. Treat node completion claims as false until you verify them.',
].join(' ')

const NODE_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: '1-64 letters, digits, "_", "-" or "."' },
    prompt: { type: 'string', description: 'Self-contained English task for the node agent, including what it must produce' },
    dependsOn: { type: 'array', items: { type: 'string' }, description: 'Nodes that must complete first; their outputs are passed to this node' },
    category: { type: 'string' },
    agent: { type: 'string' },
    label: { type: 'string' },
    task_summary: { type: 'string' },
    description: { type: 'string' },
    load_skills: { type: 'array', items: { type: 'string' } },
  },
  required: ['id', 'prompt'],
}

export const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['start', 'list', 'snapshot', 'wait', 'cancel', 'retry', 'amend', 'send', 'attach'] },
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
    run_id: { type: 'string' },
    node_id: { type: 'string' },
    node_ids: { type: 'array', items: { type: 'string' } },
    prompt: { type: 'string' },
    message: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['action'],
}
