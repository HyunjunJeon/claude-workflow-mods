import { TEXT_FIELDS, type Definition, type NodeDef, type VerificationCheck } from './types.ts'
import { projectPath, TEXT_FIELD_LIST } from './verification.ts'

// A verification word counts only at the start of a word, so "preview", "contest" and "retest" do not make a node a verifier.
// camelCase ids are split first ("finalReview" -> "final Review").
const VERIFICATION_WORDS = /(^|[^a-z0-9])(verif|validat|check|test|review|audit)/i

function hasVerificationWord(text: string): boolean {
  return VERIFICATION_WORDS.test(text.replace(/([a-z0-9])([A-Z])/g, '$1 $2'))
}

// Claude Code refuses subagent Write calls to Markdown files with these basenames (seen on 2.1.288, re-checked on 2.1.295 with --safe-mode).
export const HOST_BLOCKED_REPORT_NAME = /^(REPORT|SUMMARY|FINDINGS|ANALYSIS).*\.md$/i

export function isBlockedReportPath(path: string): boolean {
  return HOST_BLOCKED_REPORT_NAME.test(path.split(/[\\/]/).pop() ?? '')
}

// The notes file name to suggest instead of a report name. <id>-notes.md is the doctrine's name, but an id that itself starts
// like a report (report-draft) gives report-draft-notes.md, which the host refuses as well, so the id moves behind notes-.
export function notesNameFor(nodeId: string): string {
  const name = `${nodeId}-notes.md`
  return isBlockedReportPath(name) ? `notes-${nodeId}.md` : name
}

export function isVerificationNode(node: NodeDef): boolean {
  if (node.dependsOn.length === 0) return false
  return [node.id, node.label, node.task_summary, node.description].some(text => text !== undefined && hasVerificationWord(text))
}

// The final audit: a verification node that nothing depends on and that judges two or more inputs.
export function isFinalAudit(definition: Definition, node: NodeDef): boolean {
  return node.dependsOn.length >= 2 && !definition.nodes.some(other => other.dependsOn.includes(node.id)) && isVerificationNode(node)
}

const MIN_SPLIT_FILES = 3
const MIN_SPLIT_SECTIONS = 3
// A change and its own tests are one deliverable (the doctrine keeps them in one node), so tests do not count.
// A tests folder on its own counts as tests too: normalizePath strips the trailing slash, so writes: ['tests/'] reaches this regex as "tests".
const TEST_PATH = /(^|\/)(tests?|__tests__)(\/|$)|\.(test|spec)\.[^/]+$/

// ./src/, src//a.ts, src/./a.ts and src\a.ts name the same place as src and src/a.ts, so every path is spelled one way before it is compared.
// Callers pass only project-relative paths (projectPath), so only separators and . segments are left to fold. The project root itself stays as ".".
export function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').split('/').filter(part => part !== '' && part !== '.').join('/') || '.'
}

// Every path a node's file checks read, relative or absolute: a node may write its notes under /tmp and check them there.
function checkedFiles(node: NodeDef): string[] {
  return (node.verify ?? []).flatMap(check => (check.kind === 'file' ? [check.path] : []))
}

// The under-split rule counts lanes of project work, so it takes only project-relative paths; an absolute check
// (notes under /tmp, a file outside the project) is not a project file the producer owns, and normalizePath folds only relative spellings.
function checkedProjectFiles(node: NodeDef): string[] {
  return checkedFiles(node).filter(projectPath)
}

// A declared folder and the files checked inside it are one deliverable, so only the most specific paths count.
function deliverablePaths(node: NodeDef): string[] {
  const paths = [...(node.writes ?? []), ...checkedProjectFiles(node)]
  const unique = [...new Set(paths.map(normalizePath))].filter(path => !TEST_PATH.test(path))
  return unique.filter(path => !unique.some(other => other.startsWith(`${path}/`)))
}

