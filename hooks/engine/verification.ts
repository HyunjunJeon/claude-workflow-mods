import { fail, type Definition, type EngineError, type Result, type VerificationCheck } from './types.ts'

export function projectPath(path: string): boolean {
  const parts = path.replaceAll('\\', '/').split('/')
  return path.length > 0 && !path.startsWith('/') && !/^[A-Za-z]:/.test(path) &&
    !parts.includes('..') && !path.includes('\0') && !parts.includes('.claude')
}

export function parseChecks(value: unknown): Result<VerificationCheck[]> {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    return fail('invalid_verification', 'verify must contain 1-16 file or command checks.')
  }
  const checks: VerificationCheck[] = []
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return fail('invalid_verification', 'A verification check must be an object.')
    if (raw.kind === 'file' && typeof raw.path === 'string' && projectPath(raw.path)) {
      if (raw.contains !== undefined && (typeof raw.contains !== 'string' || raw.contains.length === 0)) return fail('invalid_verification', 'contains must be nonempty text.')
      checks.push({ kind: 'file', path: raw.path, ...(typeof raw.contains === 'string' ? { contains: raw.contains } : {}) })
    } else if (raw.kind === 'command' && Array.isArray(raw.argv) && raw.argv.length > 0 && raw.argv.every((arg: unknown) => typeof arg === 'string') && raw.argv[0].trim() !== '') {
      checks.push({ kind: 'command', argv: [...raw.argv] })
    } else {
      return fail('invalid_verification', 'Use a project-relative file path outside .claude, or a nonempty command argv array.')
    }
  }
  return { ok: true, value: checks }
}

export function verificationProblem(definition: Definition): EngineError | undefined {
  const missing = definition.nodes.filter(node => !node.verify?.length)
  return missing.length ? {
    code: 'verification_required',
    message: `Declare verify checks for nodes: ${missing.map(node => node.id).join(', ')}. A completion report alone is not evidence; provide file or command checks.`,
  } : undefined
}
