import { graphFits, graphLines } from './graph-layout.ts'
import type { GraphModel, ViewKind } from './graph-model.ts'
import { laneLines } from './lane-layout.ts'
import { ACCENT, type Line } from './text.ts'
import { timelineLines } from './timeline-layout.ts'

export const VIEWS: readonly ViewKind[] = ['graph', 'lanes', 'timeline']

export function activeView(model: GraphModel, columns: number): ViewKind {
  if (model.view !== 'auto') return model.view
  return graphFits(model, columns) ? 'graph' : 'lanes'
}

export function viewTabs(model: GraphModel, active: ViewKind): Line {
  return [
    ...VIEWS.flatMap((kind, i) => [
      ...(i > 0 ? [{ text: '   ' }] : []),
      kind === active ? { text: `▸ ${model.labels[kind]}`, color: ACCENT, bold: true as const } : { text: `  ${model.labels[kind]}`, dim: true as const },
    ]),
    ...(model.view === 'auto' ? [{ text: `   (${model.labels.auto})`, dim: true as const }] : []),
  ]
}

export function viewBody(model: GraphModel, columns: number, active: ViewKind): Line[] {
  return active === 'lanes' ? laneLines(model, columns) : active === 'timeline' ? timelineLines(model, columns) : graphLines(model, columns)
}

export function viewLines(model: GraphModel, columns: number): Line[] {
  if (columns <= 0) return []
  const active = activeView(model, columns)
  return [viewTabs(model, active), [], ...viewBody(model, columns, active)]
}
