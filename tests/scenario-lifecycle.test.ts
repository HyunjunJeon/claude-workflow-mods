import { expect, test, type Engine, type Plugin } from 'claude-code/testing'
import type { On } from 'claude-code'
import { parseContext } from '../hooks/engine/context.ts'
import { protocolFor } from '../hooks/engine/policy.ts'
import { boot, checkpoint, command, dag, finish, folder, harness, PROGRAMS, ROOT, start } from './control-harness.ts'

// End-to-end scenarios: each one drives the plugin through a whole lifecycle across features (preview, approval, the
// verify grammar, recovery, retry, amend, run resume, settle messages, the context diet, the planning gate, lint, the
// built-in review and commit stages, the wait for a node's background work, and the guard on a run the user rejected) and
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
  // The rejected run keeps its key: the model's start of the same definition is refused and starts nothing, so a new plan
  // needs a new key.
  expect(await dag($, { action: 'start', definition: RELEASE_WIDE })).toMatchObject({ error: { code: 'rejected_by_user' } })
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

// ---------------------------------------------------------------------------------------------------------------------
// 10. Built-in review and commit stages

// A small git for the commit node's checks. The harness answers every program with exit 0 and no output, but the generated
// checks judge output: `git log -1 --skip=<n> --format=%s` must print that commit's subject, `git status --porcelain`
// must print nothing, and `git show --format= --name-only <commit> -- :/ :(exclude,literal)<path>...` must print no file outside
// the commit's own paths. The repository is three files the test writes when the commit worker has "committed": /repo/log holds
// the subjects, newest first, /repo/status what `git status` prints, and /repo/changed the files each commit changed, one
// `<revision> <path>` line each (revisions as the checks name them: HEAD, HEAD~1). The fake does git's own filtering, so a
// path the exclude pathspecs do not cover is printed and the check's expectation judges it. With no log the repository has
// no commits (exit 128). The plugin answers git without calling the harness, so each call's argv is also appended to
// /repo/calls, one JSON line a call.
const GIT: Plugin = {
  name: 'scenario-git',
  register(on) {
    // An exclude pathspec as git reads it: `literal` makes the path a name, and without it the path is a pattern. So a bare
    // `:(exclude)app/[id]/page.ts` excuses `app/i/page.ts` (the brackets are a character class) and fails to excuse
    // `app/[id]/page.ts` itself, where `:(exclude,literal)app/[id]/page.ts` excuses exactly that file (real git 2.54).
    // It sits inside register because the plugin's code runs in the host, where this file's top level is not in scope.
    const excludes = (spec: string, path: string): boolean => {
      const magic = /^:\(([^)]*)\)/.exec(spec)
      const words = magic?.[1]?.split(',') ?? []
      if (!words.includes('exclude')) return false
      const pattern = spec.slice(magic?.[0].length ?? 0)
      if (words.includes('literal')) return path === pattern || path.startsWith(`${pattern}/`)
      const source = pattern.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
      return new RegExp(`^${source}(/.*)?$`).test(path)
    }
    on('process.run', async ($, e, next) => {
      if (e.argv[0] !== 'git') return next(e)
      const done = (exitCode: number, stdout: string, stderr: string) => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
      const readFile = async (path: string): Promise<string | undefined> => {
        try {
          return await $.fs.read(path)
        } catch {
          return undefined
        }
      }
      await $.fs.write('/repo/calls', `${(await readFile('/repo/calls')) ?? ''}${JSON.stringify(e.argv)}\n`)
      if (e.argv[1] === 'log') {
        const log = await readFile('/repo/log')
        if (log === undefined) return done(128, '', 'fatal: your current branch does not have any commits yet\n')
        const skip = Number(/^--skip=(\d+)$/.exec(e.argv.find(arg => arg.startsWith('--skip=')) ?? '')?.[1] ?? 0)
        const subject = log.split('\n').filter(line => line !== '')[skip]
        return done(0, subject === undefined ? '' : `${subject}\n`, '')
      }
      if (e.argv[1] === 'status') return done(0, (await readFile('/repo/status')) ?? '', '')
      if (e.argv[1] === 'show') {
        const split = e.argv.indexOf('--')
        const revision = e.argv[split - 1]
        const specs = e.argv.slice(split + 1)
        const changed = ((await readFile('/repo/changed')) ?? '').split('\n').flatMap(line => (line.startsWith(`${revision} `) ? [line.slice(revision?.length ?? 0).trim()] : []))
        const listed = changed.filter(path => !specs.some(spec => excludes(spec, path)))
        return done(0, listed.map(path => `${path}\n`).join(''), '')
      }
      return done(0, '', '')
    })
  },
}

const GREET_GOAL = 'A greet function exists in src/greet.ts and the README documents it'
const GREET_REQUEST = 'Add a greet function and document it in the README'
const FEAT_SUBJECT = 'feat: add greet'
const DOCS_SUBJECT = 'docs: document greet'

// Two producers; the review and commit stages are declared, not written.
function greetFlow(key: string) {
  return {
    key,
    name: 'Greet',
    goal: GREET_GOAL,
    nodes: [
      { id: 'code', prompt: contract('Write src/greet.ts exporting greet'), writes: ['src/greet.ts'], verify: [{ kind: 'file', path: 'src/greet.ts', contains: 'export function greet' }] },
      { id: 'docs', prompt: contract('Document greet in the README'), writes: ['README.md'], verify: [{ kind: 'file', path: 'README.md', contains: 'greet(' }] },
    ],
    review: { request: GREET_REQUEST },
    commit: [
      { message: `${FEAT_SUBJECT}\n\nThe greeting lives in src/greet.ts.`, paths: ['src/greet.ts'] },
      { message: DOCS_SUBJECT, paths: ['README.md'] },
    ],
  }
}

