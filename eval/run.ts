import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import type { Run } from '../hooks/engine/types.ts'
import { SCENARIOS, type Scenario } from './scenarios.ts'
import { scenarioMatched, summarizeRepeats, transcriptCounts, verificationOf, type NodeVerificationReport, type TranscriptCounts, type VerificationTotals } from './report.ts'
import { parseArgs, USAGE, type Options } from './options.ts'
import { shapeOf, type ShapeMetrics } from './shape.ts'

const REPO = realpathSync(new URL('..', import.meta.url).pathname)
const MAIN_TOOLS = ['mcp__dag-workflow__dag', 'Skill', 'Read', 'Write', 'Edit', 'Bash', 'TaskStop', 'ToolSearch', 'LSP']

// The plugin's userConfig lives in settings.json pluginConfigs under its name; a --plugin-dir copy may load as <name>@inline.
// Since the default became auto (2026-10-11), Jev runs small scenarios directly, so a run measured against a baseline taken
// under strict passes --enforcement strict to force the same DAG path.
const PLUGIN_KEYS = ['dag-workflow', 'dag-workflow@inline']

function settingsArgs(options: Options): string[] {
  if (!options.enforcement) return []
  const pluginConfigs = Object.fromEntries(PLUGIN_KEYS.map(key => [key, { options: { enforcement: options.enforcement } }]))
  return ['--settings', JSON.stringify({ pluginConfigs })]
}

type RunReport = ShapeMetrics & {
  runId: string
  status: string
  states: Record<string, number>
  nodeStates: { id: string; state: string; error?: string }[]
  nodeVerification: NodeVerificationReport[]
  verificationTotals: VerificationTotals
}

type TranscriptReport = TranscriptCounts & { path?: string }

const NO_TRANSCRIPT: TranscriptReport = transcriptCounts([])

type ScenarioResult = {
  id: string
  repeat: number
  expect: string
  exitCode: number | null
  timedOut: boolean
  seconds: number
  runs: RunReport[]
  transcript: TranscriptReport
  check: { passed: boolean; output: string }
  unchangedOk: boolean
  stdoutTail: string
}

async function readRuns(dir: string): Promise<Run[]> {
  const runsDir = `${dir}/.claude/dag/runs`
  const found: Run[] = []
  try {
    for await (const name of new Bun.Glob('*.json').scan({ cwd: runsDir })) found.push(JSON.parse(await Bun.file(`${runsDir}/${name}`).text()) as Run)
  } catch {
    return []
  }
  return found.sort((a, b) => a.createdAt - b.createdAt)
}

async function readTranscript(dir: string): Promise<TranscriptReport> {
  const projectDir = `${homedir()}/.claude/projects/${realpathSync(dir).replace(/[/.]/g, '-')}`
  const files: { path: string; mtime: number }[] = []
  try {
    for await (const name of new Bun.Glob('*.jsonl').scan({ cwd: projectDir })) {
      const path = `${projectDir}/${name}`
      files.push({ path, mtime: (await Bun.file(path).stat()).mtimeMs })
    }
  } catch {
    return NO_TRANSCRIPT
  }
  const newest = files.sort((a, b) => b.mtime - a.mtime)[0]
  if (!newest) return NO_TRANSCRIPT
  return { path: newest.path, ...transcriptCounts((await Bun.file(newest.path).text()).split('\n')) }
}

