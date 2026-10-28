import { parseDefinition } from '../hooks/engine/definition.ts'
import { absentOccurrenceWarnings, containsPrecisionWarnings, fileCheckPaths, lintDefinition, lintNotes } from '../hooks/engine/lint.ts'
import type { EngineError } from '../hooks/engine/types.ts'
import { verificationProblem } from '../hooks/engine/verification.ts'
import { parseYaml } from '../hooks/engine/yaml.ts'

// Checks DAG definition files the way the plugin's start action does: parse, verification required, lint.
// Usage: bun eval/check-definition.ts <file.yaml|file.json> [more files...]
// Exit 0 only when every file is OK; exit 1 on any failure (or when no file is given).

const READ_LIMIT = 1_000_000 // same cap as the plugin's start

type Outcome = { ok: true; nodes: number; notes: string[] } | { ok: false; lines: string[] }

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function failure(error: EngineError): Outcome {
  return { ok: false, lines: [`  ${error.code}: ${error.message}`] }
}

// Reads the check targets relative to the working directory; a missing, unreadable or oversized file is left out.
async function readTargets(definition: Parameters<typeof fileCheckPaths>[0]): Promise<Map<string, string>> {
  const texts = new Map<string, string>()
  for (const path of fileCheckPaths(definition)) {
    const file = Bun.file(path)
    try {
      if (file.size <= READ_LIMIT) texts.set(path, await file.text())
    } catch {
      // A missing file or a folder has nothing to search; the warning is advisory.
    }
  }
  return texts
}

async function check(path: string): Promise<Outcome> {
  let source: string
  try {
    source = await Bun.file(path).text()
  } catch (error) {
    return failure({ code: 'unreadable', message: message(error) })
  }
  let input: unknown
  try {
    input = /\.ya?ml$/i.test(path) ? parseYaml(source) : JSON.parse(source)
  } catch (error) {
    return failure({ code: 'parse_error', message: message(error) })
  }
  const parsed = parseDefinition(input)
  if (!parsed.ok) return failure(parsed.error)
  const problem = verificationProblem(parsed.value)
  if (problem) return failure(problem)
  const texts = await readTargets(parsed.value)
  const warnings = [...lintDefinition(parsed.value), ...absentOccurrenceWarnings(parsed.value, texts), ...containsPrecisionWarnings(parsed.value, texts)]
  if (warnings.length > 0) return { ok: false, lines: warnings.map(warning => `  warning: ${warning}`) }
  return { ok: true, nodes: parsed.value.nodes.length, notes: lintNotes(parsed.value) }
}

const paths = Bun.argv.slice(2)
if (paths.length === 0) {
  console.error('Usage: bun eval/check-definition.ts <definition.yaml|definition.json> [more files...]')
  process.exit(1)
}
let failed = false
for (const path of paths) {
  const outcome = await check(path)
  if (outcome.ok) {
    console.log([`OK ${path} (${outcome.nodes} nodes)`, ...outcome.notes.map(note => `  note: ${note}`)].join('\n'))
  } else {
    failed = true
    console.log([`FAIL ${path}`, ...outcome.lines].join('\n'))
  }
}
process.exit(failed ? 1 : 0)