// The notes a reviewer leaves, with the sections the generated prompt asks for and the verdict as the last line.
const specNotes = (verdict: string, finding: string) =>
  `## Request sentences\n"${GREET_REQUEST}"\n\n## Findings\n${finding}\n\n## Real check\n- file checks: both met\n\n## Safe-but-wrong audit\n1. a function and a README section, as requested\n\n${verdict}\n`
const standardsNotes = (verdict: string) =>
  `## Rule sources\nnone - baseline only\n\n## Rule breaches\nnone\n\n## Judgment calls\nnone\n\n${verdict}\n`

// The argv of every git call the checks made, in order.
function gitCalls(h: Harness): string[][] {
  return (h.files.get('/repo/calls') ?? '').split('\n').filter(line => line !== '').map(line => JSON.parse(line))
}

function stageEvidence(h: Harness, runId: string, nodeId: string): string[] {
  const saved = checkpoint(h, runId).nodes.find(current => current.id === nodeId)
  return (saved?.verification?.evidence ?? []).map(item => `${item.passed ? 'pass' : 'FAIL'} ${item.detail.split('\n')[0]}`)
}

test('scenario 10, stages: review and commit declared on a definition expand into reviewers and a commit that run in order, the verdict lines gate the commit, and its git checks judge the real subjects', { ...NO_RECOVERY, plugins: [GIT] }, async ($, on) => {
  const h = harness(on)
  await boot($)

  // The dry run previews the generated nodes after the user's own and starts nothing.
  const dry = await dag($, { action: 'start', definition: greetFlow('greet'), dryRun: true }) as PreviewReply
  expect(dry.preview.node_count).toBe(5)
  expect(dry.preview.waves).toEqual([['code', 'docs'], ['review-spec', 'review-standards'], ['commit']])
  expect(dry.preview.nodes.map(item => item.id)).toEqual(['code', 'docs', 'review-spec', 'review-standards', 'commit'])
  expect(dry.preview.warnings).toEqual([])
  expect(h.spawns).toHaveLength(0)
  expect([...h.files.keys()].filter(path => path.startsWith(`${ROOT}/runs/`))).toEqual([])

  const runId = await start($, greetFlow('greet'))
  expect(h.spawns.map(spawn => spawn.description)).toEqual(['Greet: code', 'Greet: docs'])
  expect(states(h, runId)).toEqual(['code:running', 'docs:running', 'review-spec:pending', 'review-standards:pending', 'commit:pending'])

  // The producers finish; both reviewers start, each with the change's write scopes, the request and its own notes file.
  h.files.set('/work/src/greet.ts', 'export function greet(name: string) {\n  return `hello ${name}`\n}\n')
  h.files.set('/work/README.md', '# app\n\nCall greet(name) to say hello.\n')
  await finish($, h, 'agent-1')
  await finish($, h, 'agent-2')
  expect(h.spawns.map(spawn => spawn.description)).toEqual(['Greet: code', 'Greet: docs', 'Greet: Review: spec axis', 'Greet: Review: standards axis'])
  const [specPrompt, standardsPrompt] = [h.spawns[2]?.prompt ?? '', h.spawns[3]?.prompt ?? '']
  expect(specPrompt).toContain('/tmp/dag-review/greet-5d65d5/review-spec-notes.md')
  expect(specPrompt).toContain(GREET_REQUEST)
  expect(specPrompt).toContain(GREET_GOAL)
  expect(specPrompt).toContain('- code: src/greet.ts')
  expect(specPrompt).toContain('- docs: README.md')
  expect(specPrompt).toContain('<result node="code"')
  expect(standardsPrompt).toContain('/tmp/dag-review/greet-5d65d5/review-standards-notes.md')
  expect(standardsPrompt).toContain('Before you start, load and follow these skills with the Skill tool: dag-workflow:review-standards.')
  expect(standardsPrompt).not.toContain(GREET_REQUEST)
  expect(h.spawns[2]?.model).toBe('sonnet')
  expect(states(h, runId)).toEqual(['code:completed', 'docs:completed', 'review-spec:running', 'review-standards:running', 'commit:pending'])

  // One verdict is not enough: the commit waits for both reviewers.
  h.files.set('/tmp/dag-review/greet-5d65d5/review-spec-notes.md', specNotes('Spec verdict: PASS', '(a) none\n(b) none\n(c) none'))
  await finish($, h, 'agent-3')
  expect(states(h, runId).slice(2)).toEqual(['review-spec:completed', 'review-standards:running', 'commit:pending'])
  expect(h.spawns).toHaveLength(4)
  h.files.set('/tmp/dag-review/greet-5d65d5/review-standards-notes.md', standardsNotes('Standards verdict: PASS'))
  await finish($, h, 'agent-4')
  expect(stageEvidence(h, runId, 'review-spec')).toEqual([
    'pass File verified: /tmp/dag-review/greet-5d65d5/review-spec-notes.md',
    'pass File verified: /tmp/dag-review/greet-5d65d5/review-spec-notes.md',
  ])
  expect(stageEvidence(h, runId, 'review-standards')).toEqual([
    'pass File verified: /tmp/dag-review/greet-5d65d5/review-standards-notes.md',
    'pass File verified: /tmp/dag-review/greet-5d65d5/review-standards-notes.md',
  ])
  // No git ran before the commit node: the reviewers and producers use file checks only.
  expect(gitCalls(h)).toEqual([])

  // The commit node starts last, reads the verdict files first, and lists both commits with their own paths.
  expect(h.spawns.map(spawn => spawn.description).slice(4)).toEqual(['Greet: Commit'])
  const commitPrompt = h.spawns[4]?.prompt ?? ''
  expect(commitPrompt).toContain('/tmp/dag-review/greet-5d65d5/review-spec-notes.md and /tmp/dag-review/greet-5d65d5/review-standards-notes.md')
  expect(commitPrompt).toContain(`Commit 1 of 2\n  paths: src/greet.ts\n  subject: ${FEAT_SUBJECT}`)
  expect(commitPrompt).toContain(`Commit 2 of 2\n  paths: README.md\n  subject: ${DOCS_SUBJECT}`)
  expect(commitPrompt).toContain('The greeting lives in src/greet.ts.')

  // The commit worker commits both, each with only its own file; the checks read the subjects back from the repository,
  // oldest at --skip=1, and the sweep checks list what each commit changed outside its own paths: nothing.
  h.files.set('/repo/log', `${DOCS_SUBJECT}\n${FEAT_SUBJECT}\n`)
  h.files.set('/repo/changed', 'HEAD~1 src/greet.ts\nHEAD README.md\n')
  await finish($, h, 'agent-5')
  expect(stageEvidence(h, runId, 'commit')).toEqual([
    'pass ["git","log","-1","--skip=1","--format=%s"] exited 0',
    'pass ["git","log","-1","--skip=0","--format=%s"] exited 0',
    'pass ["git","show","--format=","--name-only","HEAD~1","--",":/",":(exclude,literal)src/greet.ts"] exited 0',
    'pass ["git","show","--format=","--name-only","HEAD","--",":/",":(exclude,literal)README.md"] exited 0',
    'pass ["git","status","--porcelain","--",":(literal)src/greet.ts",":(literal)README.md"] exited 0',
  ])
  expect(checkpoint(h, runId).nodes.find(current => current.id === 'commit')?.verification?.evidence.map(item => item.detail.split('\n')[1])).toEqual([FEAT_SUBJECT, DOCS_SUBJECT, '', '', ''])
  expect(gitCalls(h)).toEqual([
    ['git', 'log', '-1', '--skip=1', '--format=%s'],
    ['git', 'log', '-1', '--skip=0', '--format=%s'],
    ['git', 'show', '--format=', '--name-only', 'HEAD~1', '--', ':/', ':(exclude,literal)src/greet.ts'],
    ['git', 'show', '--format=', '--name-only', 'HEAD', '--', ':/', ':(exclude,literal)README.md'],
    ['git', 'status', '--porcelain', '--', ':(literal)src/greet.ts', ':(literal)README.md'],
  ])

  const saved = checkpoint(h, runId)
  expect(saved.status).toBe('completed')
  expect(states(h, runId)).toEqual(['code:completed', 'docs:completed', 'review-spec:completed', 'review-standards:completed', 'commit:completed'])
  // The run keeps what the user wrote, not the expansion's text, so an amend sends the original fields.
  expect(saved.definition).toMatchObject({ review: { request: GREET_REQUEST, notes: '/tmp/dag-review/greet-5d65d5', category: 'unspecified-low' }, commit: [{ paths: ['src/greet.ts'] }, { paths: ['README.md'] }] })
  expect(pluginNews(h).map(submit => submit.text.split('\n')[0])).toEqual([`DAG run "Greet" (${runId}) settled: completed.`])
  expect(h.spawns).toHaveLength(5)
})

