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
  ['pgrep -f vite | xargs kill', 'pgrep piped to kill'],
  ['kill -9 $(pgrep node)', 'kill of pgrep matches'],
  ['kill `pgrep -f server`', 'kill of pgrep matches'],
  ['taskkill /IM node.exe /F', 'taskkill /IM or /FI'],
  ['taskkill /F /FI "IMAGENAME eq node.exe"', 'taskkill /IM or /FI'],
  ['powershell -c "Stop-Process -Name node"', 'Stop-Process -Name'],
  ['powershell -c "Get-Process node | Stop-Process"', 'Get-Process piped to Stop-Process'],
  ['kill -9 -1', 'kill -1'],
  ['kill -s KILL -1', 'kill -1'],
  ['kill -- -1', 'kill -1'],
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
]

test('each by-name or by-pattern kill form is found, and its name is returned', () => {
  for (const [command, form] of HITS) expect({ command, form: killByName(command) }).toEqual({ command, form })
})

test('a kill by PID, a search for the word and a plain pgrep are not refused', () => {
  for (const command of MISSES) expect({ command, form: killByName(command) }).toEqual({ command, form: undefined })
})

test('the refusal names the form and the allowed way', () => {
  const text = killRefusal('pkill')
  expect(text).toContain('pkill')
  expect(text).toContain('kill <PID>')
})

const CHECK: VerificationCheck[] = [{ kind: 'command', argv: ['check-control'] }]
const RUN = { key: 'kill', name: 'Kill', nodes: [{ id: 'a', prompt: 'Write a', dependsOn: [], verify: CHECK }] }

test('a node worker\'s pkill is refused before it runs, and its kill by PID goes through', async ($, on) => {
  const h = harness(on)
  await boot($)
  await start($, RUN)
  const refused = await $.tool.call({ tool: 'Bash', command: 'pkill -f vite', agentId: 'agent-1', tool_use_id: 'call-1' } as never)
  expect(refused.deny).toContain('pkill')
  expect(h.processes.some(run => run.argv.join(' ').includes('pkill'))).toBe(false)
  const allowed = await $.tool.call({ tool: 'Bash', command: 'kill 4242', agentId: 'agent-1', tool_use_id: 'call-2' } as never)
  expect(allowed.deny).toBeUndefined()
})

test('the main conversation is refused only while this session has an unsettled run', async ($, on) => {
  harness(on)
  await boot($, 'off')
  const before = await $.tool.call({ tool: 'Bash', command: 'killall node' } as never)
  expect(before.deny).toBeUndefined()
  await start($, RUN)
  const during = await $.tool.call({ tool: 'Bash', command: 'killall node' } as never)
  expect(during.deny).toContain('killall')
})
