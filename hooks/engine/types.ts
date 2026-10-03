export type NodeState =
  | 'pending'
  | 'blocked'
  | 'scheduled'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'skipped'

export type RunStatus = 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'

export type VerificationCheck =
  | { kind: 'file'; path: string; contains?: string }
  | { kind: 'command'; argv: string[] }

export type VerificationEvidence = {
  check: VerificationCheck
  passed: boolean
  checkedAt: number
  exitCode?: number
  detail: string
}

export type RecoveryKind = 'transient' | 'implementation' | 'missing-input' | 'clarification' | 'permanent'

export type NodeDef = {
  id: string
  prompt: string
  dependsOn: string[]
  category?: string
  agent?: string
  label?: string
  task_summary?: string
  description?: string
  load_skills?: string[]
  verify?: VerificationCheck[]
  writes?: string[]
}

export type Definition = {
  key: string
  name: string
  goal?: string
  nodes: NodeDef[]
}

export type NodeRun = {
  id: string
  label: string
  state: NodeState
  attempt: number
  fingerprint: string
  agentId?: string
  model?: string
  promptOverride?: string
  startedAt?: number
  finishedAt?: number
  error?: string
  answer?: string
  output?: string
  reportPath?: string
  routing?: {
    readonly source: 'jev' | 'definition'
    readonly category: string
    readonly confidence?: number
  }
  verification?: {
    status: 'passed' | 'failed' | 'missing'
    evidence: VerificationEvidence[]
    reportPath?: string
    error?: string
  }
  recovery?: {
    used: number
    kind: RecoveryKind
    reason: string
    model?: 'sonnet' | 'opus'
    history: { at: number; kind: RecoveryKind; reason: string; attempt: number }[]
  }
}

export type Run = {
  schemaVersion: 1
  runId: string
  key: string
  name: string
  sessionId: string
  status: RunStatus
  createdAt: number
  updatedAt: number
  definition: Definition
  definitionHash: string
  nodes: NodeRun[]
  cancelReason?: string
  settledNotified?: boolean
  handoff?: {
    from: string
    to: string
    requestedAt: number
    offeredAt?: number
  }
}

export type EngineError = { code: string; message: string }

export type Result<T> = { ok: true; value: T } | { ok: false; error: EngineError }

export function fail<T>(code: string, message: string): Result<T> {
  return { ok: false, error: { code, message } }
}
