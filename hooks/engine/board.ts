import { findCycle } from './graph.ts'
import { fail, type Result } from './types.ts'
import { projectPath } from './verification.ts'
import type {
  Block, BlockInput, BlockType, Board, BoardEdit, BoardFile, CalloutBlock, CalloutTone, CodeBlock, CodePeekBlock, CodePeekInput,
  FlowBlock, FlowEdge, FlowNode, FlowNodeKind, RunLink, SectionBlock, SequenceBlock, SequenceParticipant, SequenceStep,
  SequenceStepKind, TableBlock, TraceBlock, TracePart,
} from './board-types.ts'

// The limits keep one block readable in a pane: the Board layouts wrap and clip at these sizes, and a board stays small enough to
// persist whole and to hand back to the model with get.
const MAX_EDITS = 20
const MAX_BLOCKS = 60
const TITLE_MAX = 80
const SECTION_TEXT_MAX = 4000
// A snippet is measured as sent, so the limit is on characters; the line limits are the code_peek's (PEEK_MAX_LINES, PEEK_LINE_MAX).
const CODE_MAX = 4000
const LANGUAGE_MAX = 20
const CALLOUT_TEXT_MAX = 1000
const MAX_COLUMNS = 6
const MAX_ROWS = 30
const CELL_MAX = 80
const PEEK_PATH_MAX = 300
const PEEK_MAX_LINES = 40
const PEEK_NOTE_MAX = 200
// A line of a minified bundle must not balloon the board file; the pane clips lines to its width anyway.
const PEEK_LINE_MAX = 240
const MAX_FLOW_NODES = 24
const MAX_FLOW_EDGES = 48
const FLOW_LABEL_MAX = 40
const FLOW_NOTE_MAX = 80
const MAX_PARTICIPANTS = 8
const PARTICIPANT_LABEL_MAX = 24
const MAX_STEPS = 40
const STEP_LABEL_MAX = 60
const BOARD_ID_MAX = 64
// A result board names its run and at most one block per fact slot; the host fills four slots today, and 8 leaves room without
// letting a stored file grow the link without bound.
const RUN_ID_MAX = 64
const NODE_ID_MAX = 64
const MAX_FACTS = 8
const FACT_KEY = /^[a-z]{1,16}$/
const REF_ID = /^[A-Za-z0-9_.-]{1,32}$/
const BLOCK_ID = /^b([1-9][0-9]*)$/

const BLOCK_TYPES: readonly BlockType[] = ['section', 'callout', 'table', 'code_peek', 'code', 'trace', 'flow', 'sequence']
const BLOCK_FIELDS: Record<BlockType, readonly string[]> = {
  section: ['title', 'text'],
  callout: ['tone', 'title', 'text'],
  table: ['title', 'columns', 'rows'],
  code_peek: ['title', 'path', 'start', 'end', 'note'],
  code: ['title', 'language', 'code', 'note'],
  trace: ['title', 'run', 'node', 'part', 'note'],
  flow: ['title', 'nodes', 'edges'],
  sequence: ['title', 'participants', 'steps'],
}
const TRACE_PARTS: readonly TracePart[] = ['output', 'answer', 'error', 'verification']
const CALLOUT_TONES: readonly CalloutTone[] = ['info', 'decision', 'risk', 'warning']
const FLOW_KINDS: readonly FlowNodeKind[] = ['process', 'decision', 'terminal']
const STEP_KINDS: readonly SequenceStepKind[] = ['call', 'return', 'async', 'note']
const FLOW_NODE_FIELDS = ['id', 'label', 'kind', 'note']
const FLOW_EDGE_FIELDS = ['from', 'to', 'label']
const PARTICIPANT_FIELDS = ['id', 'label']
const STEP_FIELDS = ['from', 'to', 'label', 'kind']

const EDIT_OPS: readonly BoardEdit['op'][] = ['insert', 'update', 'replace', 'remove']
const EDIT_FIELDS: Record<BoardEdit['op'], readonly string[]> = {
  insert: ['op', 'block', 'afterId'],
  update: ['op', 'id', 'changes'],
  replace: ['op', 'id', 'block'],
  remove: ['op', 'id'],
}
const FIXED_FIELDS = [
  ['id', 'ids never change'],
  ['type', 'a block keeps its type; use replace to draw another kind'],
  ['lines', 'the host fills lines; change path, start or end of a code_peek, or run, node or part of a trace'],
] as const
// What a host-filled block's lines are read from: changing one of these reads them again, changing anything else keeps them.
const RANGE_FIELDS = ['path', 'start', 'end']
const TRACE_FIELDS = ['run', 'node', 'part']

type Fields = Record<string, unknown>
type TraceInput = Omit<TraceBlock, 'id' | 'lines'>
// The two kinds whose lines the host fills: a code_peek's from a file, a trace's from the run checkpoint.
type Hosted = CodePeekInput | TraceInput
type Sources = { peeks: ReadonlyMap<string, string[]>; traces: ReadonlyMap<string, string[]> }
type Parsed<T> = { ok: true; value: T } | { ok: false; message: string }