async function runScenario(scenario: Scenario, repeat: number, root: string, options: Options): Promise<ScenarioResult> {
  const name = options.repeat > 1 ? `${scenario.id}-${repeat}` : scenario.id
  const dir = `${root}/${name}`
  await Bun.$`mkdir -p ${dir}`.quiet()
  for (const [path, content] of Object.entries(scenario.files)) await Bun.write(`${dir}/${path}`, content)
  // The generated review nodes read the change through git (rev-parse, status, diff), and on 2026-10-10 none of the 8 planners added a review pair on the non-git fixtures (eval/baselines/stages-baseline.md).
  // No nothrow: a failed git step rejects the pool, so the whole run stops before any results file is written; --allow-empty because pipeline-stats, diamond-app and research-write start with no files.
  await Bun.$`git init -q`.cwd(dir).quiet()
  await Bun.$`git add -A`.cwd(dir).quiet()
  await Bun.$`git -c user.name=dag-eval -c user.email=dag-eval@example.invalid -c commit.gpgsign=false commit -q --allow-empty -m fixture`.cwd(dir).quiet()
  const started = Date.now()
  const proc = Bun.spawn(['claude', '-p', scenario.prompt, '--plugin-dir', REPO, '--model', options.model, ...settingsArgs(options), '--allowedTools', ...MAIN_TOOLS], {
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, options.timeoutMin * 60_000)
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const exitCode = await proc.exited
  clearTimeout(timer)
  await Bun.write(`${root}/${name}.out.txt`, `${stdout}\n--- stderr ---\n${stderr}`)

  const runs = (await readRuns(dir)).map(run => {
    const states: Record<string, number> = {}
    for (const node of run.nodes) states[node.state] = (states[node.state] ?? 0) + 1
    const nodeStates = run.nodes.map(node => ({ id: node.id, state: node.state, ...(node.error ? { error: node.error } : {}) }))
    const verification = verificationOf(run)
    return { runId: run.runId, status: run.status, states, nodeStates, nodeVerification: verification.nodes, verificationTotals: verification.totals, ...shapeOf(run.definition) }
  })
  const checked = await Bun.$`sh -c ${scenario.check}`.cwd(dir).nothrow().quiet()
  const unchangedOk = await (async () => {
    for (const path of scenario.unchanged ?? []) {
      if ((await Bun.file(`${dir}/${path}`).text()) !== scenario.files[path]) return false
    }
    return true
  })()
  return {
    id: scenario.id,
    repeat,
    expect: scenario.expect,
    exitCode,
    timedOut,
    seconds: Math.round((Date.now() - started) / 1000),
    runs,
    transcript: await readTranscript(dir),
    check: { passed: checked.exitCode === 0, output: `${checked.stdout}${checked.stderr}`.trim().slice(0, 400) },
    unchangedOk,
    stdoutTail: stdout.trim().slice(-300),
  }
}

async function pool<T, R>(items: T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await work(items[i] as T)
    }
  })
  await Promise.all(workers)
  return results
}

function acrossRepeats(results: ScenarioResult[], matched: (r: ScenarioResult) => boolean): string[] {
  const summaries = summarizeRepeats(results.map(r => ({ id: r.id, matched: matched(r), shape: r.runs.map(run => run.shape).join('; ') || 'no run', seconds: r.seconds })))
  return [
    '## Across repeats',
    '',
    '| scenario | matched/samples | shapes seen | seconds (min-median-max) |',
    '| --- | --- | --- | --- |',
    ...summaries.map(s => `| ${s.id} | ${s.matched}/${s.samples} | ${s.shapes.join(', ')} | ${s.minSeconds}-${s.medianSeconds}-${s.maxSeconds} |`),
    '',
  ]
}

