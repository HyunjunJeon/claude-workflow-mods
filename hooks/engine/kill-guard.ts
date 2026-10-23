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
// the kill, a pgrep, pidof or lsof feeding a loop whose body kills, and a variable that holds looked-up processes or PIDs
// and is then stopped. Still not caught, because the command text does not hold them: a script file that runs the kill
// (bash stop.sh), and a command name a variable holds (cmd=pkill; $cmd x). The guard is a seatbelt against a worker's
// habit, not a security boundary; tests/kill-guard.test.ts lists these as GAPS.
//
// Each scan after a command word ends where the next word of its kind starts (upTo), not after a fixed count. With fixed
// counts (200-400 characters) a long Where-Object block, awk program or loop body hid the by-name part, and unbounded scans
// made a command of repeated words cost the square of its length (10,000 repeated words took 192 ms, a gps | % { shape
// 2,772 ms). Ending at the next word keeps the cost linear: on 2026-10-23, 31 shapes of 50,000 characters (repeated command
// words, and long lines that must still be refused) each took at most 22 ms, and at 100,000 characters at most 51 ms.

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
// The pipe stage that turns ps output into a by-name list: grep (egrep, fgrep) or awk with a /pattern/. It must be the stage
// right after ps: looking for it further down rescanned the rest of the line from every pipe (a ps with 5,000 grep stages
// took 1,951 ms).
const FILTER = String.raw`\|\s*(?:[ef]?grep\b|awk\s+['"]?/)`
// The words a scan ends at: the next command of the same kind.
const KILL_WORD = String.raw`\bkill\b`
const PS_WORD = String.raw`\bps\b`
const LOOKUP_WORD = String.raw`\b${LOOKUP}\b`
const STOP_WORD = String.raw`\b(?:stop-process|spps)\b`
const STOPPING_WORD = String.raw`\b(?:stop-process|spps|kill)\b`
const GPS_WORD = String.raw`\b(?:get-process|gps)\b`
const PWSH_WORD = String.raw`\b(?:powershell|pwsh)\b`

// Any number of `chars`, ending before the next `stop`: a scan that cannot run into the next command of its kind.
function upTo(stop: string, chars: string): string {
  return `(?:(?!${stop})${chars})*`
}

// A kill that is not kill -0, which only tests that a process is alive.
const KILLS = String.raw`kill\s+(?!-0\b)`
// A loop body up to its done, or up to the next lookup: a kill by PID after the loop is not part of it.
const BODY = `${upTo(String.raw`\bdone\b|${LOOKUP_WORD}`, String.raw`[\s\S]`)}?(?:^|[\\s;&|(\`'"{])\\\\?${KILLS}`
// Get-Process (gps) with no -Id: a by-name or every-process list.
const BY_NAME_GPS = `${GPS_WORD}(?!${upTo(GPS_WORD, '[^|;\\n)]')}\\s-id\\b)`
// A % { } or ForEach-Object block, or a bare % Kill, that stops each process it is given.
const EACH_STOPPED = String.raw`\|\s*(?:%|foreach-object)\s*(?:\{${upTo(GPS_WORD, '[^{}]')})?${STOPPING_WORD}`

