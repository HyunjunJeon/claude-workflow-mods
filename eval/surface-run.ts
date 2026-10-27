import { mkdirSync, realpathSync, rmSync } from 'node:fs'
import { modelPrompt, modeRequest, parseChoices, parseModelChoices, SURFACE_CONFIDENCE, type JevChoice, type JevOutcome, type JevRequest } from '../hooks/engine/jev.ts'
import { SURFACE_CASES } from './surface-cases.ts'
import { agreement, calibration, confusion, groupRates, modeAccuracy, modeDrift, outcomes, percentile, sweep, type Confusion, type SurfaceCase, type SurfaceSample } from './surface.ts'

const REPO = realpathSync(new URL('..', import.meta.url).pathname)
const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
const HTTP_TIMEOUT_MS = 30_000
const MODEL_TIMEOUT_MS = 60_000
// These copy JEV_TIMEOUT_MS and MODE_BUDGET_MS from hooks/register.ts, which does not export them: a sample slower than
// the first loses the HTTP answer in production, and one slower than the second loses the turn-mode budget.
const JEV_TIMEOUT_MS = 5_000
const MODE_BUDGET_MS = 8_000

type Backend = 'http' | 'model'

type Options = {
  list: boolean
  only?: string[]
  dryRequest?: string
  backend: Backend
  repeat: number
  drift: boolean
  concurrency: number
  model: string
  bar: number
}

type Answer = { outcome: JevOutcome; latencyMs: number; choices: ReadonlyMap<string, JevChoice> }
type Ask = (request: JevRequest) => Promise<Answer>

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function parseBackend(text: string | undefined): Backend {
  if (text === undefined || text === 'http') return 'http'
  if (text === 'model') return 'model'
  return fail(`unknown --backend '${text}': the backend must be http or model`)
}

function parseNumber(flag: string, text: string | undefined, fallback: number): number {
  if (text === undefined) return fallback
  const parsed = Number(text)
  if (!Number.isFinite(parsed)) fail(`${flag} needs a number, got '${text}'`)
  return parsed
}

function parseArgs(argv: string[]): Options {
  const value = (flag: string) => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  return {
    list: argv.includes('--list'),
    only: value('--only')?.split(','),
    dryRequest: value('--dry-request'),
    backend: parseBackend(value('--backend')),
    repeat: parseNumber('--repeat', value('--repeat'), 3),
    drift: !argv.includes('--no-drift'),
    concurrency: parseNumber('--concurrency', value('--concurrency'), 4),
    model: value('--model') ?? 'sonnet',
    bar: parseNumber('--bar', value('--bar'), SURFACE_CONFIDENCE),
  }
}

function selectCases(ids: readonly string[] | undefined): SurfaceCase[] {
  if (!ids) return SURFACE_CASES
  const known = new Set(SURFACE_CASES.map(entry => entry.id))
  const unknown = ids.filter(id => !known.has(id))
  if (unknown.length) fail(`unknown case id(s): ${unknown.join(', ')}`)
  return SURFACE_CASES.filter(entry => ids.includes(entry.id))
}

function caseRequest(entry: SurfaceCase, askSurface: boolean): JevRequest {
  return modeRequest(entry.request, entry.recent ?? [], entry.previousReply, askSurface)
}

function httpAsk(apiKey: string): Ask {
  return async request => {
    const started = Date.now()
    const elapsed = () => Date.now() - started
    try {
      const response = await fetch(JEV_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      })
      if (!response.ok) return { outcome: 'http-error', latencyMs: elapsed(), choices: new Map() }
      const choices = parseChoices(await response.text(), request.questions)
      return { outcome: choices.size ? 'answered' : 'invalid-response', latencyMs: elapsed(), choices }
    } catch (error) {
      const outcome = error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError') ? 'timeout' : 'transport-error'
      return { outcome, latencyMs: elapsed(), choices: new Map() }
    }
  }
}

// The reply envelope of claude -p --output-format json; only the final text is read.
function resultText(stdout: string): string | undefined {
  try {
    const parsed: { result?: unknown } = JSON.parse(stdout)
    return typeof parsed.result === 'string' ? parsed.result : undefined
  } catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}

