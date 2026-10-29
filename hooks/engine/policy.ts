import { isBlockedReportPath } from './lint.ts'
import type { EngineError } from './types.ts'

export type Enforcement = 'strict' | 'auto' | 'guide' | 'off'
// How one user turn runs under `auto`: 'dag' (the strict rules) on a confident Jev 'dag', otherwise 'direct'.
export type TurnMode = 'dag' | 'direct'
// Where the answer to one user turn is shown under `auto`: 'chat' (today's behaviour) or 'board' when Jev
// judges that the user wants to understand something with several parts.
export type TurnSurface = 'chat' | 'board'

// Only a direct turn under auto lifts the main-loop gate; a turn Jev confidently calls dag, or one in a session
// with an unsettled run, is passed in as 'dag'.
export function gatesMainLoop(level: Enforcement, mode: TurnMode): boolean {
  return level === 'strict' || (level === 'auto' && mode === 'dag')
}

// A DAG opened under auto is the same DAG as under strict, so its start needs the planning skill too, even
// when the turn that opens it began as a direct one.
export function gatesPlanning(level: Enforcement): boolean {
  return level === 'strict' || level === 'auto'
}

export const DAG_TOOL = 'mcp__dag-workflow__dag'
// The board only draws into this plugin's own pane and reads project files the main conversation may Read anyway.
export const BOARD_TOOL = 'mcp__dag-workflow__board'
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
  BOARD_TOOL,
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
// A `NAME=value` word before a command is skipped only for variables that change how output looks. Any other one
// can change what runs (LD_PRELOAD, PATH, GIT_PAGER), and a bare `PATH=./bin;` still holds for the next segment.
// Lowercase names are refused too: in zsh `path=(/x $path)` changes PATH, `functions[ls]=x` redefines ls and
// `precmd_functions` runs code, and `a=-delete; find . $a` carries a flag past the checks below.
const DISPLAY_ENV = /^(?:LANG|LANGUAGE|TZ|NO_COLOR|FORCE_COLOR|CLICOLOR|COLUMNS|TERM|LC_[A-Za-z0-9_]*)=/
// `NAME+=value` and `NAME[i]=value` assign too; left alone, a head like `PATH+=:/x/ls` would be read as the command `ls`.
const ENV_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]=]*\])?\+?=/