function good<T>(value: T): Parsed<T> {
  return { ok: true, value }
}

// message is "<field>: <reason>", so a caller can put "edits[1]: " in front of it.
function bad<T>(field: string, reason: string): Parsed<T> {
  return { ok: false, message: `${field}: ${reason}` }
}

function within<T>(parent: string, parsed: Parsed<T>): Parsed<T> {
  return parsed.ok ? parsed : { ok: false, message: `${parent}.${parsed.message}` }
}

function isRecord(value: unknown): value is Fields {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function isLine(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

function omit(fields: Fields, ...keys: string[]): Fields {
  return Object.fromEntries(Object.entries(fields).filter(([key]) => !keys.includes(key)))
}

function child(parent: string, key: string): string {
  return parent === '' ? key : `${parent}.${key}`
}

// A typo such as "after_id" or "labell" must be refused, not silently dropped.
function fieldsOf(raw: unknown, field: string, allowed: readonly string[]): Parsed<Fields> {
  if (!isRecord(raw)) return bad(field, 'must be an object')
  const extra = Object.keys(raw).find(key => !allowed.includes(key))
  if (extra !== undefined) return bad(child(field, extra), `unknown field; fields: ${allowed.join(', ')}`)
  return good(raw)
}

function requiredText(raw: unknown, field: string, min: number, max: number): Parsed<string> {
  if (typeof raw !== 'string') return bad(field, 'must be a string')
  const value = raw.trim()
  if (value.length >= min && value.length <= max) return good(value)
  return bad(field, min === 0 ? `must be at most ${max} characters, got ${value.length}` : `must be ${min}-${max} characters, got ${value.length}`)
}

// An empty string stands for no value, so an update clears an optional field by sending "".
function optionalText(raw: unknown, field: string, max: number): Parsed<string> {
  return raw === undefined ? good('') : requiredText(raw, field, 0, max)
}

function oneOf<T extends string>(raw: unknown, field: string, options: readonly T[]): Parsed<T> {
  const match = options.find(option => option === raw)
  return match === undefined ? bad(field, `must be one of ${options.join(', ')}`) : good(match)
}

function optionalOneOf<T extends string>(raw: unknown, field: string, options: readonly T[]): Parsed<T | undefined> {
  return raw === undefined ? good(undefined) : oneOf(raw, field, options)
}

function refId(raw: unknown, field: string): Parsed<string> {
  return typeof raw === 'string' && REF_ID.test(raw) ? good(raw) : bad(field, 'must be 1-32 letters, digits, "_", "-" or "."')
}

function items<T>(raw: unknown, field: string, min: number, max: number, parse: (item: unknown, at: string) => Parsed<T>): Parsed<T[]> {
  if (!Array.isArray(raw)) return bad(field, 'must be an array')
  if (raw.length < min || raw.length > max) {
    return bad(field, `must hold ${min === max ? min : `${min}-${max}`} items, got ${raw.length}`)
  }
  const parsed: T[] = []
  for (const [index, item] of raw.entries()) {
    const next = parse(item, `${field}[${index}]`)
    if (!next.ok) return next
    parsed.push(next.value)
  }
  return good(parsed)
}

function firstRepeat(values: string[]): string | undefined {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) return value
    seen.add(value)
  }
  return undefined
}

function endpoint(raw: unknown, field: string, known: ReadonlySet<string>, noun: string): Parsed<string> {
  return typeof raw === 'string' && known.has(raw) ? good(raw) : bad(field, `must name a ${noun}: ${[...known].join(', ')}`)
}

function parseSection(raw: Fields): Parsed<Omit<SectionBlock, 'id'>> {
  const title = requiredText(raw.title, 'title', 1, TITLE_MAX)
  if (!title.ok) return title
  const body = optionalText(raw.text, 'text', SECTION_TEXT_MAX)
  if (!body.ok) return body
  return good({ type: 'section', title: title.value, ...(body.value ? { text: body.value } : {}) })
}

function parseCallout(raw: Fields): Parsed<Omit<CalloutBlock, 'id'>> {
  const tone = oneOf(raw.tone, 'tone', CALLOUT_TONES)
  if (!tone.ok) return tone
  const title = optionalText(raw.title, 'title', TITLE_MAX)
  if (!title.ok) return title
  const body = requiredText(raw.text, 'text', 1, CALLOUT_TEXT_MAX)
  if (!body.ok) return body
  return good({ type: 'callout', tone: tone.value, ...(title.value ? { title: title.value } : {}), text: body.value })
}

function parseTable(raw: Fields): Parsed<Omit<TableBlock, 'id'>> {
  const title = optionalText(raw.title, 'title', TITLE_MAX)
  if (!title.ok) return title
  const columns = items(raw.columns, 'columns', 1, MAX_COLUMNS, (column, at) => requiredText(column, at, 1, CELL_MAX))
  if (!columns.ok) return columns
  const width = columns.value.length
  const rows = items(raw.rows, 'rows', 0, MAX_ROWS, (row, at) => items(row, at, width, width, (cell, cellAt) => requiredText(cell, cellAt, 0, CELL_MAX)))
  if (!rows.ok) return rows
  return good({ type: 'table', ...(title.value ? { title: title.value } : {}), columns: columns.value, rows: rows.value })
}

