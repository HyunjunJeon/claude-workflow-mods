// Claude Code passes the model only the first 2048 characters of a tool description (see TOOL_DESCRIPTION_LIMIT in
// tool-spec.ts), so the rules come first and tests/board-engine.test.ts keeps the whole text under that limit.
export const BOARD_TOOL_DESCRIPTION = [
  'The board is shown to the user in the /dag pane\'s Board section (key b). Use it when the user asks to understand something with several parts (how it works, a comparison, what changed, a decision) and for the interview and PM ledgers.',
  'Write in this order: a section (what and why), ONE diagram (flow: branches; sequence: who calls whom), then the few lines that carry the mechanism (code_peek; code: your snippet; trace: a run quote; diff: a git change).',
  'Draw a few blocks per edit; call open once after the first edit. Read the board back with get before you finish.',
  'Flow edges may not form a cycle: draw a loop as a note. code_peek and diff take a project-relative path and at most 40 lines. Edits are atomic.',
  'Actions: create {title} returns board_id; edit {board_id, edits} (1-20); get {board_id}; list; open {board_id} shows it; export {board_id} returns markdown.',
  'Edits: {op:"insert", block, afterId?} (appends, or after afterId); {op:"update", id, changes} (merges fields; "" clears an optional one; never id, type or lines); {op:"replace", id, block}; {op:"remove", id}; {op:"move", id, afterId?} (after afterId, else to the end).',
  'Blocks (limits in characters; ? = optional; all but section and divider take title? 80):',
  'section {title 1-80, text? 4000};',
  'callout {tone info|decision|risk|warning, text 1-1000};',
  'table {columns 1-6, rows <=30 (each as long as columns, cells <=80)};',
  'code_peek {path, ref?, start, end (1-based, end-start < 40), note? 200};',
  'code {code 1-4000 as sent, <=40 lines of <=240, language? 20, note? 200};',
  'trace {run, node, part output|answer|error|verification, note? 200};',
  'diff {ref, path?, note? 200} quotes a git diff the host runs;',
  'flow {nodes 1-24 [{id, label 1-40, kind? process|decision|terminal, note? 80}], edges <=48 [{from, to, label?, style? dashed}]};',
  'sequence {participants 2-8 [{id, label 1-24}], steps 1-40 [{from, to, label 1-60, kind? call|return|async|note, note? 80}]};',
  'board_ref {board} links another board of this session;',
  'divider {} is a rule between groups.',
  'A board holds at most 60 blocks.',
].join(' ')

const BLOCK_SCHEMA = {
  type: 'object',
  description: 'A block: type plus the fields of that type, no id (the board assigns b<n>)',
  properties: {
    type: { type: 'string', enum: ['section', 'callout', 'table', 'code_peek', 'code', 'trace', 'diff', 'flow', 'sequence', 'board_ref', 'divider'] },
    title: { type: 'string', description: 'section (required), every other type but divider (optional): 1-80 characters' },
    text: { type: 'string', description: 'section: at most 4000 characters; callout: 1-1000' },
    tone: { type: 'string', enum: ['info', 'decision', 'risk', 'warning'], description: 'callout' },
    columns: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 6, description: 'table: header cells' },
    rows: { type: 'array', maxItems: 30, items: { type: 'array', items: { type: 'string' } }, description: 'table: each row as long as columns' },
    path: { type: 'string', description: 'code_peek (required): project-relative file; diff (optional): limits the diff to it. No ".." and not under .claude' },
    ref: {
      type: 'string',
      description: 'code_peek (optional): read the file at this git ref, not the worktree; diff (required): a git ref or a..b range. Letters, digits and _ . / ~ ^ { } @ -, at most 64, not starting with "-"',
    },
    start: { type: 'integer', minimum: 1, description: 'code_peek: first line' },
    end: { type: 'integer', minimum: 1, description: 'code_peek: last line, at most 40 lines from start' },
    note: { type: 'string', description: 'code_peek, code, trace, diff: at most 200 characters' },
    language: { type: 'string', description: 'code: at most 20 characters, such as ts' },
    code: { type: 'string', description: 'code: the snippet, 1-4000 characters kept as sent, at most 40 lines of 240' },
    board: { type: 'string', description: 'board_ref: the board_id of another board of this session, as create and list return it; not the board being edited' },
    run: { type: 'string', description: 'trace: the run id, such as dag_mv6fveyq_y06sr2' },
    node: { type: 'string', description: 'trace: the node id in that run' },
    part: { type: 'string', enum: ['output', 'answer', 'error', 'verification'], description: 'trace: which artifact of the node to quote' },
    nodes: {
      type: 'array',
      minItems: 1,
      maxItems: 24,
      description: 'flow',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '1-32 letters, digits, "_", "-" or "."' },
          label: { type: 'string', description: '1-40 characters' },
          kind: { type: 'string', enum: ['process', 'decision', 'terminal'] },
          note: { type: 'string', description: 'at most 80 characters' },
        },
        required: ['id', 'label'],
      },
    },
    edges: {
      type: 'array',
      maxItems: 48,
      description: 'flow: arrows between node ids; no self-edge, no duplicate, no cycle',
      items: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          label: { type: 'string', description: 'at most 40 characters' },
          style: { type: 'string', enum: ['dashed'], description: 'dashed for an optional or asynchronous link; omit for a solid arrow' },
        },
        required: ['from', 'to'],
      },
    },
    participants: {
      type: 'array',
      minItems: 2,
      maxItems: 8,
      description: 'sequence',
      items: {
        type: 'object',
        properties: { id: { type: 'string', description: '1-32 letters, digits, "_", "-" or "."' }, label: { type: 'string', description: '1-24 characters' } },
        required: ['id', 'label'],
      },
    },
    steps: {
      type: 'array',
      minItems: 1,
      maxItems: 40,
      description: 'sequence: messages in order, between participant ids',
      items: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          label: { type: 'string', description: '1-60 characters' },
          kind: { type: 'string', enum: ['call', 'return', 'async', 'note'] },
          note: { type: 'string', description: 'an aside under the step, at most 80 characters' },
        },
        required: ['from', 'to', 'label'],
      },
    },
  },
  required: ['type'],
}

const EDIT_SCHEMA = {
  type: 'object',
  properties: {
    op: { type: 'string', enum: ['insert', 'update', 'replace', 'remove', 'move'] },
    block: BLOCK_SCHEMA,
    afterId: { type: 'string', description: 'insert, move: the block to place this one after; omit to append (insert) or to move it to the end (move)' },
    id: { type: 'string', description: 'update, replace, remove, move: the block id, such as b3' },
    changes: { type: 'object', description: 'update: fields of the block to replace; "" clears an optional text field' },
  },
  required: ['op'],
}

export const BOARD_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['create', 'edit', 'get', 'list', 'open', 'export'] },
    title: { type: 'string', description: 'create only: the board title, 1-80 characters' },
    board_id: { type: 'string', description: 'edit, get, open, export: the board_id that create returned' },
    edits: { type: 'array', minItems: 1, maxItems: 20, items: EDIT_SCHEMA, description: 'edit only: applied in order, all or nothing' },
  },
  required: ['action'],
}