test('scenario 10, stages: a reviewer whose notes end with a FAIL verdict fails its node, the commit is skipped, and nothing is committed', { ...NO_RECOVERY, plugins: [GIT] }, async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = await start($, greetFlow('greet-fail'))
  h.files.set('/work/src/greet.ts', 'export function greet(name: string) {\n  return `hello ${name}`\n}\n')
  h.files.set('/work/README.md', '# app\n\nCall greet(name) to say hello.\n')
  await finish($, h, 'agent-1')
  await finish($, h, 'agent-2')
  expect(h.spawns.map(spawn => spawn.description).slice(2)).toEqual(['Greet: Review: spec axis', 'Greet: Review: standards axis'])
  expect(h.spawns[2]?.prompt).toContain('/tmp/dag-review/greet-fail-b43ef9/review-spec-notes.md')

  // The standards reviewer passes. The spec reviewer found a gap, wrote the PASS line once above its findings, and ended on FAIL.
  h.files.set('/tmp/dag-review/greet-fail-b43ef9/review-standards-notes.md', standardsNotes('Standards verdict: PASS'))
  await finish($, h, 'agent-4')
  expect(states(h, runId).slice(2)).toEqual(['review-spec:running', 'review-standards:completed', 'commit:pending'])
  h.files.set('/tmp/dag-review/greet-fail-b43ef9/review-spec-notes.md',
    specNotes('Spec verdict: FAIL', '(a) the README documents greet(name) but never says what it returns\n(b) none\n(c) none\nSpec verdict: PASS (earlier draft)'))
  await finish($, h, 'agent-3')

  const failed = checkpoint(h, runId)
  expect(failed.status).toBe('failed')
  expect(states(h, runId)).toEqual(['code:completed', 'docs:completed', 'review-spec:failed', 'review-standards:completed', 'commit:skipped'])
  // The Findings section was there; the last line was not the PASS line.
  expect(stageEvidence(h, runId, 'review-spec')).toEqual([
    expect.stringMatching(/^FAIL .*review-spec-notes\.md: lastLine expected "Spec verdict: PASS", got "Spec verdict: FAIL"/),
    'pass File verified: /tmp/dag-review/greet-fail-b43ef9/review-spec-notes.md',
  ])
  expect(failed.nodes.find(current => current.id === 'review-spec')?.error).toContain('Spec verdict: FAIL')
  expect(h.spawns).toHaveLength(4)
  expect(gitCalls(h)).toEqual([])
  expect(evidenceFiles(h, runId, 'commit')).toEqual([])
  expect(pluginNews(h).map(submit => submit.text.split('\n')[0])).toEqual([`DAG run "Greet" (${runId}) settled: failed.`])
  expect(pluginNews(h)[0]?.text).toContain('- review-spec: failed')
  expect(pluginNews(h)[0]?.text).toContain('- commit: skipped')
})

