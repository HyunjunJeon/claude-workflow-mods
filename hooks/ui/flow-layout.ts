import type { FlowBlock, FlowNode } from '../engine/board-types.ts'
import { graphFits, graphLines, perRowFor } from './graph-layout.ts'
import { frontiersOf, type GraphModel, type GraphNode } from './graph-model.ts'
import { fit, type Line } from './text.ts'

export type FlowLabels = { sameFrontier: string; more: string }

const KIND_GLYPHS = { decision: '◇', process: '□', terminal: '○' }

const glyphOf = (node: FlowNode) => KIND_GLYPHS[node.kind ?? 'process']

const edgeLabel = (label: string | undefined) => (label ? ` (${label})` : '')

function nameOf(block: FlowBlock): (id: string) => string {
  const labels = new Map(block.nodes.map(node => [node.id, node.label]))
  return id => labels.get(id) ?? id
}

// The DAG layout lays the nodes out in topological rows, so a flow block reuses it: each flow node becomes a box
// whose second line is its glyph and note and whose third line lists the edges that lead into it.
function modelOf(block: FlowBlock, labels: FlowLabels): GraphModel {
  const nameFor = nameOf(block)
  const nodes = block.nodes.map((node): GraphNode => ({
    id: node.id,
    label: node.label,
    icon: glyphOf(node),
    state: node.note ?? '',
    color: '',
    activity: '',
    tail: '',
    incoming: block.edges.filter(edge => edge.to === node.id).map(edge => `${nameFor(edge.from)}${edgeLabel(edge.label)}`),
    bare: true,
    selected: false,
    expanded: false,
    startedAt: null,
    finishedAt: null,
  }))
  return {
    nodes,
    edges: block.edges.map(edge => ({ from: edge.from, to: edge.to })),
    view: 'graph',
    unfold: false,
    now: 0,
    labels: { startNode: '', sameFrontier: labels.sameFrontier, more: labels.more, graph: '', lanes: '', timeline: '', auto: '', notStarted: '', critical: '' },
  }
}

function listLines(block: FlowBlock, columns: number): Line[] {
  const nameFor = nameOf(block)
  const nodeTexts = block.nodes.map(node => `${glyphOf(node)} ${node.label}${node.note ? ` — ${node.note}` : ''}`)
  const edgeTexts = block.edges.map(edge => `${nameFor(edge.from)} → ${nameFor(edge.to)}${edgeLabel(edge.label)}`)
  return [...nodeTexts, ...edgeTexts].map(text => [{ text: fit(text, columns) }])
}

export function flowLines(block: FlowBlock, columns: number, labels: FlowLabels): Line[] {
  if (columns <= 0 || block.nodes.length === 0) return []
  const model = modelOf(block, labels)
  // graphFits alone still accepts a diamond at 30 columns, drawn as 41 lines of wrapped branches and lanes. A flow reads as
  // a diagram only while the branches of each step sit side by side, so a wrapped frontier falls back to the list too.
  const wraps = frontiersOf(model).some(frontier => frontier.length > perRowFor(columns))
  return graphFits(model, columns) && !wraps ? graphLines(model, columns) : listLines(block, columns)
}
