import { expect, test } from 'claude-code/testing'
import type { EventOf } from 'claude-code'
import type { VerificationCheck } from '../hooks/engine/types.ts'
import { INPUT_SCHEMA, TOOL_DESCRIPTION, TOOL_DESCRIPTION_LIMIT } from '../hooks/engine/tool-spec.ts'
import { boot, command, dag, harness, ROOT, start } from './control-harness.ts'

const CHECK: VerificationCheck[] = [{ kind: 'command', argv: ['check-control'] }]
const FULL = 'TASK: do it. DELIVERABLE: x. SCOPE: y. VERIFY: z. STOP WHEN: done.'

// api and ui can run at the same time and both write under src; wrap waits for both.
const DEFINITION = {
  key: 'preview-demo',
  name: 'Preview demo',
  goal: 'Show what a dry run reports',
  nodes: [
    { id: 'api', prompt: FULL, writes: ['src'], verify: CHECK },
    { id: 'ui', prompt: FULL, writes: ['src/ui.ts'], verify: CHECK },
    { id: 'wrap', prompt: FULL, dependsOn: ['api', 'ui'], category: 'deep-high', writes: ['docs/wrap.md'], verify: CHECK },
  ],
}

const DEFINITION_YAML = [
  'key: preview-demo',
  'name: Preview demo',
  'goal: Show what a dry run reports',
  'nodes:',
  '  - id: api',
  `    prompt: ${FULL}`,
  '    writes: [src]',
  '    verify:',
  '      - kind: command',
  '        argv: [check-control]',
  '  - id: ui',
  `    prompt: ${FULL}`,
  '    writes: [src/ui.ts]',
  '    verify:',
  '      - kind: command',
  '        argv: [check-control]',
  '  - id: wrap',
  `    prompt: ${FULL}`,
  '    dependsOn: [api, ui]',
  '    category: deep-high',
  '    writes: [docs/wrap.md]',
  '    verify:',
  '      - kind: command',
  '        argv: [check-control]',
  '',
].join('\n')

type PreviewReply = {
  dry_run: boolean
  existing_run_id?: string
  preview: {
    node_count: number
    waves: string[][]
    critical_path: string[]
    max_concurrent: number
    nodes: { id: string; category: string; model: string }[]
    write_conflicts: { a: string; b: string; paths: string[] }[]
    warnings: string[]
  }
}

test('a dry run start returns the preview of the definition and says it is a dry run', async ($, on) => {
  harness(on)
  await boot($)
  const reply = await dag($, { action: 'start', definition: DEFINITION, dryRun: true }) as PreviewReply
  expect(reply.dry_run).toBe(true)
  expect(reply.preview.node_count).toBe(3)
  expect(reply.preview.waves).toEqual([['api', 'ui'], ['wrap']])
  expect(reply.preview.critical_path).toEqual(['api', 'wrap'])
  expect(reply.preview.max_concurrent).toBe(8)
  expect(reply.preview.nodes.map(node => `${node.id}:${node.category}:${node.model}`)).toEqual(['api:quick:sonnet', 'ui:quick:sonnet', 'wrap:deep-high:opus'])
  expect(reply.preview.write_conflicts).toEqual([{ a: 'api', b: 'ui', paths: ['src/ui.ts'] }])
  expect(reply.existing_run_id).toBeUndefined()
})

test('a dry run creates nothing: no spawn, no file, no run in the list', async ($, on) => {
  const h = harness(on)
  await boot($)
  const filesBefore = [...h.files.keys()].sort()
  await dag($, { action: 'start', definition: DEFINITION, dryRun: true })
  expect(h.spawns).toHaveLength(0)
  expect([...h.files.keys()].filter(path => path.startsWith(`${ROOT}/runs/`))).toEqual([])
  expect([...h.files.keys()].sort()).toEqual(filesBefore)
  expect(await dag($, { action: 'list' })).toEqual({ runs: [] })
  // The definition was not consumed: a real start afterwards makes a fresh run.
  expect(await dag($, { action: 'start', definition: DEFINITION })).toMatchObject({ reused: false })
  expect(h.spawns).toHaveLength(2)
})