function parseCodePeek(raw: Fields): Parsed<CodePeekInput> {
  const title = optionalText(raw.title, 'title', TITLE_MAX)
  if (!title.ok) return title
  const file = requiredText(raw.path, 'path', 1, PEEK_PATH_MAX)
  if (!file.ok) return file
  if (!projectPath(file.value)) return bad('path', 'must be relative to the project, without "..", and outside .claude')
  if (!isLine(raw.start)) return bad('start', 'must be a whole number from 1')
  if (!isLine(raw.end)) return bad('end', 'must be a whole number from 1')
  if (raw.end < raw.start) return bad('end', `must not be before start (${raw.start})`)
  if (raw.end - raw.start >= PEEK_MAX_LINES) return bad('end', `a code_peek shows at most ${PEEK_MAX_LINES} lines, got ${raw.end - raw.start + 1}`)
  const note = optionalText(raw.note, 'note', PEEK_NOTE_MAX)
  if (!note.ok) return note
  return good({
    type: 'code_peek', ...(title.value ? { title: title.value } : {}), path: file.value, start: raw.start, end: raw.end,
    ...(note.value ? { note: note.value } : {}),
  })
}

// A snippet keeps its indentation, so unlike the other texts it is not trimmed. A trailing newline ends the last line and does not
// start another, so 40 lines of a file pasted whole still fit.
function snippet(raw: unknown): Parsed<string> {
  if (typeof raw !== 'string') return bad('code', 'must be a string')
  if (raw.length < 1 || raw.length > CODE_MAX) return bad('code', `must be 1-${CODE_MAX} characters, got ${raw.length}`)
  if (raw.trim() === '') return bad('code', 'must hold more than whitespace')
  const parts = raw.split(/\r?\n/)
  const lines = parts.at(-1) === '' ? parts.slice(0, -1) : parts
  if (lines.length > PEEK_MAX_LINES) return bad('code', `at most ${PEEK_MAX_LINES} lines, got ${lines.length}`)
  for (const [index, line] of lines.entries()) {
    if (line.length > PEEK_LINE_MAX) return bad('code', `line ${index + 1} (index ${index}) has ${line.length} characters; a line holds at most ${PEEK_LINE_MAX}`)
  }
  return good(raw)
}

function parseCode(raw: Fields): Parsed<Omit<CodeBlock, 'id'>> {
  const title = optionalText(raw.title, 'title', TITLE_MAX)
  if (!title.ok) return title
  const language = optionalText(raw.language, 'language', LANGUAGE_MAX)
  if (!language.ok) return language
  const code = snippet(raw.code)
  if (!code.ok) return code
  const note = optionalText(raw.note, 'note', PEEK_NOTE_MAX)
  if (!note.ok) return note
  return good({
    type: 'code', ...(title.value ? { title: title.value } : {}), ...(language.value ? { language: language.value } : {}), code: code.value,
    ...(note.value ? { note: note.value } : {}),
  })
}

function parseTrace(raw: Fields): Parsed<TraceInput> {
  const title = optionalText(raw.title, 'title', TITLE_MAX)
  if (!title.ok) return title
  const run = requiredText(raw.run, 'run', 1, RUN_ID_MAX)
  if (!run.ok) return run
  const node = requiredText(raw.node, 'node', 1, NODE_ID_MAX)
  if (!node.ok) return node
  const part = oneOf(raw.part, 'part', TRACE_PARTS)
  if (!part.ok) return part
  const note = optionalText(raw.note, 'note', PEEK_NOTE_MAX)
  if (!note.ok) return note
  return good({
    type: 'trace', ...(title.value ? { title: title.value } : {}), run: run.value, node: node.value, part: part.value,
    ...(note.value ? { note: note.value } : {}),
  })
}

function parseFlowNode(raw: unknown, at: string): Parsed<FlowNode> {
  const fields = fieldsOf(raw, at, FLOW_NODE_FIELDS)
  if (!fields.ok) return fields
  const id = refId(fields.value.id, child(at, 'id'))
  if (!id.ok) return id
  const label = requiredText(fields.value.label, child(at, 'label'), 1, FLOW_LABEL_MAX)
  if (!label.ok) return label
  const kind = optionalOneOf(fields.value.kind, child(at, 'kind'), FLOW_KINDS)
  if (!kind.ok) return kind
  const note = optionalText(fields.value.note, child(at, 'note'), FLOW_NOTE_MAX)
  if (!note.ok) return note
  return good({ id: id.value, label: label.value, ...(kind.value ? { kind: kind.value } : {}), ...(note.value ? { note: note.value } : {}) })
}

