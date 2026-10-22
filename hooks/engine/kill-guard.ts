// Commands that stop processes by name or pattern. Up to max_concurrent node workers (8 by default) run on one machine
// beside each other and the person's own programs, so a worker that ends "every vite" with pkill can stop another node's
// dev server in the middle of its verify check. superlite refuses the same forms (hooks/block-unsafe-kill); stopping a
// PID the worker started stays allowed. Pure: register.ts decides when this applies.
//
// The command is read as text, quotes and heredocs included, on purpose. A shell-aware reading (blank quoted text, unwrap
// bash -c) was tried on 2026-10-22 and a review found six ways past it in one pass: a heredoc fed to bash, nested quotes
// in $(...), an apostrophe in a comment, su -c, eval, an unquoted PowerShell script. Missing a kill stops another node's
// server; refusing a command that only mentions pkill costs one reworded command, and the refusal says how.

// Where a command word can start: the line start, a separator, a pipe, a subshell, a command substitution or a quote
// (eval "...", su -c "...", bash -c '...').
const START = String.raw`(?:^|[;&|(\n\`'"]|\$\()\s*`
// What can stand before the command word: variable assignments, words that run the next word as a command (with their
// options, and timeout's duration), then a directory such as /usr/bin/.
const PREFIX = String.raw`(?:(?:[A-Za-z_]\w*=\S*|(?:sudo|doas|exec|nohup|command|xargs|time|env|nice|ionice|stdbuf)(?:\s+-{1,2}[\w-]+(?:[ =][\w.:-]+)?)*|timeout(?:\s+-\S+)*\s+\d+(?:\.\d+)?[smhd]?)\s+)*(?:[^\s;&|()\`'"]*/)?`
// Commands that print process ids by name, pattern or port.
const LOOKUP = '(?:pgrep|pidof|lsof)'

const FORMS: readonly { form?: string; pattern: RegExp }[] = [
  { pattern: new RegExp(`${START}${PREFIX}(pkill|killall)(?=$|[\\s;&|)\`'"])`, 'i') },
  { form: 'looked-up PIDs piped to kill', pattern: new RegExp(`${START}${PREFIX}${LOOKUP}\\b[^;&\\n]*\\|\\s*xargs\\s+(?:-\\S+\\s+)*kill\\b`, 'i') },
  { form: 'kill of looked-up PIDs', pattern: new RegExp(`${START}${PREFIX}kill\\s[^;&|\\n]*(?:\\$\\(|\`)\\s*${LOOKUP}\\b`, 'i') },
  { form: 'fuser -k', pattern: new RegExp(`${START}${PREFIX}fuser\\b[^;&|\\n]*\\s-[A-Za-z]*k`) },
  { form: 'taskkill /IM or /FI', pattern: new RegExp(`${START}${PREFIX}taskkill(?:\\.exe)?\\b[^;&|\\n]*\\s(?://?|-)(?:im|fi)\\b`, 'i') },
  // Process id -1 means every process the user may signal.
  { form: 'kill -1', pattern: new RegExp(`${START}${PREFIX}kill\\s+(?:(?:-s\\s+\\S+|-\\S+)\\s+)+-1(?=\\s*(?:$|[;&|)\\n'"]))`, 'i') },
  // PowerShell, wherever it appears in the command; spps and kill are Stop-Process's aliases, gps is Get-Process's.
  { form: 'Stop-Process -Name', pattern: /(?:stop-process|spps)\b[^;|\n]*\s-name\b/i },
  { form: 'Get-Process piped to Stop-Process', pattern: /(?:get-process|gps)\b(?![^|;\n]*\s-id\b)[^;\n]*\|\s*(?:stop-process|spps|kill)\b(?![^|;\n]*\s-id\b)/i },
]

// The form a command uses to stop processes by name or pattern, or undefined when it names no such form.
export function killByName(command: string): string | undefined {
  for (const { form, pattern } of FORMS) {
    const match = pattern.exec(command)
    if (match) return form ?? match[1]?.toLowerCase()
  }
  return undefined
}

export function killRefusal(form: string): string {
  return [
    `dag-workflow refused this command: ${form} stops processes by name or pattern.`,
    'Other DAG nodes and the person\'s own programs run on this machine, so it can stop another node\'s server or test run.',
    'Stop only processes you started, by PID: keep the PID when you start one (for example `cmd & echo $!`), then `kill <PID>`',
    '(`taskkill /PID <PID>` or `Stop-Process -Id <PID>` on Windows).',
    'The command is read as text: if the word only appears in text (a commit message, a search pattern, a file you are',
    'writing), reword it, or write the file with the Write tool.',
  ].join(' ')
}
