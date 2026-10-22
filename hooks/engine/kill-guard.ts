// Commands that stop processes by name or pattern. Up to max_concurrent node workers (8 by default) run on one machine
// beside each other and the person's own programs, so a worker that ends "every vite" with pkill can stop another node's
// dev server in the middle of its verify check. superlite refuses the same forms (hooks/block-unsafe-kill); stopping a
// PID the worker started stays allowed. Pure: register.ts decides when this applies.
//
// The command is read as text, quotes and heredocs included, on purpose. A shell-aware reading (blank quoted text, unwrap
// bash -c) was tried on 2026-10-22 and a review found six ways past it in one pass: a heredoc fed to bash, nested quotes
// in $(...), an apostrophe in a comment, su -c, eval, an unquoted PowerShell script. Missing a kill stops another node's
// server; refusing a command that only mentions pkill costs one reworded command, and the refusal says how.
//
// Four review rounds left gaps open because each pattern tried for them matched the bare word and refused ordinary commands
// (find tests/kill -name, rg 'Stop-Process' -n, a process-group cleanup through ps). On 2026-10-23 they were closed by the
// context the ordinary commands lack: a PowerShell command before the PowerShell forms, a grep or awk filter between ps and
// the kill, and a pgrep, pidof or lsof feeding a loop whose body kills. Still not caught: Stop-Process -InputObject on a
// variable an earlier statement filled by name, and padding past the bounded scans. The guard is a seatbelt against a
// worker's habit, not a security boundary; tests/kill-guard.test.ts lists these as GAPS.

// Where a command word can start: the line start, a separator, a pipe, a subshell, a group or negation ({ !), a command
// substitution, a quote (eval "...", su -c "...", bash -c '...') or a control-flow keyword. A leading backslash (\pkill) only
// skips aliases.
const START = String.raw`(?:^|[;&|(\n\`'"{!]|\$\(|\b(?:then|do|else|elif)\s)\s*\\?`
// What can stand before the command word: variable assignments, words that run the next word as a command (with their
// options, and timeout's duration), then a directory such as /usr/bin/.
const PREFIX = String.raw`(?:(?:[A-Za-z_]\w*=\S*|(?:sudo|doas|exec|nohup|command|xargs|time|env|nice|ionice|stdbuf)(?:\s+-{1,2}[\w-]+(?:[ =][\w.:-]+)?)*|timeout(?:\s+-\S+)*\s+\d+(?:\.\d+)?[smhd]?)\s+)*(?:[^\s;&|()\`'"]*/)?`
// Commands that print process ids by name, pattern or port. ps is left out: it looks up by PID as often as by name
// (kill -- -$(ps -o pgid= $PID)), which is the cleanup the refusal asks for. ps counts only with FILTER after it.
const LOOKUP = '(?:pgrep|pidof|lsof)'
// The pipe stage that turns ps output into a by-name list: grep (egrep, fgrep) or awk with a /pattern/.
const FILTER = String.raw`\|\s*(?:[ef]?grep\b|awk\s+['"]?/)`
// A loop body up to its done: a kill by PID after the loop is not part of it.
const BODY = String.raw`(?:(?!\bdone\b)[\s\S]){0,400}?(?:^|[\s;&|(\`'"{])\\?kill\s`

