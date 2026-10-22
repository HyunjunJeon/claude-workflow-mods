import type { EngineInterface } from 'claude-code'
import { applyEdits, boardForModel, diffKey, diffsNeeded, newBoard, parseBoardFile, parseEdits, peekKey, peeksNeeded, traceKey, tracesNeeded, type DiffRequest, type PeekRequest, type TraceRequest } from '../engine/board.ts'
import { boardToMarkdown } from '../engine/board-export.ts'
import { chipContext, chipLabel, citedChips } from '../engine/board-chips.ts'
import type { Board, BoardEdit, BoardFile } from '../engine/board-types.ts'
import { err, ok, type ToolReply } from '../engine/format.ts'
import { fail, type Result, type Run } from '../engine/types.ts'
import type { Strings } from '../ui/i18n.ts'
import { ACCENT } from '../ui/text.ts'
import { ATTENTION_TOAST_MS, DAG_SUBDIR, GIT_READ_TIMEOUT_MS, message, SAFE_RUN_DIR, workingRoot, type ToolInput } from './io.ts'

// Boards: the state createBoards returns and the functions that take it. validate refuses $ passed to a method or a
// callback, so each operation that calls the host is a top-level function taking ($, boards, ...), and the host gives only
// what needs no $.
export type BoardsHost = {
  sessionId(): string
  projectRoot(): string
  // register.ts's run checkpoint folder, where a trace block reads its run.
  runsDir(): string
  // The pane's strings, which follow the language setting.
  strings(): Strings
}

// The register.ts functions a board operation calls that call the host themselves. They cannot take $ from here, so
// register.ts builds them around its own $ for each call (boardCalls), and validate follows them in register.ts.
export type BoardCalls = {
  // Creates a .claude/dag subdirectory on its first write and, once per session, the .gitignore.
  ensureDir(dir: string): Promise<void>
  // Shows a board in the /dag pane: the board tool's open action.
  openBoard(board: Board): Promise<ToolReply>
}

// register.ts reads the list and the selection for the pane, moves the selection from its keys, and reads and clears the
// chips from its prompt hooks.
export type Boards = {
  readonly host: BoardsHost
  // This session's boards in creation order, which is the Board section's order, and the one it shows; unset, it shows the
  // board updated last.
  list: Board[]
  selectedId: string | undefined
  // The chips the person put into the prompt box from the Board section, by label, oldest first. The next user prompt gets the
  // content of the ones it carries, and all are forgotten. A label holds no board id, so a later chip with the same label wins.
  readonly chips: Map<string, { boardId: string; blockId: string }>
}

export const BOARDS_SUBDIR = `${DAG_SUBDIR}/boards`
// More chips than a person cites in one prompt; the oldest beyond it are dropped.
const MAX_CHIPS = 20
export const CHIP_PAINT = { bold: true, color: ACCENT }

export function createBoards(host: BoardsHost): Boards {
  return { host, list: [], selectedId: undefined, chips: new Map() }
}

function boardsPath(boards: Boards): string {
  return `${boards.host.projectRoot()}/${BOARDS_SUBDIR}/${boards.host.sessionId()}.json`
}

// A missing file is a session without boards. A file that cannot be read or parsed is logged and left on disk: the
// session starts without boards, and its first create writes the file again.
export async function loadBoards($: EngineInterface, boards: Boards): Promise<void> {
  boards.list = []
  boards.selectedId = undefined
  if (!boards.host.projectRoot() || !boards.host.sessionId()) return
  const path = boardsPath(boards)
  try {
    if (!(await $.fs.exists(path))) return
    const parsed = parseBoardFile(await $.fs.read(path), boards.host.sessionId())
    if (parsed.ok) boards.list = parsed.value.boards
    else $.ui.log(`could not load ${path}: ${parsed.error.message}`)
  } catch (error) {
    $.ui.log(`could not read ${path}: ${message(error)}`)
  }
}

// Memory takes the new list only once the file holds it, so a failed write changes neither.
async function saveBoards($: EngineInterface, boards: Boards, calls: BoardCalls, next: Board[]): Promise<void> {
  const file: BoardFile = { schemaVersion: 1, sessionId: boards.host.sessionId(), boards: next }
  await calls.ensureDir(`${boards.host.projectRoot()}/${BOARDS_SUBDIR}`)
  await $.fs.write(boardsPath(boards), JSON.stringify(file, null, 2) + '\n')
  boards.list = next
}

