import { parseDefinition } from '../hooks/engine/definition.ts'
import { lintDefinition } from '../hooks/engine/lint.ts'
import type { EngineError } from '../hooks/engine/types.ts'
import { verificationProblem } from '../hooks/engine/verification.ts'
import { parseYaml } from '../hooks/engine/yaml.ts'

// Checks DAG definition files the way the plugin's start action does: parse, verification required, lint.
// Usage: bun eval/check-definition.ts [--allow-warnings] <file.yaml|file.json> [more files...]
// The flag may sit anywhere among the arguments. Exit 0 only when every file is OK; exit 1 on any failure (or when no file is given).
// Lint warnings alone make a file FAIL, unless --allow-warnings is given: then the file prints
// `OK <path> (<n> nodes, <k> warnings)` followed by its warning lines. Parse errors, unreadable files and missing verify still FAIL.

type Outcome = { ok: true; nodes: number; warnings: string[] } | { ok: false; lines: string[] }

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function failure(error: EngineError): Outcome {
  return { ok: false, lines: [`  ${error.code}: ${error.message}`] }
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
  const warnings = lintDefinition(parsed.value).map(warning => `  warning: ${warning}`)
  return { ok: true, nodes: parsed.value.nodes.length, warnings }
}

const args = Bun.argv.slice(2)
const allowWarnings = args.includes('--allow-warnings')
const paths = args.filter(arg => arg !== '--allow-warnings')
if (paths.length === 0) {
  console.error('Usage: bun eval/check-definition.ts [--allow-warnings] <definition.yaml|definition.json> [more files...]')
  process.exit(1)
}
let failed = false
for (const path of paths) {
  const outcome = await check(path)
  if (outcome.ok && outcome.warnings.length === 0) {
    console.log(`OK ${path} (${outcome.nodes} nodes)`)
  } else if (outcome.ok && allowWarnings) {
    console.log([`OK ${path} (${outcome.nodes} nodes, ${outcome.warnings.length} warnings)`, ...outcome.warnings].join('\n'))
  } else {
    failed = true
    console.log([`FAIL ${path}`, ...(outcome.ok ? outcome.warnings : outcome.lines)].join('\n'))
  }
}
process.exit(failed ? 1 : 0)
