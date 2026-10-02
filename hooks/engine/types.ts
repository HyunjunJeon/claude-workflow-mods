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
}

export type EngineError = { code: string; message: string }

export type Result<T> = { ok: true; value: T } | { ok: false; error: EngineError }

export function fail<T>(code: string, message: string): Result<T> {
  return { ok: false, error: { code, message } }
}
