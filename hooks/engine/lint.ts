import type { Definition, NodeDef, VerificationCheck } from './types.ts'

const VERIFICATION_WORDS = /verif|validat|check|test|review|audit/i

// Claude Code refuses subagent Write calls to Markdown files with these basenames (seen on 2.1.288, re-checked on 2.1.295 with --safe-mode).
export const HOST_BLOCKED_REPORT_NAME = /^(REPORT|SUMMARY|FINDINGS|ANALYSIS).*\.md$/i

export function isBlockedReportPath(path: string): boolean {
  return HOST_BLOCKED_REPORT_NAME.test(path.split(/[\\/]/).pop() ?? '')
}

export function isVerificationNode(node: NodeDef): boolean {
  if (node.dependsOn.length === 0) return false
  return [node.id, node.label, node.task_summary, node.description].some(text => text !== undefined && VERIFICATION_WORDS.test(text))
}

// The final audit: a verification node that nothing depends on and that judges two or more inputs.
export function isFinalAudit(definition: Definition, node: NodeDef): boolean {
  return node.dependsOn.length >= 2 && !definition.nodes.some(other => other.dependsOn.includes(node.id)) && isVerificationNode(node)
}

const MIN_SPLIT_FILES = 3
const MIN_SPLIT_SECTIONS = 3
// A change and its own tests are one deliverable (the doctrine keeps them in one node), so tests do not count.
const TEST_PATH = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[^/]+$/

function deliverablePaths(node: NodeDef): string[] {
  const paths = [
    ...(node.writes ?? []),
    ...(node.verify ?? []).flatMap(check => (check.kind === 'file' ? [check.path] : [])),
  ]
  return [...new Set(paths.map(path => path.replace(/\/+$/, '')))].filter(path => !TEST_PATH.test(path))
}

function namedSections(prompt: string): string[] {
  const names = [...prompt.matchAll(/##\s+([A-Z][\w-]*(?: [A-Z][\w-]*)*)/g)].map(match => (match[1] ?? '').trim().toLowerCase())
  return [...new Set(names.filter(name => name !== '' && name !== 'output'))]
}

// Vacuous verify checks pass without proving the deliverable is right.
// V1: a file check without contains. V2: a command that always passes. V3: a command that only tests that a path exists.
const ALWAYS_PASSING_PROGRAMS = new Set(['true', ':', 'echo', 'printf', 'exit', 'yes', 'sleep']) // V2
const EXISTENCE_ONLY_PROGRAMS = new Set(['ls', 'stat', 'cat']) // V3
const EXISTENCE_TEST_PROGRAMS = new Set(['test', '[']) // V3
const EXISTENCE_TEST_FLAGS = new Set(['-e', '-f', '-d', '-s']) // V3

function programName(argv: string[]): string {
  return (argv[0] ?? '').split(/[\\/]/).pop() ?? ''
}

// V3: test or [ whose dash arguments are all bare existence flags; any other operator or no flag at all is a real test.
function isExistenceTest(argv: string[]): boolean {
  if (!EXISTENCE_TEST_PROGRAMS.has(programName(argv))) return false
  const flags = argv.slice(1).filter(arg => arg.startsWith('-'))
  return flags.length > 0 && flags.every(flag => EXISTENCE_TEST_FLAGS.has(flag))
}

function vacuousReason(check: VerificationCheck): string | undefined {
  if (check.kind === 'file') {
    return check.contains ? undefined : 'is a file check without contains, so it only proves the file exists (touch passes it)'
  }
  const program = programName(check.argv)
  if (ALWAYS_PASSING_PROGRAMS.has(program)) return `runs ${program}, which always passes`
  if (EXISTENCE_ONLY_PROGRAMS.has(program) || isExistenceTest(check.argv)) return 'only tests that a path exists'
  return undefined
}

export function lintDefinition(definition: Definition): string[] {
  const warnings: string[] = []
  for (const node of definition.nodes) {
    const missing = [
      ...(node.prompt.includes('TASK:') ? [] : ['TASK:']),
      ...(node.prompt.includes('STOP WHEN') ? [] : ['STOP WHEN']),
    ]
    if (missing.length > 0) {
      warnings.push(`node "${node.id}": the prompt lacks ${missing.join(' and ')} - follow the node prompt contract (TASK, DELIVERABLE, SCOPE, VERIFY, STOP WHEN).`)
    }
  }
  for (const node of definition.nodes) {
    const paths = [
      ...(node.verify ?? []).flatMap(check => (check.kind === 'file' ? [check.path] : [])),
      ...(node.writes ?? []),
    ]
    for (const path of paths) {
      if (isBlockedReportPath(path)) {
        warnings.push(`node "${node.id}": "${path}" is named like a report, and Claude Code 2.1.295 refuses subagent writes to REPORT*, SUMMARY*, FINDINGS* and ANALYSIS* Markdown files - use a different name such as ${node.id}-notes.md or return the text in ## Output; if the user requires this exact name, the main conversation writes the file after the run settles.`)
      }
    }
  }
  for (const node of definition.nodes) {
    const clauses = (node.verify ?? []).flatMap((check, index) => {
      const reason = vacuousReason(check)
      return reason === undefined ? [] : [`check ${index + 1} ${reason}`]
    })
    if (clauses.length > 0) {
      warnings.push(`node "${node.id}": vacuous verify - ${clauses.join('; ')} - declare a file check with nonempty contains text, or a command that exits nonzero when the deliverable is wrong.`)
    }
  }
  const producers = definition.nodes.filter(node => !isVerificationNode(node))
  for (const node of producers) {
    const paths = deliverablePaths(node)
    if (paths.length >= MIN_SPLIT_FILES) {
      warnings.push(`node "${node.id}": one producer owns ${paths.length} files (${paths.join(', ')}) - give each independent file its own node so the lanes run in parallel and fail in isolation.`)
    }
  }
  if (producers.length === 1) {
    const sections = namedSections(producers[0]!.prompt)
    if (sections.length >= MIN_SPLIT_SECTIONS) {
      warnings.push(`node "${producers[0]!.id}": the only producer writes ${sections.length} separate sections (${sections.join(', ')}) - fan out one node per section and add a synthesis node that depends on them.`)
    }
  }
  if (definition.nodes.length >= 2 && !definition.nodes.some(isVerificationNode)) {
    warnings.push('the graph has no verification node - add a node that depends on the producers, runs the real check and has "verify" in its id or label.')
  }
  for (const node of definition.nodes) {
    // A missing category routes as quick, so it is held to the same rule.
    if ((node.category ?? 'quick') === 'quick' && isFinalAudit(definition, node)) {
      warnings.push(`node "${node.id}": the final audit requires judgment across inputs, while quick is reserved for mechanical checks - it runs on unspecified-low instead; write unspecified-low or higher in the definition. Both quick and unspecified-low use sonnet.`)
    }
  }
  if (definition.goal === undefined || definition.goal.trim() === '') {
    warnings.push('the definition has no goal - set "goal" to one sentence naming the deliverable and its observable done condition; every node sees it.')
  }
  return warnings
}
