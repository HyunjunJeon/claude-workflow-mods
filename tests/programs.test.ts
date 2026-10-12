import { expect, test, type Plugin } from 'claude-code/testing'
import { parseDefinition } from '../hooks/engine/definition.ts'
import { commandPrograms, shellCommands } from '../hooks/engine/programs.ts'
import type { VerificationCheck } from '../hooks/engine/types.ts'
import { boot, command, dag, harness, start } from './control-harness.ts'

test('a shell script yields the commands it starts by bare name, skipping builtins, guards, functions and paths', () => {
  const cases: [string, string[]][] = [
    [`diff <(rg -c TODO src | sed -E 's/^(.*):([0-9]+)$/\\1 \\2/' | sort) <(awk -F'|' '{print $2}' notes/x.md | sort)`, ['diff', 'rg', 'sed', 'sort', 'awk']],
    ['python3 test_app.py 2>&1 | tail -1', ['python3', 'tail']],
    ['set -euo pipefail; cd sub && npm test', ['npm']],
    ['command -v rg >/dev/null && rg x . || grep -r x .', ['grep']],
    [`run() { "$@" > /tmp/o 2>&1; }; run x`, []],
    ['for f in a b; do cat "$f"; done; while read -r l; do echo $l; done < file', ['cat']],
    ['if ! grep -q x f; then exit 1; fi', ['grep']],
    ['timeout 5 jq . a.json && env FOO=1 node x.js', ['timeout', 'jq', 'env', 'node']],
    ['test -f x && [ -s y ] && wc -l x', ['wc']],
    ['x=$(git rev-parse HEAD); echo "$x" | grep -q "^[0-9a-f]"', ['git', 'grep']],
    ['echo ${HOME} && ./scripts/check.sh # rg in a comment', []],
  ]
  for (const [script, commands] of cases) expect({ script, found: shellCommands(script) }).toEqual({ script, found: commands })
})

test('a shell script the scan does not model gets no verdict', () => {
  for (const script of ['case $x in a) foo;; esac', '. venv/bin/activate && pytest', 'source env.sh; tool', 'PATH=/opt/bin:$PATH tool', 'cat <<EOF\nhi\nEOF', 'echo $((1+2))', '[[ -f x ]] && tool', "ls 'open quote", 'alias g=grep; g x']) {
    expect({ script, found: shellCommands(script) }).toEqual({ script, found: undefined })
  }
})

const definition = (...verify: VerificationCheck[][]) => {
  const parsed = parseDefinition({ key: 'k', nodes: verify.map((checks, index) => ({ id: `n${index}`, prompt: 'TASK: x STOP WHEN: y', verify: checks })) })
  if (!parsed.ok) throw new Error(parsed.error.message)
  return parsed.value
}

test('command checks name their program and, for sh -c scripts, the programs inside; paths and login shells are not looked up', () => {
  const uses = commandPrograms(definition(
    [{ kind: 'file', path: 'a.md', contains: 'x' }, { kind: 'command', argv: ['bun', 'test'] }],
    [{ kind: 'command', argv: ['bash', '-euo', 'pipefail', '-c', 'rg x | wc -l'] }],
    [{ kind: 'command', argv: ['./run.sh'] }, { kind: 'command', argv: ['/bin/sh', '-c', 'jq . a.json'] }],
    [{ kind: 'command', argv: ['bash', '-lc', 'rg x'] }, { kind: 'command', argv: ['sh', 'script.sh'] }],
  ))
  expect(uses).toEqual([
    { nodeId: 'n0', check: 2, program: 'bun', viaShell: false },
    { nodeId: 'n1', check: 1, program: 'bash', viaShell: false },
    { nodeId: 'n1', check: 1, program: 'rg', viaShell: true },
    { nodeId: 'n1', check: 1, program: 'wc', viaShell: true },
    { nodeId: 'n2', check: 2, program: 'jq', viaShell: true },
    { nodeId: 'n3', check: 1, program: 'bash', viaShell: false },
    { nodeId: 'n3', check: 2, program: 'sh', viaShell: false },
  ])
})

// Stand in for the host's PATH. A plugin runs in its own layer and sees no test variables, so each one carries its answer:
// MISSING_RG prints rg whenever the lookup is asked about it, NO_SH cannot start the lookup at all.
const MISSING_RG: Plugin = {
  name: 'test-path-missing-rg',
  register(on) {
    on('process.run', ($, e, next) => {
      if (e.argv[0] !== 'sh' || !e.argv[2]?.includes('command -v')) return next(e)
      const names = (e.init?.stdin ?? '').split('\n')
      return { value: { exitCode: 0, stdout: names.includes('rg') ? 'rg\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
  },
}
const NO_SH: Plugin = {
  name: 'test-path-no-sh',
  register(on) {
    on('process.run', ($, e, next) => (e.argv[0] === 'sh' && e.argv[2]?.includes('command -v') ? { deny: 'spawn sh ENOENT' } : next(e)))
  },
}

const RG_CHECK: VerificationCheck = { kind: 'command', argv: ['bash', '-c', 'diff <(rg -c TODO src | sort) expected.txt'] }
const NODE = { id: 'count', prompt: 'TASK: count STOP WHEN: done', verify: [RG_CHECK] }
test('start, a dry run and /dag preview refuse a verify program missing from PATH before any node runs', { plugins: [MISSING_RG] }, async ($, on) => {
  const h = harness(on)
  await boot($)
  for (const input of [{ action: 'start', definition: { key: 'rg-run', nodes: [NODE] } }, { action: 'start', dryRun: true, definition: { key: 'rg-run', nodes: [NODE] } }]) {
    const reply = await dag($, input)
    const error = reply.error as { code: string; message: string }
    expect(error.code).toBe('invalid_verification')
    expect(error.message).toContain('node "count" check 1 runs rg inside its shell script')
    expect(error.message).toContain('grep -E instead of rg')
  }
  h.files.set('/work/flows/rg.json', JSON.stringify({ key: 'rg-file', nodes: [NODE] }))
  const preview = await command($, 'preview flows/rg.json')
  expect(preview.text).toContain('invalid_verification')
  expect(h.spawns).toHaveLength(0)
})

test('amend refuses a missing verify program, while a found one starts as before', { plugins: [MISSING_RG] }, async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = await start($, { key: 'amend-rg', nodes: [{ ...NODE, verify: [{ kind: 'command', argv: ['check-control'] }] }] })
  expect(h.spawns).toHaveLength(1)
  const reply = await dag($, { action: 'amend', run_id: runId, definition: { key: 'amend-rg', nodes: [NODE] } })
  expect((reply.error as { code: string }).code).toBe('invalid_verification')
})

test('a lookup that cannot run leaves the definition unjudged', { plugins: [NO_SH] }, async ($, on) => {
  const h = harness(on)
  await boot($)
  await start($, { key: 'no-sh', nodes: [NODE] })
  expect(h.spawns).toHaveLength(1)
})
