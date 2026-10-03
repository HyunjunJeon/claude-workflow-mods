import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import type { Run } from '../hooks/engine/types.ts'
import { SCENARIOS, type Scenario } from './scenarios.ts'
import { classifyToolResults, verificationOf, type NodeVerificationReport, type ToolResultCounts, type VerificationTotals } from './report.ts'
import { shapeOf, type ShapeMetrics } from './shape.ts'

const REPO = realpathSync(new URL('..', import.meta.url).pathname)
const MAIN_TOOLS = ['mcp__dag-workflow__dag', 'Skill', 'Read', 'Write', 'Edit', 'Bash', 'TaskStop', 'ToolSearch', 'LSP']

type Options = { list: boolean; only?: string[]; concurrency: number; model: string; timeoutMin: number; keep: boolean }

type RunReport = ShapeMetrics & {
  runId: string
  status: string
  states: Record<string, number>
  nodeStates: { id: string; state: string; error?: string }[]
  nodeVerification: NodeVerificationReport[]
  verificationTotals: VerificationTotals
}

type TranscriptReport = ToolResultCounts & {
  path?: string
  skillBeforeStart: boolean | null
  starts: number
}

const NO_COUNTS: ToolResultCounts = { planningRefusals: 0, toolDenials: 0, verificationRequired: 0, invalidVerification: 0 }

type ScenarioResult = {
  id: string
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

function parseArgs(argv: string[]): Options {
  const value = (flag: string) => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const only = value('--only')
  return {
    list: argv.includes('--list'),
    ...(only ? { only: only.split(',') } : {}),
    concurrency: Number(value('--concurrency') ?? 4),
    model: value('--model') ?? 'sonnet',
    timeoutMin: Number(value('--timeout-min') ?? 15),
    keep: argv.includes('--keep'),
  }
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
    return { skillBeforeStart: null, starts: 0, ...NO_COUNTS }
  }
  const newest = files.sort((a, b) => b.mtime - a.mtime)[0]
  if (!newest) return { skillBeforeStart: null, starts: 0, ...NO_COUNTS }
  let index = 0
  let skillAt = -1
  let firstStartAt = -1
  let starts = 0
  const resultTexts: string[] = []
  for (const line of (await Bun.file(newest.path).text()).split('\n')) {
    if (!line.trim()) continue
    const row = JSON.parse(line) as { type?: string; isSidechain?: boolean; message?: { content?: unknown } }
    if (row.isSidechain || !Array.isArray(row.message?.content)) continue
    for (const block of row.message.content as { type: string; name?: string; input?: Record<string, unknown>; content?: unknown }[]) {
      index += 1
      if (block.type === 'tool_use' && block.name === 'Skill' && String(block.input?.skill ?? '').endsWith('dag-planning') && skillAt < 0) skillAt = index
      if (block.type === 'tool_use' && block.name === 'mcp__dag-workflow__dag' && block.input?.action === 'start') {
        starts += 1
        if (firstStartAt < 0) firstStartAt = index
      }
      if (block.type === 'tool_result') resultTexts.push(JSON.stringify(block.content ?? ''))
    }
  }
  return { path: newest.path, skillBeforeStart: firstStartAt < 0 ? null : skillAt >= 0 && skillAt < firstStartAt, starts, ...classifyToolResults(resultTexts) }
}