// The harness answers every `rm` with exit 0 and leaves its files alone, which would hide a missing removal. This makes
// `rm <path>` delete the harness file as the real program does. It wraps the harness's capture array, which the harness fills
// as the host events arrive; the test kit locks Array.prototype, so the wrapper goes in with defineProperty, not by assignment.
function removesFiles(h: Harness): void {
  const push = h.processes.push.bind(h.processes)
  Object.defineProperty(h.processes, 'push', {
    value: (...runs: Harness['processes']) => {
      for (const run of runs) if (run.argv[0] === 'rm') h.files.delete(run.argv.at(-1) ?? '')
      return push(...runs)
    },
  })
}

test('scenario 10, stages: a PASS verdict an earlier run left in the reviewers\' notes folder is gone before they start, so a reviewer that writes nothing fails, the commit is skipped, and nothing is committed', { ...NO_RECOVERY, plugins: [GIT] }, async ($, on) => {
  const h = harness(on)
  removesFiles(h)
  await boot($)
  // The default folder is shared by every run that uses the key: an earlier run left complete, passing notes for both reviewers.
  const notes = '/tmp/dag-review/greet-stale-11a930'
  h.files.set(`${notes}/review-spec-notes.md`, specNotes('Spec verdict: PASS', '(a) none\n(b) none\n(c) none'))
  h.files.set(`${notes}/review-standards-notes.md`, standardsNotes('Standards verdict: PASS'))
  const runId = await start($, greetFlow('greet-stale'))
  expect(h.files.has(`${notes}/review-spec-notes.md`)).toBe(true)
  h.files.set('/work/src/greet.ts', 'export function greet(name: string) {\n  return `hello ${name}`\n}\n')
  h.files.set('/work/README.md', '# app\n\nCall greet(name) to say hello.\n')
  await finish($, h, 'agent-1')
  await finish($, h, 'agent-2')

  // Both reviewers started and neither has written yet, so no verdict file stands in the folder.
  expect(h.spawns.map(spawn => spawn.description).slice(2)).toEqual(['Greet: Review: spec axis', 'Greet: Review: standards axis'])
  expect(h.spawns[2]?.prompt).toContain(`${notes}/review-spec-notes.md`)
  expect([...h.files.keys()].filter(path => path.startsWith(`${notes}/`))).toEqual([])

  // The standards reviewer does its work and writes fresh notes. The spec reviewer ends its turn with nothing written.
  h.files.set(`${notes}/review-standards-notes.md`, standardsNotes('Standards verdict: PASS'))
  await finish($, h, 'agent-4')
  expect(states(h, runId).slice(2)).toEqual(['review-spec:running', 'review-standards:completed', 'commit:pending'])
  await finish($, h, 'agent-3')

  const failed = checkpoint(h, runId)
  expect(failed.status).toBe('failed')
  expect(states(h, runId)).toEqual(['code:completed', 'docs:completed', 'review-spec:failed', 'review-standards:completed', 'commit:skipped'])
  expect(stageEvidence(h, runId, 'review-spec')).toEqual([
    expect.stringMatching(/^FAIL .*review-spec-notes\.md/),
    expect.stringMatching(/^FAIL .*review-spec-notes\.md/),
  ])
  expect(h.spawns).toHaveLength(4)
  expect(gitCalls(h)).toEqual([])
  expect(evidenceFiles(h, runId, 'commit')).toEqual([])
  expect(pluginNews(h).map(submit => submit.text.split('\n')[0])).toEqual([`DAG run "Greet" (${runId}) settled: failed.`])
  expect(pluginNews(h)[0]?.text).toContain('- review-spec: failed')
  expect(pluginNews(h)[0]?.text).toContain('- commit: skipped')
})

