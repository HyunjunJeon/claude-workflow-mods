import type { Run } from '../hooks/engine/types.ts'

export type ToolResultCounts = {
  planningRefusals: number
  toolDenials: number
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

// Refusal codes count only in the dag tool's own replies and denials only in error results:
// the planning skill's reference quotes these codes, so a Read of it must not count.
export function classifyToolResults(results: readonly ToolResult[]): ToolResultCounts {
  const counts: ToolResultCounts = { planningRefusals: 0, toolDenials: 0, verificationRequired: 0, invalidVerification: 0 }
  for (const { tool, isError, text } of results) {
    if (isError && text.includes('dag-workflow refused')) counts.toolDenials += 1
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
