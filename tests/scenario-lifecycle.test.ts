import { expect, test, type Engine, type Plugin } from 'claude-code/testing'
import type { On } from 'claude-code'
import { parseContext } from '../hooks/engine/context.ts'
import { protocolFor } from '../hooks/engine/policy.ts'
import { boot, checkpoint, command, dag, finish, folder, harness, PROGRAMS, ROOT, start } from './control-harness.ts'

// End-to-end scenarios: each one drives the plugin through a whole lifecycle across features (preview, approval, the
// verify grammar, recovery, retry, amend, run resume, settle messages, the context diet, the planning gate, lint) and
// asserts the chain a person or the model would observe: spawns, checkpoint states, evidence files, submitted prompts and
// their context.
// The unit and hook tests prove each case on its own; these prove the cases still compose.

type Harness = ReturnType<typeof harness>
type Submit = Harness['submits'][number]

const SKILL = 'dag-workflow:planning'
const STRICT = protocolFor('strict', true)
const CHECK = [{ kind: 'command', argv: ['check-control'] }]
const NO_RECOVERY = { options: { auto_recovery: false } }

// The harness answers every program with exit 0 and no output; PROGRAMS (control-harness.ts) plays `report`, whose
// exit code and output a verify expectation can judge. This plugin adds a parser, `cli [--strict] <file>`: strict mode
// rejects the file (exit 1, an error on stderr), lenient mode accepts it. A plugin's register closes over nothing of this
// file, so behaviour travels in argv.
const CLI: Plugin = {
  name: 'scenario-cli',
  register(on) {
    on('process.run', ($, e, next) => {
      if (e.argv[0] !== 'cli') return next(e)
      const file = e.argv.at(-1) ?? ''
      const done = (exitCode: number, stdout: string, stderr: string) => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
      return e.argv.includes('--strict') ? done(1, '', `error: ${file}: unexpected token at line 3\n`) : done(0, `parsed ${file} leniently\n`, '')
    })
  },
}

function restores(submit: Submit | undefined): boolean {
  return submit?.context.some(entry => entry.includes('"kind":"context-restoration"')) ?? false
}

// The node states a restoration block reports, as `id:state`.
function reportedNodes(submit: Submit | undefined): string[] {
  const block = submit?.context.find(entry => entry.includes('"kind":"context-restoration"'))
  if (!block) return []
  const parsed: { entries: { kind: string; id?: { text: string }; state?: string }[] } = JSON.parse(block)
  return parsed.entries.filter(entry => entry.kind === 'node').map(entry => `${entry.id?.text}:${entry.state}`).sort()
}

function pluginNews(h: Harness): Submit[] {
  return h.submits.filter(submit => submit.origin === 'plugin')
}

function states(h: Harness, runId: string): string[] {
  return checkpoint(h, runId).nodes.map(node => `${node.id}:${node.state}`)
}

// Every evidence file a node's verification wrote in this run, oldest attempt first, as `status` and failed details.
function evidenceFiles(h: Harness, runId: string, nodeId: string): { status: string; failed: string[] }[] {
  const prefix = `${ROOT}/runs/${runId}/${nodeId}.verification.`
  return [...h.files.keys()].filter(path => path.startsWith(prefix)).sort().map(path => {
    const saved: { status: string; evidence: { passed: boolean; detail: string }[] } = JSON.parse(h.files.get(path) ?? 'null')
    return { status: saved.status, failed: saved.evidence.filter(item => !item.passed).map(item => item.detail.split('\n')[0] ?? '') }
  })
}

async function ask($: Engine, text: string): Promise<void> {
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
}

type PreviewReply = { dry_run: true; preview: { node_count: number; waves: string[][]; nodes: { id: string; model: string }[]; warnings: string[] } }
type StartReply = { run_id: string; reused: boolean; awaiting_approval?: true; note?: string }

async function modelStart($: Engine, definition: unknown): Promise<StartReply> {
  const reply = await dag($, { action: 'start', definition })
  if (typeof reply.run_id !== 'string') throw new Error(JSON.stringify(reply))
  return reply as StartReply
}

// ---------------------------------------------------------------------------------------------------------------------
// 1. Plan to settle

