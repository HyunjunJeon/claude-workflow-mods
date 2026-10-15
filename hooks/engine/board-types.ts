// A board is a document of blocks that the main conversation draws into the /dag pane's Board section: the interview
// ledger and the plan before a run, the result after it. The engine (hooks/engine/board.ts) and the layouts (hooks/ui/) share these types.

export type CalloutTone = 'info' | 'decision' | 'risk' | 'warning'
export type FlowNodeKind = 'process' | 'decision' | 'terminal'
export type SequenceStepKind = 'call' | 'return' | 'async' | 'note'
export type TracePart = 'output' | 'answer' | 'error' | 'verification'

export type SectionBlock = { id: string; type: 'section'; title: string; text?: string }
export type CalloutBlock = { id: string; type: 'callout'; tone: CalloutTone; title?: string; text: string }
export type TableBlock = { id: string; type: 'table'; title?: string; columns: string[]; rows: string[][] }
// lines is the file's text when the block was drawn, so the board keeps showing what was discussed after the file changes.
// ref is the git ref the host read the file at (git show <ref>:<path>); absent means the worktree file, so a block can quote a past version.
export type CodePeekBlock = { id: string; type: 'code_peek'; title?: string; path: string; ref?: string; start: number; end: number; lines: string[]; note?: string }
// code is a snippet the model proposes; nothing reads it back from a file, so it carries its text directly.
export type CodeBlock = { id: string; type: 'code'; title?: string; language?: string; code: string; note?: string }
// lines is the run artifact's text when the block was drawn, so the quote survives the run checkpoint's later edits.
export type TraceBlock = { id: string; type: 'trace'; title?: string; run: string; node: string; part: TracePart; lines: string[]; note?: string }
// lines is the output of git diff <ref> [-- <path>] when the block was drawn, so the quote survives later commits and edits.
// ref may be a range (main..feature); path is project-relative and scopes the diff to one file, absent means the whole diff.
export type DiffBlock = { id: string; type: 'diff'; title?: string; ref: string; path?: string; lines: string[]; note?: string }
export type FlowNode = { id: string; label: string; kind?: FlowNodeKind; note?: string }
// style is absent for the solid default; 'dashed' marks an optional or asynchronous link, so the solid edge stays bare.
export type FlowEdge = { from: string; to: string; label?: string; style?: 'dashed' }
export type FlowBlock = { id: string; type: 'flow'; title?: string; nodes: FlowNode[]; edges: FlowEdge[] }
export type SequenceParticipant = { id: string; label: string }
// note is a short aside under the step's label, for detail that would crowd the arrow.
export type SequenceStep = { from: string; to: string; label: string; kind?: SequenceStepKind; note?: string }
export type SequenceBlock = { id: string; type: 'sequence'; title?: string; participants: SequenceParticipant[]; steps: SequenceStep[] }
// board is the board_id of another board in the same session; the pane draws the block as a button that selects it.
export type BoardRefBlock = { id: string; type: 'board_ref'; board: string; title?: string }
// A rule between groups of blocks; it carries no content.
export type DividerBlock = { id: string; type: 'divider' }

export type Block =
  | SectionBlock
  | CalloutBlock
  | TableBlock
  | CodePeekBlock
  | CodeBlock
  | TraceBlock
  | DiffBlock
  | FlowBlock
  | SequenceBlock
  | BoardRefBlock
  | DividerBlock
export type BlockType = Block['type']

// What the model sends: a block without its id. Three kinds also lose their lines, which the host fills: a code peek's from the
// file (or from git when it names a ref), a trace's from the run checkpoint, a diff's from git. A code block keeps its text, because
// nothing reads it back from anywhere.
export type CodePeekInput = Omit<CodePeekBlock, 'id' | 'lines'>
export type DiffInput = Omit<DiffBlock, 'id' | 'lines'>
export type BlockInput =
  | Omit<SectionBlock, 'id'>
  | Omit<CalloutBlock, 'id'>
  | Omit<TableBlock, 'id'>
  | CodePeekInput
  | Omit<CodeBlock, 'id'>
  | Omit<TraceBlock, 'id' | 'lines'>
  | DiffInput
  | Omit<FlowBlock, 'id'>
  | Omit<SequenceBlock, 'id'>
  | Omit<BoardRefBlock, 'id'>
  | Omit<DividerBlock, 'id'>

// move reorders a block after afterId and changes nothing else about it; the engine decides where an absent afterId puts it.
export type BoardEdit =
  | { op: 'insert'; block: BlockInput; afterId?: string }
  | { op: 'update'; id: string; changes: Record<string, unknown> }
  | { op: 'replace'; id: string; block: BlockInput }
  | { op: 'remove'; id: string }
  | { op: 'move'; id: string; afterId?: string }

// nextId only grows, so a removed block's id is never reused and an old reference cannot name a new block.
export type Board = {
  boardId: string
  sessionId: string
  title: string
  createdAt: number
  updatedAt: number
  nextId: number
  blocks: Block[]
}

// One file per session, .claude/dag/boards/<sessionId>.json, so retention prunes boards the way it prunes context files.
export type BoardFile = { schemaVersion: 1; sessionId: string; boards: Board[] }
