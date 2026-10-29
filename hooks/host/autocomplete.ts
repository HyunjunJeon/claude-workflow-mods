import type { EngineInterface } from 'claude-code'
import { DEFINITION_FOLDERS } from '../engine/autocomplete.ts'
import { listIfPresent } from './io.ts'

// The prompt.autocomplete hook asks as the person types, so it never starts a process: the definition files come from
// $.fs.list on the two folders of engine/autocomplete.ts, and the walk is reused for this long. The hook's 10 s budget
// (HookBudget.ms) counts only the hook's own code and not its $ calls, so the reuse is about not listing the folders again
// for every character typed, not about the budget. A file added meanwhile shows up within one window.
export const DEFINITION_CACHE_MS = 10_000
// flows/improvement/ is one level under flows/; three levels leave room for a deeper grouping without walking a whole tree.
const DEFINITION_DEPTH = 3

// The last walk and when it started. The walk is kept as a promise so keystrokes that arrive during it share its answer.
export type DefinitionFiles = { walk: { root: string; at: number; paths: Promise<string[]> } | undefined }

export function createDefinitionFiles(): DefinitionFiles {
  return { walk: undefined }
}

// Every file under the definition folders, as paths relative to the session's folder: the one /dag run and /dag preview
// resolve their argument against (register.ts commandFilePath).
export async function definitionPaths($: EngineInterface, files: DefinitionFiles): Promise<string[]> {
  const root = await $.session.cwd()
  const now = await $.clock.now()
  const last = files.walk
  if (last !== undefined && last.root === root && now - last.at < DEFINITION_CACHE_MS) return last.paths
  const paths = walkFolders($, root)
  files.walk = { root, at: now, paths }
  return paths
}

// One $.fs.list per folder, a level at a time; a folder that is not there lists as empty.
async function walkFolders($: EngineInterface, root: string): Promise<string[]> {
  const found: string[] = []
  let level = DEFINITION_FOLDERS
  for (let depth = 0; depth <= DEFINITION_DEPTH && level.length > 0; depth++) {
    const listings = await Promise.all(level.map(async folder => ({ folder, entries: await listIfPresent($, `${root}/${folder}`) })))
    const next: string[] = []
    for (const { folder, entries } of listings) {
      for (const entry of entries) {
        if (entry.kind === 'file') found.push(`${folder}/${entry.name}`)
        else if (entry.kind === 'dir') next.push(`${folder}/${entry.name}`)
      }
    }
    level = next
  }
  return found
}