function modelAsk(model: string, cwd: string): Ask {
  // Without CLAUDE_CODE_PLUGIN_DIRS this plugin does not load, so it cannot judge its own classifier calls.
  const env = { ...process.env }
  delete env.CLAUDE_CODE_PLUGIN_DIRS
  return async request => {
    const ask = modelPrompt(request)
    const started = Date.now()
    // This approximates the runtime's $.model.complete call (sonnet, effort low, no tools) with a one-shot headless session.
    const proc = Bun.spawn(
      ['claude', '-p', ask.prompt, '--system-prompt', ask.system, '--tools', '', '--model', model, '--effort', 'low', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands', '--setting-sources', 'project'],
      { cwd, env, stdout: 'pipe', stderr: 'pipe' },
    )
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill()
    }, MODEL_TIMEOUT_MS)
    const [stdout] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const exitCode = await proc.exited
    clearTimeout(timer)
    const latencyMs = Date.now() - started
    if (timedOut) return { outcome: 'timeout', latencyMs, choices: new Map() }
    if (exitCode !== 0) return { outcome: 'transport-error', latencyMs, choices: new Map() }
    const text = resultText(stdout)
    const choices = text === undefined ? new Map<string, JevChoice>() : parseModelChoices(text, request.questions)
    return { outcome: choices.size ? 'answered' : 'invalid-response', latencyMs, choices }
  }
}

async function sample(entry: SurfaceCase, repeat: number, ask: Ask, drift: boolean): Promise<SurfaceSample> {
  const main = await ask(caseRequest(entry, true))
  const alone = drift ? (await ask(caseRequest(entry, false))).choices.get('mode') : undefined
  return {
    caseId: entry.id,
    repeat,
    outcome: main.outcome,
    latencyMs: main.latencyMs,
    surface: main.choices.get('surface'),
    mode: main.choices.get('mode'),
    modeAlone: alone,
  }
}

async function pool<T, R>(items: T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      // SAFETY: i < items.length was checked on the line above, and no await separates the check from this read.
      results[i] = await work(items[i] as T)
    }
  })
  await Promise.all(workers)
  return results
}

function ratioText(value: number | null): string {
  return value === null ? '-' : value.toFixed(2)
}

function confusionRow(entry: Confusion): string {
  return `| ${entry.bar.toFixed(2)} | ${entry.scored} | ${entry.truePositive} | ${entry.falsePositive} | ${entry.falseNegative} | ${entry.trueNegative} | ${ratioText(entry.precision)} | ${ratioText(entry.recall)} | ${ratioText(entry.accuracy)} |`
}

const CONFUSION_HEADER = ['| bar | scored | TP | FP | FN | TN | precision | recall | accuracy |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |']

function summarize(cases: readonly SurfaceCase[], samples: readonly SurfaceSample[], options: Options) {
  const latencies = samples.map(entry => entry.latencyMs)
  return {
    outcomes: outcomes(samples),
    latency: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      overJevTimeout: latencies.filter(ms => ms > JEV_TIMEOUT_MS).length,
      overModeBudget: latencies.filter(ms => ms > MODE_BUDGET_MS).length,
    },
    confusion: confusion(cases, samples, options.bar),
    sweep: sweep(cases, samples),
    groups: groupRates(cases, samples, options.bar),
    calibration: calibration(cases, samples),
    agreement: agreement(samples),
    drift: options.drift ? modeDrift(samples) : undefined,
    modeAccuracy: modeAccuracy(cases, samples),
  }
}

function choiceText(entry: SurfaceSample): string {
  return entry.surface ? `${entry.surface.choice}@${entry.surface.confidence.toFixed(2)}` : entry.outcome
}

