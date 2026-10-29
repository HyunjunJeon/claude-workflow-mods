import { CATEGORIES } from './node-prompt.ts'
import { SECURITY_GUIDES } from './stages.ts'
import { TEXT_FIELDS, type TextField } from './types.ts'
import { DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS, MIN_COMMAND_TIMEOUT_MS } from './verification.ts'

// Claude Code passes the model only the first 2048 characters of a tool description, so the
// rules come first and tests/tool-spec.test.ts keeps the whole text under that limit.
export const TOOL_DESCRIPTION_LIMIT = 2048

export const TOOL_DESCRIPTION = [
  'The only way to get work done in this session: plan the task as a dependency-ordered DAG of subagent nodes and run it here.',
  'start returns at once. Do not poll: when the run settles you get a summary with every node\'s output. Treat node completion claims as false until you verify them.',
  'Every node needs verify: 1-16 plugin-run checks before the node completes, {kind:"file",path,contains?|absent?|matches?|lastLine?|equals?} (path relative, or absolute read-only; a folder allows contains/absent) or {kind:"command",argv,expect?:{exit,stdout,stderr},timeoutMs?} (exit 0 unless expect.exit); start/amend refuse nodes without them.',
  'A node receives the outputs of its dependsOn nodes, so list exactly the nodes whose results it needs. Ready nodes run in parallel waves; a failed node skips its dependents.',
  'Definition: "key" (same key and definition reuses the run; another definition under it is refused), "name", optional "goal" (shown to every node) and "nodes".',
  '"review":{request} and "commit":[{message,paths}] add the review pair and a commit node.',
  'Node: "id", a self-contained "prompt" (what to do and produce), optional "dependsOn", "category" (model routing; Jev may override), "agent" (subagent type, e.g. Explore), "writes" (project-relative paths, for session conflict display), "label", "task_summary", "load_skills".',
  'Actions: start {definition} or start {path} (a project-relative .yaml/.yml/.json definition file); start {..., dryRun:true} previews waves, models, write conflicts and warnings, starts nothing; start {preview_id} runs it as previewed; list; context; decisions; sessions; snapshot {run_id}; wait {run_id} (current snapshot, never blocks); cancel {run_id, reason};',
  'retry {run_id, node_id|node_ids, prompt} (failed/cancelled nodes and skipped dependents; completed ones are reused); amend {run_id, definition} (re-runs changed nodes and dependents, adds nodes);',
  'send {run_id, node_id, message} (steer a running node); answer {run_id, node_id, answer} (answer a blocked node); attach {run_id} (adopt another session\'s run).',
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
    external: { type: 'boolean', description: 'true when the node changes anything outside the project files (push, deploy, database, storage, settings, messages); the automatic review fix never reruns it' },
    slice: { type: 'boolean', description: 'true when the node is one vertical slice that owns several files; the many-files lint warning becomes a note' },
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
          timeoutMs: {
            type: 'integer',
            minimum: MIN_COMMAND_TIMEOUT_MS,
            maximum: MAX_COMMAND_TIMEOUT_MS,
            description: `command only: time limit in milliseconds, default ${DEFAULT_COMMAND_TIMEOUT_MS}; raise it for a check that is slow by nature`,
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
    action: { type: 'string', enum: ['start', 'list', 'context', 'decisions', 'sessions', 'snapshot', 'wait', 'cancel', 'retry', 'amend', 'send', 'answer', 'attach'] },
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
            category: { type: 'string', description: 'The reviewers\' category; default standard' },
            rules: { type: 'array', items: { type: 'string' }, description: 'Rule file paths review-standards reads first; it still searches for CONTRIBUTING, CLAUDE.md, AGENTS.md and similar' },
            security: { type: 'array', items: { type: 'string', enum: Object.keys(SECURITY_GUIDES) }, description: 'Secure-coding guides (kisa: KISA; owasp: OWASP Top 10 and CWE Top 25; agent: agent trust boundaries); adds seven lens nodes, one verifier per candidate at run time and review-security, which gates the commit. Opt-in: set it only when the request or a project rule file asks' },
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
    dryRun: { type: 'boolean', description: 'start only: true previews the definition (waves, critical path, models, write conflicts, warnings), starts nothing and returns preview_id' },
    preview_id: { type: 'string', description: 'start only: the preview_id of a dry run in this session, instead of definition or path; starts that exact definition, screened again' },
    run_id: { type: 'string' },
    node_id: { type: 'string' },
    node_ids: { type: 'array', items: { type: 'string' } },
    prompt: { type: 'string' },
    message: { type: 'string' },
    answer: { type: 'string', description: 'answer only: the reply to the blocked node\'s question, one of its options or free text' },
    reason: { type: 'string' },
  },
  required: ['action'],
}
