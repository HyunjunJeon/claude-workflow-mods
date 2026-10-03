import { downstream } from './graph.ts'
import { advance } from './run.ts'
import { spawnTarget } from './node-prompt.ts'
import { fail, type RecoveryKind, type Result, type Run } from './types.ts'

export const MAX_AUTO_RECOVERIES = 2

export function recoveryKind(value: string): RecoveryKind | undefined {
  switch (value) {
    case 'transient':
    case 'implementation':
    case 'missing-input':
    case 'clarification':
    case 'permanent':
      return value
    default:
      return undefined
  }
}

export function recoverNode(input: Run, nodeId: string, decision: { kind: RecoveryKind; reason: string; now: number }): Result<Run> {
  const node = input.nodes.find(current => current.id === nodeId)
  if (!node || node.state !== 'failed' || input.cancelReason || input.handoff) return fail('not_recoverable', 'Only failed work owned by this run can recover.')
  if (decision.kind !== 'transient' && decision.kind !== 'implementation') return fail('recovery_needs_input', 'This failure needs input or a user decision.')
  if (node.verification?.status === 'missing') return fail('recovery_needs_input', 'Declare verification checks before retrying.')
  const used = node.recovery?.used ?? 0
  if (used >= MAX_AUTO_RECOVERIES) return fail('recovery_exhausted', 'The node used its two extra automatic attempts.')
  const affected = downstream(input.definition.nodes, [nodeId])
  const definition = input.definition.nodes.find(current => current.id === nodeId)
  const originalModel = definition ? spawnTarget({ ...definition, category: node.routing?.category ?? definition.category }).model : 'sonnet'
  const model = decision.kind === 'implementation' || node.recovery?.model === 'opus' || node.model?.includes('opus') || originalModel === 'opus' ? 'opus' : 'sonnet'
  const nodes = input.nodes.map(current => {
    if (current.id !== nodeId && !(affected.has(current.id) && current.state === 'skipped')) return current
    const { agentId, startedAt, finishedAt, error, answer, output, reportPath, verification, ...rest } = current
    if (current.id !== nodeId) return { ...rest, state: 'pending' as const }
    return {
      ...rest,
      state: 'pending' as const,
      promptOverride: [
        current.promptOverride ?? definition?.prompt ?? '',
        '',
        `[Recovery ${used + 1}/${MAX_AUTO_RECOVERIES}] ${decision.kind}: ${decision.reason}`,
        'Fix the observed failure within the original scope. Re-run the declared verification; do not broaden the task or claim success without evidence.',
      ].join('\n'),
      recovery: {
        used: used + 1,
        kind: decision.kind,
        reason: decision.reason,
        model: model === 'opus' ? 'opus' as const : 'sonnet' as const,
        history: [...(current.recovery?.history ?? []), { at: decision.now, kind: decision.kind, reason: decision.reason, attempt: current.attempt }],
      },
    }
  })
  return { ok: true, value: advance({ ...input, nodes, settledNotified: false }, decision.now) }
}
