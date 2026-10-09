import { isBlockedReportPath } from './lint.ts'
import type { EngineError } from './types.ts'

export type Enforcement = 'strict' | 'guide' | 'off'

export const DAG_TOOL = 'mcp__dag-workflow__dag'
export const PLANNING_SKILL = 'dag-workflow:planning'

// Only this plugin's skill or its bare name opens the strict gate; `planning` is short enough that another plugin's `x:planning` must not.
export function isPlanningSkill(name: unknown): boolean {
  if (typeof name !== 'string') return false
  const skill = name.trim().replace(/^\//, '')
  return skill === PLANNING_SKILL || skill === 'planning'
}

export function planningRequired(): EngineError {
  return {
    code: 'planning_skill_required',
    message: `Load the planning doctrine before the first DAG of this session: call the Skill tool with skill "${PLANNING_SKILL}", read the reference file it names in full, write the run plan, then call start again.`,
  }
}

export const MAIN_LOOP_TOOLS: ReadonlySet<string> = new Set([
  DAG_TOOL,
  'Read',
  'LSP',
  'WebFetch',
  'WebSearch',
  'ToolSearch',
  'AskUserQuestion',
  'Skill',
  'EnterPlanMode',
  'ExitPlanMode',
  'ListAgents',
  'GetTask',
  'TaskGet',
  'TaskList',
  'TaskStop',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  'ReadMcpResourceDirTool',
  'ListSkills',
  'SearchSkills',
  'ListPlugins',
  'ListConnectors',
  'ReadNotifications',
  'FetchInboxMessage',
  'memory_list',
  'memory_read',
  'WaitForMcpServers',
  'SendUserMessage',
  'PushNotification',
  'EndConversation',
  'CronList',
])

const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'find', 'fd', 'tree', 'pwd', 'echo',
  'printf', 'stat', 'file', 'du', 'df', 'which', 'type', 'basename', 'dirname', 'realpath', 'readlink',
  'sort', 'uniq', 'cut', 'tr', 'diff', 'cmp', 'jq', 'date', 'whoami', 'uname', 'nl', 'column', 'true', 'cd',
  'test', '[', 'read',
])

// Shell structure words: what follows them on the same segment is a command
// checked like any other, and a bare closing word carries no command at all.
const SHELL_LEADERS: ReadonlySet<string> = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!'])
const SHELL_CLOSERS: ReadonlySet<string> = new Set(['done', 'fi'])
// `command NAME ...` only skips aliases and functions (AGENTS.md tells everyone to type `command claude`), so it is
// skipped like a leader and NAME is still checked. `command -v`/`-p` stay put as the head, which is not on the list.
const COMMAND_BUILTIN = 'command'

function isLeaderToken(tokens: readonly string[]): boolean {
  const first = tokens[0] as string
  if (SHELL_LEADERS.has(first) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) return true
  return first === COMMAND_BUILTIN && !(tokens[1] ?? '').startsWith('-')
}
const VERSION_FLAGS: ReadonlySet<string> = new Set(['--version', '-V', '--help', '-h'])
const UV_PIP_READ_ONLY: ReadonlySet<string> = new Set(['list', 'freeze', 'show', 'check'])
const SED_FLAGS = /^-[nEru]+$|^--(quiet|silent|regexp-extended|unbuffered)$/
const SED_SAFE_COMMANDS: ReadonlySet<string> = new Set(['p', 'P', 'd', 'D', '=', 'q', 'Q', 'n', 'N', 'h', 'H', 'g', 'G', 'x', 'l', '{', '}'])

// A sed script is read-only unless it writes (w, W, s///w) or runs (e, s///e)
// something; scanning skips delimited regexes so a ';' or 'w' inside one is text.
function sedScriptProblem(script: string): string | undefined {
  let i = 0
  const delimited = (delimiter: string): boolean => {
    while (i < script.length) {
      const ch = script[i++]
      if (ch === '\\') i++
      else if (ch === delimiter) return true
    }
    return false
  }
  const address = (): boolean => {
    if (script[i] === '/') {
      i++
      return delimited('/')
    }
    if (script[i] === '\\' && i + 1 < script.length) {
      const delimiter = script[i + 1] as string
      i += 2
      return delimited(delimiter)
    }
    while (i < script.length && /[\d$~]/.test(script[i] as string)) i++
    return true
  }
  const skip = () => {
    while (i < script.length && /[\s;]/.test(script[i] as string)) i++
  }
  skip()
  while (i < script.length) {
    if (!address()) return 'sed script has an unterminated address'
    if (script[i] === ',') {
      i++
      if (!address()) return 'sed script has an unterminated address'
    }
    while (script[i] === ' ' || script[i] === '!') i++
    const command = script[i++]
    if (command === undefined) return 'sed script lacks a command'
    if (command === 's' || command === 'y') {
      const delimiter = script[i++]
      if (!delimiter || !delimited(delimiter) || !delimited(delimiter)) return `sed ${command} command is unterminated`
      const start = i
      while (i < script.length && /[A-Za-z0-9]/.test(script[i] as string)) i++
      if (/[weW]/.test(script.slice(start, i))) return 'sed s with the w or e flag writes files or runs commands'
    } else if (!SED_SAFE_COMMANDS.has(command)) {
      return `sed command "${command}" can write files or run commands`
    }
    skip()
  }
  return undefined
}