test('a dry run reads a definition file by path and previews it like the inline definition', async ($, on) => {
  const h = harness(on)
  h.files.set('/work/flows/demo.yaml', DEFINITION_YAML)
  await boot($)
  const inline = await dag($, { action: 'start', definition: DEFINITION, dryRun: true })
  const byPath = await dag($, { action: 'start', path: 'flows/demo.yaml', dryRun: true })
  expect(byPath).toEqual(inline)
  expect(h.spawns).toHaveLength(0)
  expect(await dag($, { action: 'start', path: 'flows/missing.yaml', dryRun: true })).toMatchObject({ error: { code: 'definition_unreadable' } })
  expect(await dag($, { action: 'start', path: '../outside.yaml', dryRun: true })).toMatchObject({ error: { code: 'invalid_request' } })
  expect(await dag($, { action: 'start', definition: DEFINITION, path: 'flows/demo.yaml', dryRun: true })).toMatchObject({ error: { code: 'invalid_request' } })
})

test('an invalid definition fails a dry run with the same error code as start', async ($, on) => {
  const h = harness(on)
  await boot($)
  const unverified = { key: 'unverified', nodes: [{ id: 'a', prompt: FULL }] }
  const empty = { key: 'empty', nodes: [] }
  for (const [definition, code] of [[unverified, 'verification_required'], [empty, 'invalid_definition']] as const) {
    const started = await dag($, { action: 'start', definition })
    const previewed = await dag($, { action: 'start', definition, dryRun: true })
    expect(started).toMatchObject({ error: { code } })
    expect(previewed).toEqual(started)
  }
  expect(h.spawns).toHaveLength(0)
})

test('a dry run of the definition a key already runs names that run and starts no second one', async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = await start($, DEFINITION)
  const spawned = h.spawns.length
  const reply = await dag($, { action: 'start', definition: DEFINITION, dryRun: true }) as PreviewReply
  expect(reply).toMatchObject({ dry_run: true, existing_run_id: runId })
  expect(reply.preview.waves).toEqual([['api', 'ui'], ['wrap']])
  expect(h.spawns).toHaveLength(spawned)
  expect(((await dag($, { action: 'list' })).runs as unknown[])).toHaveLength(1)
})

test('a dry run of a different definition under a used key is refused like start', async ($, on) => {
  const h = harness(on)
  await boot($)
  await start($, DEFINITION)
  const changed = { ...DEFINITION, nodes: DEFINITION.nodes.slice(0, 2) }
  const started = await dag($, { action: 'start', definition: changed })
  expect(started).toMatchObject({ error: { code: 'definition_conflict' } })
  const previewed = await dag($, { action: 'start', definition: changed, dryRun: true })
  expect(previewed).toEqual(started)
  expect(previewed.existing_run_id).toBeUndefined()
  expect(h.spawns).toHaveLength(2)
})

test('a dry run is planning: under strict it is refused until the planning skill is loaded', async ($, on) => {
  const h = harness(on)
  h.files.set('/work/flows/demo.yaml', DEFINITION_YAML)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const readsBefore = h.reads.length
  expect(await dag($, { action: 'start', definition: DEFINITION, dryRun: true })).toMatchObject({ error: { code: 'planning_skill_required' } })
  expect(await dag($, { action: 'start', path: 'flows/demo.yaml', dryRun: true })).toMatchObject({ error: { code: 'planning_skill_required' } })
  expect(h.reads).toHaveLength(readsBefore)
  await $.skill.prompt({ skill: 'dag-workflow:planning', text: '# planning' })
  expect(await dag($, { action: 'start', definition: DEFINITION, dryRun: true })).toMatchObject({ dry_run: true })
})