const SHIP = {
  key: 'ship',
  name: 'Ship',
  goal: 'The API handler and the UI bundle ship together and the integration check passes',
  nodes: [
    {
      id: 'api', prompt: 'Write the API handler', writes: ['src/api'],
      verify: [
        { kind: 'file', path: 'src/api/handler.ts', contains: 'export function handler', matches: '^export function handler\\(req: Request\\)' },
        { kind: 'file', path: 'src/api', absent: 'TODO' },
      ],
    },
    {
      id: 'ui', prompt: 'Build the UI bundle against the shared contract', writes: ['out/build.log'],
      verify: [
        { kind: 'file', path: 'out/build.log', lastLine: 'BUILD OK', absent: 'ERROR' },
        { kind: 'file', path: '/shared/contracts/api-v2.json', contains: '"version": 2' },
      ],
    },
    {
      id: 'verify-ship', prompt: 'Run the integration check', dependsOn: ['api', 'ui'], category: 'unspecified-low', writes: ['out/VERSION'],
      verify: [
        { kind: 'command', argv: ['report', '0', 'ok 1 api\nok 2 ui\nPASS 2 of 2\n'], expect: { stdout: { lastLine: 'PASS 2 of 2' } } },
        { kind: 'command', argv: ['report', '1', '', 'refused: missing token'], expect: { exit: [1], stderr: { contains: 'missing token' } } },
        { kind: 'file', path: 'out/VERSION', equals: '2.0.0' },
      ],
    },
  ],
}

test('scenario 1, plan to settle: a dry run starts nothing, the real run passes every kind of check and settles with one plain message', { ...NO_RECOVERY, plugins: [PROGRAMS] }, async ($, on) => {
  const h = harness(on)
  await boot($)

  const dry = await dag($, { action: 'start', definition: SHIP, dryRun: true }) as PreviewReply
  expect(dry.dry_run).toBe(true)
  expect(dry.preview.waves).toEqual([['api', 'ui'], ['verify-ship']])
  expect(dry.preview.nodes.map(node => `${node.id}:${node.model}`)).toEqual(['api:sonnet', 'ui:sonnet', 'verify-ship:sonnet'])
  expect(h.spawns).toHaveLength(0)
  expect([...h.files.keys()].filter(path => path.startsWith(`${ROOT}/runs/`))).toEqual([])

  const runId = await start($, SHIP)
  expect(h.spawns.map(spawn => spawn.description)).toEqual(['Ship: api', 'Ship: ui'])
  expect(states(h, runId)).toEqual(['api:running', 'ui:running', 'verify-ship:pending'])

  // What the two workers leave behind.
  folder(h, '/work/src/api', {
    'handler.ts': 'export function handler(req: Request) {\n  return new Response("ok")\n}\n',
    'routes.ts': 'export const routes = ["/health"]\n',
  })
  h.files.set('/work/out/build.log', 'bundling 12 modules\nBUILD OK\n')
  h.files.set('/shared/contracts/api-v2.json', '{\n  "version": 2\n}\n')
  await finish($, h, 'agent-1')
  await finish($, h, 'agent-2')
  expect(h.spawns.map(spawn => spawn.description)).toEqual(['Ship: api', 'Ship: ui', 'Ship: verify-ship'])
  expect(h.spawns[2]?.prompt).toContain('<result node="api"')
  expect(h.spawns[2]?.prompt).toContain('<result node="ui"')

  h.files.set('/work/out/VERSION', '2.0.0\n')
  await finish($, h, 'agent-3')

  const saved = checkpoint(h, runId)
  expect(saved.status).toBe('completed')
  expect(saved.nodes.map(node => `${node.id}:${node.state}:${node.verification?.status}:${node.verification?.evidence.filter(item => item.passed).length}`))
    .toEqual(['api:completed:passed:2', 'ui:completed:passed:2', 'verify-ship:completed:passed:3'])
  // Each node's evidence is its own file, and the folder check read every file below the folder.
  for (const id of ['api', 'ui', 'verify-ship']) expect(evidenceFiles(h, runId, id)).toEqual([{ status: 'passed', failed: [] }])
  expect(h.reads).toEqual(expect.arrayContaining(['/work/src/api/handler.ts', '/work/src/api/routes.ts', '/shared/contracts/api-v2.json']))
  expect(saved.nodes[2]?.verification?.evidence.map(item => item.exitCode)).toEqual([0, 1, undefined])

  // With the pane up no node sends progress; the one plugin message is the settle summary, and it carries no block.
  const news = pluginNews(h)
  expect(news.map(submit => submit.text.split('\n')[0])).toEqual([`DAG run "Ship" (${runId}) settled: completed.`])
  expect(news[0]?.text).toContain('- verify-ship: completed; verification: passed')
  expect(news[0]?.context).toEqual([STRICT])
})

// ---------------------------------------------------------------------------------------------------------------------
// 2. Failure and recovery