function sedProblem(args: string[]): string | undefined {
  const scripts: string[] = []
  for (let k = 0; k < args.length; k++) {
    const arg = args[k] as string
    if (SED_FLAGS.test(arg)) continue
    if (arg === '-e' || arg === '--expression') {
      scripts.push(args[++k] ?? '')
      continue
    }
    if (arg.startsWith('-')) return `sed ${arg} is not allowed in the main conversation`
    if (scripts.length === 0) scripts.push(arg)
  }
  if (scripts.length === 0) return 'sed without a script'
  for (const script of scripts) {
    const problem = sedScriptProblem(script)
    if (problem) return problem
  }
  return undefined
}

const GIT_READ_ONLY: ReadonlySet<string> = new Set([
  'status', 'log', 'diff', 'show', 'ls-files', 'ls-tree', 'rev-parse', 'blame', 'describe', 'shortlog',
  'grep', 'cat-file', 'branch', 'tag', 'remote',
])

const FIND_WRITERS = new Set(['-exec', '-execdir', '-delete', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls'])
const GIT_BRANCH_WRITERS = /^(-d|-D|-m|-M|-c|-C|-f|-u|--delete|--move|--copy|--force|--set-upstream-to.*|--unset-upstream|--edit-description)$/

function tokenize(segment: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: string | undefined
  let started = false
  for (const ch of segment) {
    if (quote) {
      if (ch === quote) quote = undefined
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      started = true
    } else if (/\s/.test(ch)) {
      if (started || current) tokens.push(current)
      current = ''
      started = false
    } else {
      current += ch
      started = true
    }
  }
  if (started || current) tokens.push(current)
  return tokens
}

function splitSegments(command: string): string[] {
  const segments: string[] = []
  let current = ''
  let quote: string | undefined
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string
    if (quote) {
      if (ch === quote) quote = undefined
      current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
    } else if (ch === ';' || ch === '\n' || ch === '|' || ch === '&') {
      segments.push(current)
      current = ''
      if ((ch === '|' || ch === '&') && command[i + 1] === ch) i++
    } else {
      current += ch
    }
  }
  segments.push(current)
  return segments.map(s => s.trim()).filter(Boolean)
}

function gitVerdict(args: string[]): string | undefined {
  let i = 0
  while (i < args.length && (args[i] as string).startsWith('-')) {
    const flag = args[i] as string
    i += flag === '-C' || flag === '-c' || flag === '--git-dir' || flag === '--work-tree' ? 2 : 1
  }
  const sub = args[i]
  if (!sub || !GIT_READ_ONLY.has(sub)) return `git ${sub ?? ''} is not a read-only git command`.trim()
  const rest = args.slice(i + 1)
  if (sub === 'branch' && rest.some(a => !a.startsWith('-') || GIT_BRANCH_WRITERS.test(a))) return 'git branch with a name or a write flag changes branches'
  if (sub === 'tag' && rest.some(a => a !== '-l' && a !== '--list' && !a.startsWith('--sort') && !a.startsWith('-n'))) return 'git tag with arguments creates or deletes tags'
  if (sub === 'remote' && rest.some(a => a !== '-v' && a !== '--verbose' && a !== 'show' && a !== 'get-url')) return 'git remote with arguments changes remotes'
  return undefined
}

export function readOnlyBashProblem(command: string): string | undefined {
  const text = command.replace(/\d?>&\d/g, ' ').replace(/\d?>\s*\/dev\/null/g, ' ')
  const outsideSingle = text.replace(/'[^']*'/g, "''")
  if (/[`]|\$\(/.test(outsideSingle)) return 'command substitution can run anything'
  if (/<\(/.test(outsideSingle)) return 'process substitution can run anything'
  if (/>/.test(outsideSingle.replace(/"[^"]*"/g, '""'))) return 'output redirection writes files'
  for (const segment of splitSegments(text)) {
    const tokens = tokenize(segment).filter((token, k, all) => !/^\d?<$/.test(token) && !/^\d?<[^<(]/.test(token) && !/^\d?<$/.test(all[k - 1] ?? ''))
    while (tokens.length > 0 && isLeaderToken(tokens)) tokens.shift()
    const head = tokens[0]
    if (!head) continue
    if (SHELL_CLOSERS.has(head) && tokens.length === 1) continue
    if (head === 'for') {
      if (tokens.length >= 3 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(tokens[1] as string) && tokens[2] === 'in') continue
      return 'a for loop must read "for NAME in WORDS"'
    }
    const name = head.split('/').pop() as string
    const args = tokens.slice(1)
    if (args.length === 1 && VERSION_FLAGS.has(args[0] as string)) continue
    if (name === 'git') {
      const problem = gitVerdict(args)
      if (problem) return problem
      continue
    }
    if (name === 'uv') {
      if (args[0] === 'pip' && UV_PIP_READ_ONLY.has(args[1] as string)) continue
      return `uv ${args.slice(0, args[0] === 'pip' ? 2 : 1).join(' ')} is not a read-only uv command`.trim()
    }
    if (name === 'sed') {
      const problem = sedProblem(args)
      if (problem) return problem
      continue
    }
    if (!READ_ONLY_COMMANDS.has(name)) return `${name} is not on the read-only command list`
    if (name === 'find' && args.some(a => FIND_WRITERS.has(a))) return 'find with -exec/-delete can change files'
    if (name === 'sort' && args.some(a => a === '-o' || a.startsWith('--output'))) return 'sort -o writes a file'
    if (name === 'date' && args.some(a => a === '-s' || a.startsWith('--set'))) return 'date -s changes the clock'
  }
  return undefined
}

export type Verdict = { allowed: true } | { allowed: false; reason: string }

export function mainLoopVerdict(tool: string, input: Readonly<Record<string, unknown>>, extraAllowed: ReadonlySet<string>): Verdict {
  if (MAIN_LOOP_TOOLS.has(tool) || extraAllowed.has(tool)) return { allowed: true }
  if (tool === 'Bash') {
    const problem = readOnlyBashProblem(typeof input.command === 'string' ? input.command : '')
    return problem ? { allowed: false, reason: `this Bash command is not read-only (${problem})` } : { allowed: true }
  }
  // Claude Code refuses these names to subagents, so a report the user requires can only be written here; Edit and Bash stay refused.
  if (tool === 'Write' && typeof input.file_path === 'string' && isBlockedReportPath(input.file_path)) return { allowed: true }
  return { allowed: false, reason: `${tool} changes state or delegates work` }
}

export function denyMessage(tool: string, reason: string): string {
  return [
    `dag-workflow refused ${tool} in the main conversation: ${reason}.`,
    'DAG orchestration is mandatory here: this conversation only plans, reads (Read, LSP, read-only Bash, web), asks and orchestrates.',
    `Put this work into a DAG node instead: plan it with the ${PLANNING_SKILL} skill, then call ${DAG_TOOL} with action "start" (a new plan; a one-step task is a one-node DAG) or "amend" (add or change nodes of the current run).`,
    'Nodes run as subagents with every tool, receive the outputs of the nodes they depend on, and report back when the run settles.',
  ].join('\n')
}

export function protocolFor(level: Enforcement, interactive = true): string {
  const rule = level === 'strict'
    ? 'In this main conversation you only plan, read (Read, LSP, read-only Bash, web), ask, orchestrate and verify; Edit, Write, mutating Bash, Agent, Workflow, TodoWrite and other tools are refused here and belong inside DAG nodes. The one exception: Write to a REPORT*, SUMMARY*, FINDINGS* or ANALYSIS* .md file the user asked for, which Claude Code refuses to subagents, only to copy a settled node\'s Output or notes verbatim.'
    : 'Prefer doing all work inside DAG nodes; this main conversation should plan, orchestrate and verify.'
  const lines = [
    '[dag-workflow] DAG orchestration is mandatory for this task.',
    level === 'strict'
      ? `- Before your first DAG in this session, load the ${PLANNING_SKILL} skill with the Skill tool and follow it; start is refused until you do.`
      : `- Before your first DAG in this session, load the ${PLANNING_SKILL} skill with the Skill tool and follow it.`,
    `- Plan the task as a DAG and run it with ${DAG_TOOL} (action "start"); a one-step task is a one-node DAG. Do not keep plans in TodoWrite or TaskCreate.`,
    `- ${rule}`,
    '- Model the real dependencies: a node lists in dependsOn every node whose result it needs; independent nodes run in parallel; keep their write scopes disjoint.',
    '- Every node automatically receives the outputs of the nodes it depends on. Set the definition\'s "goal" to the overall objective and tell each node what to produce.',
    '- start returns at once. Do not poll: when the run settles you get a summary with every node\'s output. Verify it, then use retry, amend or a follow-up run for anything missing.',
  ]
  if (!interactive) lines.push('- Non-interactive session: do not ask the user (no AskUserQuestion, no clarifying questions); decide, and record every assumption in the definition\'s goal and in the node prompts.')
  return lines.join('\n')
}