function markdown(results: ScenarioResult[], stamp: string, options: Options): string {
  const shapes = new Set(results.flatMap(r => r.runs.map(run => run.shape)))
  const producerShapes = new Set(results.flatMap(r => r.runs.map(run => run.producerShape)))
  const matched = (r: ScenarioResult) => scenarioMatched(r.expect, r.runs, options.enforcement)
  const matches = results.filter(matched).length
  const rows = results.map(r => {
    const main = r.runs[0]
    const shape = r.runs.map(run => `${run.shape} (producers: ${run.producerShape})`).join('; ') || 'no run'
    const widths = r.runs.map(run => run.widths.join('-')).join('; ')
    const categories = r.runs.map(run => Object.entries(run.categories).map(([k, v]) => `${k}x${v}`).join(' ')).join('; ')
    const status = r.runs.map(run => run.status).join('; ') || (r.timedOut ? 'timed out' : `exit ${r.exitCode}`)
    const problems = r.runs
      .flatMap(run => run.nodeStates.filter(n => n.state !== 'completed'))
      .map(n => `${n.id}:${n.state}${n.error ? ` (${n.error.slice(0, 60)})` : ''}`)
      .join('; ')
    const totals = r.runs.reduce((sum, run) => ({ verified: sum.verified + run.verificationTotals.verifiedNodes, nodes: sum.nodes + run.nodeVerification.length, retries: sum.retries + run.verificationTotals.autoRetries }), { verified: 0, nodes: 0, retries: 0 })
    return `| ${options.repeat > 1 ? `${r.id} #${r.repeat}` : r.id} | ${r.expect} | ${r.runs.length} | ${shape} | ${main?.nodes ?? '-'} | ${main?.depth ?? '-'} | ${widths || '-'} | ${main?.fanInNodes ?? '-'} | ${main?.verify ?? '-'} | ${main?.warnings ?? '-'} | ${categories || '-'} | ${status} | ${r.check.passed && r.unchangedOk ? 'PASS' : 'FAIL'} | ${r.transcript.skillBeforeStart} | ${r.transcript.planningRefusals}/${r.transcript.toolDenials} | ${r.transcript.denials.map(d => `${d.tool}: ${d.reason} x${d.count}`).join('; ') || '-'} | ${r.transcript.askUserQuestions} | ${r.transcript.verificationRequired}/${r.transcript.invalidVerification} | ${totals.verified}/${totals.nodes} | ${totals.retries} | ${problems || '-'} | ${r.seconds}s |`
  })
  const all = results.flatMap(r => r.runs)
  const sum = (pick: (t: VerificationTotals) => number) => all.reduce((n, run) => n + pick(run.verificationTotals), 0)
  const totalNodes = all.reduce((n, run) => n + run.nodeVerification.length, 0)
  const verifySummary = `Verification: ${sum(t => t.verifiedNodes)}/${totalNodes} nodes verified, ${sum(t => t.failedVerification)} failed, ${sum(t => t.missingVerification)} missing; automatic retries: ${sum(t => t.autoRetries)}; start/amend refusals: ${results.reduce((n, r) => n + r.transcript.verificationRequired, 0)} verification_required, ${results.reduce((n, r) => n + r.transcript.invalidVerification, 0)} invalid_verification.`
  return [
    `# DAG shape evaluation ${stamp}`,
    '',
    `Repeats: ${options.repeat}.`,
    '',
    `Model: ${options.model}. Plugin: ${REPO}. Fixtures: git repositories with one initial commit.${options.enforcement ? ` Enforcement: ${options.enforcement}.` : ''}`,
    '',
    `Distinct shapes: ${shapes.size} (${[...shapes].join(', ')}). Distinct producer shapes: ${producerShapes.size} (${[...producerShapes].join(', ')}). Samples matching their expected shape: ${matches}/${results.length}.`,
    '',
    verifySummary,
    '',
    '| scenario | expected | runs | shape | nodes | depth | layer widths | fan-in nodes | verify node | warnings | categories | status | outcome check | skill before start | refusals (planning/total) | refusals by tool and reason | AskUserQuestion calls | verify refusals (required/invalid) | verified/total nodes | auto retries | unfinished nodes | time |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    ...(options.repeat > 1 ? acrossRepeats(results, matched) : []),
  ].join('\n')
}

const parsed = parseArgs(Bun.argv.slice(2))
if ('error' in parsed) {
  console.error(`${parsed.error}\n${USAGE}`)
  process.exit(1)
}
const options = parsed.options
const selected = SCENARIOS.filter(s => !options.only || options.only.includes(s.id))
if (options.list) {
  for (const s of selected) console.log(`${s.id.padEnd(16)} expect=${s.expect.padEnd(15)} ${s.prompt}`)
  process.exit(0)
}
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const root = `/tmp/dag-shapes/${stamp}`
const samples = selected.flatMap(scenario => Array.from({ length: options.repeat }, (_, i) => ({ scenario, repeat: i + 1 })))
const results = await pool(samples, options.concurrency, async ({ scenario, repeat }) => {
  const result = await runScenario(scenario, repeat, root, options)
  console.log(`SCENARIO_DONE ${scenario.id}#${repeat} runs=${result.runs.length} shape=${result.runs[0]?.shape ?? 'none'} check=${result.check.passed}`)
  return result
})
const outDir = `${REPO}/eval/results`
await Bun.write(`${outDir}/${stamp}.json`, JSON.stringify({ stamp, root, options, results }, null, 2))
await Bun.write(`${outDir}/${stamp}.md`, markdown(results, stamp, options))
if (!options.keep) await Bun.$`rm -rf ${root}`.quiet()
console.log(`SHAPES_DONE ${outDir}/${stamp}.md fixtures=${options.keep ? root : 'removed'}`)