const FORMS: readonly { form?: string; pattern: RegExp }[] = [
  { pattern: new RegExp(`${START}${PREFIX}(pkill|killall)(?=$|[\\s;&|)\`'"])`, 'i') },
  { form: 'looked-up PIDs piped to kill', pattern: new RegExp(`${START}${PREFIX}${LOOKUP}\\b[^;&\\n]*\\|\\s*xargs\\s+(?:-\\S+\\s+)*kill\\b`, 'i') },
  { form: 'kill of looked-up PIDs', pattern: new RegExp(`${START}${PREFIX}kill\\s[^;&|\\n]*(?:\\$\\(|\`)\\s*${LOOKUP}\\b`, 'i') },
  { form: 'looked-up PIDs piped to kill', pattern: new RegExp(`${START}${PREFIX}ps\\b[^;&|\\n]{0,200}${FILTER}[^;&\\n]{0,300}\\|\\s*xargs\\s+(?:-\\S+\\s+)*kill\\b`, 'i') },
  { form: 'kill of looked-up PIDs', pattern: new RegExp(`${START}${PREFIX}kill\\s[^;&|\\n]{0,200}(?:\\$\\(|\`)\\s*ps\\b[^;&|\\n)\`]{0,200}${FILTER}`, 'i') },
  // for p in $(pgrep x); do kill $p; done, or pgrep x | while read p; do kill $p; done.
  { form: 'kill in a loop over looked-up PIDs', pattern: new RegExp(`(?:\\bin\\s+(?:\\$\\(|\`)\\s*${PREFIX}${LOOKUP}\\b|${START}${PREFIX}${LOOKUP}\\b[^;&\\n]{0,200}\\|\\s*while\\s+read\\b)${BODY}`, 'i') },
  { form: 'fuser -k', pattern: new RegExp(`${START}${PREFIX}fuser\\b[^;&|\\n]*\\s-[A-Za-z]*k`) },
  { form: 'taskkill /IM or /FI', pattern: new RegExp(`${START}${PREFIX}taskkill(?:\\.exe)?\\b[^;&|\\n]*\\s(?://?|-)(?:im|fi)\\b`, 'i') },
  // Process id -1 means every process the user may signal.
  { form: 'kill -1', pattern: new RegExp(`${START}${PREFIX}kill\\s+(?:(?:-s\\s+\\S+|-\\S+)\\s+)+-1(?=\\s*(?:$|[;&|)\\n'"]))`, 'i') },
  // PowerShell, wherever it appears in the command; spps is Stop-Process's alias, gps is Get-Process's. Anywhere, only the
  // whole -Name counts: the kill alias, -N and -ProcessName also matched find, grep -n and rg -n calls that only name those
  // words. The scans after a command name are bounded: unbounded, 10,000 repeated command words took 192 ms, each scanning
  // to the end. On 2026-10-23 every 50,000-character shape of repeated command words took under 6 ms except gps | % {,
  // 76 ms; it took 2,772 ms while the brace scan of the .Kill() form below was unbounded.
  { form: 'Stop-Process -Name', pattern: /(?:stop-process|spps)\b[^;|\n]{0,200}\s-name\b/i },
  // After powershell or pwsh on the same line, also -Name's abbreviations and -ProcessName, and the kill alias with the whole
  // -Name or -ProcessName (bash's own kill -n takes a signal number).
  { form: 'Stop-Process -Name', pattern: /(?:powershell|pwsh)(?:\.exe)?\b[^\n]{0,300}?(?:\b(?:stop-process|spps)\b[^;|\n]{0,200}\s-(?:n|na|nam|processname)\b|(?:^|[\s;|("'{])kill\b[^;|\n]{0,200}\s-(?:name|processname)\b)/i },
  // Get-Process by name (no -Id) whose results are stopped: piped to Stop-Process, .Kill() on them, % Kill, or a % { } block
  // that stops each one (its -Id $_.Id is the by-name list's).
  { form: 'Get-Process piped to Stop-Process', pattern: /(?:get-process|gps)\b(?![^|;\n)]{0,200}\s-id\b)[^;\n]{0,300}(?:\|\s*(?:stop-process|spps|kill)\b(?![^|;\n"]{0,200}\s-id\b)|\)\.kill\(|\|\s*(?:%|foreach-object)\s+(?:\{[^}]{0,200}\.)?kill\b|\|\s*(?:%|foreach-object)\s*\{[^}]{0,200}\b(?:stop-process|spps|kill)\b)/i },
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
