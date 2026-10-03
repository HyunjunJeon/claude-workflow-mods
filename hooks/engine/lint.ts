import type { Definition, NodeDef } from './types.ts'

const VERIFICATION_WORDS = /verif|validat|check|test|review|audit/i

export function isVerificationNode(node: NodeDef): boolean {
  if (node.dependsOn.length === 0) return false
  return [node.id, node.label, node.task_summary, node.description].some(text => text !== undefined && VERIFICATION_WORDS.test(text))
}

export function lintDefinition(definition: Definition): string[] {
  const warnings: string[] = []
  for (const node of definition.nodes) {
    const missing = [
      ...(node.prompt.includes('TASK:') ? [] : ['TASK:']),
      ...(node.prompt.includes('STOP WHEN') ? [] : ['STOP WHEN']),
    ]
    if (missing.length > 0) {
      warnings.push(`node "${node.id}": the prompt lacks ${missing.join(' and ')} - follow the node prompt contract (TASK, DELIVERABLE, SCOPE, VERIFY, STOP WHEN).`)
    }
  }
  if (definition.nodes.length >= 2 && !definition.nodes.some(isVerificationNode)) {
    warnings.push('the graph has no verification node - add a node that depends on the producers, runs the real check and has "verify" in its id or label.')
  }
  const feeds = new Set(definition.nodes.flatMap(node => node.dependsOn))
  for (const node of definition.nodes) {
    if (node.category === 'quick' && node.dependsOn.length >= 2 && !feeds.has(node.id) && isVerificationNode(node)) {
      warnings.push(`node "${node.id}": the final audit requires judgment across inputs, while quick is reserved for mechanical checks - route it to unspecified-low or higher; both quick and unspecified-low use sonnet.`)
    }
  }
  return warnings
}