const SCRUB = {
  key: 'scrub',
  name: 'Scrub',
  goal: 'The config ships without leftover TODO markers',
  nodes: [
    { id: 'scrub', prompt: 'Remove the debug leftovers from the config', writes: ['src/config.ts'], verify: [{ kind: 'file', path: 'src/config.ts', contains: 'export const config', absent: 'TODO' }] },
    { id: 'verify-config', prompt: 'Check the config loads', dependsOn: ['scrub'], verify: CHECK },
  ],
}

test('scenario 2, failure and recovery: a failed absent check is classified transient, retried on the same grade, and the fixed retry lets dependents run', async ($, on) => {
  const h = harness(on)
  h.control.recovery = 'transient'
  await boot($)
  const runId = await start($, SCRUB)

  h.files.set('/work/src/config.ts', 'export const config = { debug: false }\n// TODO drop the debug flag\n')
  await finish($, h, 'agent-1')

  // The check failed on the forbidden text, Jev was asked once, and the node went straight back to work on sonnet.
  expect(evidenceFiles(h, runId, 'scrub')).toEqual([{ status: 'failed', failed: ['src/config.ts: absent "TODO" found on line 2'] }])
  expect(h.requests.filter(request => 'recovery' in request.questions)).toHaveLength(1)
  expect(h.spawns.map(spawn => `${spawn.description}:${spawn.model}`)).toEqual(['Scrub: scrub:sonnet', 'Scrub: scrub:sonnet'])
  expect(h.spawns[1]?.prompt).toContain('[Recovery 1/2] transient: src/config.ts: absent "TODO" found on line 2')
  expect(states(h, runId)).toEqual(['scrub:running', 'verify-config:pending'])
  expect(checkpoint(h, runId).nodes[0]?.recovery).toMatchObject({ used: 1, kind: 'transient', model: 'sonnet' })
  const decisions: { decisions: { kind: string; selected: string; outcome: string }[] } = await dag($, { action: 'decisions' }) as never
  expect(decisions.decisions.filter(record => record.kind === 'recovery')).toMatchObject([{ selected: 'transient', outcome: 'applied' }])

  // The retry fixes the file before it ends.
  h.files.set('/work/src/config.ts', 'export const config = { debug: false }\n')
  await finish($, h, 'agent-2')
  expect(h.spawns.map(spawn => spawn.description)).toEqual(['Scrub: scrub', 'Scrub: scrub', 'Scrub: verify-config'])
  await finish($, h, 'agent-3')

  expect(checkpoint(h, runId).status).toBe('completed')
  expect(states(h, runId)).toEqual(['scrub:completed', 'verify-config:completed'])
  expect(evidenceFiles(h, runId, 'scrub').map(file => file.status)).toEqual(['failed', 'passed'])
  const news = pluginNews(h)
  expect(news).toHaveLength(1)
  expect(news[0]?.text).toContain('- scrub: completed; verification: passed')
  expect(news[0]?.text).toContain('automatic retries: 1/2 (transient)')
})

// ---------------------------------------------------------------------------------------------------------------------
// 3. Expected failure, then amend

const rejectsBadInput = (argv: string[]) => ({ kind: 'command', argv, expect: { exit: [1], stderr: { contains: 'unexpected token' } } })

function cliDefinition(guardArgv: string[]) {
  return {
    key: 'cli',
    name: 'CLI',
    goal: 'The CLI rejects malformed input in strict mode',
    nodes: [
      { id: 'parser', prompt: 'Make strict mode reject malformed JSON', verify: [rejectsBadInput(['cli', '--strict', 'fixtures/bad.json'])] },
      { id: 'guard', prompt: 'Make strict mode reject an empty file', verify: [rejectsBadInput(guardArgv)] },
      { id: 'docs', prompt: 'Document strict mode', dependsOn: ['guard'], verify: CHECK },
      { id: 'verify-cli', prompt: 'Check the CLI end to end', dependsOn: ['parser', 'docs'], category: 'unspecified-low', verify: CHECK },
    ],
  }
}