function markdown(cases: readonly SurfaceCase[], samples: readonly SurfaceSample[], summary: ReturnType<typeof summarize>, stamp: string, options: Options): string {
  const backend = options.backend === 'model' ? `model (${options.model})` : `http (${JEV_URL})`
  const latency = summary.latency
  const msText = (ms: number | undefined) => (ms === undefined ? '-' : `${ms} ms`)
  const perCase = cases.map(entry => {
    const choices = samples.filter(s => s.caseId === entry.id).sort((a, b) => a.repeat - b.repeat).map(choiceText)
    return `| ${entry.id} | ${entry.expect} | ${choices.join(', ') || '-'} |`
  })
  const drift = summary.drift
  return [
    `# Surface judgment evaluation ${stamp}`,
    '',
    `Backend: ${backend}. Repeats: ${options.repeat}. Cases: ${cases.length}. Bar: ${options.bar}.`,
    '',
    '## Outcomes',
    '',
    ...Object.entries(summary.outcomes).map(([outcome, count]) => `- ${outcome}: ${count}`),
    '',
    '## Latency',
    '',
    `p50 ${msText(latency.p50)}, p95 ${msText(latency.p95)}. Over ${JEV_TIMEOUT_MS} ms (JEV_TIMEOUT_MS): ${latency.overJevTimeout}. Over ${MODE_BUDGET_MS} ms (MODE_BUDGET_MS): ${latency.overModeBudget}.`,
    '',
    '## Confusion at the bar (board is positive)',
    '',
    ...CONFUSION_HEADER,
    confusionRow(summary.confusion),
    '',
    '## Sweep',
    '',
    ...CONFUSION_HEADER,
    ...summary.sweep.map(confusionRow),
    '',
    '## Board rate by group at the bar',
    '',
    '| group | samples | board |',
    '| --- | --- | --- |',
    ...summary.groups.map(group => `| ${group.group} | ${group.samples} | ${group.board} |`),
    '',
    '## Calibration (raw surface choice)',
    '',
    '| confidence | answers | correct |',
    '| --- | --- | --- |',
    ...summary.calibration.map(bucket => `| ${bucket.from}-${bucket.to} | ${bucket.answers} | ${bucket.correct} |`),
    '',
    '## Agreement across repeats',
    '',
    `${summary.agreement.agreed}/${summary.agreement.cases} cases agreed. Split: ${summary.agreement.split.join(', ') || '-'}.`,
    '',
    ...(drift
      ? [
          '## Mode drift (with the surface question versus mode alone)',
          '',
          `Compared: ${drift.compared}. Drifted: ${drift.drifted.map(d => `${d.caseId}#${d.repeat} ${d.withSurface}->${d.alone}`).join(', ') || '-'}.`,
          '',
        ]
      : []),
    '## Mode accuracy',
    '',
    `${summary.modeAccuracy.correct}/${summary.modeAccuracy.scored} samples with an expected mode were correct.`,
    '',
    '## Per case',
    '',
    '| case | expect | surface choices |',
    '| --- | --- | --- |',
    ...perCase,
    '',
  ].join('\n')
}

const options = parseArgs(Bun.argv.slice(2))
const selected = selectCases(options.only)
if (options.list) {
  for (const entry of selected) console.log(`${entry.id.padEnd(32)} expect=${entry.expect.padEnd(9)} group=${entry.group.padEnd(12)} ${entry.request.slice(0, 80)}`)
  process.exit(0)
}
if (options.dryRequest !== undefined) {
  const [entry] = selectCases([options.dryRequest])
  if (!entry) fail(`unknown case id: ${options.dryRequest}`)
  const request = caseRequest(entry, true)
  if (options.backend === 'http') console.log(JSON.stringify(request, null, 2))
  else {
    const ask = modelPrompt(request)
    console.log(`${ask.system}\n\n${ask.prompt}`)
  }
  process.exit(0)
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const workDir = `/tmp/dag-surface/${stamp}`
let ask: Ask
if (options.backend === 'http') {
  const apiKey = process.env.TYPESAFE_API_KEY
  if (!apiKey) fail('the http backend needs TYPESAFE_API_KEY in the environment; set it or pass --backend model')
  ask = httpAsk(apiKey)
} else {
  // An empty working directory keeps any CLAUDE.md and project settings out of the classifier session.
  mkdirSync(workDir, { recursive: true })
  ask = modelAsk(options.model, workDir)
}

const jobs = selected.flatMap(entry => Array.from({ length: options.repeat }, (_, repeat) => ({ entry, repeat })))
const samples = await pool(jobs, options.concurrency, async ({ entry, repeat }) => {
  const result = await sample(entry, repeat, ask, options.drift)
  console.log(`SAMPLE_DONE ${entry.id}#${repeat} outcome=${result.outcome} surface=${choiceText(result)} ${result.latencyMs}ms`)
  return result
})
if (options.backend === 'model') rmSync(workDir, { recursive: true, force: true })

const summary = summarize(selected, samples, options)
const outDir = `${REPO}/eval/results`
const mdPath = `${outDir}/surface-${stamp}.md`
await Bun.write(`${outDir}/surface-${stamp}.json`, JSON.stringify({ stamp, options, samples, summary }, null, 2))
await Bun.write(mdPath, markdown(selected, samples, summary, stamp, options))
console.log(`SURFACE_DONE ${mdPath}`)