test('scenario 10, stages: a commit that also swept in a file outside its own paths fails the commit node and names the file, while the clean commit beside it passes its check', { ...NO_RECOVERY, plugins: [GIT] }, async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = await start($, greetFlow('greet-sweep'))
  const notes = '/tmp/dag-review/greet-sweep-098ce3'
  h.files.set('/work/src/greet.ts', 'export function greet(name: string) {\n  return `hello ${name}`\n}\n')
  h.files.set('/work/README.md', '# app\n\nCall greet(name) to say hello.\n')
  await finish($, h, 'agent-1')
  await finish($, h, 'agent-2')
  h.files.set(`${notes}/review-spec-notes.md`, specNotes('Spec verdict: PASS', '(a) none\n(b) none\n(c) none'))
  h.files.set(`${notes}/review-standards-notes.md`, standardsNotes('Standards verdict: PASS'))
  await finish($, h, 'agent-3')
  await finish($, h, 'agent-4')
  expect(h.spawns.map(spawn => spawn.description).slice(4)).toEqual(['Greet: Commit'])

  // Both subjects are right and the listed paths are committed, but the first commit was made with an unrelated edit staged:
  // it holds src/scratch.ts as well as src/greet.ts. The second commit holds only README.md.
  h.files.set('/repo/log', `${DOCS_SUBJECT}\n${FEAT_SUBJECT}\n`)
  h.files.set('/repo/changed', 'HEAD~1 src/greet.ts\nHEAD~1 src/scratch.ts\nHEAD README.md\n')
  await finish($, h, 'agent-5')

  const failed = checkpoint(h, runId)
  expect(failed.status).toBe('failed')
  expect(states(h, runId)).toEqual(['code:completed', 'docs:completed', 'review-spec:completed', 'review-standards:completed', 'commit:failed'])
  expect(stageEvidence(h, runId, 'commit')).toEqual([
    'pass ["git","log","-1","--skip=1","--format=%s"] exited 0',
    'pass ["git","log","-1","--skip=0","--format=%s"] exited 0',
    'FAIL stdout: equals expected "", got "src/scratch.ts"',
    'pass ["git","show","--format=","--name-only","HEAD","--",":/",":(exclude,literal)README.md"] exited 0',
    'pass ["git","status","--porcelain","--",":(literal)src/greet.ts",":(literal)README.md"] exited 0',
  ])
  // The node's error names the check of the first commit and the file it swept in.
  expect(failed.nodes.find(current => current.id === 'commit')?.error).toContain('"HEAD~1","--",":/",":(exclude,literal)src/greet.ts"] exited 0\nsrc/scratch.ts')
  expect(pluginNews(h).map(submit => submit.text.split('\n')[0])).toEqual([`DAG run "Greet" (${runId}) settled: failed.`])
  expect(pluginNews(h)[0]?.text).toContain('- commit: failed')
})

// A Next.js bracket route and a one-character sibling: git reads a bare pathspec as a pattern, so `app/[id]/page.ts` also names
// `app/i/page.ts`, and a worker running plain `git add -- app/[id]/page.ts` stages both. The sibling is unrelated work the
// commit must not hold. The checks name the listed path literally, so the sweep finds the sibling, and a worker that committed
// only the listed path is not failed for it.
const ROUTE = 'app/[id]/page.ts'
const SIBLING = 'app/i/page.ts'
const ROUTE_SUBJECT = 'feat: add the id route'
const ROUTE_REQUEST = 'Add the id route page'

function routeFlow(key: string) {
  return {
    key,
    name: 'Route',
    goal: `The id route page exists in ${ROUTE}`,
    nodes: [{ id: 'page', prompt: contract(`Write ${ROUTE}`), writes: [ROUTE], verify: [{ kind: 'file', path: ROUTE, contains: 'export default' }] }],
    review: { request: ROUTE_REQUEST },
    commit: [{ message: ROUTE_SUBJECT, paths: [ROUTE] }],
  }
}

// Runs the route flow until its commit worker is the live agent: the page is written and both reviewers passed.
async function routeToCommit($: Engine, h: Harness, key: string, notes: string): Promise<string> {
  const runId = await start($, routeFlow(key))
  h.files.set(`/work/${ROUTE}`, 'export default function Page() {\n  return null\n}\n')
  await finish($, h, 'agent-1')
  h.files.set(`${notes}/review-spec-notes.md`, specNotes('Spec verdict: PASS', '(a) none\n(b) none\n(c) none').replaceAll(GREET_REQUEST, ROUTE_REQUEST))
  h.files.set(`${notes}/review-standards-notes.md`, standardsNotes('Standards verdict: PASS'))
  await finish($, h, 'agent-2')
  await finish($, h, 'agent-3')
  expect(h.spawns.map(spawn => spawn.description)).toEqual(['Route: page', 'Route: Review: spec axis', 'Route: Review: standards axis', 'Route: Commit'])
  return runId
}

test('scenario 10, stages: a bracket path commit that also took its one-character sibling fails the commit node and names the sibling, and the worker is told to use literal pathspecs', { ...NO_RECOVERY, plugins: [GIT] }, async ($, on) => {
  const h = harness(on)
  await boot($)
  const notes = '/tmp/dag-review/route-sibling-b3e05d'
  const runId = await routeToCommit($, h, 'route-sibling', notes)

  // The worker is told to read the path as a name, quoted for the shell.
  const commitPrompt = h.spawns[3]?.prompt ?? ''
  expect(commitPrompt).toContain(`Commit 1 of 1\n  paths: '${ROUTE}'\n  subject: ${ROUTE_SUBJECT}`)
  expect(commitPrompt).toContain('`git --literal-pathspecs add -- <its paths>`')
  expect(commitPrompt).toContain(`\`git --literal-pathspecs status --porcelain -- '${ROUTE}'\` prints nothing`)

  // The subject is right and the page is committed, but the commit was made without --literal-pathspecs: it holds the sibling too.
  h.files.set('/repo/log', `${ROUTE_SUBJECT}\n`)
  h.files.set('/repo/changed', `HEAD ${ROUTE}\nHEAD ${SIBLING}\n`)
  await finish($, h, 'agent-4')

  const failed = checkpoint(h, runId)
  expect(failed.status).toBe('failed')
  expect(states(h, runId)).toEqual(['page:completed', 'review-spec:completed', 'review-standards:completed', 'commit:failed'])
  expect(stageEvidence(h, runId, 'commit')).toEqual([
    'pass ["git","log","-1","--skip=0","--format=%s"] exited 0',
    `FAIL stdout: equals expected "", got "${SIBLING}"`,
    `pass ["git","status","--porcelain","--",":(literal)${ROUTE}"] exited 0`,
  ])
  expect(failed.nodes.find(current => current.id === 'commit')?.error).toContain(`"HEAD","--",":/",":(exclude,literal)${ROUTE}"] exited 0\n${SIBLING}`)
  expect(pluginNews(h)[0]?.text).toContain('- commit: failed')
})