// An accepted handoff brings the source session's boards along: a block's lines were captured when it was drawn, so
// copying is only the board list with each board's sessionId rewritten — parseBoardFile refuses a board that names
// another session, and this session's own file would too. The Board section then shows the board changed last, as it does
// anywhere else. A missing or unparsable source file is a no-op; a failure is logged and never fails the accept.
export async function inheritBoards($: EngineInterface, boards: Boards, calls: BoardCalls, source: string): Promise<void> {
  const path = `${boards.host.projectRoot()}/${BOARDS_SUBDIR}/${source}.json`
  try {
    if (!(await $.fs.exists(path))) return
    const parsed = parseBoardFile(await $.fs.read(path), source)
    if (!parsed.ok) {
      $.ui.log(`could not inherit ${path}: ${parsed.error.message}`)
      return
    }
    const held = new Set(boards.list.map(board => board.boardId))
    const inherited = parsed.value.boards.filter(board => !held.has(board.boardId)).map(board => ({ ...board, sessionId: boards.host.sessionId() }))
    if (inherited.length === 0) return
    await saveBoards($, boards, calls, [...boards.list, ...inherited])
  } catch (error) {
    $.ui.log(`could not inherit ${path}: ${message(error)}`)
  }
}

// A final newline ends the last line; it does not start another.
function textLines(text: string): string[] {
  const lines = text.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

// What git prints for a board quote, run from the folder the session works in (a worktree after EnterWorktree, else the
// project root) like a verify command. A git that cannot start or runs past GIT_READ_TIMEOUT_MS rejects, and that refuses the
// edit the same way a non-zero exit does, with git's own complaint.
async function gitOutput($: EngineInterface, boards: Boards, args: string[], at: string): Promise<Result<string>> {
  const refused = (reason: string) => fail<string>('invalid_board_edit', `${at}: git ${args[0]} could not read it (${reason})`)
  try {
    const result = await $.process.run(['git', ...args], { cwd: await workingRoot($, boards.host.projectRoot()), timeoutMs: GIT_READ_TIMEOUT_MS })
    return result.exitCode === 0 ? { ok: true, value: result.stdout } : refused(result.stderr.trim() || `exit ${result.exitCode}`)
  } catch (error) {
    return refused(message(error))
  }
}

// Lines start..end (1-based) of a project file for a code_peek: the file in the folder the session works in, or with a ref the
// file as git holds it at that ref. A worktree session quotes its own copy, the one it is changing, not the main folder's.
// The ./ makes git read the path from that folder, which may be inside the repository; a bare <ref>:<path> starts at the
// repository root. peeksNeeded merges a range several edits ask for, so a refusal names the path and no edit index.
async function readPeek($: EngineInterface, boards: Boards, request: PeekRequest): Promise<Result<string[]>> {
  const at = request.ref ? `code_peek ${request.path}@${request.ref}` : `code_peek ${request.path}`
  let text: string
  if (request.ref) {
    const shown = await gitOutput($, boards, ['show', `${request.ref}:./${request.path}`], at)
    if (!shown.ok) return shown
    text = shown.value
  } else {
    try {
      text = await $.fs.read(`${await workingRoot($, boards.host.projectRoot())}/${request.path}`)
    } catch (error) {
      return fail('invalid_board_edit', `${at}: cannot read the file (${message(error)})`)
    }
  }
  const lines = textLines(text)
  if (request.end > lines.length) {
    return fail('invalid_board_edit', `${at}: lines ${request.start}-${request.end} reach past the end of the file, which has ${lines.length} lines`)
  }
  return { ok: true, value: lines.slice(request.start - 1, request.end) }
}

// One artifact of one node for a trace block: output, answer and error are NodeRun fields of the run checkpoint, and verification
// is the evidence file verifyNode persisted. tracesNeeded merges a target several edits ask for, so a refusal names the trace, not
// an edit index. The run id is model input, so it must match the checkpoint naming before it reaches a path.
async function readTrace($: EngineInterface, boards: Boards, request: TraceRequest): Promise<Result<string[]>> {
  const at = `trace ${request.run} ${request.node} ${request.part}`
  if (!SAFE_RUN_DIR.test(request.run)) return fail('invalid_board_edit', `${at}: no run checkpoint has that name`)
  const runPath = `${boards.host.runsDir()}/${request.run}.json`
  if (!(await $.fs.exists(runPath))) return fail('invalid_board_edit', `${at}: no checkpoint at ${runPath}`)
  let run: Run
  try {
    run = JSON.parse(await $.fs.read(runPath)) as Run
  } catch (error) {
    return fail('invalid_board_edit', `${at}: cannot read the run checkpoint (${message(error)})`)
  }
  // A board is session state, so it may quote only the session's own runs.
  if (run.sessionId !== boards.host.sessionId()) return fail('invalid_board_edit', `${at}: the run belongs to another session`)
  const node = run.nodes.find(candidate => candidate.id === request.node)
  if (node === undefined) return fail('invalid_board_edit', `${at}: the run has no node ${request.node}`)
  if (request.part === 'verification') {
    const reportPath = node.verification?.reportPath
    if (reportPath === undefined) return fail('invalid_board_edit', `${at}: the node ran no verification`)
    let text: string
    try {
      text = await $.fs.read(reportPath)
    } catch (error) {
      return fail('invalid_board_edit', `${at}: cannot read the verification artifact (${message(error)})`)
    }
    return { ok: true, value: text.split(/\r?\n/) }
  }
  const text = request.part === 'output' ? node.output : request.part === 'answer' ? node.answer : node.error
  if (text === undefined) return fail('invalid_board_edit', `${at}: the node recorded no ${request.part}`)
  return { ok: true, value: text.split(/\r?\n/) }
}

// The lines of git diff <ref> [-- <path>] for a diff block; path is relative to the folder the session works in, as a pathspec
// run from there is. :(literal) makes git read the path as one file name, as the commit stage's checks do (stages.ts): a
// bare app/[id]/page.ts is a pattern that also names app/i/page.ts, and a leading ":" is pathspec magic. --no-color and
// --no-ext-diff keep a plain unified diff when the person's config sets color.ui=always or an external diff tool such as
// difftastic. An empty diff is no read failure: the engine refuses it in the block's own words. diffsNeeded merges a diff
// several edits ask for, so a refusal names the diff, not an edit index.
async function readDiff($: EngineInterface, boards: Boards, request: DiffRequest): Promise<Result<string[]>> {
  const at = request.path ? `diff ${request.ref} ${request.path}` : `diff ${request.ref}`
  const shown = await gitOutput($, boards, ['diff', '--no-color', '--no-ext-diff', request.ref, ...(request.path ? ['--', `:(literal)${request.path}`] : [])], at)
  return shown.ok ? { ok: true, value: textLines(shown.value) } : shown
}

async function editBoard($: EngineInterface, boards: Boards, calls: BoardCalls, board: Board, edits: BoardEdit[]): Promise<ToolReply> {
  const peeks = new Map<string, string[]>()
  for (const request of peeksNeeded(board, edits)) {
    const lines = await readPeek($, boards, request)
    if (!lines.ok) return err(lines.error)
    peeks.set(peekKey(request), lines.value)
  }
  const traces = new Map<string, string[]>()
  for (const request of tracesNeeded(board, edits)) {
    const lines = await readTrace($, boards, request)
    if (!lines.ok) return err(lines.error)
    traces.set(traceKey(request), lines.value)
  }
  const diffs = new Map<string, string[]>()
  for (const request of diffsNeeded(board, edits)) {
    const lines = await readDiff($, boards, request)
    if (!lines.ok) return err(lines.error)
    diffs.set(diffKey(request), lines.value)
  }
  const boardIds = new Set(boards.list.map(candidate => candidate.boardId))
  const applied = applyEdits(board, edits, { now: await $.clock.now(), peeks, traces, diffs, boardIds })
  if (!applied.ok) return err(applied.error)
  const edited = applied.value.board
  await saveBoards($, boards, calls, boards.list.map(candidate => (candidate.boardId === edited.boardId ? edited : candidate)))
  boards.selectedId = edited.boardId
  $.ui.invalidate('ui.render')
  return ok({ board_id: edited.boardId, blocks: edited.blocks.map(block => ({ id: block.id, type: block.type })), inserted: applied.value.inserted })
}

// The board changed last; a tie goes to the later one in the list.
function latestBoard(candidates: readonly Board[]): Board | undefined {
  return candidates.reduce<Board | undefined>((latest, board) => (latest === undefined || board.updatedAt >= latest.updatedAt ? board : latest), undefined)
}

// The board the Board section shows: the selected one, else the one changed last. The same choice as shownIndex in
// ui/board-model.ts, which that module does not export.
function shownBoard(boards: Boards): Board | undefined {
  return boards.list.find(board => board.boardId === boards.selectedId) ?? latestBoard(boards.list)
}

// The title the approval block points at: the board this session changed last.
export function latestBoardTitle(boards: Boards): string | undefined {
  return latestBoard(boards.list)?.title
}

function newBoardId(now: number): string {
  return `board_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

// A block header pressed in the Board section puts the block's chip into the prompt box at the cursor, and the label is kept so
// the user prompt that carries it gets the block's content (prompt.submit).
export async function citeBlock($: EngineInterface, boards: Boards, blockId: string): Promise<void> {
  const board = shownBoard(boards)
  const block = board?.blocks.find(candidate => candidate.id === blockId)
  // The press raced a change of the shown board, which redraws the pane without that header.
  if (!board || !block) return
  const label = chipLabel(block)
  const filled = await $.prompt.fill({ text: `${label} `, mode: 'insert', decorations: [{ start: 0, end: label.length, ...CHIP_PAINT }] })
  if (!filled.isFilled) {
    $.ui.toast(boards.host.strings().toastChipFailed(filled.refusal ?? 'unknown'), { timeoutMs: ATTENTION_TOAST_MS })
    return
  }
  // Deleted first so a chip pressed again counts as the newest.
  boards.chips.delete(label)
  boards.chips.set(label, { boardId: board.boardId, blockId })
  for (const oldest of boards.chips.keys()) {
    if (boards.chips.size <= MAX_CHIPS) break
    boards.chips.delete(oldest)
  }
}

// The context a user prompt gets for the chips it carries, from the boards as they are now; a chip whose board or block is gone
// adds nothing.
export function chipContexts(boards: Boards, text: string): string[] {
  return citedChips(text, boards.chips.keys()).flatMap(label => {
    const chip = boards.chips.get(label)
    const board = boards.list.find(candidate => candidate.boardId === chip?.boardId)
    const block = board?.blocks.find(candidate => candidate.id === chip?.blockId)
    return board && block ? [chipContext(board, block)] : []
  })
}

// The board tool (engine/board-spec.ts): the main conversation draws boards that the pane's Board section shows.
export async function handleBoardTool($: EngineInterface, boards: Boards, calls: BoardCalls, input: ToolInput): Promise<ToolReply> {
  if (input.action === 'list') {
    return ok({ boards: boards.list.map(board => ({ board_id: board.boardId, title: board.title, blocks: board.blocks.length, updatedAt: board.updatedAt })) })
  }
  if (input.action === 'create') {
    const now = await $.clock.now()
    const boardId = newBoardId(now)
    const created = newBoard({ boardId, sessionId: boards.host.sessionId(), title: typeof input.title === 'string' ? input.title : '', now })
    if (!created.ok) return err(created.error)
    await saveBoards($, boards, calls, [...boards.list, created.value])
    boards.selectedId = boardId
    $.ui.invalidate('ui.render')
    return ok({ board_id: boardId })
  }
  if (input.action !== 'edit' && input.action !== 'get' && input.action !== 'open' && input.action !== 'export') {
    return err({ code: 'invalid_request', message: `Unknown action "${String(input.action)}".` })
  }
  const board = boards.list.find(candidate => candidate.boardId === input.board_id)
  if (!board) return err({ code: 'unknown_board', message: `No board "${String(input.board_id)}" in this session; use the list action to see boards.` })
  if (input.action === 'get') return ok(boardForModel(board))
  if (input.action === 'open') return calls.openBoard(board)
  if (input.action === 'export') return ok({ board_id: board.boardId, markdown: boardToMarkdown(board) })
  const edits = parseEdits(input.edits)
  return edits.ok ? editBoard($, boards, calls, board, edits.value) : err(edits.error)
}