const FORMS: readonly { form?: string; pattern: RegExp }[] = [
  { pattern: new RegExp(`${START}${PREFIX}(pkill|killall)(?=$|[\\s;&|)\`'"])`, 'i') },
  { form: 'looked-up PIDs piped to kill', pattern: new RegExp(`${START}${PREFIX}${LOOKUP}\\b${upTo(LOOKUP_WORD, '[^;&\\n]')}\\|\\s*xargs\\s+(?:-\\S+\\s+)*kill\\b`, 'i') },
  { form: 'kill of looked-up PIDs', pattern: new RegExp(`${START}${PREFIX}kill\\s${upTo(KILL_WORD, '[^;&|\\n]')}(?:\\$\\(|\`)\\s*${LOOKUP}\\b`, 'i') },
  // After the filter the scan crosses ; too: an awk program holds them ('{ n++; print $2 }').
  { form: 'looked-up PIDs piped to kill', pattern: new RegExp(`${START}${PREFIX}ps\\b${upTo(PS_WORD, '[^;&|\\n]')}${FILTER}${upTo(PS_WORD, '[^&\\n]')}\\|\\s*xargs\\s+(?:-\\S+\\s+)*kill\\b`, 'i') },
  { form: 'kill of looked-up PIDs', pattern: new RegExp(`${START}${PREFIX}kill\\s${upTo(KILL_WORD, '[^;&|\\n]')}(?:\\$\\(|\`)\\s*ps\\b${upTo(PS_WORD, '[^;&|\\n)\`]')}${FILTER}`, 'i') },
  // PID=$(lsof -ti:5173); kill $PID: a variable that holds looked-up PIDs, killed later. Case-sensitive, as the shell is.
  { form: 'kill of looked-up PIDs', pattern: new RegExp(`\\b([A-Za-z_]\\w*)=["']?(?:\\$\\(|\`)\\s*${PREFIX}(?:${LOOKUP}\\b|ps\\b${upTo(PS_WORD, '[^;&|\\n)\`]')}${FILTER})${upTo(`${LOOKUP_WORD}|${PS_WORD}`, '[\\s\\S]')}?${START}${PREFIX}${KILLS}${upTo(KILL_WORD, '[^;&|\\n]')}?\\$\\{?\\1\\b`) },
  // for p in $(pgrep x); do kill $p; done, or pgrep x | while read p; do kill $p; done.
  { form: 'kill in a loop over looked-up PIDs', pattern: new RegExp(`(?:\\bin\\s+(?:\\$\\(|\`)\\s*${PREFIX}${LOOKUP}\\b|${START}${PREFIX}${LOOKUP}\\b${upTo(LOOKUP_WORD, '[^;&\\n]')}\\|\\s*while\\s+read\\b)${BODY}`, 'i') },
  { form: 'fuser -k', pattern: new RegExp(`${START}${PREFIX}fuser\\b${upTo('\\bfuser\\b', '[^;&|\\n]')}\\s-[A-Za-z]*k`) },
  { form: 'taskkill /IM or /FI', pattern: new RegExp(`${START}${PREFIX}taskkill(?:\\.exe)?\\b${upTo('\\btaskkill\\b', '[^;&|\\n]')}\\s(?://?|-)(?:im|fi)\\b`, 'i') },
  // Process id -1 means every process the user may signal.
  { form: 'kill -1', pattern: new RegExp(`${START}${PREFIX}kill\\s+(?:(?:-s\\s+\\S+|-\\S+)\\s+)+-1(?=\\s*(?:$|[;&|)\\n'"]))`, 'i') },
  // PowerShell, wherever it appears in the command; spps is Stop-Process's alias, gps is Get-Process's. Anywhere, only the
  // whole -Name counts: the kill alias, -N and -ProcessName also matched find, grep -n and rg -n calls that only name those
  // words.
  { form: 'Stop-Process -Name', pattern: new RegExp(`${STOP_WORD}${upTo(STOP_WORD, '[^;|\\n]')}\\s-name\\b`, 'i') },
  // After powershell or pwsh on the same line, also -Name's abbreviations and -ProcessName, and the kill alias with the whole
  // -Name or -ProcessName (bash's own kill -n takes a signal number).
  { form: 'Stop-Process -Name', pattern: new RegExp(`${PWSH_WORD}${upTo(PWSH_WORD, '[^\\n]')}?(?:${STOP_WORD}${upTo(STOP_WORD, '[^;|\\n]')}\\s-(?:n|na|nam|processname)\\b|(?:^|[\\s;|("'{])kill\\b${upTo(KILL_WORD, '[^;|\\n]')}\\s-(?:name|processname)\\b)`, 'i') },
  // Get-Process by name whose results are stopped: piped to Stop-Process (not by its own -Id), .Kill() on them, or each one
  // stopped in a % block (its -Id $_.Id is the by-name list's).
  { form: 'Get-Process piped to Stop-Process', pattern: new RegExp(`${BY_NAME_GPS}${upTo(GPS_WORD, '[^;\\n]')}(?:\\|\\s*${STOPPING_WORD}(?!${upTo(STOPPING_WORD, '[^|;\\n"]')}\\s-id\\b)|\\)\\.kill\\(|${EACH_STOPPED})`, 'i') },
  // $p = Get-Process node; ...; Stop-Process -InputObject $p, $p | spps or $p.Kill(). PowerShell names are case-insensitive.
  { form: 'Get-Process results stopped', pattern: new RegExp(`\\$(\\w+)\\s*=\\s*\\(?\\s*${BY_NAME_GPS}${upTo(GPS_WORD, '[\\s\\S]')}?(?:${STOPPING_WORD}${upTo(STOPPING_WORD, '[^;|\\n]')}?\\$\\1\\b|\\$\\1\\b${upTo(GPS_WORD, '[^;\\n]')}?(?:\\|\\s*${STOPPING_WORD}|\\.kill\\s*\\(|${EACH_STOPPED}))`, 'i') },
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