test('in guide mode a dry run before the planning skill is loaded carries the planning warning', async ($, on) => {
  const h = harness(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await command($, 'enforce guide')
  const reply = await dag($, { action: 'start', definition: DEFINITION, dryRun: true }) as PreviewReply
  expect(reply.dry_run).toBe(true)
  expect(reply.preview.warnings.some(warning => warning.includes('dag-workflow:planning'))).toBe(true)
  expect(h.spawns).toHaveLength(0)
})

test('a dryRun that is not a boolean is refused before anything is read, and dryRun false starts normally', async ($, on) => {
  const h = harness(on)
  h.files.set('/work/flows/demo.yaml', DEFINITION_YAML)
  await boot($)
  const readsBefore = h.reads.length
  for (const dryRun of ['true', 1, 'yes', null]) {
    const reply = await dag($, { action: 'start', definition: DEFINITION, dryRun })
    expect(reply).toMatchObject({ error: { code: 'invalid_request', message: expect.stringContaining('dryRun must be true or false') } })
    expect(await dag($, { action: 'start', path: 'flows/demo.yaml', dryRun })).toMatchObject({ error: { code: 'invalid_request' } })
  }
  expect(h.spawns).toHaveLength(0)
  expect(h.reads).toHaveLength(readsBefore)
  expect([...h.files.keys()].filter(path => path.startsWith(`${ROOT}/runs/`))).toEqual([])
  expect(await dag($, { action: 'list' })).toEqual({ runs: [] })
  expect(await dag($, { action: 'start', definition: DEFINITION, dryRun: false })).toMatchObject({ reused: false })
  expect(h.spawns).toHaveLength(2)
})

test('dryRun is for start only: amend, retry and cancel with a dryRun field are refused and change nothing', async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = await start($, DEFINITION)
  const spawned = h.spawns.length
  const before = h.files.get(`${ROOT}/runs/${runId}.json`)
  const amended = { ...DEFINITION, nodes: [...DEFINITION.nodes, { id: 'extra', prompt: FULL, verify: CHECK }] }
  for (const dryRun of [true, false, 'true']) {
    expect(await dag($, { action: 'amend', run_id: runId, definition: amended, dryRun })).toMatchObject({ error: { code: 'invalid_request', message: expect.stringContaining('dryRun is for start only') } })
  }
  expect(await dag($, { action: 'cancel', run_id: runId, dryRun: true })).toMatchObject({ error: { code: 'invalid_request' } })
  expect(await dag($, { action: 'retry', run_id: runId, dryRun: true })).toMatchObject({ error: { code: 'invalid_request' } })
  expect(h.spawns).toHaveLength(spawned)
  expect(h.files.get(`${ROOT}/runs/${runId}.json`)).toBe(before)
  expect(((await dag($, { action: 'list' })).runs as { status: string }[])[0]?.status).toBe('running')
  // Control: without the field the same amend goes through, so the refusals above came from dryRun.
  expect(await dag($, { action: 'amend', run_id: runId, definition: amended })).toMatchObject({ rerun: ['extra'] })
})

test('a dry run opens no pane and schedules nothing, while a real start does', async ($, on) => {
  const opened: EventOf['ui.open'][] = []
  // Registered before the harness so this handler, not the harness's always-placed one, sees the open.
  on('ui.open', { id: 'dag' }, (_$, e) => { opened.push(e); return { value: { isPlaced: true } } })
  const h = harness(on)
  h.files.set('/work/flows/demo.yaml', DEFINITION_YAML)
  await boot($)
  const processes = h.processes.length
  await dag($, { action: 'start', definition: DEFINITION, dryRun: true })
  await dag($, { action: 'start', path: 'flows/demo.yaml', dryRun: true })
  await command($, 'preview flows/demo.yaml')
  await h.clock.advance(15 * 60_000)
  await h.clock.settle()
  expect(opened).toHaveLength(0)
  expect(h.spawns).toHaveLength(0)
  expect(h.processes).toHaveLength(processes)
  expect(h.requests).toHaveLength(0)
  expect(h.sends).toHaveLength(0)
  expect(h.toasts).toHaveLength(0)
  // Control: the same host does open the pane and spawn for a real start, so the counts above can fail.
  await start($, DEFINITION)
  expect(opened).toHaveLength(1)
  expect(h.spawns).toHaveLength(2)
})

test('/dag preview <file> prints the header, the waves, the critical path and the write conflict', async ($, on) => {
  const h = harness(on)
  h.files.set('/work/flows/demo.yaml', DEFINITION_YAML)
  await boot($)
  const out = await command($, 'preview flows/demo.yaml')
  const lines = (out.text ?? '').split('\n')
  expect(lines[0]).toBe('Preview (nothing started): 3 nodes, 2 waves, widest wave 2, max concurrent 8')
  expect(lines).toContain('  wave 1: api (quick -> sonnet), ui (quick -> sonnet)')
  expect(lines).toContain('  wave 2: wrap (deep-high -> opus)')
  expect(lines).toContain('Critical path: api -> wrap')
  expect(lines).toContain('  api <-> ui: src/ui.ts')
  expect(lines.filter(line => line.startsWith('unchecked write scope'))).toEqual([])
  expect(h.spawns).toHaveLength(0)
  expect([...h.files.keys()].filter(path => path.startsWith(`${ROOT}/runs/`))).toEqual([])
  expect(await dag($, { action: 'list' })).toEqual({ runs: [] })
})