function parseFlowEdge(raw: unknown, at: string, known: ReadonlySet<string>): Parsed<FlowEdge> {
  const fields = fieldsOf(raw, at, FLOW_EDGE_FIELDS)
  if (!fields.ok) return fields
  const from = endpoint(fields.value.from, child(at, 'from'), known, 'node')
  if (!from.ok) return from
  const to = endpoint(fields.value.to, child(at, 'to'), known, 'node')
  if (!to.ok) return to
  if (from.value === to.value) return bad(at, `joins ${from.value} to itself; draw a loop as a note`)
  const label = optionalText(fields.value.label, child(at, 'label'), FLOW_LABEL_MAX)
  if (!label.ok) return label
  return good({ from: from.value, to: to.value, ...(label.value ? { label: label.value } : {}) })
}

// findCycle walks dependsOn, so an edge from -> to becomes "to depends on from"; the path it returns reads in edge direction.
function flowCycle(nodes: FlowNode[], edges: FlowEdge[]): string[] | undefined {
  return findCycle(nodes.map(node => ({ id: node.id, prompt: '', dependsOn: edges.filter(edge => edge.to === node.id).map(edge => edge.from) })))
}

function parseFlow(raw: Fields): Parsed<Omit<FlowBlock, 'id'>> {
  const title = optionalText(raw.title, 'title', TITLE_MAX)
  if (!title.ok) return title
  const nodes = items(raw.nodes, 'nodes', 1, MAX_FLOW_NODES, parseFlowNode)
  if (!nodes.ok) return nodes
  const ids = nodes.value.map(node => node.id)
  const repeatedNode = firstRepeat(ids)
  if (repeatedNode !== undefined) return bad('nodes', `id ${repeatedNode} is used twice`)
  const known = new Set(ids)
  const edges = items(raw.edges, 'edges', 0, MAX_FLOW_EDGES, (edge, at) => parseFlowEdge(edge, at, known))
  if (!edges.ok) return edges
  const repeatedEdge = firstRepeat(edges.value.map(edge => `${edge.from} -> ${edge.to}`))
  if (repeatedEdge !== undefined) return bad('edges', `${repeatedEdge} is drawn twice`)
  const cycle = flowCycle(nodes.value, edges.value)
  if (cycle) return bad('edges', `flow edges form a cycle ${cycle.join(' -> ')}; draw a loop as a note`)
  return good({ type: 'flow', ...(title.value ? { title: title.value } : {}), nodes: nodes.value, edges: edges.value })
}

function parseParticipant(raw: unknown, at: string): Parsed<SequenceParticipant> {
  const fields = fieldsOf(raw, at, PARTICIPANT_FIELDS)
  if (!fields.ok) return fields
  const id = refId(fields.value.id, child(at, 'id'))
  if (!id.ok) return id
  const label = requiredText(fields.value.label, child(at, 'label'), 1, PARTICIPANT_LABEL_MAX)
  if (!label.ok) return label
  return good({ id: id.value, label: label.value })
}

// from and to may be the same participant: a call to itself is a legitimate step.
function parseStep(raw: unknown, at: string, known: ReadonlySet<string>): Parsed<SequenceStep> {
  const fields = fieldsOf(raw, at, STEP_FIELDS)
  if (!fields.ok) return fields
  const from = endpoint(fields.value.from, child(at, 'from'), known, 'participant')
  if (!from.ok) return from
  const to = endpoint(fields.value.to, child(at, 'to'), known, 'participant')
  if (!to.ok) return to
  const label = requiredText(fields.value.label, child(at, 'label'), 1, STEP_LABEL_MAX)
  if (!label.ok) return label
  const kind = optionalOneOf(fields.value.kind, child(at, 'kind'), STEP_KINDS)
  if (!kind.ok) return kind
  return good({ from: from.value, to: to.value, label: label.value, ...(kind.value ? { kind: kind.value } : {}) })
}

function parseSequence(raw: Fields): Parsed<Omit<SequenceBlock, 'id'>> {
  const title = optionalText(raw.title, 'title', TITLE_MAX)
  if (!title.ok) return title
  const participants = items(raw.participants, 'participants', 2, MAX_PARTICIPANTS, parseParticipant)
  if (!participants.ok) return participants
  const ids = participants.value.map(participant => participant.id)
  const repeated = firstRepeat(ids)
  if (repeated !== undefined) return bad('participants', `id ${repeated} is used twice`)
  const known = new Set(ids)
  const steps = items(raw.steps, 'steps', 1, MAX_STEPS, (step, at) => parseStep(step, at, known))
  if (!steps.ok) return steps
  return good({ type: 'sequence', ...(title.value ? { title: title.value } : {}), participants: participants.value, steps: steps.value })
}

// Validates and normalises what the model sends (strings trimmed except a code snippet, empty optional fields dropped). A block
// without id or lines: the board assigns the id and the host supplies a code_peek's or a trace's lines.
function parseBlockInput(raw: unknown): Parsed<BlockInput> {
  if (!isRecord(raw)) return bad('block', 'must be an object')
  const type = oneOf(raw.type, 'type', BLOCK_TYPES)
  if (!type.ok) return type
  const fields = fieldsOf(raw, '', ['type', ...BLOCK_FIELDS[type.value]])
  if (!fields.ok) return fields
  switch (type.value) {
    case 'section': return parseSection(fields.value)
    case 'callout': return parseCallout(fields.value)
    case 'table': return parseTable(fields.value)
    case 'code_peek': return parseCodePeek(fields.value)
    case 'code': return parseCode(fields.value)
    case 'trace': return parseTrace(fields.value)
    case 'flow': return parseFlow(fields.value)
    case 'sequence': return parseSequence(fields.value)
  }
}