test('scenario 3, expected failure: an expected exit 1 with stderr passes, an exit 0 fails and blocks dependents, and amend reruns only that node and its dependents', { ...NO_RECOVERY, plugins: [CLI] }, async ($, on) => {
  const h = harness(on)
  await boot($)
  // The guard's check forgot --strict, so the CLI accepts the file and exits 0.
  const runId = await start($, cliDefinition(['cli', 'fixtures/empty.json']))
  expect(h.spawns.map(spawn => spawn.description)).toEqual(['CLI: parser', 'CLI: guard'])
  await finish($, h, 'agent-1')
  await finish($, h, 'agent-2')

  const failed = checkpoint(h, runId)
  expect(failed.status).toBe('failed')
  expect(states(h, runId)).toEqual(['parser:completed', 'guard:failed', 'docs:skipped', 'verify-cli:skipped'])
  expect(failed.nodes[0]?.verification?.evidence).toMatchObject([{ passed: true, exitCode: 1 }])
  expect(evidenceFiles(h, runId, 'guard')).toEqual([{ status: 'failed', failed: ['exit code 0 is not accepted (expected 1)'] }])
  expect(h.spawns).toHaveLength(2)
  expect(pluginNews(h).map(submit => submit.text.split('\n')[0])).toEqual([`DAG run "CLI" (${runId}) settled: failed.`])
  expect(pluginNews(h)[0]?.text).toContain('- guard: failed (exit code 0 is not accepted (expected 1)')

  const parserBefore = failed.nodes[0]
  const amended = await dag($, { action: 'amend', run_id: runId, definition: cliDefinition(['cli', '--strict', 'fixtures/empty.json']) })
  expect((amended.rerun as string[]).sort()).toEqual(['docs', 'guard', 'verify-cli'])
  expect(h.spawns.map(spawn => spawn.description).slice(2)).toEqual(['CLI: guard'])
  await finish($, h, 'agent-3')
  await finish($, h, 'agent-4')
  await finish($, h, 'agent-5')

  const saved = checkpoint(h, runId)
  expect(saved.status).toBe('completed')
  expect(h.spawns.map(spawn => spawn.description)).toEqual(['CLI: parser', 'CLI: guard', 'CLI: guard', 'CLI: docs', 'CLI: verify-cli'])
  // The parser kept its first and only attempt: the amend did not touch it.
  expect(saved.nodes[0]).toMatchObject({ state: 'completed', attempt: parserBefore?.attempt, finishedAt: parserBefore?.finishedAt, agentId: 'agent-1' })
  expect(evidenceFiles(h, runId, 'guard').map(file => file.status)).toEqual(['failed', 'passed'])
  expect(evidenceFiles(h, runId, 'parser').map(file => file.status)).toEqual(['passed'])
  expect(pluginNews(h).map(submit => submit.text.split('\n')[0])).toEqual([
    `DAG run "CLI" (${runId}) settled: failed.`,
    `DAG run "CLI" (${runId}) settled: completed.`,
  ])
})

// ---------------------------------------------------------------------------------------------------------------------
// 4. Approval

const node = (id: string, dependsOn: string[] = []) => ({ id, prompt: `Write ${id}`, dependsOn, verify: CHECK })
const RELEASE_WIDE = { key: 'release-wide', name: 'Release wide', nodes: [node('bump'), node('changelog'), node('verify-release', ['bump', 'changelog'])] }
const RELEASE_NARROW = { key: 'release-narrow', name: 'Release narrow', nodes: [node('bump'), node('verify-bump', ['bump'])] }

test('scenario 4, approval: under the session override a model start holds, shows its preview, is rejected with nothing run, and a narrower start is approved and settles', NO_RECOVERY, async ($, on) => {
  const h = harness(on)
  await boot($)
  expect((await command($, 'approval always')).text).toBe('DAG start approval: always (session override)')

  const wide = await modelStart($, RELEASE_WIDE)
  expect(wide).toMatchObject({ reused: false, awaiting_approval: true })
  expect(wide.note).toContain('/dag approve <run_id>')
  expect(h.spawns).toHaveLength(0)
  expect(checkpoint(h, wide.run_id).approval).toBeDefined()
  expect(states(h, wide.run_id)).toEqual(['bump:scheduled', 'changelog:scheduled', 'verify-release:pending'])

  const status = ((await command($, `status ${wide.run_id}`)).text ?? '').split('\n')
  expect(status[1]).toBe(`  awaiting approval: /dag approve ${wide.run_id} starts it, /dag reject ${wide.run_id} [reason] cancels it`)
  expect(status).toContain('Preview (nothing started): 3 nodes, 2 waves, widest wave 2, max concurrent 8')
  expect(status).toContain('  wave 1: bump (quick -> sonnet), changelog (quick -> sonnet)')

  await command($, `reject ${wide.run_id} too broad, bump only`)
  await h.clock.settle()
  expect(h.spawns).toHaveLength(0)
  expect(checkpoint(h, wide.run_id)).toMatchObject({ status: 'cancelled', cancelReason: 'Rejected by the user: too broad, bump only', settledNotified: true })
  expect(states(h, wide.run_id)).toEqual(['bump:cancelled', 'changelog:cancelled', 'verify-release:cancelled'])
  expect(h.prompts.filter(text => text.includes(wide.run_id))).toEqual([`DAG run "Release wide" (${wide.run_id}) was rejected by the user: too broad, bump only. Nothing ran.`])
  // The rejected run keeps its key: the same definition again returns it and starts nothing, so a new plan needs a new key.
  expect(await modelStart($, RELEASE_WIDE)).toMatchObject({ reused: true, run_id: wide.run_id })
  expect(h.spawns).toHaveLength(0)

  const narrow = await modelStart($, RELEASE_NARROW)
  expect(narrow.awaiting_approval).toBe(true)
  expect(h.spawns).toHaveLength(0)
  await command($, `approve ${narrow.run_id}`)
  await h.clock.settle()
  expect(h.spawns.map(spawn => spawn.description)).toEqual(['Release narrow: bump'])
  expect(checkpoint(h, narrow.run_id).approval).toBeUndefined()
  await finish($, h, 'agent-1')
  await finish($, h, 'agent-2')

  expect(h.spawns.map(spawn => spawn.description)).toEqual(['Release narrow: bump', 'Release narrow: verify-bump'])
  expect(checkpoint(h, narrow.run_id).status).toBe('completed')
  expect(h.prompts.filter(text => text.includes(narrow.run_id)).map(text => text.split('\n')[0])).toEqual([
    `DAG run "Release narrow" (${narrow.run_id}) was approved by the user and has started.`,
    `DAG run "Release narrow" (${narrow.run_id}) settled: completed.`,
  ])
})

