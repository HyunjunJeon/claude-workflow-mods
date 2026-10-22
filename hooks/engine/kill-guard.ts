// Commands that stop processes by name or pattern. Up to max_concurrent node workers (8 by default) run on one machine
// beside each other and the person's own programs, so a worker that ends "every vite" with pkill can stop another node's
// dev server in the middle of its verify check. superlite refuses the same forms (hooks/block-unsafe-kill); stopping a
// PID the worker started stays allowed. Pure: register.ts decides when this applies.

// Where a command word can start: the line start, a separator, a pipe, a subshell or a command substitution.
const START = String.raw`(?:^|[;&|(\n\`]|\$\()\s*`
// What can stand before the command word: variable assignments, words that run the next word as a command (with their
// options, and timeout's duration), then a directory such as /usr/bin/.
const PREFIX = String.raw`(?:(?:[A-Za-z_]\w*=\S*|(?:sudo|doas|exec|nohup|command|xargs|time|env|nice|ionice|stdbuf)(?:\s+-{1,2}[\w-]+(?:[ =][\w.:-]+)?)*|timeout(?:\s+-\S+)*\s+\d+(?:\.\d+)?[smhd]?)\s+)*(?:[^\s;&|()\`'"]*/)?`
// Commands that print process ids by name, pattern or port.
const LOOKUP = '(?:pgrep|pidof|lsof)'

type Form = { form?: string; pattern: RegExp }

const SHELL_FORMS: readonly Form[] = [
  { pattern: new RegExp(`${START}${PREFIX}(pkill|killall)(?=$|[\\s;&|)\`])`, 'i') },
  { form: 'looked-up PIDs piped to kill', pattern: new RegExp(`${START}${PREFIX}${LOOKUP}\\b[^;&\\n]*\\|\\s*xargs\\s+(?:-\\S+\\s+)*kill\\b`, 'i') },
  { form: 'kill of looked-up PIDs', pattern: new RegExp(`${START}${PREFIX}kill\\s[^;&|\\n]*(?:\\$\\(|\`)\\s*${LOOKUP}\\b`, 'i') },
  { form: 'fuser -k', pattern: new RegExp(`${START}${PREFIX}fuser\\b[^;&|\\n]*\\s-[A-Za-z]*k`) },
  { form: 'taskkill /IM or /FI', pattern: new RegExp(`${START}${PREFIX}taskkill(?:\\.exe)?\\b[^;&|\\n]*\\s(?://?|-)(?:im|fi)\\b`, 'i') },
  // Process id -1 means every process the user may signal.
  { form: 'kill -1', pattern: new RegExp(`${START}${PREFIX}kill\\s+(?:(?:-s\\s+\\S+|-\\S+)\\s+)+-1(?=\\s*(?:$|[;&|)\\n]))`, 'i') },
]

// Only inside a script given to powershell or pwsh; spps and kill are Stop-Process's aliases, gps is Get-Process's.
const POWERSHELL_FORMS: readonly Form[] = [
  { form: 'Stop-Process -Name', pattern: /(?:stop-process|spps|kill)\b[^;|\n]*\s-name\b/i },
  { form: 'Get-Process piped to Stop-Process', pattern: /(?:get-process|gps)\b(?![^|;\n]*\s-id\b)[^;\n]*\|\s*(?:stop-process|spps|kill)\b(?![^|;\n]*\s-id\b)/i },
]

const HEREDOC = /(<<-?[ \t]*(['"]?)(\w+)\2[^\n]*)\n[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/g
const SHELL_SCRIPT = /\b(?:ba|z|da|k)?sh\s+(?:-\w+\s+)*-\w*c\s+(?:'([^']*)'|"((?:[^"\\]|\\.)*)")/g
const POWERSHELL_SCRIPT = /\b(?:powershell|pwsh)(?:\.exe)?\b[^\n;&|'"]*?\s-(?:c|command)\s+(?:'([^']*)'|"((?:[^"\\]|\\.)*)")/gi
// sh -c "bash -c '...'" is two levels; deeper nesting is not a way agents write commands.
const MAX_NESTING = 2

// The form a command uses to stop processes by name or pattern, or undefined when it names no such form.
export function killByName(command: string): string | undefined {
  const { shell, powershell } = commandParts(command, 0)
  return firstForm(shell, SHELL_FORMS) ?? firstForm(powershell, [...SHELL_FORMS, ...POWERSHELL_FORMS])
}

export function killRefusal(form: string): string {
  return [
    `dag-workflow refused this command: ${form} stops processes by name or pattern.`,
    'Other DAG nodes and the person\'s own programs run on this machine, so it can stop another node\'s server or test run.',
    'Stop only processes you started, by PID: keep the PID when you start one (for example `cmd & echo $!`), then `kill <PID>`',
    '(`taskkill /PID <PID>` or `Stop-Process -Id <PID>` on Windows).',
  ].join(' ')
}

function firstForm(texts: readonly string[], forms: readonly Form[]): string | undefined {
  for (const text of texts) {
    for (const { form, pattern } of forms) {
      const match = pattern.exec(text)
      if (match) return form ?? match[1]?.toLowerCase()
    }
  }
  return undefined
}

// What would run as a command: the command with heredoc bodies and quoted text blanked, since a word in a commit message, a
// grep pattern or a script being written is not a command, plus each script handed to sh -c or bash -c. Scripts given to
// powershell -c or pwsh -Command come back apart, for the PowerShell forms.
function commandParts(command: string, depth: number): { shell: string[]; powershell: string[] } {
  const text = command.replace(HEREDOC, '$1')
  const shell = [blankQuotes(text)]
  const powershell: string[] = []
  if (depth < MAX_NESTING) {
    for (const match of text.matchAll(SHELL_SCRIPT)) {
      const inner = commandParts(match[1] ?? match[2] ?? '', depth + 1)
      shell.push(...inner.shell)
      powershell.push(...inner.powershell)
    }
    for (const match of text.matchAll(POWERSHELL_SCRIPT)) powershell.push(match[1] ?? match[2] ?? '')
  }
  return { shell, powershell }
}

// Single-quoted text goes; double-quoted text goes too, except the $(...) and `...` inside it, which the shell runs.
function blankQuotes(command: string): string {
  let out = ''
  let index = 0
  while (index < command.length) {
    const char = command.charAt(index)
    if (char === '\\') {
      out += command.slice(index, index + 2)
      index += 2
    } else if (char === '\'') {
      const end = command.indexOf('\'', index + 1)
      if (end < 0) break
      out += '\'\''
      index = end + 1
    } else if (char === '"') {
      const end = doubleQuoteEnd(command, index + 1)
      out += `"${substitutions(command.slice(index + 1, end))}"`
      index = end + 1
    } else {
      out += char
      index++
    }
  }
  return out
}

function doubleQuoteEnd(command: string, from: number): number {
  let index = from
  while (index < command.length && command.charAt(index) !== '"') index += command.charAt(index) === '\\' ? 2 : 1
  return index
}

function substitutions(quoted: string): string {
  return (quoted.match(/\$\((?:[^()]|\([^()]*\))*\)|`[^`]*`/g) ?? []).join(' ')
}