export type PeekRequest = { path: string; start: number; end: number }

export function peekKey(request: PeekRequest): string {
  return `${request.path}#L${request.start}-L${request.end}`
}

export type TraceRequest = { run: string; node: string; part: TracePart }

export function traceKey(request: TraceRequest): string {
  return `${request.run}#${request.node}#${request.part}`
}

// The host reads files for these, so a request exists only for a range the engine would accept; applyEdits reports the rest.
function peekRequest(file: unknown, start: unknown, end: unknown): PeekRequest | undefined {
  if (typeof file !== 'string') return undefined
  const trimmed = file.trim()
  if (!projectPath(trimmed) || !isLine(start) || !isLine(end) || end < start || end - start >= PEEK_MAX_LINES) return undefined
  return { path: trimmed, start, end }
}

function cutLine(line: string): string {
  return line.length > PEEK_LINE_MAX ? `${line.slice(0, PEEK_LINE_MAX - 1)}…` : line
}

function peekedLines(peek: CodePeekInput, peeks: ReadonlyMap<string, string[]>): Parsed<string[]> {
  const key = peekKey(peek)
  const lines = peeks.get(key)
  if (lines === undefined) return bad('path', `could not read ${key} (the file is missing or unreadable)`)
  const wanted = peek.end - peek.start + 1
  if (lines.length !== wanted) return bad('end', `${key} reaches past the end of the file (${lines.length} of ${wanted} lines exist)`)
  return good(lines.map(cutLine))
}

function tracedLines(trace: TraceInput, traces: ReadonlyMap<string, string[]>): Parsed<string[]> {
  const key = traceKey(trace)
  const lines = traces.get(key)
  if (lines === undefined) return bad('run', `could not read the ${trace.part} of node ${trace.node} in run ${trace.run} (${key}); the run checkpoint does not hold it`)
  if (lines.length === 0) return bad('part', `the ${trace.part} of node ${trace.node} in run ${trace.run} (${key}) is empty`)
  // No range to ask for, so a long artifact keeps its first lines: a stored trace never holds more than a code_peek can.
  return good(lines.slice(0, PEEK_MAX_LINES).map(cutLine))
}

function hostedLines(input: Hosted, sources: Sources): Parsed<string[]> {
  return input.type === 'code_peek' ? peekedLines(input, sources.peeks) : tracedLines(input, sources.traces)
}

// A host-filled block's lines come from outside the input (a file read, a run checkpoint, the old block, a persisted file), so the
// caller supplies them.
function assemble(id: string, input: BlockInput, linesFor: (hosted: Hosted) => Parsed<string[]>): Parsed<Block> {
  if (input.type !== 'code_peek' && input.type !== 'trace') return good({ id, ...input })
  const lines = linesFor(input)
  return lines.ok ? good({ id, ...input, lines: lines.value }) : lines
}

export function newBoard(input: { boardId: string; sessionId: string; title: string; now: number }): Result<Board> {
  const title = requiredText(input.title, 'title', 1, TITLE_MAX)
  if (!title.ok) return fail('invalid_board_title', title.message)
  return { ok: true, value: { boardId: input.boardId, sessionId: input.sessionId, title: title.value, createdAt: input.now, updatedAt: input.now, nextId: 1, blocks: [] } }
}

function parseEdit(raw: unknown): Parsed<BoardEdit> {
  if (!isRecord(raw)) return bad('edit', 'must be an object')
  const op = oneOf(raw.op, 'op', EDIT_OPS)
  if (!op.ok) return op
  const fields = fieldsOf(raw, '', EDIT_FIELDS[op.value])
  if (!fields.ok) return fields
  if (op.value === 'insert') {
    const block = parseBlockInput(fields.value.block)
    if (!block.ok) return block
    const afterId = fields.value.afterId === undefined ? good(undefined) : requiredText(fields.value.afterId, 'afterId', 1, BOARD_ID_MAX)
    if (!afterId.ok) return afterId
    return good({ op: 'insert', block: block.value, ...(afterId.value === undefined ? {} : { afterId: afterId.value }) })
  }
  const id = requiredText(fields.value.id, 'id', 1, BOARD_ID_MAX)
  if (!id.ok) return id
  if (op.value === 'remove') return good({ op: 'remove', id: id.value })
  if (op.value === 'replace') {
    const block = parseBlockInput(fields.value.block)
    return block.ok ? good({ op: 'replace', id: id.value, block: block.value }) : block
  }
  const changes = fields.value.changes
  if (!isRecord(changes) || Object.keys(changes).length === 0) return bad('changes', 'must be an object naming at least one field')
  return good({ op: 'update', id: id.value, changes })
}