// ---------------------------------------------------------------------------------------------------------------------
// 5. Planning gate and continuity

// The host's $.state for this plugin's flag, held by the test so it can empty it the way a new process does.
function hostState(on: On) {
  const host = { value: undefined as boolean | undefined, version: 0 }
  on('state.get', { plugin: 'dag-workflow', key: 'planningLoaded' }, () => ({ value: { value: host.value, version: host.version } }))
  on('state.set', { plugin: 'dag-workflow', key: 'planningLoaded' }, (_$, e) => {
    host.value = e.value
    host.version += 1
    return { value: { isSet: true as const, version: host.version } }
  })
  return host
}

function storedFlag(h: Harness, sessionId: string): boolean | undefined {
  const text = h.files.get(`${ROOT}/context/${sessionId}.json`)
  return text === undefined ? undefined : parseContext(JSON.parse(text), '/work', sessionId)?.planningLoaded
}

const flow = (key: string) => ({ key, nodes: [{ id: 'a', prompt: `Make ${key}.txt`, verify: CHECK }] })

async function sessionStart($: Engine): Promise<void> {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
}

test('scenario 5, gate and continuity: the flag reaches the context file, a resumed process reopens the gate from it, and /clear closes it', async ($, on) => {
  const h = harness(on)
  const host = hostState(on)
  await sessionStart($)
  expect(await dag($, { action: 'start', definition: flow('first') })).toMatchObject({ error: { code: 'planning_skill_required' } })

  await $.skill.prompt({ skill: SKILL, text: '# planning' })
  await start($, flow('first'))
  expect(h.spawns).toHaveLength(1)
  expect(storedFlag(h, 'source')).toBe(true)

  // /clear under a new session id: the gate closes and the cleared conversation's file does not inherit the flag.
  h.control.sessionId = 'cleared'
  await $.classic.SessionStart({ source: 'clear' })
  expect(host.value).toBe(false)
  expect(await dag($, { action: 'start', definition: flow('second') })).toMatchObject({ error: { code: 'planning_skill_required' } })
  expect(storedFlag(h, 'cleared')).toBe(undefined)
  expect(storedFlag(h, 'source')).toBe(true)

  // A new process resumes the first conversation (claude --resume keeps its id) with an empty $.state. The kit cannot
  // reset module variables inside one test, so the /clear above closed the in-process flag first: from here the only
  // record that the conversation loaded the skill is its context file.
  h.control.sessionId = 'source'
  host.value = undefined
  host.version = 0
  await sessionStart($)
  expect(await dag($, { action: 'start', definition: flow('second') })).toMatchObject({ reused: false })
  expect(h.spawns.map(spawn => spawn.description)).toEqual(['first: a', 'second: a'])
  expect(host.value).toBe(true)

  // A /clear of the resumed conversation closes it again, and a reload afterwards keeps it closed.
  h.control.sessionId = 'cleared-again'
  await $.classic.SessionStart({ source: 'clear' })
  expect(await dag($, { action: 'start', definition: flow('third') })).toMatchObject({ error: { code: 'planning_skill_required' } })
  await sessionStart($)
  expect(await dag($, { action: 'start', definition: flow('third') })).toMatchObject({ error: { code: 'planning_skill_required' } })
  expect(h.spawns.map(spawn => spawn.description).filter(text => text.startsWith('third'))).toEqual([])
})