function namedSections(prompt: string): string[] {
  const names = [...prompt.matchAll(/##\s+([A-Z][\w-]*(?: [A-Z][\w-]*)*)/g)].map(match => (match[1] ?? '').toLowerCase())
  return [...new Set(names.filter(name => name !== 'output'))]
}

// Vacuous verify checks pass without proving the deliverable is right.
// V1: a file check with no text expectation. V2: a command that always passes. V3: a command that only tests that a path exists.
// V4: a command that accepts several exit codes and checks no output, so success and failure both pass.
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

// V4: two or more distinct accepted exit codes and neither stdout nor stderr expected.
function acceptsSeveralExitsBlind(check: Extract<VerificationCheck, { kind: 'command' }>): boolean {
  const exit = check.expect?.exit
  return Array.isArray(exit) && new Set(exit).size >= 2 && check.expect?.stdout === undefined && check.expect?.stderr === undefined
}

function vacuousReason(check: VerificationCheck): string | undefined {
  if (check.kind === 'file') {
    return TEXT_FIELDS.some(field => check[field] !== undefined)
      ? undefined
      : `is a file check without ${TEXT_FIELD_LIST}, so it only proves the file exists (touch passes it)`
  }
  const program = programName(check.argv)
  if (ALWAYS_PASSING_PROGRAMS.has(program)) return `runs ${program}, which always passes`
  if (acceptsSeveralExitsBlind(check)) return 'accepts several exit codes without checking output'
  if (EXISTENCE_ONLY_PROGRAMS.has(program) || isExistenceTest(check.argv)) return 'only tests that a path exists'
  return undefined
}

// review-spec judges the result against the request sentences, so the request is cut into the parts it will judge one by one:
// at sentence ends, ';', newlines and commas outside parentheses. A part of fewer than three words ("and", "etc.") joins the one before it.
const MIN_CLAUSE_WORDS = 3

function requestClauses(request: string): string[] {
  const parts: string[] = []
  let current = ''
  let depth = 0
  for (let index = 0; index < request.length; index++) {
    const char = request.charAt(index)
    current += char
    if (char === '(') depth++
    if (char === ')') depth = Math.max(0, depth - 1)
    const next = request.charAt(index + 1)
    const sentenceEnd = '.!?'.includes(char) && (next === '' || /\s/.test(next))
    if (sentenceEnd || char === ';' || char === '\n' || (char === ',' && depth === 0)) {
      parts.push(current)
      current = ''
    }
  }
  parts.push(current)
  const clauses: string[] = []
  for (const text of parts) {
    const part = text.replace(/[\s,;.!?]+$/, '').trim()
    if (part === '') continue
    const words = part.split(/\s+/).length
    if (words < MIN_CLAUSE_WORDS && clauses.length > 0) clauses[clauses.length - 1] += ` ${part}`
    else clauses.push(part)
  }
  return clauses
}

const DELIVERABLE_START = /^(?:add|create|implement|build|write|introduce|expose|support|make|return|an?|and an?)\b/i
// A criterion is a result word, a status code, an output verb, or a double-quoted literal such as "hello <name>" that the output can be checked against.
// A backtick span such as `greet` only names the deliverable, so it is not one.
const CRITERION = /"[^"]+"|\b(?:[1-5]\d\d|returns?|responds|when|if|unless|only|must|never|rejects?|errors?|fails?|status|within|limit|empty|sorted|ordered|matches|contains|exactly|with|as|prints|outputs|displays|shows|writes|logs|exits|emits|renders|sends|redirects|raises|throws|lists)\b/i
const ACCESS_RULE = /\b(authori[sz]\w*|permission\w*|owners?|admins?|administrators?|roles?|who (?:may|can)|signed[- ]in|logged[- ]in|access control)\b/i
// Who may act matters only for something other people can reach, so warning 2 needs a network surface in the request or goal.
const NETWORK_SURFACE = /\b(?:endpoints?|routes?|apis?|urls?|https?|web\w*|servers?|pages?|forms?)\b/i

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
  // One warning per node: a notes path is usually both checked (lastLine, contains) and written, and each mention used to repeat it.
  for (const node of definition.nodes) {
    const blocked = [...new Set([...checkedFiles(node), ...(node.writes ?? [])].filter(isBlockedReportPath))]
    if (blocked.length > 0) {
      warnings.push(`node "${node.id}": ${blocked.map(path => `"${path}"`).join(', ')} ${blocked.length === 1 ? 'is' : 'are'} named like a report, and Claude Code 2.1.295 refuses subagent writes to REPORT*, SUMMARY*, FINDINGS* and ANALYSIS* Markdown files - use a different name such as ${notesNameFor(node.id)} or return the text in ## Output; if the user requires this exact name, the main conversation writes the file after the run settles.`)
    }
  }
  for (const node of definition.nodes) {
    const clauses = (node.verify ?? []).flatMap((check, index) => {
      const reason = vacuousReason(check)
      return reason === undefined ? [] : [`check ${index + 1} ${reason}`]
    })
    if (clauses.length > 0) {
      warnings.push(`node "${node.id}": vacuous verify - ${clauses.join('; ')} - declare a file check with ${TEXT_FIELD_LIST}, or a command that fails when the deliverable is wrong (one accepted exit code, or an expect on its stdout or stderr).`)
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
    // A missing category routes as trivial, so it is held to the same rule.
    if ((node.category ?? 'trivial') === 'trivial' && isFinalAudit(definition, node)) {
      warnings.push(`node "${node.id}": the final audit requires judgment across inputs, while trivial is reserved for mechanical checks - it runs on standard instead; write standard or higher in the definition. Both trivial and standard use sonnet.`)
    }
  }
  if (definition.goal === undefined || definition.goal.trim() === '') {
    warnings.push('the definition has no goal - set "goal" to one sentence naming the deliverable and its observable done condition; every node sees it.')
  }
  const review = definition.review
  if (review !== undefined) {
    for (const clause of requestClauses(review.request)) {
      if (DELIVERABLE_START.test(clause) && !CRITERION.test(clause)) {
        warnings.push(`review.request: "${clause}" names a deliverable without an observable criterion (what it returns or does, its error and edge cases) - review-spec judges such a part by its own reading, so repeated runs can disagree; state the expected behavior.`)
      }
    }
    const requestAndGoal = `${review.request}\n${definition.goal ?? ''}`
    if ((review.security?.length ?? 0) > 0 && NETWORK_SURFACE.test(requestAndGoal) && !ACCESS_RULE.test(requestAndGoal)) {
      warnings.push('review.request: review.security is set, but neither the request nor the goal says who may use what it asks for - after a security fix adds an access check, review-spec can report it as unrequested or as conflicting with a requested result (a 403 before a requested 404); say who may perform each action.')
    }
  }
  return warnings
}