test('/dag preview prints the routing note once under the header and names nodes whose write scope is unchecked', async ($, on) => {
  const nodes = [
    { id: 'u1', prompt: FULL, verify: CHECK },
    { id: 'u2', prompt: FULL, verify: CHECK },
    { id: 'ro', prompt: FULL, writes: [], verify: CHECK },
    { id: 'wrap', prompt: FULL, dependsOn: ['u1', 'u2', 'ro'], verify: CHECK },
  ]
  const definition = { key: 'unchecked-demo', nodes }
  const h = harness(on)
  h.files.set('/work/flows/unchecked.json', JSON.stringify(definition))
  await boot($)
  const lines = ((await command($, 'preview flows/unchecked.json')).text ?? '').split('\n')
  expect(lines[1]).toContain('Jev may reroute')
  expect(lines.filter(line => line.includes('Jev may reroute'))).toHaveLength(1)
  // u1 and u2 declare nothing and share a wave; ro declares a read-only scope and wrap has no peer to overlap with.
  expect(lines).toContain('unchecked write scope (no writes declared): u1, u2')
  const reply = await dag($, { action: 'start', definition, dryRun: true }) as { preview: { unchecked_writes: string[]; routing_note: string; nodes: { id: string; writes: string[] | null }[] } }
  expect(reply.preview.unchecked_writes).toEqual(['u1', 'u2'])
  expect(reply.preview.nodes.map(node => `${node.id}:${JSON.stringify(node.writes)}`)).toEqual(['u1:null', 'u2:null', 'ro:[]', 'wrap:null'])
  expect(reply.preview.routing_note).toContain('Jev may reroute')
  expect(h.spawns).toHaveLength(0)
})

test('/dag preview lists a definition warning and /dag preview without a file shows the usage', async ($, on) => {
  const report = { key: 'report', name: 'Report', nodes: [{ id: 'r', prompt: FULL, verify: [{ kind: 'file', path: 'REPORT.md' }] }] }
  const h = harness(on)
  h.files.set('/work/flows/report.json', JSON.stringify(report))
  await boot($)
  const out = await command($, 'preview flows/report.json')
  expect(out.text).toContain('Warnings:\n- ')
  expect(out.text).toContain('REPORT.md')
  expect(out.text).not.toContain('Write conflicts')
  expect((await command($, 'preview')).text).toContain('preview <file>')
  expect((await command($, 'preview flows/nope.yaml')).text).toContain('Cannot read a DAG definition from /work/flows/nope.yaml')
  expect(h.spawns).toHaveLength(0)
})

test('/dag preview says when the key already runs this definition and refuses a conflicting one', async ($, on) => {
  const h = harness(on)
  h.files.set('/work/flows/demo.yaml', DEFINITION_YAML)
  h.files.set('/work/flows/changed.json', JSON.stringify({ ...DEFINITION, nodes: DEFINITION.nodes.slice(0, 2) }))
  await boot($)
  const runId = await start($, DEFINITION)
  expect((await command($, 'preview flows/demo.yaml')).text).toContain(`already run ${runId}`)
  expect((await command($, 'preview flows/changed.json')).text).toContain('definition_conflict')
  expect(h.spawns).toHaveLength(2)
})

test('the /dag command advertises preview <file> in its argument hint', async ($, on) => {
  const hints: (string | undefined)[] = []
  // Registered before the harness, filtered to /dag, so this handler sees the registration the harness would otherwise answer alone.
  on('command.register', { name: 'dag' }, (_$, e) => { hints.push(e.argumentHint); return { value: { command: e.name } } })
  harness(on)
  await boot($)
  expect(hints.at(-1)).toContain('preview <file>')
})

test('the dag tool schema and description tell the model about dryRun within the description limit', () => {
  expect(INPUT_SCHEMA.properties.dryRun.type).toBe('boolean')
  expect(INPUT_SCHEMA.properties.dryRun.description).toContain('start only')
  expect(TOOL_DESCRIPTION).toContain('dryRun:true')
  expect(TOOL_DESCRIPTION.length).toBeLessThanOrEqual(TOOL_DESCRIPTION_LIMIT)
})