// ---------------------------------------------------------------------------------------------------------------------
// 6. Context diet over a run

const IMPORTER = {
  key: 'importer',
  name: 'Importer',
  nodes: [
    { id: 'a', prompt: 'Parse the source', verify: CHECK },
    { id: 'b', prompt: 'Map the records', dependsOn: ['a'], verify: CHECK },
    { id: 'c', prompt: 'Write the import', dependsOn: ['b'], verify: CHECK },
  ],
}

// No pane on this surface, so every finished node reaches the model as a progress note. The cancel is the person's own,
// typed as /dag cancel while node b still runs: no tool result told the model, and no message goes out until b's worker
// stops, so only the restoration block on the next user prompt can tell it.
test('scenario 6, context diet: plugin messages never carry the block, and a user prompt carries it once after a change the model has not seen', NO_RECOVERY, async ($, on) => {
  const h = harness(on)
  await $.session.start({ surface: 'vscode', isInteractive: true, cwd: '/work' })
  await $.skill.prompt({ skill: SKILL, text: '# planning' })

  await ask($, 'Build the importer')
  const runId = await start($, IMPORTER)
  await finish($, h, 'agent-1')
  await ask($, 'How far along is it?')
  await command($, `cancel ${runId}`)
  await ask($, 'Is the importer still running?')
  await finish($, h, 'agent-2', true)
  await ask($, 'What happened?')

  expect(h.submits.map(submit => `${submit.origin}:${submit.text.split(' ')[0]}:${restores(submit) ? 'block' : '-'}`)).toEqual([
    'composer:Build:block',
    'plugin:Node:-',
    'composer:How:-',
    'composer:Is:block',
    'plugin:DAG:-',
    'composer:What:-',
  ])
  expect(h.submits.filter(restores)).toHaveLength(2)
  expect(reportedNodes(h.submits[3])).toEqual(['a:completed', 'b:running', 'c:cancelled'])
  expect(pluginNews(h).map(submit => submit.context)).toEqual([[STRICT], [STRICT]])
  expect(pluginNews(h)[1]?.text.split('\n')[0]).toBe(`DAG run "Importer" (${runId}) settled: cancelled.`)
  expect(states(h, runId)).toEqual(['a:completed', 'b:cancelled', 'c:cancelled'])
})

// ---------------------------------------------------------------------------------------------------------------------
// 7. Lint on a realistic definition

const contract = (task: string) => `TASK: ${task}\nDELIVERABLE: the change\nSCOPE: the named files\nVERIFY: the declared checks\nSTOP WHEN: the checks pass`
const PREVIEW_TOOL = {
  id: 'preview-tool', prompt: contract('Add start dryRun'), writes: ['hooks/engine/preview.ts'],
  verify: [{ kind: 'file', path: 'hooks/engine/preview.ts', contains: 'export function previewDefinition' }],
}
// A file check with no text field: touch passes it.
const PREVIEW_README = { id: 'preview-readme', prompt: contract('Document the preview'), writes: ['README.md'], verify: [{ kind: 'file', path: 'README.md' }] }
const REVIEW = { id: 'review-spec', prompt: contract('Review the change against the spec'), dependsOn: ['preview-tool', 'preview-readme'], category: 'unspecified-low', writes: [], verify: CHECK }
// A commit at the end: "preview" holds "review", but not at the start of a word, so this is no verification node.
const commit = (dependsOn: string[]) => ({
  id: 'commit', label: 'Commit the run preview', prompt: contract('Commit the phase'), dependsOn,
  verify: [{ kind: 'command', argv: ['git', 'diff', '--quiet'] }],
})

const VACUOUS = 'node "preview-readme": vacuous verify - check 1 is a file check without contains, absent, matches, lastLine or equals'
const LINT_CASES = [
  {
    name: 'with a review node, only the vacuous file check warns: the commit is neither a verifier nor a final audit',
    nodes: [PREVIEW_TOOL, PREVIEW_README, REVIEW, commit(['review-spec', 'preview-readme'])],
    warnings: [VACUOUS],
  },
  {
    name: 'without one, the commit does not stand in for a verification node',
    nodes: [PREVIEW_TOOL, PREVIEW_README, commit(['preview-tool', 'preview-readme'])],
    warnings: [VACUOUS, 'the graph has no verification node'],
  },
]

