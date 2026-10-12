import type { Definition } from './types.ts'

// The programs a definition's command checks start by bare name. register.ts looks them up on the host's PATH before any node
// runs, because a check whose program is missing can never pass however right the deliverable is.
export type ProgramUse = { nodeId: string; check: number; program: string; viaShell: boolean }

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
// Builtins and keywords of sh and bash: the shell runs these itself, so they are never looked up on PATH.
const SHELL_OWN = new Set([
  '!', '{', '}', '[', '[[', ']]', ':', '.', 'alias', 'bg', 'bind', 'break', 'builtin', 'caller', 'cd', 'command', 'compgen',
  'complete', 'continue', 'coproc', 'declare', 'dirs', 'disown', 'do', 'done', 'echo', 'elif', 'else', 'enable', 'esac', 'eval',
  'exec', 'exit', 'export', 'false', 'fc', 'fg', 'fi', 'for', 'function', 'getopts', 'hash', 'help', 'history', 'if', 'in', 'jobs',
  'kill', 'let', 'local', 'logout', 'mapfile', 'popd', 'printf', 'pushd', 'pwd', 'read', 'readarray', 'readonly', 'return',
  'select', 'set', 'shift', 'shopt', 'source', 'suspend', 'test', 'then', 'time', 'times', 'trap', 'true', 'type', 'typeset',
  'ulimit', 'umask', 'unalias', 'unset', 'until', 'wait', 'while',
])
// Words after which the rest of the segment is a list or a name, not a command.
const LIST_KEYWORDS = new Set(['for', 'select', 'function'])
// Programs that run the next word as a command: `timeout 5 rg x` also starts rg.
const RUNNERS = new Set(['command', 'env', 'exec', 'nice', 'nohup', 'time', 'timeout', 'xargs'])
const NAME = /^[A-Za-z_][\w.+-]*$/
const ASSIGNMENT = /^[A-Za-z_]\w*=/
const REDIRECTION = /^\d*(<|>)/
// Constructs the word scan below does not model. A script with any of them gets no verdict rather than a guess, since a
// refusal has no override: here-documents, arithmetic, [[ ]] tests and PATH changes; case, source, . and alias as commands.
const UNMODELLED = /<<|\(\(|\[\[|\bPATH=/
const UNMODELLED_COMMANDS = new Set(['case', 'source', '.', 'alias'])
// Redirections that duplicate a descriptor (2>&1, >&2, &>file) hold an & that is not a command separator.
const DUPLICATION = /\d*[<>]&\d*-?|&>>?/g

// Quoted text, ${...}, escaped characters and comments become an opaque mark that is never a name; undefined on an open quote.
function masked(script: string): string | undefined {
  let out = ''
  for (let index = 0; index < script.length; index++) {
    const char = script[index]!
    if (char === '\\') {
      out += '\u0000'
      index++
    } else if (char === "'" || char === '"') {
      let end = index + 1
      while (end < script.length && script[end] !== char) end += char === '"' && script[end] === '\\' ? 2 : 1
      if (end >= script.length) return undefined
      out += '\u0000'
      index = end
    } else if (char === '$' && script[index + 1] === '{') {
      const end = script.indexOf('}', index)
      if (end < 0) return undefined
      out += '\u0000'
      index = end
    } else if (char === '#' && (index === 0 || /[\s;&|(]/.test(script[index - 1]!))) {
      while (index + 1 < script.length && script[index + 1] !== '\n') index++
    } else {
      out += char
    }
  }
  return out
}

// The commands a shell script starts by bare name, or undefined when the script uses something the scan does not model.
// Command positions are the script start and the words after newline, ;, &, &&, |, ||, (, $(, <(, ` and braces.
export function shellCommands(script: string): string[] | undefined {
  if (UNMODELLED.test(script)) return undefined
  const text = masked(script)
  if (text === undefined) return undefined
  const guarded = new Set([...script.matchAll(/\b(?:command\s+-[vV]|which|type(?:\s+-[aPpt]+)?|hash)\s+([A-Za-z_][\w.+-]*)/g)].map(match => match[1]))
  const defined = new Set([
    ...[...text.matchAll(/(?:^|[\s;&|({])([A-Za-z_][\w.-]*)\s*\(\s*\)/g)].map(match => match[1]),
    ...[...text.matchAll(/\bfunction\s+([A-Za-z_][\w.-]*)/g)].map(match => match[1]),
  ])
  const found: string[] = []
  for (const segment of text.replace(DUPLICATION, ' \u0000 ').split(/[\n;&|(){}`]/)) {
    const words = segment.trim().split(/\s+/).filter(word => word !== '')
    let expectCommand = true
    for (let index = 0; index < words.length && expectCommand; index++) {
      const word = words[index]!
      if (LIST_KEYWORDS.has(word)) break
      if (ASSIGNMENT.test(word)) continue
      if (REDIRECTION.test(word)) {
        if (/^\d*(<|>)+&?$/.test(word)) index++
        continue
      }
      if (word.startsWith('-') || /^\d+$/.test(word)) continue
      if (UNMODELLED_COMMANDS.has(word)) return undefined
      if (word === 'command' && /^-[vV]$/.test(words[index + 1] ?? '')) break
      if (RUNNERS.has(word)) {
        if (!SHELL_OWN.has(word)) found.push(word)
        continue
      }
      if (SHELL_OWN.has(word)) {
        if (!['!', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', 'time', '{'].includes(word)) expectCommand = false
        continue
      }
      expectCommand = false
      if (NAME.test(word) && !guarded.has(word) && !defined.has(word)) found.push(word)
    }
  }
  return [...new Set(found)]
}

// The script of `sh -c <script>` and its relatives, or undefined when argv is no plain -c call: a login or interactive
// shell (-l, -i, --login) reads a profile that may change PATH, so its script gets no verdict.
function shellScript(argv: readonly string[]): string | undefined {
  if (!SHELLS.has(argv[0]?.split(/[\\/]/).pop() ?? '')) return undefined
  let command = false
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index]!
    if (arg === '--') return command ? argv[index + 1] : undefined
    if (/^--/.test(arg)) {
      if (arg === '--login' || arg === '--rcfile' || arg === '--init-file') return undefined
      continue
    }
    if (/^[-+][A-Za-z]+$/.test(arg)) {
      if (/[li]/.test(arg)) return undefined
      if (arg.includes('c')) command = true
      if (arg.endsWith('o')) index++
      continue
    }
    return command ? arg : undefined
  }
  return undefined
}

export function commandPrograms(definition: Definition): ProgramUse[] {
  return definition.nodes.flatMap(node => (node.verify ?? []).flatMap((check, index): ProgramUse[] => {
    if (check.kind !== 'command') return []
    const program = check.argv[0] ?? ''
    const use = { nodeId: node.id, check: index + 1 }
    const script = shellScript(check.argv)
    const inner = script === undefined ? [] : shellCommands(script) ?? []
    // A path such as ./run.sh or /bin/sh is not looked up: the run may create it, and the host starts it as given.
    const direct = NAME.test(program) ? [{ ...use, program, viaShell: false }] : []
    return [...direct, ...inner.map(name => ({ ...use, program: name, viaShell: true }))]
  }))
}

export function missingProgramsMessage(uses: readonly ProgramUse[]): string {
  const places = uses.map(use => `node "${use.nodeId}" check ${use.check} runs ${use.program}${use.viaShell ? ' inside its shell script' : ''}`)
  return `verify commands run from the project root through the host process, with its PATH and no shell profile, and these programs are not on that PATH: ${places.join('; ')}. Claude Code's Bash tool has programs this environment lacks (rg among them), so a check that passes in Bash can still fail here. Use a program that is on PATH (grep -E instead of rg), or call one the run itself installs by its path.`
}
