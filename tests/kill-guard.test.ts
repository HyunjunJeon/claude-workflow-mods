import { expect, test } from 'claude-code/testing'
import { killByName, killRefusal } from '../hooks/engine/kill-guard.ts'
import { boot, harness, start } from './control-harness.ts'
import type { VerificationCheck } from '../hooks/engine/types.ts'

// Commands that stop processes by name or pattern are refused for node workers, which share the machine with each other
// and with the person; stopping a PID the worker started stays allowed. Each form has a must-hit and a must-not-hit case.

const HITS: [string, string][] = [
  ['pkill -f vite', 'pkill'],
  ['killall node', 'killall'],
  ['sudo pkill node', 'pkill'],
  ['/usr/bin/pkill -9 node', 'pkill'],
  ['npm run dev & sleep 2; pkill -f vite', 'pkill'],
  ['echo $(killall node)', 'killall'],
  ['PKILL node', 'pkill'],
  ['pgrep -f vite | xargs kill', 'looked-up PIDs piped to kill'],
  ['lsof -ti:5173 | xargs kill', 'looked-up PIDs piped to kill'],
  ['kill -9 $(pgrep node)', 'kill of looked-up PIDs'],
  ['kill `pgrep -f server`', 'kill of looked-up PIDs'],
  ['kill $(pidof node)', 'kill of looked-up PIDs'],
  ['kill -9 $(lsof -ti :5173)', 'kill of looked-up PIDs'],
  ['fuser -k 5173/tcp', 'fuser -k'],
  ['bash -c "pkill -f vite"', 'pkill'],
  ["sh -lc 'killall node'", 'killall'],
  ['echo "$(pkill node)"', 'pkill'],
  ['env pkill node', 'pkill'],
  ['FOO=1 pkill node', 'pkill'],
  ['timeout 5 killall node', 'killall'],
  ['nice -n 10 pkill node', 'pkill'],
  ['doas killall node', 'killall'],
  ['taskkill /IM node.exe /F', 'taskkill /IM or /FI'],
  ['taskkill /F /FI "IMAGENAME eq node.exe"', 'taskkill /IM or /FI'],
  ['powershell -c "Stop-Process -Name node"', 'Stop-Process -Name'],
  ['powershell -c "Get-Process node | Stop-Process"', 'Get-Process piped to Stop-Process'],
  ['pwsh -Command "Get-Process | Where-Object Name -eq node | Stop-Process"', 'Get-Process piped to Stop-Process'],
  ['kill -9 -1', 'kill -1'],
  ['kill -s KILL -1', 'kill -1'],
  ['kill -- -1', 'kill -1'],
  // Forms a shell-aware reading let through (review of 845899a).
  ["bash <<'EOF'\npkill -f vite\nEOF", 'pkill'],
  ['kill "$(pgrep -f "vite dev")"', 'kill of looked-up PIDs'],
  ["ls # it's here\npkill node", 'pkill'],
  ['powershell Stop-Process -Name node', 'Stop-Process -Name'],
  ['powershell.exe "Stop-Process -Name node"', 'Stop-Process -Name'],
  ['su -c "cd x; pkill node"', 'pkill'],
  ['eval "pkill node"', 'pkill'],
  ["watch 'killall node'", 'killall'],
  // Review of 10a88af: control flow, a leading backslash, and .Kill() or % Kill on Get-Process results.
  ['if true; then pkill node; fi', 'pkill'],
  ['while true; do pkill node; done', 'pkill'],
  ['{ pkill node; }', 'pkill'],
  ['! pkill node', 'pkill'],
  ['\\pkill node', 'pkill'],
  ['powershell -c "(Get-Process node).Kill()"', 'Get-Process piped to Stop-Process'],
  ['powershell -c "Get-Process node | % Kill"', 'Get-Process piped to Stop-Process'],
  // Gaps closed on 2026-10-23, each by a context the ordinary commands in MISSES lack: a PowerShell command before the
  // PowerShell forms, a grep or awk filter between ps and the kill, a pgrep, pidof or lsof feeding a loop that kills.
  ['pwsh -c "kill -Name node"', 'Stop-Process -Name'],
  ['powershell -c "Stop-Process -ProcessName node"', 'Stop-Process -Name'],
  ['powershell -c "spps -N node"', 'Stop-Process -Name'],
  ['powershell.exe -Command "spps -Na node -Force"', 'Stop-Process -Name'],
  ["ps aux | grep vite | awk '{print $2}' | xargs kill", 'looked-up PIDs piped to kill'],
  ["ps -ef | egrep 'vite|node' | awk '{print $2}' | xargs -r kill -9", 'looked-up PIDs piped to kill'],
  ["ps aux | awk '/vite/ {print $2}' | xargs kill", 'looked-up PIDs piped to kill'],
  ["kill $(ps aux | grep vite | awk '{print $2}')", 'kill of looked-up PIDs'],
  ['kill -9 `ps -ef | grep -v grep | grep node | awk \'{print $2}\'`', 'kill of looked-up PIDs'],
  ['for p in $(pgrep -f vite); do kill $p; done', 'kill in a loop over looked-up PIDs'],
  ['for pid in `pidof node`; do kill -9 "$pid"; done', 'kill in a loop over looked-up PIDs'],
  ['for p in $(pgrep -f vite)\ndo\n  kill $p\ndone', 'kill in a loop over looked-up PIDs'],
  ['pgrep -f vite | while read p; do kill $p; done', 'kill in a loop over looked-up PIDs'],
  ['powershell -c "Get-Process node | % { Stop-Process -Id $_.Id }"', 'Get-Process piped to Stop-Process'],
  ['pwsh -c "gps node | ForEach-Object { spps -Id $_.Id -Force }"', 'Get-Process piped to Stop-Process'],
]