for (const lintCase of LINT_CASES) {
  test(`scenario 7, lint on a realistic definition: ${lintCase.name}`, async ($, on) => {
    const h = harness(on)
    await boot($)
    const definition = { key: 'run-preview', name: 'Run preview', goal: 'start dryRun returns the preview and the README documents it', nodes: lintCase.nodes }
    const dry = await dag($, { action: 'start', definition, dryRun: true }) as PreviewReply
    expect(dry.preview.warnings).toEqual(lintCase.warnings.map(warning => expect.stringContaining(warning)))
    // The real start reports the same warnings.
    const started = await dag($, { action: 'start', definition })
    expect(started.warnings).toEqual(dry.preview.warnings)
    expect(h.spawns.map(spawn => spawn.description)).toEqual(['Run preview: preview-tool', 'Run preview: preview-readme'])
  })
}

// ---------------------------------------------------------------------------------------------------------------------
// 8. Run resume

const PIPELINE = {
  key: 'pipeline',
  name: 'Pipeline',
  nodes: [
    { id: 'extract', prompt: 'Extract the records', verify: CHECK },
    { id: 'transform', prompt: 'Transform the records', dependsOn: ['extract'], verify: CHECK },
    { id: 'load', prompt: 'Load the records', dependsOn: ['transform'], verify: CHECK },
  ],
}

// The process dies while transform's worker runs, and the worker dies with it; no session.end reaches the plugin, as on a
// kill. `claude --resume` starts a new process on the same conversation id, and the host lists no live agent (the harness
// agent.list answers []). Startup reloads the checkpoint, and recoverRuns hands the run to requeueLost, which requeues the
// running node whose agent is gone. The kit cannot reset module variables inside one test, so the new process is a
// second session.start; it reloads every run from its checkpoint file.
test('scenario 8, run resume: after a restart the node whose agent is gone is requeued from the checkpoint with its upstream result, and the run settles', NO_RECOVERY, async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = await start($, PIPELINE)
  await finish($, h, 'agent-1')
  expect(h.spawns.map(spawn => spawn.description)).toEqual(['Pipeline: extract', 'Pipeline: transform'])
  expect(checkpoint(h, runId).nodes[1]).toMatchObject({ state: 'running', attempt: 1, agentId: 'agent-2' })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  // Only the lost node starts again, as its second attempt, and its prompt still carries extract's result.
  expect(h.spawns.map(spawn => spawn.description)).toEqual(['Pipeline: extract', 'Pipeline: transform', 'Pipeline: transform'])
  expect(h.spawns[2]?.prompt).toContain('attempt 2')
  expect(h.spawns[2]?.prompt).toContain('<result node="extract"')
  const resumed = checkpoint(h, runId)
  expect(resumed.status).toBe('running')
  expect(resumed.nodes.map(node => `${node.id}:${node.state}:${node.attempt}:${node.agentId ?? '-'}`))
    .toEqual(['extract:completed:1:agent-1', 'transform:running:2:agent-3', 'load:pending:0:-'])

  // The resumed conversation has not seen this process's state, so the next user prompt carries it once.
  await ask($, 'Where is the pipeline?')
  expect(restores(h.submits.at(-1))).toBe(true)
  expect(reportedNodes(h.submits.at(-1))).toEqual(['extract:completed', 'load:pending', 'transform:running'])

  await finish($, h, 'agent-3')
  expect(h.spawns.map(spawn => spawn.description).slice(3)).toEqual(['Pipeline: load'])
  await finish($, h, 'agent-4')

  const saved = checkpoint(h, runId)
  expect(saved.status).toBe('completed')
  expect(states(h, runId)).toEqual(['extract:completed', 'transform:completed', 'load:completed'])
  // The attempt lost in the restart was never verified: transform has one evidence file, from its second attempt.
  expect(evidenceFiles(h, runId, 'transform')).toEqual([{ status: 'passed', failed: [] }])
  expect(pluginNews(h).map(submit => submit.text.split('\n')[0])).toEqual([`DAG run "Pipeline" (${runId}) settled: completed.`])
})

// ---------------------------------------------------------------------------------------------------------------------
// 9. A missing path and the checkpoint store inside a whole flow

const ENTRY = 'Loader: no longer evaluates config source'
const CLEANUP = {
  key: 'cleanup',
  name: 'Cleanup',
  goal: 'The legacy loader no longer calls eval and the changelog says so',
  nodes: [
    {
      id: 'drop-eval', prompt: 'Remove the eval call from src/legacy/loader.ts', writes: ['src/legacy/loader.ts'],
      verify: [{ kind: 'file', path: 'src/legacy/loader.ts', absent: 'eval(' }],
    },
    // Any file of the project may hold the entry. The run's own checkpoint holds it too, since it keeps this definition.
    { id: 'changelog', prompt: 'Add the changelog entry', writes: ['CHANGELOG.md'], verify: [{ kind: 'file', path: '.', contains: ENTRY }] },
    { id: 'verify-cleanup', prompt: 'Run the loader tests', dependsOn: ['drop-eval', 'changelog'], category: 'unspecified-low', verify: CHECK },
  ],
}