test('scenario 10, stages: a bracket path commit that holds only the listed path passes, so a literal-minded worker is not failed for its own path', { ...NO_RECOVERY, plugins: [GIT] }, async ($, on) => {
  const h = harness(on)
  await boot($)
  const notes = '/tmp/dag-review/route-literal-394225'
  const runId = await routeToCommit($, h, 'route-literal', notes)

  h.files.set('/repo/log', `${ROUTE_SUBJECT}\n`)
  h.files.set('/repo/changed', `HEAD ${ROUTE}\n`)
  await finish($, h, 'agent-4')

  expect(checkpoint(h, runId).status).toBe('completed')
  expect(stageEvidence(h, runId, 'commit')).toEqual([
    'pass ["git","log","-1","--skip=0","--format=%s"] exited 0',
    `pass ["git","show","--format=","--name-only","HEAD","--",":/",":(exclude,literal)${ROUTE}"] exited 0`,
    `pass ["git","status","--porcelain","--",":(literal)${ROUTE}"] exited 0`,
  ])
  expect(gitCalls(h)).toEqual([
    ['git', 'log', '-1', '--skip=0', '--format=%s'],
    ['git', 'show', '--format=', '--name-only', 'HEAD', '--', ':/', `:(exclude,literal)${ROUTE}`],
    ['git', 'status', '--porcelain', '--', `:(literal)${ROUTE}`],
  ])
})

// ---------------------------------------------------------------------------------------------------------------------
// 11. Background work and the wait for the worker's next turn

// A node agent that launched a command in the background and ended its turn has not finished: the command's notification
// starts its next turn. The eval below writes out/eval.log when it is done, so a verification that ran at the first turn
// end would find no log and fail the node: only a wait for the next turn lets the node pass.
const BACKGROUND_THIRTY_MINUTES = 30 * 60_000
const EVAL_LOG = 'out/eval.log'
const WAITING_ANSWER = 'The eval runs in the background; I will report when it finishes.'
const FINAL_ANSWER = 'The eval passed.\nDAG_NODE_STATUS: completed'

function evalFlow(key: string) {
  return {
    key,
    name: 'Eval',
    goal: 'The eval suite passes and its result is reported',
    nodes: [
      { id: 'eval', prompt: contract('Run the eval suite'), writes: [EVAL_LOG], verify: [{ kind: 'file', path: EVAL_LOG, lastLine: 'EVAL OK' }] },
      { id: 'lint', prompt: contract('Lint the sources'), verify: CHECK },
      { id: 'report', prompt: contract('Report the eval result'), dependsOn: ['eval'], verify: CHECK },
    ],
  }
}

// What the host reports for a tool call a node agent makes.
async function workerRuns($: Engine, agentId: string, call: Record<string, unknown>): Promise<void> {
  await $.tool.call({ ...call, agentId, tool_use_id: `call-${agentId}` } as never)
}

// A worker's turn ends with this answer (the harness `finish` always answers with the status line).
async function turnEnds($: Engine, h: Harness, agentId: string, answer: string, turn: number): Promise<void> {
  await $.turn.complete({ turnId: `turn-${agentId}-${turn}`, agentId, reason: 'answer', isAborted: false, answer, durationMs: 1 })
  await h.clock.settle()
}

// The host starts the worker's next turn: its first step goes through turn.step.
async function nextTurnStarts($: Engine, agentId: string, turn: number): Promise<void> {
  const stream = ($.turn.step as (e: object) => AsyncGenerator)({ turnId: `turn-${agentId}-${turn}`, index: 0, model: 'claude-test', messageCount: 3, agentId })
  for (let step = await stream.next(); step.done !== true; step = await stream.next());
}

// The stop the plugin sends a worker it gives up on goes through tool.call as TaskStop; this records which agents got one.
const STOPS: Plugin = {
  name: 'scenario-stops',
  register(on) {
    on('tool.call', async ($, e, next) => {
      const call = e as unknown as { tool: string; task_id?: string }
      if (call.tool === 'TaskStop') await $.fs.write(`/stopped/${call.task_id}`, 'stopped')
      return next(e)
    })
  },
}

const stopped = (h: Harness): string[] => [...h.files.keys()].filter(path => path.startsWith('/stopped/')).sort()

