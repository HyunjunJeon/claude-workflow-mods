import { isPlanningSkill } from '../hooks/engine/policy.ts'
import type { Run } from '../hooks/engine/types.ts'
import type { ShapeClass } from './shape.ts'

export type Denial = { tool: string; reason: string; count: number }

export type ToolResultCounts = {
  planningRefusals: number
  toolDenials: number
  denials: Denial[]
  verificationRequired: number
  invalidVerification: number
}

export type NodeVerificationReport = {
  id: string
  state: string
  attempt: number
  verification: 'passed' | 'failed' | 'missing' | 'unrecorded'
  recoveryUsed: number
  recoveryKind?: string
  routedCategory?: string
  routingSource?: string
}

export type VerificationTotals = {
  verifiedNodes: number
  failedVerification: number
  missingVerification: number
  autoRetries: number
}

export type ToolResult = {
  readonly tool: string
  readonly isError: boolean
  readonly text: string
}

const DAG_TOOL = 'mcp__dag-workflow__dag'

// The first line of policy.ts denyMessage; the text may be JSON-escaped, so the line ends at a period before a newline or escaped newline.
const DENIAL = /dag-workflow refused (\S+) in the main conversation: (.+?)\.(?:\\n|\n|$)/

export type TranscriptCounts = ToolResultCounts & {
  skillBeforeStart: boolean | null
  starts: number
  askUserQuestions: number
}

type Block = { type: string; id?: string; name?: string; input?: { skill?: unknown; action?: unknown }; content?: unknown; tool_use_id?: string; is_error?: boolean }

// Counts the main session's rows: a tool_use once per id and a tool_result once per tool_use_id, so a row written twice counts once.
export function transcriptCounts(lines: readonly string[]): TranscriptCounts {
  let index = 0
  let skillAt = -1
  let firstStartAt = -1
  let starts = 0
  let askUserQuestions = 0
  const toolNames = new Map<string, string>()
  const answered = new Set<string>()
  const results: ToolResult[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    // SAFETY: the host writes each transcript row as a JSON object; only these fields are read and each is checked before use.
    const row = JSON.parse(line) as { isSidechain?: boolean; message?: { content?: unknown } }
    if (row.isSidechain || !Array.isArray(row.message?.content)) continue
    // SAFETY: the content is an array (checked above) of host content blocks, and every field read from a block is optional in Block.
    for (const block of row.message.content as Block[]) {
      if (block.type === 'tool_use') {
        if (block.id && toolNames.has(block.id)) continue
        if (block.id && block.name) toolNames.set(block.id, block.name)
      }
      if (block.type === 'tool_result' && block.tool_use_id) {
        if (answered.has(block.tool_use_id)) continue
        answered.add(block.tool_use_id)
      }
      index += 1
      if (block.type === 'tool_use' && block.name === 'AskUserQuestion') askUserQuestions += 1
      if (block.type === 'tool_use' && block.name === 'Skill' && isPlanningSkill(block.input?.skill) && skillAt < 0) skillAt = index
      if (block.type === 'tool_use' && block.name === DAG_TOOL && block.input?.action === 'start') {
        starts += 1
        if (firstStartAt < 0) firstStartAt = index
      }
      if (block.type === 'tool_result') {
        results.push({ tool: toolNames.get(block.tool_use_id ?? '') ?? '', isError: block.is_error === true, text: JSON.stringify(block.content ?? '') })
      }
    }
  }
  return { skillBeforeStart: firstStartAt < 0 ? null : skillAt >= 0 && skillAt < firstStartAt, starts, askUserQuestions, ...classifyToolResults(results) }
}

export type RunShape = { nodes: number; shape: ShapeClass; producerShape: ShapeClass }

// Under strict enforcement a direct scenario also matches when every run it made is a single node; under auto a one-node run is still a DAG start.
export function scenarioMatched(expect: string, runs: readonly RunShape[], enforcement: string | undefined): boolean {
  if (expect !== 'direct') return runs.some(run => run.shape === expect || run.producerShape === expect)
  if (runs.length === 0) return true
  return enforcement === 'strict' && runs.every(run => run.nodes === 1)
}

// Refusal codes count only in the dag tool's own replies and denials only in error results:
// the planning skill's reference quotes these codes, so a Read of it must not count.
export function classifyToolResults(results: readonly ToolResult[]): ToolResultCounts {
  const counts: ToolResultCounts = { planningRefusals: 0, toolDenials: 0, denials: [], verificationRequired: 0, invalidVerification: 0 }
  for (const { tool, isError, text } of results) {
    if (isError && text.includes('dag-workflow refused')) {
      counts.toolDenials += 1
      const [, deniedTool = tool || 'unknown', reason = 'unknown'] = DENIAL.exec(text) ?? []
      const known = counts.denials.find(d => d.tool === deniedTool && d.reason === reason)
      if (known) known.count += 1
      else counts.denials.push({ tool: deniedTool, reason, count: 1 })
    }
    if (tool !== DAG_TOOL) continue
    if (text.includes('planning_skill_required')) counts.planningRefusals += 1
    if (text.includes('verification_required')) counts.verificationRequired += 1
    if (text.includes('invalid_verification')) counts.invalidVerification += 1
  }
  return counts
}

export function verificationOf(run: Run): { nodes: NodeVerificationReport[]; totals: VerificationTotals } {
  const totals: VerificationTotals = { verifiedNodes: 0, failedVerification: 0, missingVerification: 0, autoRetries: 0 }
  const nodes = run.nodes.map((node): NodeVerificationReport => {
    const status = node.verification?.status
    if (status === 'passed') totals.verifiedNodes += 1
    if (status === 'failed') totals.failedVerification += 1
    if (status === 'missing') totals.missingVerification += 1
    const used = node.recovery?.used ?? 0
    totals.autoRetries += used
    return {
      id: node.id,
      state: node.state,
      attempt: node.attempt,
      verification: status ?? 'unrecorded',
      recoveryUsed: used,
      ...(node.recovery ? { recoveryKind: node.recovery.kind } : {}),
      ...(node.routing ? { routedCategory: node.routing.category, routingSource: node.routing.source } : {}),
    }
  })
  return { nodes, totals }
}

export type Sample = { id: string; matched: boolean; shape: string; seconds: number }

export type RepeatSummary = { id: string; samples: number; matched: number; shapes: string[]; minSeconds: number; medianSeconds: number; maxSeconds: number }

// Scenarios keep the order in which they first appear; the median of an even count is the rounded mean of the two middle values.
export function summarizeRepeats(samples: readonly Sample[]): RepeatSummary[] {
  const byId = new Map<string, Sample[]>()
  for (const sample of samples) byId.set(sample.id, [...(byId.get(sample.id) ?? []), sample])
  return [...byId].map(([id, group]) => {
    const seconds = group.map(s => s.seconds).sort((x, y) => x - y)
    const middle = seconds.length >> 1
    const low = seconds[0] ?? 0
    const high = seconds[seconds.length - 1] ?? 0
    const median = seconds.length % 2 ? (seconds[middle] ?? 0) : Math.round(((seconds[middle - 1] ?? 0) + (seconds[middle] ?? 0)) / 2)
    return {
      id,
      samples: group.length,
      matched: group.filter(s => s.matched).length,
      shapes: [...new Set(group.map(s => s.shape))],
      minSeconds: low,
      medianSeconds: median,
      maxSeconds: high,
    }
  })
}
