import type { Run } from './types.ts'

// What prompt.autocomplete reports (claude-code's PromptAutocompleteInput): the draft, the caret, the non-whitespace token
// that ends at the caret and where it starts. engine/ never imports the host's typings, so the shape is spelled here.
export type AutocompleteInput = { text: string; cursor: number; token: string; start: number }
// A row of the typeahead: what taking it writes over the token, and the dim line beside it.
export type AutocompleteRow = { text: string; description?: string }
export type AutocompleteRun = Pick<Run, 'runId' | 'name' | 'status' | 'createdAt'>

// The typeahead draws a short list; 20 rows is a screenful of it.
export const AUTOCOMPLETE_ROWS = 20
// Where this repo keeps definition files (flows/improvement/*.yaml, eval/fixtures/*.yaml); the host module lists these two.
export const DEFINITION_FOLDERS: readonly string[] = ['flows', 'eval/fixtures']
// The extensions /dag run reads: YAML for .yaml and .yml in any case, JSON for the rest (register.ts readDefinitionFile).
const DEFINITION_FILE = /\.(ya?ml|json)$/i
const FILE_VERBS: ReadonlySet<string> = new Set(['run', 'preview'])
const RUN_VERBS: ReadonlySet<string> = new Set(['status', 'cancel', 'retry', 'approve', 'reject', 'handoff', 'accept'])
// The draft up to the token must be `/dag <subcommand> ` and nothing else, so only the subcommand's first argument matches.
const ARGUMENT_HEAD = /^\/dag[ \t]+([a-z]+)[ \t]+$/

// Which list the token's position needs: the definition files, the run ids, or none. The hook asks this first so a keystroke
// elsewhere in the draft does not read the file list at all.
export function autocompleteWant({ text, cursor, token }: AutocompleteInput): 'files' | 'runs' | undefined {
  // A taken row replaces only the token, so a caret inside a word would leave the rest of it behind the row.
  if (!/^(\s|$)/.test(text.slice(cursor))) return undefined
  const verb = ARGUMENT_HEAD.exec(text.slice(0, cursor - token.length))?.[1]
  if (verb === undefined) return undefined
  if (FILE_VERBS.has(verb)) return 'files'
  return RUN_VERBS.has(verb) ? 'runs' : undefined
}

// Up to AUTOCOMPLETE_ROWS rows for the token: project-relative definition paths in sorted order, or run ids newest first.
export function autocompleteRows(input: AutocompleteInput, files: readonly string[], runs: readonly AutocompleteRun[]): AutocompleteRow[] {
  const want = autocompleteWant(input)
  if (want === 'files') {
    return files
      .filter(path => DEFINITION_FILE.test(path) && path.startsWith(input.token))
      .sort()
      .slice(0, AUTOCOMPLETE_ROWS)
      .map(path => ({ text: path }))
  }
  if (want === 'runs') {
    return runs
      .filter(run => run.runId.startsWith(input.token))
      .sort((a, b) => b.createdAt - a.createdAt || (a.runId < b.runId ? 1 : -1))
      .slice(0, AUTOCOMPLETE_ROWS)
      .map(run => ({ text: run.runId, description: `${run.name.replace(/\s+/g, ' ')} · ${run.status}` }))
  }
  return []
}
