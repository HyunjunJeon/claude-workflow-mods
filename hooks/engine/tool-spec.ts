import { CATEGORIES } from './node-prompt.ts'
import { TEXT_FIELDS, type TextField } from './types.ts'

// Claude Code passes the model only the first 2048 characters of a tool description, so the
// rules come first and tests/tool-spec.test.ts keeps the whole text under that limit.
export const TOOL_DESCRIPTION_LIMIT = 2048

export const TOOL_DESCRIPTION = [
  'The only way to get work done in this session: plan the task as a dependency-ordered DAG of subagent nodes and run it here.',
  'start returns at once. Do not poll: when the run settles you receive a summary with every node\'s output. Treat node completion claims as false until you verify them.',
  'Every node needs verify: 1-16 checks run by the plugin before the node completes, {kind:"file",path,contains?|absent?|matches?|lastLine?|equals?} (path relative, or absolute read-only; a folder allows contains/absent) or {kind:"command",argv,expect?:{exit,stdout,stderr}} (exit 0 unless expect.exit); start/amend refuse nodes without them.',
  'A node receives the outputs of the nodes in its dependsOn, so list exactly the nodes whose results it needs. Ready nodes run in parallel waves; a failed node skips its dependents.',
  'Definition: "key" (same key and definition returns the existing run; a different definition under that key is refused), "name", optional "goal" (shown to every node) and "nodes".',
  '"review":{request} and "commit":[{message,paths}] add the review pair and a commit node.',
  'Node: "id", a self-contained "prompt" saying what to do and produce, optional "dependsOn", "category" (model routing; Jev may override it), "agent" (subagent type such as Explore), "writes" (project-relative paths, for session conflict display), "label", "task_summary", "load_skills".',
  'Actions: start {definition} or start {path} (a project-relative .yaml/.yml/.json definition file); start {..., dryRun:true} validates and previews waves, models, write conflicts and warnings, starting nothing; list; context; decisions; sessions; snapshot {run_id}; wait {run_id} (current snapshot, never blocks); cancel {run_id, reason};',
  'retry {run_id, node_id|node_ids, prompt} (failed/cancelled nodes and their skipped dependents; completed nodes are reused); amend {run_id, definition} (re-runs changed nodes and their dependents, adds nodes);',
  'send {run_id, node_id, message} (steer a running node); attach {run_id} (adopt a run from another session).',
].join(' ')

// Keyed by TextField, so a field added to TEXT_FIELDS does not compile until it is described here.
const TEXT_FIELD_DESCRIPTIONS: Record<TextField, string> = {
  contains: 'The text includes this',
  absent: 'The text does not include this',
  matches: 'JavaScript RegExp source, m flag (^ and $ anchor lines)',
  lastLine: 'The last line, trailing whitespace removed, equals this',
  equals: 'The whole text, trailing whitespace removed, equals this',
}

// The text expectations of a file check, and of a command's stdout or stderr; every given field must hold.
const TEXT_EXPECT_PROPERTIES = Object.fromEntries(TEXT_FIELDS.map(field => [field, { type: 'string', description: TEXT_FIELD_DESCRIPTIONS[field] }]))

const EXIT_CODE = { type: 'integer', minimum: 0, maximum: 255 }

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
          path: { type: 'string', description: 'file: project-relative, or absolute for a read-only check outside the project' },
          ...TEXT_EXPECT_PROPERTIES,
          argv: { type: 'array', items: { type: 'string' }, description: 'command: run without a shell from the project root' },
          expect: {
            type: 'object',
            description: 'command: without exit only 0 passes',
            properties: {
              exit: { anyOf: [EXIT_CODE, { type: 'array', items: EXIT_CODE, minItems: 1 }], description: 'Accepted exit code or codes' },
              stdout: { type: 'object', properties: TEXT_EXPECT_PROPERTIES },
              stderr: { type: 'object', properties: TEXT_EXPECT_PROPERTIES },
            },
          },
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
        review: {
          type: 'object',
          description: 'Adds review-spec and review-standards after every node; amend sends this field again, never the generated nodes',
          properties: {
            request: { type: 'string', description: 'The user\'s request, verbatim; review-spec judges the change against it' },
            notes: { type: 'string', description: 'Absolute folder for the notes files; default /tmp/dag-review/<key>-<6 hex digits of its hash>' },
            category: { type: 'string', description: 'The reviewers\' category; default unspecified-low' },
            rules: { type: 'array', items: { type: 'string' }, description: 'Rule file paths review-standards reads first; it still searches for CONTRIBUTING, CLAUDE.md, AGENTS.md and similar' },
          },
          required: ['request'],
        },
        commit: {
          type: 'array',
          minItems: 1,
          maxItems: 5,
          description: 'Adds a commit node after the reviewers (or every node): each entry in order stages exactly its paths and commits',
          items: {
            type: 'object',
            properties: {
              message: { type: 'string', description: 'Commit message; its first line is the subject' },
              paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 50, description: 'Project-relative files or folders' },
            },
            required: ['message', 'paths'],
          },
        },
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