// Known gaps, kept on purpose (kill-guard.ts says why): catching them needs more than a reading of one command line.
// Asserted so a change is a decision.
const GAPS = [
  // Stop-Process given processes a variable holds: the Get-Process by name is in an earlier statement.
  'powershell -c "$p = Get-Process node; Stop-Process -InputObject $p"',
  // The scans after a command word are bounded, so padding pushes the by-name option out of reach.
  `powershell -c "Stop-Process ${'-Force '.repeat(40)}-Name node"`,
]

// Refused on purpose: the command is read as text, so a kill word at a command start inside a quote or a heredoc counts.
// Missing a real kill stops another node's server; one of these costs a reworded command, and the refusal says so.
const ACCEPTED: [string, string][] = [
  ['grep -nE "(pkill|killall)" hooks/', 'pkill'],
  ['git commit -m "fix: refuse x; pkill is blocked"', 'pkill'],
  ["echo 'a; pkill b'", 'pkill'],
  ['git commit -m "Stop-Process -Name is refused"', 'Stop-Process -Name'],
  ['cat > s.sh <<EOF\npkill -f vite\nEOF', 'pkill'],
]

const MISSES = [
  'kill 1234',
  'kill -9 1234',
  'kill -TERM "$PID"',
  'kill -1 1234',
  'taskkill /PID 1234 /F',
  'powershell -c "Stop-Process -Id 42"',
  'powershell -c "Get-Process -Id 42 | Stop-Process"',
  'grep -rn pkill hooks/',
  'echo "never use killall here"',
  'ps aux | grep killall',
  'git commit -m "block pkill"',
  'pgrep -f vite',
  'bun test tests/kill-guard.test.ts',
  'fuser -v 5173/tcp',
  'lsof -ti:5173',
  "echo 'it is fine to pkill your own PID'",
  'ps aux | grep node',
  'powershell -c "Get-Process -Id 42 | % Kill"',
  'powershell -c "Get-Process node | Select-Object Id"',
  // Review of 3e0ffa7: refused by patterns that were then taken out.
  "find tests/kill -name '*.test.ts'",
  "find . -path '*kill*' -name '*.ts'",
  'echo "use kill -name later"',
  "rg 'Stop-Process' hooks -n",
  'grep spps tests/kill-guard.test.ts -n',
  "kill -- -$(ps -o pgid= $PID | tr -d ' ')",
  'ps -p 1234 -o pid= | xargs kill',
  // Near the forms closed on 2026-10-23, without the context that makes them a kill by name.
  'ps aux | grep -c vite',
  "ps aux | grep vite | awk '{print $2}' > pids.txt",
  'ps -o pid= -p "$PID" | xargs kill',
  'for p in $(pgrep -f vite); do echo $p; done; kill $MYPID',
  'for f in $(git ls-files); do grep -n kill $f; done',
  'pgrep -f vite | while read p; do echo $p; done',
  'pwsh -c "Get-ChildItem -Name"',
  'pwsh -c "rg kill -n hooks"',
  'powershell -c "Get-Process -Id 42 | % { Stop-Process -Id $_.Id }"',
  'powershell -c "Get-Process node | % { $_.Id }"',
]

test('each by-name or by-pattern kill form is found, and its name is returned', () => {
  for (const [command, form] of HITS) expect({ command, form: killByName(command) }).toEqual({ command, form })
})

test('a kill by PID, a search for the word and a plain pgrep are not refused', () => {
  for (const command of MISSES) expect({ command, form: killByName(command) }).toEqual({ command, form: undefined })
})

test('the known gaps stay unrefused until someone decides to close them', () => {
  for (const command of GAPS) expect({ command, form: killByName(command) }).toEqual({ command, form: undefined })
})

test('a kill word at a command start inside quoted text or a heredoc is refused on purpose', () => {
  for (const [command, form] of ACCEPTED) expect({ command, form: killByName(command) }).toEqual({ command, form })
})

test('the refusal names the form, the allowed way and what to do when the word is only text', () => {
  const text = killRefusal('pkill')
  expect(text).toContain('pkill')
  expect(text).toContain('kill <PID>')
  expect(text).toContain('reword it, or write the file with the Write tool')
})

const CHECK: VerificationCheck[] = [{ kind: 'command', argv: ['check-control'] }]
const RUN = { key: 'kill', name: 'Kill', nodes: [{ id: 'a', prompt: 'Write a', dependsOn: [], verify: CHECK }] }

test('a node worker\'s pkill is refused before it runs, and its kill by PID goes through', async ($, on) => {
  harness(on)
  await boot($)
  await start($, RUN)
  const refused = await $.tool.call({ tool: 'Bash', command: 'pkill -f vite', agentId: 'agent-1', tool_use_id: 'call-1' } as never)
  expect(refused.deny).toContain('pkill')
  const allowed = await $.tool.call({ tool: 'Bash', command: 'kill 4242', agentId: 'agent-1', tool_use_id: 'call-2' } as never)
  expect(allowed.deny).toBeUndefined()
})

test('the main conversation and every subagent are refused only while this session has an unsettled run', async ($, on) => {
  harness(on)
  await boot($, 'off')
  const before = await $.tool.call({ tool: 'Bash', command: 'killall node' } as never)
  expect(before.deny).toBeUndefined()
  await start($, RUN)
  const during = await $.tool.call({ tool: 'Bash', command: 'killall node' } as never)
  expect(during.deny).toContain('killall')
  // A subagent that is not a node worker, such as an Explore agent the main conversation started, is held to the same rule.
  const helper = await $.tool.call({ tool: 'Bash', command: 'pkill -f vite', agentId: 'explore-1', tool_use_id: 'call-9' } as never)
  expect(helper.deny).toContain('pkill')
})