test('scenario 11, background wait: a node that backgrounded its work and ended its turn without a status line is not verified early, its dependents wait, and the next turn completes it', { ...NO_RECOVERY, plugins: [STOPS] }, async ($, on) => {
  const h = harness(on)
  on('turn.step', async function* ($: unknown, e: { turnId: string; index: number }) {
    yield { kind: 'text', index: 0, text: 'the eval finished' }
    return { turnId: e.turnId, index: e.index, answer: 'the eval finished', toolUses: [], stopReason: 'end_turn', usage: null }
  } as never)
  await boot($)
  const runId = await start($, evalFlow('eval'))
  expect(h.spawns.map(spawn => spawn.description)).toEqual(['Eval: eval', 'Eval: lint'])

  await workerRuns($, 'agent-1', { tool: 'Bash', command: 'bun eval/run.ts > out/eval.log', run_in_background: true })
  await turnEnds($, h, 'agent-1', WAITING_ANSWER, 1)

  // The turn ended without a status line, so the node stays running and nothing was verified: the log does not exist yet.
  expect(states(h, runId)).toEqual(['eval:running', 'lint:running', 'report:pending'])
  expect(checkpoint(h, runId).nodes[0]).toMatchObject({ state: 'running', agentId: 'agent-1' })
  expect(evidenceFiles(h, runId, 'eval')).toEqual([])
  expect(h.logs).toContain('Eval › eval: waiting on background work')
  expect(h.spawns).toHaveLength(2)
  expect(pluginNews(h)).toEqual([])

  // A sibling finishes meanwhile; the dependent of the waiting node still does not start, and the run is not settled.
  await finish($, h, 'agent-2')
  expect(states(h, runId)).toEqual(['eval:running', 'lint:completed', 'report:pending'])
  expect(checkpoint(h, runId).status).toBe('running')
  await h.clock.advance(20 * 60_000)
  expect(states(h, runId)).toEqual(['eval:running', 'lint:completed', 'report:pending'])
  expect(h.spawns).toHaveLength(2)

  // The background command finishes and its notification starts the agent's next turn. That turn runs on past the 30
  // minutes counted from the first turn's end without failing the node, and it ends reporting completed.
  h.files.set(`/work/${EVAL_LOG}`, 'running 40 cases\nEVAL OK\n')
  await nextTurnStarts($, 'agent-1', 2)
  await h.clock.advance(15 * 60_000)
  expect(states(h, runId)).toEqual(['eval:running', 'lint:completed', 'report:pending'])
  expect(evidenceFiles(h, runId, 'eval')).toEqual([])
  await turnEnds($, h, 'agent-1', FINAL_ANSWER, 2)
  expect(states(h, runId)).toEqual(['eval:completed', 'lint:completed', 'report:running'])
  expect(evidenceFiles(h, runId, 'eval')).toEqual([{ status: 'passed', failed: [] }])
  expect(checkpoint(h, runId).nodes[0]?.verification?.evidence[0]?.detail).toBe(`File verified: ${EVAL_LOG}`)
  // The node's report is its last turn's answer, not the waiting note.
  expect(h.files.get(`${ROOT}/runs/${runId}/eval.md`)).toContain('The eval passed.')
  expect(h.files.get(`${ROOT}/runs/${runId}/eval.md`)).not.toContain('I will report')
  expect(h.spawns.map(spawn => spawn.description)).toEqual(['Eval: eval', 'Eval: lint', 'Eval: report'])
  expect(h.spawns[2]?.prompt).toContain('<result node="eval"')

  await finish($, h, 'agent-3')
  expect(checkpoint(h, runId).status).toBe('completed')
  expect(states(h, runId)).toEqual(['eval:completed', 'lint:completed', 'report:completed'])
  expect(pluginNews(h).map(submit => submit.text.split('\n')[0])).toEqual([`DAG run "Eval" (${runId}) settled: completed.`])

  // The wait ended with the turn: the minutes after it change nothing and stop nobody.
  await h.clock.advance(BACKGROUND_THIRTY_MINUTES)
  expect(states(h, runId)).toEqual(['eval:completed', 'lint:completed', 'report:completed'])
  expect(stopped(h)).toEqual([])
  expect(h.spawns).toHaveLength(3)
})

test('scenario 11, background wait: with no next turn the node fails after 30 minutes on the clock, its agent is stopped, dependents are skipped and a late turn end changes nothing', { ...NO_RECOVERY, plugins: [STOPS] }, async ($, on) => {
  const h = harness(on)
  await boot($)
  const runId = await start($, evalFlow('eval-stalled'))
  await finish($, h, 'agent-2')
  await workerRuns($, 'agent-1', { tool: 'Bash', command: 'bun eval/run.ts > out/eval.log', run_in_background: true })
  await turnEnds($, h, 'agent-1', WAITING_ANSWER, 1)
  expect(states(h, runId)).toEqual(['eval:running', 'lint:completed', 'report:pending'])

  await h.clock.advance(BACKGROUND_THIRTY_MINUTES - 1_000)
  expect(states(h, runId)).toEqual(['eval:running', 'lint:completed', 'report:pending'])
  expect(stopped(h)).toEqual([])
  await h.clock.advance(1_000)
  await h.clock.settle()

  const failed = checkpoint(h, runId)
  expect(failed.status).toBe('failed')
  expect(states(h, runId)).toEqual(['eval:failed', 'lint:completed', 'report:skipped'])
  expect(failed.nodes[0]?.error).toBe('The node agent ended its turn with background work pending and was not resumed within 30 minutes.')
  // It was never verified (no log was ever written), its worker was stopped, and its last answer is kept as the report.
  expect(evidenceFiles(h, runId, 'eval')).toEqual([])
  expect(stopped(h)).toEqual(['/stopped/agent-1'])
  expect(h.files.get(`${ROOT}/runs/${runId}/eval.md`)).toBe(WAITING_ANSWER)
  expect(h.spawns).toHaveLength(2)
  expect(pluginNews(h).map(submit => submit.text.split('\n')[0])).toEqual([`DAG run "Eval" (${runId}) settled: failed.`])
  expect(pluginNews(h)[0]?.text).toContain('- eval: failed (The node agent ended its turn with background work pending and was not resumed within 30 minutes.)')

  // The agent's turn end arrives late: the node stays failed and the dependent stays skipped.
  h.files.set(`/work/${EVAL_LOG}`, 'EVAL OK\n')
  await turnEnds($, h, 'agent-1', FINAL_ANSWER, 2)
  expect(states(h, runId)).toEqual(['eval:failed', 'lint:completed', 'report:skipped'])
  expect(h.spawns).toHaveLength(2)
  expect(pluginNews(h)).toHaveLength(1)
})