export function parseEdits(input: unknown): Result<BoardEdit[]> {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_EDITS) {
    return fail('invalid_board_edit', `edits: must be an array of 1-${MAX_EDITS} edits`)
  }
  const edits: BoardEdit[] = []
  for (const [index, raw] of input.entries()) {
    const edit = parseEdit(raw)
    if (!edit.ok) return fail('invalid_board_edit', `edits[${index}]: ${edit.message}`)
    edits.push(edit.value)
  }
  return { ok: true, value: edits }
}

// The ranges the host must read before applyEdits: those an insert or replace brings in, and an update that moves a code_peek.
export function peeksNeeded(board: Board, edits: BoardEdit[]): PeekRequest[] {
  const found = new Map<string, PeekRequest>()
  const want = (file: unknown, start: unknown, end: unknown) => {
    const request = peekRequest(file, start, end)
    if (request) found.set(peekKey(request), request)
  }
  for (const edit of edits) {
    if ((edit.op === 'insert' || edit.op === 'replace') && edit.block.type === 'code_peek') {
      want(edit.block.path, edit.block.start, edit.block.end)
    } else if (edit.op === 'update') {
      const block = board.blocks.find(candidate => candidate.id === edit.id)
      if (block?.type === 'code_peek' && RANGE_FIELDS.some(key => key in edit.changes)) {
        want(edit.changes.path ?? block.path, edit.changes.start ?? block.start, edit.changes.end ?? block.end)
      }
    }
  }
  return [...found.values()]
}

// Like peekRequest, a request exists only for a quote the engine would accept, with run and node trimmed the way parseTrace trims them.
function traceRequest(run: unknown, node: unknown, part: unknown): TraceRequest | undefined {
  const runId = requiredText(run, 'run', 1, RUN_ID_MAX)
  const nodeId = requiredText(node, 'node', 1, NODE_ID_MAX)
  const kind = oneOf(part, 'part', TRACE_PARTS)
  return runId.ok && nodeId.ok && kind.ok ? { run: runId.value, node: nodeId.value, part: kind.value } : undefined
}

// The artifacts the host must read from run checkpoints before applyEdits: those an insert or replace brings in, and an update that
// points a trace at another run, node or part.
export function tracesNeeded(board: Board, edits: BoardEdit[]): TraceRequest[] {
  const found = new Map<string, TraceRequest>()
  const want = (run: unknown, node: unknown, part: unknown) => {
    const request = traceRequest(run, node, part)
    if (request) found.set(traceKey(request), request)
  }
  for (const edit of edits) {
    if ((edit.op === 'insert' || edit.op === 'replace') && edit.block.type === 'trace') {
      want(edit.block.run, edit.block.node, edit.block.part)
    } else if (edit.op === 'update') {
      const block = board.blocks.find(candidate => candidate.id === edit.id)
      if (block?.type === 'trace' && TRACE_FIELDS.some(key => key in edit.changes)) {
        want(edit.changes.run ?? block.run, edit.changes.node ?? block.node, edit.changes.part ?? block.part)
      }
    }
  }
  return [...found.values()]
}

type Draft = { blocks: Block[]; nextId: number; inserted: string[] }
type Op<K extends BoardEdit['op']> = Extract<BoardEdit, { op: K }>

function refuse<T>(at: string, message: string): Result<T> {
  return fail('invalid_board_edit', `${at}: ${message}`)
}

function unknownBlock<T>(at: string, id: string, blocks: Block[]): Result<T> {
  return fail('unknown_block', `${at}: no block ${id}; this board holds ${blocks.length === 0 ? 'no blocks' : blocks.map(block => block.id).join(', ')}`)
}

function insertBlock(draft: Draft, edit: Op<'insert'>, at: string, sources: Sources): Result<Draft> {
  const input = parseBlockInput(edit.block)
  if (!input.ok) return refuse(at, input.message)
  let position = draft.blocks.length
  if (edit.afterId !== undefined) {
    const index = draft.blocks.findIndex(block => block.id === edit.afterId)
    if (index === -1) return unknownBlock(at, edit.afterId, draft.blocks)
    position = index + 1
  }
  if (draft.blocks.length >= MAX_BLOCKS) return refuse(at, `a board holds at most ${MAX_BLOCKS} blocks`)
  const id = `b${draft.nextId}`
  const block = assemble(id, input.value, hosted => hostedLines(hosted, sources))
  if (!block.ok) return refuse(at, block.message)
  return { ok: true, value: { blocks: draft.blocks.toSpliced(position, 0, block.value), nextId: draft.nextId + 1, inserted: [...draft.inserted, id] } }
}

// The lines a host-filled block keeps through an update, or undefined when the update changes what they are read from.
function keptLines(existing: Block, changes: Fields): string[] | undefined {
  if (existing.type === 'code_peek') return RANGE_FIELDS.some(key => key in changes) ? undefined : existing.lines
  if (existing.type === 'trace') return TRACE_FIELDS.some(key => key in changes) ? undefined : existing.lines
  return undefined
}

