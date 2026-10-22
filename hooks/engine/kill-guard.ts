// Commands that stop processes by name or pattern. Up to max_concurrent node workers (8 by default) run on one machine
// beside each other and the person's own programs, so a worker that ends "every vite" with pkill can stop another node's
// dev server in the middle of its verify check. superlite refuses the same forms (hooks/block-unsafe-kill); stopping a
// PID the worker started stays allowed. Pure: register.ts decides whose Bash call this applies to.

// Where a command word can start: the line start, a separator, a pipe, a subshell or a command substitution.
const START = String.raw`(?:^|[;&|(\n\`]|\$\()\s*`
// Words that run the next word as a command, and an optional directory such as /usr/bin/.
const PREFIX = String.raw`(?:(?:sudo|exec|nohup|command|xargs|time)(?:\s+-\S+)*\s+)*(?:[^\s;&|()\`'"]*/)?`

const FORMS: readonly { form?: string; pattern: RegExp }[] = [
  { pattern: new RegExp(`${START}${PREFIX}(pkill|killall)(?=$|[\\s;&|)\`])`, 'i') },
  { form: 'pgrep piped to kill', pattern: new RegExp(`${START}${PREFIX}pgrep\\b[^;&\\n]*\\|\\s*xargs\\s+(?:-\\S+\\s+)*kill\\b`, 'i') },
  { form: 'kill of pgrep matches', pattern: new RegExp(`${START}${PREFIX}kill\\s[^;&|\\n]*(?:\\$\\(|\`)\\s*pgrep\\b`, 'i') },
  { form: 'taskkill /IM or /FI', pattern: new RegExp(`${START}${PREFIX}taskkill(?:\\.exe)?\\b[^;&|\\n]*\\s(?://?|-)(?:im|fi)\\b`, 'i') },
  // PowerShell runs inside a quoted -c argument, so these two match anywhere in the command.
  { form: 'Stop-Process -Name', pattern: /stop-process\b[^;|\n"]*\s-name\b/i },
  { form: 'Get-Process piped to Stop-Process', pattern: /get-process\b(?![^|;\n]*\s-id\b)[^|;\n]*\|\s*stop-process\b(?![^|;\n"]*\s-id\b)/i },
  // Process id -1 means every process the user may signal.
  { form: 'kill -1', pattern: new RegExp(`${START}${PREFIX}kill\\s+(?:(?:-s\\s+\\S+|-\\S+)\\s+)+-1(?=\\s*(?:$|[;&|)\\n]))`, 'i') },
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
  ].join(' ')
}
