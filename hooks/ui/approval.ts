import { conflictEntry, waveEntries } from '../engine/format.ts'
import type { Preview } from '../engine/preview.ts'
import type { Strings } from './i18n.ts'
import { fit, type Line, type Segment } from './text.ts'

// What a person sees of a run held for start approval. Pure: the caller computes the Preview and passes the strings table.
// Ids, categories, models and paths come from the definition and print as they are; every word around them is a Strings key.

// Lint warnings are listed in full up to this many; more than that and the block gives the count and the first one.
const LINT_LISTED = 3
// A held run needs the person's answer, so its lines share the yellow of a node waiting for a permission answer.
const ATTENTION = 'yellow'

// The compact block under the pane's approval line: the counts, one line per wave, anything that clashes or went
// unchecked, the lint result and the routing note once. Every line is fitted to the pane, so a long warning ends in an
// ellipsis instead of wrapping.
export function approvalPreview(preview: Preview, columns: number, t: Strings): Line[] {
  const row = (text: string, style: Omit<Segment, 'text'> = {}): Line => [{ text: fit(text, columns), ...style }]
  const attention = { color: ATTENTION }
  const lines: Line[] = [
    // A wave wider than the cap queues its overflow, which the person should notice before approving.
    row(t.previewSummary(preview.node_count, preview.waves.length, preview.widest_wave, preview.max_concurrent), preview.widest_wave > preview.max_concurrent ? attention : {}),
    ...preview.waves.map((ids, index) => row(`  ${t.previewWave(index + 1, waveEntries(preview, ids))}`)),
  ]
  if (preview.write_conflicts.length) lines.push(row(t.previewConflicts(preview.write_conflicts.map(conflictEntry).join('; ')), attention))
  if (preview.unchecked_writes.length) lines.push(row(t.previewUnchecked(preview.unchecked_writes.join(', ')), attention))
  const [first] = preview.warnings
  if (first === undefined) lines.push(row(t.previewLintClean))
  else if (preview.warnings.length <= LINT_LISTED) lines.push(...preview.warnings.map(warning => row(t.previewLint(warning), attention)))
  else lines.push(row(t.previewLintMany(preview.warnings.length, first), attention))
  lines.push(row(t.previewRouting, { dim: true }))
  return lines
}