function isLeaderToken(tokens: readonly string[]): boolean {
  const [first = ''] = tokens
  if (SHELL_LEADERS.has(first) || DISPLAY_ENV.test(first)) return true
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
      const delimiter = script.charAt(i + 1)
      i += 2
      return delimited(delimiter)
    }
    while (i < script.length && /[\d$~]/.test(script.charAt(i))) i++
    return true
  }
  const skip = () => {
    while (i < script.length && /[\s;]/.test(script.charAt(i))) i++
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
      while (i < script.length && /[A-Za-z0-9]/.test(script.charAt(i))) i++
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
  const rest = args.values()
  for (const arg of rest) {
    if (SED_FLAGS.test(arg)) continue
    if (arg === '-e' || arg === '--expression') {
      scripts.push(rest.next().value ?? '')
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
    const ch = command.charAt(i)
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

// Global options that only pick the repository or the pager. Every other one can make git run a program (-c and
// --config-env set core.pager and friends, --exec-path swaps git's helpers, --paginate starts the pager).
const GIT_GLOBAL_WITH_VALUE: ReadonlySet<string> = new Set(['-C', '--git-dir', '--work-tree'])
const GIT_GLOBAL_PLAIN: ReadonlySet<string> = new Set([
  '--no-pager', '-P', '--no-optional-locks', '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs',
])
const GIT_GLOBAL_INLINE = /^--(?:git-dir|work-tree)=/

function optionName(arg: string): string {
  const eq = arg.indexOf('=')
  return eq < 0 ? arg : arg.slice(0, eq)
}

// getopt_long parsers take any unambiguous prefix of a long option (`sort --out=f` writes f, `file --comp` compiles),
// so a prefix of a named option counts as that option. A bare `--` ends the options and is not one.
function hasLongOption(args: readonly string[], ...names: string[]): boolean {
  return args.some(arg => {
    const given = optionName(arg)
    return given.length > 2 && given.startsWith('--') && names.some(name => `--${name}`.startsWith(given))
  })
}

// A short flag hides in a cluster (`sort -uo f`, `file -bC`) and may carry its value inline (`sort -ofile`), so every
// letter after a single dash counts. A value that happens to contain the letter (`sort -to`) is refused too; spacing it avoids that.
function hasShortFlag(args: readonly string[], letters: string): boolean {
  return args.some(arg => /^-[^-]/.test(arg) && [...arg.slice(1)].some(letter => letters.includes(letter)))
}

// `uniq [OPTION]... [INPUT [OUTPUT]]`: the second operand is a file uniq writes. -f, -s and -w take the next word as their value.
function uniqOperands(args: readonly string[]): number {
  let operands = 0
  const rest = args.values()
  for (const arg of rest) {
    if (arg === '--') {
      operands += [...rest].length
      break
    }
    if (arg === '-' || !arg.startsWith('-')) operands++
    else if (/^-[A-Za-z]*[fsw]$|^--(?:skip-fields|skip-chars|check-chars)$/.test(arg)) rest.next()
  }
  return operands
}

function gitVerdict(args: string[]): string | undefined {
  let i = 0
  let flag = args[i]
  while (flag?.startsWith('-')) {
    if (GIT_GLOBAL_WITH_VALUE.has(flag)) i += 2
    else if (GIT_GLOBAL_PLAIN.has(flag) || GIT_GLOBAL_INLINE.test(flag)) i += 1
    else return `git global option ${optionName(flag)} is not on the read-only list`
    flag = args[i]
  }
  const sub = args[i]
  if (!sub || !GIT_READ_ONLY.has(sub)) return `git ${sub ?? ''} is not a read-only git command`.trim()
  const rest = args.slice(i + 1)
  if (hasLongOption(rest, 'output')) return 'git --output writes a file'
  if (hasLongOption(rest, 'ext-diff')) return 'git --ext-diff can run a program'
  if (sub === 'grep' && (hasShortFlag(rest, 'O') || hasLongOption(rest, 'open-files-in-pager'))) return 'git grep -O can run a program'
  if (sub === 'branch' && rest.some(a => !a.startsWith('-') || GIT_BRANCH_WRITERS.test(a))) return 'git branch with a name or a write flag changes branches'
  if (sub === 'tag' && rest.some(a => a !== '-l' && a !== '--list' && !a.startsWith('--sort') && !a.startsWith('-n'))) return 'git tag with arguments creates or deletes tags'
  if (sub === 'remote' && rest.some(a => a !== '-v' && a !== '--verbose' && a !== 'show' && a !== 'get-url')) return 'git remote with arguments changes remotes'
  return undefined
}

// Flags of the listed commands that write a file or run a program, so the command name alone does not make a call read-only.
function flagProblem(name: string, args: string[]): string | undefined {
  switch (name) {
    case 'find':
      return args.some(a => FIND_WRITERS.has(a)) ? 'find with -exec/-delete can change files' : undefined
    case 'fd':
      return hasShortFlag(args, 'xX') || hasLongOption(args, 'exec', 'exec-batch') ? 'fd with -x/-X/--exec can run programs' : undefined
    case 'rg':
      return hasLongOption(args, 'pre', 'hostname-bin') ? 'rg --pre/--hostname-bin can run a program' : undefined
    case 'tree':
      return hasShortFlag(args, 'oR') ? 'tree -o/-R writes files' : undefined
    case 'file':
      return hasShortFlag(args, 'C') || hasLongOption(args, 'compile') ? 'file -C writes a magic.mgc file' : undefined
    case 'sort':
      if (hasShortFlag(args, 'o') || hasLongOption(args, 'output')) return 'sort -o writes a file'
      return hasLongOption(args, 'compress-program') ? 'sort --compress-program can run a program' : undefined
    case 'uniq':
      return uniqOperands(args) >= 2 ? 'uniq with an output file writes it' : undefined
    case 'date':
      return args.some(a => a === '-s' || a.startsWith('--set')) ? 'date -s changes the clock' : undefined
    default:
      return undefined
  }
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
    const assigned = ENV_ASSIGNMENT.exec(head)?.[1]
    if (assigned) return `${assigned}= is refused here: a shell variable can change what runs (PATH, LD_PRELOAD, GIT_*, and in zsh also path or functions) or carry a flag past these checks; write the value into the command instead`
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
    const problem = flagProblem(name, args)
    if (problem) return problem
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

const DISAGREEMENT_TEXT_LIMIT = 80

// Observation only: where the host's `isReadOnly` (the tool's own word) and the plugin's read-only judgment of a main-conversation call differ.
// Covers Bash and tools outside the main-loop list; returns the debug text, or undefined when they agree or the plugin makes no read-only judgment.
// A Bash call the plugin holds read-only and the host does not gives no line: register.ts recordHostReadOnlyGap already
// records that case as a decision of kind readonly.
export function readOnlyDisagreement(tool: string, input: Readonly<Record<string, unknown>>, hostReadOnly: boolean, extraAllowed: ReadonlySet<string>): string | undefined {
  let plugin: string
  if (tool === 'Bash') {
    if (!hostReadOnly) return undefined
    const problem = readOnlyBashProblem(typeof input.command === 'string' ? input.command : '')
    if (problem === undefined) return undefined
    plugin = `refused: ${problem.slice(0, DISAGREEMENT_TEXT_LIMIT)}`
  } else {
    if (MAIN_LOOP_TOOLS.has(tool) || extraAllowed.has(tool) || !hostReadOnly) return undefined
    const verdict = mainLoopVerdict(tool, input, extraAllowed)
    // The report-file Write exception allows a write; that is no read-only judgment to compare.
    if (verdict.allowed) return undefined
    plugin = `refused: ${verdict.reason.slice(0, DISAGREEMENT_TEXT_LIMIT)}`
  }
  return `read-only disagreement: ${tool} host=${hostReadOnly ? 'read-only' : 'not stated'} plugin=${plugin}`
}

export function denyMessage(tool: string, reason: string): string {
  return [
    `dag-workflow refused ${tool} in the main conversation: ${reason}.`,
    'DAG orchestration is mandatory here: this conversation only plans, reads (Read, LSP, read-only Bash, web), asks and orchestrates.',
    `Put this work into a DAG node instead: plan it with the ${PLANNING_SKILL} skill, then call ${DAG_TOOL} with action "start" (a new plan; a one-step task is a one-node DAG) or "amend" (add or change nodes of the current run).`,
    'Nodes run as subagents with every tool, receive the outputs of the nodes they depend on, and report back when the run settles.',
  ].join('\n')
}

const NON_INTERACTIVE_LINE = '- Non-interactive session: do not ask the user (no AskUserQuestion, no clarifying questions); decide, and record every assumption in the definition\'s goal and in the node prompts.'

const ESCALATION_LINE = '- If it turns out to need three or more independent pieces of work that gain from running in parallel or in isolated contexts, load the dag-workflow:planning skill and run it as a DAG instead.'

// The surface is only read under auto, where Jev judges it per prompt; every other level keeps its text byte for byte.
export function protocolFor(level: Enforcement, interactive = true, mode: TurnMode = 'dag', surface: TurnSurface = 'chat'): string {
  const onBoard = level === 'auto' && surface === 'board'
  if (level === 'auto' && mode === 'direct') {
    const lines = onBoard
      ? [
        '[dag-workflow] This request asks to understand something: answer it on a board in this conversation; no DAG is needed.',
        // The board tool is deferred in sessions, so the model has to load it before its first call.
        `- The board tool is ${BOARD_TOOL}; when it is deferred, load it with ToolSearch query "select:${BOARD_TOOL}". create a board titled after the topic in the user's language, draw a section (what and why), ONE diagram (flow for branches, sequence for who calls whom) and the few quoted lines that carry the mechanism (code_peek, diff or trace), call open once, then get the board back and check every block against what you read.`,
        '- Keep the chat reply to a few lines that point to the board. This is a should, not a gate: if the tool is unavailable, an edit is refused twice, or open replies shown: false, answer in chat instead.',
        ESCALATION_LINE,
      ]
      : [
        '[dag-workflow] This request is small: do it directly in this conversation; no DAG is needed.',
        ESCALATION_LINE,
      ]
    if (!interactive) lines.push(NON_INTERACTIVE_LINE)
    return lines.join('\n')
  }
  // auto reads like strict: a DAG turn under auto is held to the strict rules, with one line saying why.
  const rule = level === 'strict' || level === 'auto'
    ? 'In this main conversation you only plan, read (Read, LSP, read-only Bash, web), ask, orchestrate and verify; Edit, Write, mutating Bash, Agent, Workflow, TodoWrite and other tools are refused here and belong inside DAG nodes. The one exception: Write to a REPORT*, SUMMARY*, FINDINGS* or ANALYSIS* .md file the user asked for, which Claude Code refuses to subagents, only to copy a settled node\'s Output or notes verbatim.'
    : 'Prefer doing all work inside DAG nodes; this main conversation should plan, orchestrate and verify.'
  const lines = [
    '[dag-workflow] DAG orchestration is mandatory for this task.',
    ...(level === 'auto' ? ['- This request runs as a DAG: under enforcement auto, Jev judged it to need three or more nodes that gain from parallel or isolated work, or this session has a DAG run that has not settled.'] : []),
    gatesPlanning(level)
      ? `- Before your first DAG in this session, load the ${PLANNING_SKILL} skill with the Skill tool and follow it; start is refused until you do.`
      : `- Before your first DAG in this session, load the ${PLANNING_SKILL} skill with the Skill tool and follow it.`,
    `- Plan the task as a DAG and run it with ${DAG_TOOL} (action "start"); a one-step task is a one-node DAG. Do not keep plans in TodoWrite or TaskCreate.`,
    `- ${rule}`,
    '- Model the real dependencies: a node lists in dependsOn every node whose result it needs; independent nodes run in parallel; keep their write scopes disjoint.',
    '- Every node automatically receives the outputs of the nodes it depends on. Set the definition\'s "goal" to the overall objective and tell each node what to produce.',
    '- start returns at once. Do not poll: when the run settles you get a summary with every node\'s output. Verify it, then use retry, amend or a follow-up run for anything missing.',
  ]
  // The settle message repeats how to draw, so this line only says that the answer goes there once the run is verified.
  if (onBoard) lines.push(`- The user wants the answer on a board: once the run settles and you have verified it, draw the findings on a board with ${BOARD_TOOL}; the settle message repeats how.`)
  if (!interactive) lines.push(NON_INTERACTIVE_LINE)
  return lines.join('\n')
}