// ---------------------------------------------------------------------------------------------------------------------
// 12. A run the user rejected

const BUMP = { key: 'bump', name: 'Bump', goal: 'The version is bumped and the changelog says so', nodes: [node('version'), node('changelog'), node('verify-bump', ['version', 'changelog'])] }
const BUMP_NARROW = { key: 'bump-narrow', name: 'Bump narrow', goal: 'The version is bumped', nodes: [node('version'), node('verify-version', ['version'])] }

test('scenario 12, rejection: after the user rejects a held run the model\'s retry, amend and identical start are refused and spawn nothing, a revised definition under a new key is held again and can be approved, and only the person\'s own retry runs the rejected plan', { options: { auto_recovery: false, start_approval: 'always' } }, async ($, on) => {
  const h = harness(on)
  await boot($)
  const held = await modelStart($, BUMP)
  expect(held).toMatchObject({ reused: false, awaiting_approval: true })
  expect(h.spawns).toHaveLength(0)

  await command($, `reject ${held.run_id} too broad, bump only`)
  await h.clock.settle()
  const rejectedRun = checkpoint(h, held.run_id)
  expect(rejectedRun).toMatchObject({ status: 'cancelled', cancelReason: 'Rejected by the user: too broad, bump only', rejected: { reason: 'too broad, bump only' } })
  expect(states(h, held.run_id)).toEqual(['version:cancelled', 'changelog:cancelled', 'verify-bump:cancelled'])
  const promptsBefore = h.prompts.length
  expect(promptsBefore).toBe(1)

  // The model tries to get its plan through anyway: every route to run the rejected plan again is refused, naming the
  // run, the user's reason and what to do instead, and none of them starts a worker or touches the run.
  const refusal = {
    error: {
      code: 'rejected_by_user',
      message: `The user rejected run ${held.run_id} ("Bump"): too broad, bump only. Do not retry, amend or restart it. Revise the plan to answer the rejection, give the revised definition a new key, and ask the user before running it again.`,
    },
  }
  expect(await dag($, { action: 'retry', run_id: held.run_id })).toEqual(refusal)
  expect(await dag($, { action: 'retry', run_id: held.run_id, node_ids: ['version'], prompt: contract('Bump the version, smaller') })).toEqual(refusal)
  expect(await dag($, { action: 'amend', run_id: held.run_id, definition: BUMP_NARROW })).toEqual(refusal)
  expect(await dag($, { action: 'amend', run_id: held.run_id, definition: BUMP })).toEqual(refusal)
  expect(await dag($, { action: 'start', definition: BUMP })).toEqual(refusal)
  // Another plan under the rejected key is no way around it either.
  expect(await dag($, { action: 'start', definition: { ...BUMP, nodes: [node('version')] } })).toMatchObject({ error: { code: 'definition_conflict' } })
  await h.clock.settle()
  expect(h.spawns).toHaveLength(0)
  expect(checkpoint(h, held.run_id)).toEqual(rejectedRun)
  expect(h.prompts).toHaveLength(promptsBefore)

  // A reload keeps the rejection: it is in the checkpoint.
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await h.clock.settle()
  expect(await dag($, { action: 'retry', run_id: held.run_id })).toEqual(refusal)
  expect(await dag($, { action: 'start', definition: BUMP })).toEqual(refusal)
  expect(h.spawns).toHaveLength(0)

  // The revised plan answers the rejection with a new key: it is held for approval like any model start, then approved.
  const narrow = await modelStart($, BUMP_NARROW)
  expect(narrow).toMatchObject({ reused: false, awaiting_approval: true })
  expect(narrow.run_id).not.toBe(held.run_id)
  expect(h.spawns).toHaveLength(0)
  expect(states(h, narrow.run_id)).toEqual(['version:scheduled', 'verify-version:pending'])
  expect(checkpoint(h, narrow.run_id).rejected).toBeUndefined()

  await command($, `approve ${narrow.run_id}`)
  await h.clock.settle()
  expect(h.spawns.map(spawn => spawn.description)).toEqual(['Bump narrow: version'])
  await finish($, h, 'agent-1')
  await finish($, h, 'agent-2')
  expect(h.spawns.map(spawn => spawn.description)).toEqual(['Bump narrow: version', 'Bump narrow: verify-version'])
  expect(checkpoint(h, narrow.run_id).status).toBe('completed')
  expect(checkpoint(h, held.run_id)).toEqual(rejectedRun)
  expect(h.prompts.filter(text => text.includes(narrow.run_id)).map(text => text.split('\n')[0])).toEqual([
    `DAG run "Bump narrow" (${narrow.run_id}) was approved by the user and has started.`,
    `DAG run "Bump narrow" (${narrow.run_id}) settled: completed.`,
  ])

  // Only the person can overrule their own rejection: their /dag retry runs the first plan after all.
  await command($, `retry ${held.run_id}`)
  await h.clock.settle()
  expect(h.spawns.map(spawn => spawn.description).slice(2)).toEqual(['Bump: version', 'Bump: changelog'])
  expect(checkpoint(h, held.run_id).rejected).toBeUndefined()
})