function updateBlock(draft: Draft, edit: Op<'update'>, at: string, sources: Sources): Result<Draft> {
  const index = draft.blocks.findIndex(block => block.id === edit.id)
  const existing = draft.blocks[index]
  if (existing === undefined) return unknownBlock(at, edit.id, draft.blocks)
  for (const [key, why] of FIXED_FIELDS) {
    if (key in edit.changes) return refuse(at, `${key}: cannot be changed; ${why}`)
  }
  const input = parseBlockInput({ ...omit(existing, 'id', 'lines'), ...edit.changes })
  if (!input.ok) return refuse(at, input.message)
  const kept = keptLines(existing, edit.changes)
  const block = assemble(existing.id, input.value, hosted => (kept === undefined ? hostedLines(hosted, sources) : good(kept)))
  if (!block.ok) return refuse(at, block.message)
  return { ok: true, value: { ...draft, blocks: draft.blocks.with(index, block.value) } }
}

function replaceBlock(draft: Draft, edit: Op<'replace'>, at: string, sources: Sources): Result<Draft> {
  const index = draft.blocks.findIndex(block => block.id === edit.id)
  if (index === -1) return unknownBlock(at, edit.id, draft.blocks)
  const input = parseBlockInput(edit.block)
  if (!input.ok) return refuse(at, input.message)
  const block = assemble(edit.id, input.value, hosted => hostedLines(hosted, sources))
  if (!block.ok) return refuse(at, block.message)
  return { ok: true, value: { ...draft, blocks: draft.blocks.with(index, block.value) } }
}

function removeBlock(draft: Draft, edit: Op<'remove'>, at: string): Result<Draft> {
  if (!draft.blocks.some(block => block.id === edit.id)) return unknownBlock(at, edit.id, draft.blocks)
  return { ok: true, value: { ...draft, blocks: draft.blocks.filter(block => block.id !== edit.id) } }
}

function applyEdit(draft: Draft, edit: BoardEdit, at: string, sources: Sources): Result<Draft> {
  switch (edit.op) {
    case 'insert': return insertBlock(draft, edit, at, sources)
    case 'update': return updateBlock(draft, edit, at, sources)
    case 'replace': return replaceBlock(draft, edit, at, sources)
    case 'remove': return removeBlock(draft, edit, at)
  }
}

// All or nothing: each edit builds a new block list from the last, so a refusal returns before the given board is touched.
export function applyEdits(board: Board, edits: BoardEdit[], context: Sources & { now: number }): Result<{ board: Board; inserted: string[] }> {
  let draft: Draft = { blocks: board.blocks, nextId: board.nextId, inserted: [] }
  for (const [index, edit] of edits.entries()) {
    const next = applyEdit(draft, edit, `edits[${index}]`, context)
    if (!next.ok) return next
    draft = next.value
  }
  return { ok: true, value: { board: { ...board, updatedAt: context.now, nextId: draft.nextId, blocks: draft.blocks }, inserted: draft.inserted } }
}

export type ModelBlock = Exclude<Block, CodePeekBlock | TraceBlock> | (Omit<CodePeekBlock, 'lines'> & { lineCount: number }) | (Omit<TraceBlock, 'lines'> & { lineCount: number })
export type ModelBoard = Omit<Board, 'blocks'> & { blocks: ModelBlock[] }

// What the get action returns: the model drew these blocks and does not need the file or run text back. A code block is the model's own text, so it stays.
export function boardForModel(board: Board): ModelBoard {
  return {
    ...board,
    blocks: board.blocks.map((block): ModelBlock => {
      if (block.type !== 'code_peek' && block.type !== 'trace') return block
      const { lines, ...rest } = block
      return { ...rest, lineCount: lines.length }
    }),
  }
}

function invalidFile<T>(message: string): Result<T> {
  return fail('invalid_board_file', `board file: ${message}`)
}

function storedLines(raw: unknown, peek: CodePeekInput): Parsed<string[]> {
  const wanted = peek.end - peek.start + 1
  if (isStringArray(raw) && raw.length === wanted && raw.every(line => line.length <= PEEK_LINE_MAX)) return good(raw)
  return bad('lines', `must hold ${wanted} strings of at most ${PEEK_LINE_MAX} characters`)
}

function storedTraceLines(raw: unknown): Parsed<string[]> {
  if (isStringArray(raw) && raw.length >= 1 && raw.length <= PEEK_MAX_LINES && raw.every(line => line.length <= PEEK_LINE_MAX)) return good(raw)
  return bad('lines', `must hold 1-${PEEK_MAX_LINES} strings of at most ${PEEK_LINE_MAX} characters`)
}

function parseStoredBlock(raw: unknown, at: string): Parsed<Block> {
  if (!isRecord(raw)) return bad(at, 'must be an object')
  const id = raw.id
  if (typeof id !== 'string' || !BLOCK_ID.test(id)) return bad(child(at, 'id'), 'must look like b1, b2, ...')
  const input = within(at, parseBlockInput(omit(raw, 'id', ...(raw.type === 'code_peek' || raw.type === 'trace' ? ['lines'] : []))))
  if (!input.ok) return input
  return within(at, assemble(id, input.value, hosted => (hosted.type === 'code_peek' ? storedLines(raw.lines, hosted) : storedTraceLines(raw.lines))))
}

