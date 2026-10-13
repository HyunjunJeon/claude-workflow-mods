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
export type CodePeekBlock = { id: string; type: 'code_peek'; title?: string; path: string; start: number; end: number; lines: string[]; note?: string }
// code is a snippet the model proposes; nothing reads it back from a file, so it carries its text directly.
export type CodeBlock = { id: string; type: 'code'; title?: string; language?: string; code: string; note?: string }
// lines is the run artifact's text when the block was drawn, so the quote survives the run checkpoint's later edits.
export type TraceBlock = { id: string; type: 'trace'; title?: string; run: string; node: string; part: TracePart; lines: string[]; note?: string }
export type FlowNode = { id: string; label: string; kind?: FlowNodeKind; note?: string }
export type FlowEdge = { from: string; to: string; label?: string }
export type FlowBlock = { id: string; type: 'flow'; title?: string; nodes: FlowNode[]; edges: FlowEdge[] }
export type SequenceParticipant = { id: string; label: string }
export type SequenceStep = { from: string; to: string; label: string; kind?: SequenceStepKind }
export type SequenceBlock = { id: string; type: 'sequence'; title?: string; participants: SequenceParticipant[]; steps: SequenceStep[] }

export type Block = SectionBlock | CalloutBlock | TableBlock | CodePeekBlock | CodeBlock | TraceBlock | FlowBlock | SequenceBlock
export type BlockType = Block['type']

// What the model sends: a block without its id. Two kinds also lose their lines, which the host fills: a code peek's from the
// file, a trace's from the run checkpoint. A code block keeps its text, because nothing reads it back from anywhere.
export type CodePeekInput = Omit<CodePeekBlock, 'id' | 'lines'>
export type BlockInput =
  | Omit<SectionBlock, 'id'>
  | Omit<CalloutBlock, 'id'>
  | Omit<TableBlock, 'id'>
  | CodePeekInput
  | Omit<CodeBlock, 'id'>
  | Omit<TraceBlock, 'id' | 'lines'>
  | Omit<FlowBlock, 'id'>
  | Omit<SequenceBlock, 'id'>

export type BoardEdit =
  | { op: 'insert'; block: BlockInput; afterId?: string }
  | { op: 'update'; id: string; changes: Record<string, unknown> }
  | { op: 'replace'; id: string; block: BlockInput }
  | { op: 'remove'; id: string }

// The run a result board reports, and for each fact slot (summary, nodes, graph, writes, ...) the id of the block that holds it, so the
// next settle of the same run replaces those blocks in place. A fact's block may be gone: the model is free to remove it.
export type RunLink = { runId: string; facts: Record<string, string> }

// nextId only grows, so a removed block's id is never reused and an old reference cannot name a new block.
// run is set by the host when it draws a result board; no edit the model sends can set or change it.
export type Board = {
  boardId: string
  sessionId: string
  title: string
  createdAt: number
  updatedAt: number
  nextId: number
  blocks: Block[]
  run?: RunLink
}

// One file per session, .claude/dag/boards/<sessionId>.json, so retention prunes boards the way it prunes context files.
export type BoardFile = { schemaVersion: 1; sessionId: string; boards: Board[] }