async function runScenario(scenario: Scenario, root: string, options: Options): Promise<ScenarioResult> {
  const dir = `${root}/${scenario.id}`
  await Bun.$`mkdir -p ${dir}`.quiet()
  for (const [path, content] of Object.entries(scenario.files)) await Bun.write(`${dir}/${path}`, content)
  const started = Date.now()
  const proc = Bun.spawn(['claude', '-p', scenario.prompt, '--plugin-dir', REPO, '--model', options.model, '--allowedTools', ...MAIN_TOOLS], {
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
  await Bun.write(`${root}/${scenario.id}.out.txt`, `${stdout}\n--- stderr ---\n${stderr}`)

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

function markdown(results: ScenarioResult[], stamp: string, options: Options): string {
  const shapes = new Set(results.flatMap(r => r.runs.map(run => run.shape)))
  const producerShapes = new Set(results.flatMap(r => r.runs.map(run => run.producerShape)))
  const matches = results.filter(r => r.runs.some(run => run.shape === r.expect || run.producerShape === r.expect)).length
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
    return `| ${r.id} | ${r.expect} | ${r.runs.length} | ${shape} | ${main?.nodes ?? '-'} | ${main?.depth ?? '-'} | ${widths || '-'} | ${main?.fanInNodes ?? '-'} | ${main?.verify ?? '-'} | ${main?.warnings ?? '-'} | ${categories || '-'} | ${status} | ${r.check.passed && r.unchangedOk ? 'PASS' : 'FAIL'} | ${r.transcript.skillBeforeStart} | ${r.transcript.planningRefusals}/${r.transcript.toolDenials} | ${r.transcript.verificationRequired}/${r.transcript.invalidVerification} | ${totals.verified}/${totals.nodes} | ${totals.retries} | ${problems || '-'} | ${r.seconds}s |`
  })
  const all = results.flatMap(r => r.runs)
  const sum = (pick: (t: VerificationTotals) => number) => all.reduce((n, run) => n + pick(run.verificationTotals), 0)
  const totalNodes = all.reduce((n, run) => n + run.nodeVerification.length, 0)
  const verifySummary = `Verification: ${sum(t => t.verifiedNodes)}/${totalNodes} nodes verified, ${sum(t => t.failedVerification)} failed, ${sum(t => t.missingVerification)} missing; automatic retries: ${sum(t => t.autoRetries)}; start/amend refusals: ${results.reduce((n, r) => n + r.transcript.verificationRequired, 0)} verification_required, ${results.reduce((n, r) => n + r.transcript.invalidVerification, 0)} invalid_verification.`
  return [
    `# DAG shape evaluation ${stamp}`,
    '',
    `Model: ${options.model}. Plugin: ${REPO}.`,
    '',
    `Distinct shapes: ${shapes.size} (${[...shapes].join(', ')}). Distinct producer shapes: ${producerShapes.size} (${[...producerShapes].join(', ')}). Scenarios matching their expected shape: ${matches}/${results.length}.`,
    '',
    verifySummary,
    '',
    '| scenario | expected | runs | shape | nodes | depth | layer widths | fan-in nodes | verify node | warnings | categories | status | outcome check | skill before start | refusals (planning/tools) | verify refusals (required/invalid) | verified/total nodes | auto retries | unfinished nodes | time |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n')
}

const options = parseArgs(Bun.argv.slice(2))
const selected = SCENARIOS.filter(s => !options.only || options.only.includes(s.id))
if (options.list) {
  for (const s of selected) console.log(`${s.id.padEnd(16)} expect=${s.expect.padEnd(15)} ${s.prompt}`)
  process.exit(0)
}
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const root = `/tmp/dag-shapes/${stamp}`
const results = await pool(selected, options.concurrency, async scenario => {
  const result = await runScenario(scenario, root, options)
  console.log(`SCENARIO_DONE ${scenario.id} runs=${result.runs.length} shape=${result.runs[0]?.shape ?? 'none'} check=${result.check.passed}`)
  return result
})
const outDir = `${REPO}/eval/results`
await Bun.write(`${outDir}/${stamp}.json`, JSON.stringify({ stamp, root, options, results }, null, 2))
await Bun.write(`${outDir}/${stamp}.md`, markdown(results, stamp, options))
if (!options.keep) await Bun.$`rm -rf ${root}`.quiet()
console.log(`SHAPES_DONE ${outDir}/${stamp}.md fixtures=${options.keep ? root : 'removed'}`)