function stamp(raw: unknown, field: string): Parsed<number> {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? good(raw) : bad(field, 'must be a time in ms')
}

// A fact's block id may name a block the board no longer holds: the model can remove it, and the next settle draws it again.
function parseRunLink(raw: unknown, at: string): Parsed<RunLink> {
  const fields = fieldsOf(raw, at, ['runId', 'facts'])
  if (!fields.ok) return fields
  const { runId, facts } = fields.value
  if (typeof runId !== 'string' || runId.length < 1 || runId.length > RUN_ID_MAX) return bad(child(at, 'runId'), `must be 1-${RUN_ID_MAX} characters`)
  const factsAt = child(at, 'facts')
  if (!isRecord(facts)) return bad(factsAt, 'must be an object')
  const entries = Object.entries(facts)
  if (entries.length > MAX_FACTS) return bad(factsAt, `must hold at most ${MAX_FACTS} entries, got ${entries.length}`)
  const slots: Record<string, string> = {}
  for (const [key, id] of entries) {
    if (!FACT_KEY.test(key)) return bad(factsAt, `key ${JSON.stringify(key.slice(0, 20))} must be 1-16 lowercase letters`)
    if (typeof id !== 'string' || !BLOCK_ID.test(id)) return bad(child(factsAt, key), 'must be a block id like b1')
    slots[key] = id
  }
  return good({ runId, facts: slots })
}

function parseStoredBoard(raw: unknown, at: string, sessionId: string): Parsed<Board> {
  const fields = fieldsOf(raw, at, ['boardId', 'sessionId', 'title', 'createdAt', 'updatedAt', 'nextId', 'blocks', 'run'])
  if (!fields.ok) return fields
  const boardId = requiredText(fields.value.boardId, child(at, 'boardId'), 1, BOARD_ID_MAX)
  if (!boardId.ok) return boardId
  if (fields.value.sessionId !== sessionId) return bad(child(at, 'sessionId'), `must be ${sessionId}`)
  const title = requiredText(fields.value.title, child(at, 'title'), 1, TITLE_MAX)
  if (!title.ok) return title
  const createdAt = stamp(fields.value.createdAt, child(at, 'createdAt'))
  if (!createdAt.ok) return createdAt
  const updatedAt = stamp(fields.value.updatedAt, child(at, 'updatedAt'))
  if (!updatedAt.ok) return updatedAt
  const nextId = fields.value.nextId
  if (!isLine(nextId)) return bad(child(at, 'nextId'), 'must be a whole number from 1')
  const blocks = items(fields.value.blocks, child(at, 'blocks'), 0, MAX_BLOCKS, parseStoredBlock)
  if (!blocks.ok) return blocks
  const repeated = firstRepeat(blocks.value.map(block => block.id))
  if (repeated !== undefined) return bad(child(at, 'blocks'), `id ${repeated} is used twice`)
  // A block id at or above nextId would be handed out again by the next insert.
  const reused = blocks.value.find(block => Number(block.id.slice(1)) >= nextId)
  if (reused) return bad(child(at, 'nextId'), `${nextId} must be above every block id, but the board holds ${reused.id}`)
  const run = fields.value.run === undefined ? good(undefined) : parseRunLink(fields.value.run, child(at, 'run'))
  if (!run.ok) return run
  return good({
    boardId: boardId.value, sessionId, title: title.value, createdAt: createdAt.value, updatedAt: updatedAt.value, nextId, blocks: blocks.value,
    ...(run.value === undefined ? {} : { run: run.value }),
  })
}

// Reads .claude/dag/boards/<sessionId>.json back. Every board and block goes through the same validation as an edit, so a
// hand-edited or half-written file cannot put a cycle or an oversized block on screen.
export function parseBoardFile(json: string, sessionId: string): Result<BoardFile> {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return invalidFile('is not valid JSON')
  }
  if (!isRecord(raw)) return invalidFile('must be an object')
  const file = fieldsOf(raw, '', ['schemaVersion', 'sessionId', 'boards'])
  if (!file.ok) return invalidFile(file.message)
  if (file.value.schemaVersion !== 1) return invalidFile('schemaVersion: must be 1')
  if (file.value.sessionId !== sessionId) return invalidFile(`sessionId: must be ${sessionId}`)
  const boards = items(file.value.boards, 'boards', 0, Number.POSITIVE_INFINITY, (board, at) => parseStoredBoard(board, at, sessionId))
  if (!boards.ok) return invalidFile(boards.message)
  const repeated = firstRepeat(boards.value.map(board => board.boardId))
  if (repeated !== undefined) return invalidFile(`boards: boardId ${repeated} is used twice`)
  return { ok: true, value: { schemaVersion: 1, sessionId, boards: boards.value } }
}
