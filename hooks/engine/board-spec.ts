// Claude Code passes the model only the first 2048 characters of a tool description (see TOOL_DESCRIPTION_LIMIT in
// tool-spec.ts), so the rules come first and tests/board-engine.test.ts keeps the whole text under that limit.
export const BOARD_TOOL_DESCRIPTION = [
  'The board is shown to the user in the /dag pane\'s Board section (key b). Use it when the user wants to see how something works (a flow, a call order, a data shape), and for the interview ledger, the plan and the result.',
  'Write in this order: a section saying what and why, then ONE diagram (flow for branches and steps, sequence for who calls whom), then code_peek for the few lines that carry the mechanism.',
  'Draw incrementally: a few blocks per edit, and call open once after the first edit. Block ids b<n> are shown to the user, who may refer to them. Read the board back with get before you finish.',
  'Flow edges may not form a cycle: draw a loop as a note. code_peek takes a project-relative path and at most 40 lines. Edits are atomic: one bad edit changes nothing.',
  'Actions: create {title} returns board_id; edit {board_id, edits} (1-20); get {board_id}; list; open {board_id} shows the board in the pane without taking the keyboard.',
  'Edits: {op:"insert", block, afterId?} (appends, or goes after afterId); {op:"update", id, changes} (merges fields; "" clears an optional one; never id, type or lines); {op:"replace", id, block}; {op:"remove", id}.',
  'Blocks (limits in characters; optional fields marked ?):',
  'section {title 1-80, text? 4000};',
  'callout {tone info|decision|risk|warning, text 1-1000, title? 80};',
  'table {columns 1-6, rows <=30 (each as long as columns, cells <=80), title?};',
  'code_peek {path, start, end (1-based, end-start < 40), note? 200, title?};',
  'flow {nodes 1-24 [{id, label 1-40, kind? process|decision|terminal, note? 80}], edges <=48 [{from, to, label?}], title?}, node ids [A-Za-z0-9_.-]{1,32};',
  'sequence {participants 2-8 [{id, label 1-24}], steps 1-40 [{from, to, label 1-60, kind? call|return|async|note}], title?}.',
  'A board holds at most 60 blocks.',
].join(' ')

const BLOCK_SCHEMA = {
  type: 'object',
  description: 'A block: type plus the fields of that type, no id (the board assigns b<n>)',
  properties: {
    type: { type: 'string', enum: ['section', 'callout', 'table', 'code_peek', 'flow', 'sequence'] },
    title: { type: 'string', description: 'section (required), every other type (optional): 1-80 characters' },
    text: { type: 'string', description: 'section: at most 4000 characters; callout: 1-1000' },
    tone: { type: 'string', enum: ['info', 'decision', 'risk', 'warning'], description: 'callout' },
    columns: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 6, description: 'table: header cells' },
    rows: { type: 'array', maxItems: 30, items: { type: 'array', items: { type: 'string' } }, description: 'table: each row as long as columns' },
    path: { type: 'string', description: 'code_peek: project-relative file, no ".." and not under .claude' },
    start: { type: 'integer', minimum: 1, description: 'code_peek: first line' },
    end: { type: 'integer', minimum: 1, description: 'code_peek: last line, at most 40 lines from start' },
    note: { type: 'string', description: 'code_peek: at most 200 characters' },
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
        properties: { from: { type: 'string' }, to: { type: 'string' }, label: { type: 'string', description: 'at most 40 characters' } },
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
    op: { type: 'string', enum: ['insert', 'update', 'replace', 'remove'] },
    block: BLOCK_SCHEMA,
    afterId: { type: 'string', description: 'insert: the block to place this one after; omit to append' },
    id: { type: 'string', description: 'update, replace, remove: the block id, such as b3' },
    changes: { type: 'object', description: 'update: fields of the block to replace; "" clears an optional text field' },
  },
  required: ['op'],
}

export const BOARD_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['create', 'edit', 'get', 'list', 'open'] },
    title: { type: 'string', description: 'create only: the board title, 1-80 characters' },
    board_id: { type: 'string', description: 'edit, get, open: the board_id that create returned' },
    edits: { type: 'array', minItems: 1, maxItems: 20, items: EDIT_SCHEMA, description: 'edit only: applied in order, all or nothing' },
  },
  required: ['action'],
}
