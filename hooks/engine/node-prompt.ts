import type { NodeOutcome } from './run.ts'
import type { NodeDef, NodeRun, Run } from './types.ts'

export const STATUS_PREFIX = 'DAG_NODE_STATUS:'
export const UPSTREAM_OUTPUT_CHARS = 4_000

const OUTPUT_HEADING = /^#{1,4}\s*Output\s*:?\s*$/im

const CATEGORY_MODELS: Readonly<Record<string, string>> = {
  quick: 'sonnet',
  'unspecified-low': 'sonnet',
  'unspecified-high': 'opus',
  'deep-low': 'sonnet',
  'deep-high': 'opus',
  writing: 'sonnet',
  'visual-engineering': 'sonnet',
  artistry: 'opus',
  ultrabrain: 'opus',
  architect: 'opus',
}

export const CATEGORIES = Object.keys(CATEGORY_MODELS)

export type UpstreamResult = { id: string; label: string; output: string; reportPath?: string }

export function spawnTarget(node: NodeDef): { subagentType: string; model: 'sonnet' | 'opus' } {
  const model = node.category ? CATEGORY_MODELS[node.category] : undefined
  return { subagentType: node.agent ?? 'general-purpose', model: model === 'opus' ? 'opus' : 'sonnet' }
}

export function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit).trimEnd()}\n… (truncated)`
}

export function extractOutput(answer: string | undefined, limit = UPSTREAM_OUTPUT_CHARS): string {
  const body = (answer ?? '')
    .split('\n')
    .filter(line => !line.includes(STATUS_PREFIX))
    .join('\n')
  const match = OUTPUT_HEADING.exec(body)
  const section = match ? body.slice(match.index + match[0].length) : body
  return truncate(section.trim(), limit)
}

function upstreamBlock(upstream: UpstreamResult[]): string[] {
  if (upstream.length === 0) return []
  return [
    '<upstream_results>',
    'These are the outputs of the nodes this node depends on. They are your inputs: build on them and do not redo their work.',
    ...upstream.flatMap(result => [
      `<result node="${result.id}"${result.reportPath ? ` report="${result.reportPath}"` : ''}>`,
      result.output || '(the node reported no output)',
      '</result>',
    ]),
    '</upstream_results>',
    '',
  ]
}

export function buildNodePrompt(run: Run, def: NodeDef, node: NodeRun, upstream: UpstreamResult[] = []): string {
  const task = node.promptOverride ?? def.prompt
  const skills = def.load_skills?.length
    ? [`Before you start, load and follow these skills with the Skill tool: ${def.load_skills.join(', ')}.`, '']
    : []
  return [
    `You are executing node "${def.id}" of the DAG workflow "${run.name}" (run ${run.runId}, attempt ${node.attempt + 1}).`,
    ...(run.definition.goal ? [`Overall goal of the workflow: ${run.definition.goal}`] : []),
    'Do only this node\'s task. Other nodes run in parallel or later; never do their work, and keep your writes inside this task\'s scope.',
    'The project directory .claude/dag/ holds this workflow\'s own checkpoints and node reports. It is not part of your task: never edit it, and never count it as a change or as pre-existing project content.',
    '',
    ...skills,
    ...(def.writes ? [`Declared write scopes (project-relative): ${def.writes.length ? def.writes.join(', ') : '(read-only)'}.`, ''] : []),
    ...(def.verify ? [`Completion is gated by these plugin-run checks: ${JSON.stringify(def.verify)}.`, 'Your success claim does not bypass a failing check.', ''] : []),
    ...upstreamBlock(upstream),
    '<task>',
    task,
    '</task>',
    '',
    'When you finish, end your final report with an "## Output" section for the nodes that depend on you:',
    'the files you created or changed, the key facts, values, findings or decisions you produced, in compact form.',
    'Then end with exactly one final line:',
    `${STATUS_PREFIX} completed`,
    'or, if you could not complete the task:',
    `${STATUS_PREFIX} failed: <one-line reason>`,
  ].join('\n')
}

export function parseOutcome(event: { reason?: string; isAborted: boolean; answer: string }): NodeOutcome {
  if (event.isAborted || event.reason === 'aborted') {
    return { state: 'cancelled', error: 'The node agent was stopped before it finished.' }
  }
  if (event.reason === 'error' || event.reason === 'refusal') {
    return { state: 'failed', answer: event.answer, error: `The node agent ended with ${event.reason}.` }
  }
  const lastLine = event.answer.trimEnd().split('\n').pop() ?? ''
  const index = lastLine.indexOf(STATUS_PREFIX)
  if (index >= 0) {
    const verdict = lastLine.slice(index + STATUS_PREFIX.length).trim()
    if (/^failed\b/i.test(verdict)) {
      const reason = verdict.replace(/^failed\s*:?\s*/i, '').trim()
      return { state: 'failed', answer: event.answer, error: reason || 'The node reported failure.' }
    }
  }
  return { state: 'completed', answer: event.answer }
}
