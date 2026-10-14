import type {
  Block, Board, BoardRefBlock, CalloutBlock, CodeBlock, CodePeekBlock, DiffBlock, FlowBlock, FlowEdge, FlowNode, FlowNodeKind, SectionBlock, SequenceBlock, SequenceStep,
  TableBlock, TraceBlock,
} from './board-types.ts'

// What a board becomes when it leaves the pane: one markdown document the model can read back or quote. Each block keeps its
// id as an HTML comment, so a line of the export still names the block a later board edit would address.
export function boardToMarkdown(board: Board): string {
  const blocks = board.blocks.map(block => [`<!-- ${block.id} -->`, ...blockLines(block)].join('\n'))
  return `${[`# ${oneLine(board.title)}`, ...blocks].join('\n\n')}\n`
}

function blockLines(block: Block): string[] {
  switch (block.type) {
    case 'section': return sectionLines(block)
    case 'callout': return calloutLines(block)
    case 'table': return tableLines(block)
    case 'code_peek': return codePeekLines(block)
    case 'code': return codeLines(block)
    case 'trace': return traceLines(block)
    case 'diff': return diffLines(block)
    case 'flow': return flowLines(block)
    case 'sequence': return sequenceLines(block)
    case 'board_ref': return boardRefLines(block)
    case 'divider': return ['---']
  }
}

// A heading or label is one line: a line break would end it and turn the rest into body text or broken mermaid.
function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ')
}

// Blocks other than a section have no heading, so a title they carry shows as a bold line above the content.
function titled(block: { title?: string }): string[] {
  return block.title ? [`**${oneLine(block.title)}**`] : []
}

function noted(note: string | undefined): string[] {
  return note ? [`*${note}*`] : []
}

// The fence is one backtick longer than any run in the quoted text, so a node's own ``` block cannot close it early.
function fenced(lines: string[], info = ''): string[] {
  let longest = 2
  for (const line of lines) {
    for (const run of line.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  }
  const fence = '`'.repeat(longest + 1)
  return [`${fence}${info}`, ...lines, fence]
}

function sectionLines(block: SectionBlock): string[] {
  const heading = `## ${oneLine(block.title)}`
  return block.text ? [heading, block.text] : [heading]
}

function calloutLines(block: CalloutBlock): string[] {
  const label = block.title ? `${block.tone} — ${oneLine(block.title)}` : block.tone
  const text = block.text.split(/\r?\n/).map(line => (line === '' ? '>' : `> ${line}`))
  return [`> **${label}**:`, ...text]
}

function tableLines(block: TableBlock): string[] {
  const row = (cells: string[]) => `| ${cells.map(cell => cell.replace(/\|/g, '\\|').replace(/\s*[\r\n]+\s*/g, '<br>')).join(' | ')} |`
  return [...titled(block), row(block.columns), row(block.columns.map(() => '---')), ...block.rows.map(row)]
}

function codePeekLines(block: CodePeekBlock): string[] {
  const range = `L${block.start}–L${block.end}`
  return [...titled(block), `\`${block.path}\` (${block.ref ? `${range} at ${block.ref}` : range})`, ...fenced(block.lines), ...noted(block.note)]
}

function codeLines(block: CodeBlock): string[] {
  return [...titled(block), ...fenced(block.code.split(/\r?\n/), block.language), ...noted(block.note)]
}

function traceLines(block: TraceBlock): string[] {
  return [...titled(block), `\`${block.node} · ${block.part}\``, ...fenced(block.lines), ...noted(block.note)]
}

function diffLines(block: DiffBlock): string[] {
  const scope = block.path ? `${block.ref} · ${block.path}` : block.ref
  return [...titled(block), `\`${scope}\``, ...fenced(block.lines, 'diff'), ...noted(block.note)]
}

// The title the model gave the link, or the board_id when it gave none, so a reader of the export sees which board the pane would select.
function boardRefLines(block: BoardRefBlock): string[] {
  return [`> Board: [${oneLine(block.title ?? block.board)}]`]
}

// A quote ends a mermaid label, so it becomes the other quote.
function mermaidLabel(label: string): string {
  return oneLine(label).replace(/"/g, "'")
}

function mermaid(lines: string[]): string[] {
  return ['```mermaid', ...lines, '```']
}

const NODE_BRACKETS = {
  process: ['[', ']'],
  decision: ['{', '}'],
  terminal: ['([', '])'],
} satisfies Record<FlowNodeKind, [string, string]>

function flowNode(node: FlowNode): string {
  const [open, close] = NODE_BRACKETS[node.kind ?? 'process']
  return `${node.id}${open}"${mermaidLabel(node.label)}"${close}`
}

// A dashed edge is a dotted arrow, which mermaid writes -.-> and labels the same way as a solid one.
function flowEdge(edge: FlowEdge): string {
  const arrow = edge.style === 'dashed' ? '-.->' : '-->'
  return edge.label ? `${edge.from} ${arrow}|${mermaidLabel(edge.label)}| ${edge.to}` : `${edge.from} ${arrow} ${edge.to}`
}

function flowLines(block: FlowBlock): string[] {
  const edges = block.edges.map(flowEdge)
  return [...titled(block), ...mermaid(['flowchart LR', ...block.nodes.map(flowNode), ...edges])]
}

function sequenceMessage(step: SequenceStep): string {
  const label = mermaidLabel(step.label)
  switch (step.kind) {
    case 'note': return `Note over ${step.from},${step.to}: ${label}`
    case 'return': return `${step.from}-->>${step.to}: ${label}`
    case 'async': return `${step.from}-)${step.to}: ${label}`
    case 'call':
    case undefined: return `${step.from}->>${step.to}: ${label}`
  }
}

// A step's note is an aside on its own line, drawn the way a note step is, so it stays under the arrow it explains.
function sequenceStep(step: SequenceStep): string[] {
  const message = sequenceMessage(step)
  return step.note ? [message, `Note over ${step.from},${step.to}: ${mermaidLabel(step.note)}`] : [message]
}

function sequenceLines(block: SequenceBlock): string[] {
  const participants = block.participants.map(participant => `participant ${participant.id} as "${mermaidLabel(participant.label)}"`)
  return [...titled(block), ...mermaid(['sequenceDiagram', ...participants, ...block.steps.flatMap(sequenceStep)])]
}
