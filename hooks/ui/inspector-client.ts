import type { ClientModule } from 'claude-code'
import type { InspectorModel } from './inspector-model.ts'

const InspectorClient: ClientModule<InspectorModel, number> = (model, surface) => {
  const { Box, Text, Button } = surface.elements
  if (surface.columns > 0 && surface.state !== surface.columns) {
    surface.setState(surface.columns)
    surface.post({ columns: surface.columns })
  }
  const lineActions = new Map(model.lineActions?.map(({ line, action }) => [line, action] as const))
  return Box({
    flexDirection: 'column',
    children: [
      Text({ bold: true, wrap: 'wrap', children: [model.title] }),
      Text({ children: [' '] }),
      ...model.lines.map((line, index) => {
        if (line.length === 0) return Text({ children: [' '] })
        const action = lineActions.get(index)
        // A plain Button takes one row like a Text row; dimColor keeps the header dim until the pointer or focus shows it can be pressed.
        if (action !== undefined) {
          return Button({
            key: action, plain: true, dimColor: true, label: line.map(segment => segment.text).join(''),
            onPress: () => surface.post({ action }),
          })
        }
        return Box({
          flexDirection: 'row',
          children: line.map(segment => Text({
            ...(segment.color ? { color: segment.color } : {}),
            ...(segment.bold ? { bold: true } : {}),
            ...(segment.dim ? { dimColor: true } : {}),
            wrap: 'truncate-end',
            children: [segment.text],
          })),
        })
      }),
      Text({ children: [' '] }),
      ...model.actions.map(action => Button({
        key: action.id, plain: true, label: action.label,
        onPress: () => surface.post({ action: action.id }),
      })),
    ],
  })
}

export default InspectorClient
