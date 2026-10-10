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

// The text expectation fields, in evaluation order. The parser, lint, the tool schema and the runtime read this one list,
// so a new field is added here and nowhere else is missed.
export const TEXT_FIELDS = ['contains', 'absent', 'matches', 'lastLine', 'equals'] as const

export type TextField = (typeof TEXT_FIELDS)[number]

// What a text must satisfy; every given field must hold. contains: the text includes it. absent: it does not.
// matches: RegExp source compiled with the m flag, kept as a string so the definition hashes and persists it.
// lastLine: the last line after trailing whitespace is removed equals it. equals: the whole text after trailing whitespace is removed equals it.
export type TextExpect = { [Field in TextField]?: string }

// path is project-relative, or absolute for a read-only check outside the project (never inside .claude/dag).
export type FileCheck = { kind: 'file'; path: string } & TextExpect

// Without exit only 0 is accepted.
export type CommandExpect = {
  exit?: number | number[]
  stdout?: TextExpect
  stderr?: TextExpect
}

export type CommandCheck = { kind: 'command'; argv: string[]; expect?: CommandExpect }

export type VerificationCheck = FileCheck | CommandCheck

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

// The review pair a definition declares in one field. parseDefinition expands it into the review-spec and review-standards nodes.
// Kept with its defaults filled in (notes folder, category), so a definition that spells a default out hashes like one that leaves it out.
export type ReviewStage = {
  request: string // the user's request, pasted verbatim into review-spec
  notes: string // absolute folder for both notes files; default /tmp/dag-review/<cleaned key>-<6 hex>
  category: string // the reviewers' category; default unspecified-low
  rules?: string[] // repository rule files for review-standards; absent means it searches for them
}

// One commit of the commit stage, in commit order. The first line of message is the subject; the rest is the body.
export type CommitEntry = { message: string; paths: string[] }

export type Definition = {
  key: string
  name: string
  goal?: string
  // The user's nodes followed by the nodes expanded from review and commit (stages.ts).
  nodes: NodeDef[]
  // Kept so a reused or amended definition re-expands identically. An amend sends these original fields with the user's
  // nodes only: a node named review-spec, review-standards or commit next to its field is refused as a duplicate stage.
  review?: ReviewStage
  commit?: CommitEntry[]
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
    // rule: a final audit proposed or routed as quick runs on unspecified-low.
    readonly source: 'jev' | 'definition' | 'rule'
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
  // A pending user approval: while set, no node starts. Absent means none.
  approval?: { requestedAt: number }
  // Set when the user rejected the run while it awaited approval (reason is theirs, possibly empty). Every transition and
  // the checkpoint keep it: the model may not retry, amend or restart the run; only the user's own /dag retry runs it again.
  rejected?: { at: number; reason: string }
}

export type EngineError = { code: string; message: string }

export type Result<T> = { ok: true; value: T } | { ok: false; error: EngineError }

export function fail<T>(code: string, message: string): Result<T> {
  return { ok: false, error: { code, message } }
}
