export type Segment = { text: string; color?: string; bold?: true; dim?: true }
export type Line = Segment[]

export const ACCENT = 'cyan'

// Bits: 1 up, 2 right, 4 down, 8 left.
export const GLYPHS: Record<number, string> = {
  1: '│', 2: '─', 3: '└', 4: '│', 5: '│', 6: '┌', 7: '├', 8: '─', 9: '┘', 10: '─', 11: '┴', 12: '┐', 13: '┤', 14: '┬', 15: '┼',
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export function clean(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ')
}

function isWide(segment: string): boolean {
  const cp = segment.codePointAt(0) ?? 0
  return /\p{Emoji_Presentation}|\uFE0F/u.test(segment) || (cp >= 0x1100 &&
    (cp <= 0x115f || cp === 0x2329 || cp === 0x232a || (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe6f) || (cp >= 0xff01 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) ||
      cp >= 0x20000))
}

export function width(text: string): number {
  let cells = 0
  for (const { segment } of segmenter.segment(clean(text))) cells += isWide(segment) ? 2 : 1
  return cells
}

export function fit(text: string, columns: number, pad = false): string {
  const source = clean(text)
  if (columns <= 0) return ''
  const truncated = width(source) > columns
  let out = ''
  let used = 0
  for (const { segment } of segmenter.segment(source)) {
    const size = width(segment)
    if (used + size > columns - (truncated ? 1 : 0)) break
    out += segment
    used += size
  }
  if (truncated) {
    out += '…'
    used += 1
  }
  return out + (pad ? ' '.repeat(Math.max(0, columns - used)) : '')
}

// Streamed text grows at its end, so the newest characters stay visible.
export function fitTail(text: string, columns: number): string {
  const source = clean(text)
  if (columns <= 0) return ''
  if (width(source) <= columns) return source
  const kept: string[] = []
  let used = 1
  for (const segment of [...segmenter.segment(source)].map(part => part.segment).reverse()) {
    const size = width(segment)
    if (used + size > columns) break
    kept.unshift(segment)
    used += size
  }
  return `…${kept.join('')}`
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

export function paintRuns(chars: string[], hot: boolean[], focused: boolean, trim = true): Line {
  let end = chars.length
  while (trim && end > 0 && chars[end - 1] === ' ') end--
  const line: Line = []
  for (let x = 0; x < end; x++) {
    const style: Omit<Segment, 'text'> = !focused ? { color: ACCENT } : hot[x] ? { color: ACCENT, bold: true } : { dim: true }
    const last = line[line.length - 1]
    if (last && last.color === style.color && last.bold === style.bold && last.dim === style.dim) last.text += chars[x]
    else line.push({ text: chars[x]!, ...style })
  }
  return line
}