// The files read since `from` that sit in the checkpoint store; the verification of the nodes that finished meanwhile
// is what reads in those spans.
function storeReadsSince(h: Harness, from: number): string[] {
  return h.reads.slice(from).filter(path => path.startsWith(`${ROOT}/`))
}

test('scenario 9, missing path and checkpoint store: absent on a deleted file and contains found only in the checkpoint both fail and block dependents, and retry with the real deliverables settles', NO_RECOVERY, async ($, on) => {
  const h = harness(on)
  folder(h, '/work', { 'README.md': '# app\n', 'src/legacy/loader.ts': 'export function load(source) {\n  return eval(source)\n}\n' })
  await boot($)
  const runId = await start($, CLEANUP)
  expect(h.spawns.map(spawn => spawn.description)).toEqual(['Cleanup: drop-eval', 'Cleanup: changelog'])

  // One worker deletes the loader instead of fixing it; the other writes no entry.
  h.files.delete('/work/src/legacy/loader.ts')
  const firstVerify = h.reads.length
  await finish($, h, 'agent-1')
  await finish($, h, 'agent-2')

  // The entry's text is in the run's checkpoint, and the walk of the project neither read nor counted it.
  expect([...h.files].some(([path, text]) => path.startsWith(`${ROOT}/runs/`) && text.includes(ENTRY))).toBe(true)
  expect(storeReadsSince(h, firstVerify)).toEqual([])
  expect(evidenceFiles(h, runId, 'drop-eval')).toEqual([{ status: 'failed', failed: [expect.stringContaining('Path is missing or unreadable: src/legacy/loader.ts')] }])
  expect(evidenceFiles(h, runId, 'changelog')).toEqual([{ status: 'failed', failed: [`. (1 files): contains "${ENTRY}" not found`] }])
  expect(checkpoint(h, runId).status).toBe('failed')
  expect(states(h, runId)).toEqual(['drop-eval:failed', 'changelog:failed', 'verify-cleanup:skipped'])
  expect(h.spawns).toHaveLength(2)
  const failedNews = pluginNews(h)
  expect(failedNews.map(submit => submit.text.split('\n')[0])).toEqual([`DAG run "Cleanup" (${runId}) settled: failed.`])
  expect(failedNews[0]?.text).toContain('- drop-eval: failed (Path is missing or unreadable: src/legacy/loader.ts')

  // The model retries; this time the workers leave the deliverables the checks ask for.
  await dag($, { action: 'retry', run_id: runId })
  expect(h.spawns.map(spawn => spawn.description).slice(2)).toEqual(['Cleanup: drop-eval', 'Cleanup: changelog'])
  h.files.set('/work/src/legacy/loader.ts', 'export function load(source) {\n  return JSON.parse(source)\n}\n')
  h.files.set('/work/CHANGELOG.md', `# Changelog\n\n## 2.1\n- ${ENTRY}\n`)
  const secondVerify = h.reads.length
  await finish($, h, 'agent-3')
  await finish($, h, 'agent-4')
  expect(h.spawns.map(spawn => spawn.description).slice(4)).toEqual(['Cleanup: verify-cleanup'])
  await finish($, h, 'agent-5')

  expect(checkpoint(h, runId).status).toBe('completed')
  expect(states(h, runId)).toEqual(['drop-eval:completed', 'changelog:completed', 'verify-cleanup:completed'])
  expect(evidenceFiles(h, runId, 'drop-eval').map(file => file.status)).toEqual(['failed', 'passed'])
  expect(evidenceFiles(h, runId, 'changelog').map(file => file.status)).toEqual(['failed', 'passed'])
  expect(checkpoint(h, runId).nodes[1]?.verification?.evidence[0]?.detail).toBe('Folder verified: . (3 files)')
  expect(h.reads.slice(secondVerify)).toContain('/work/CHANGELOG.md')
  expect(storeReadsSince(h, secondVerify)).toEqual([])
  expect(pluginNews(h).map(submit => submit.text.split('\n')[0])).toEqual([
    `DAG run "Cleanup" (${runId}) settled: failed.`,
    `DAG run "Cleanup" (${runId}) settled: completed.`,
  ])
})
