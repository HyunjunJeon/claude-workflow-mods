import type { ClientModule } from 'claude-code'
import type { GraphModel } from './graph-model.ts'
import { activeView, VIEWS, viewBody } from './views.ts'

const GraphClient: ClientModule = (props, surface) => {
  const { Box, Text, Button } = surface.elements
  if (surface.state === undefined) {
    surface.onKey(event => surface.post({ key: event.key, shift: event.shift === true }))
    surface.setState(true)
  }
  const model = props as unknown as GraphModel
  if (surface.columns <= 0) return Box({ children: [] })
  const active = activeView(model, surface.columns)
  const tab = (key: string, label: string, chosen: boolean, view: string) =>
    Button({ key, label, plain: true, ...(chosen ? {} : { dimColor: true }), onPress: () => surface.post({ view }) })
  const tabs = Box({
    flexDirection: 'row',
    columnGap: 3,
    children: [
      ...VIEWS.map(kind => tab(`view-${kind}`, `${kind === active ? '▸ ' : '  '}${model.labels[kind]}`, kind === active, kind)),
      tab('view-auto', model.view === 'auto' ? `(${model.labels.auto})` : model.labels.auto, model.view === 'auto', 'auto'),
    ],
  })
  return Box({
    flexDirection: 'column',
    children: [
      tabs,
      Text({ children: [' '] }),
      ...viewBody(model, surface.columns, active).map(line =>
        Box({
          flexDirection: 'row',
          children: line.map(segment =>
            Text({
              ...(segment.color ? { color: segment.color } : {}),
              ...(segment.bold ? { bold: true } : {}),
              ...(segment.dim ? { dimColor: true } : {}),
              wrap: 'truncate-end',
              children: [segment.text],
            }),
          ),
        }),
      ),
    ],
  })
}

export default GraphClient
