import { WORKTREES_DIR, fileAction, isNodeWorktree } from './isolation.ts'

// The git recipe for running a node in its own worktree: snapshot the main working tree (uncommitted and untracked files
// included), make a detached worktree from it, read the node's result back as a tree, and merge that result into the main
// tree file by file. The recipe comes from the 2026-10-23 spike (eval/baselines/worktree-spike-2.1.308.md), and
// scripts/worktree-check.ts runs it against the installed git (2.54 when it was written).
// Every command goes through `run`, shaped like the host's $.process.run, so this module never touches the host: the
// plugin passes the real one and tests pass a fake. The commands assume POSIX tools (cp, rm, mkdir, ln, mktemp, test).

export type GitRun = (argv: readonly string[], init: { cwd: string; env?: Record<string, string>; stdin?: string }) => Promise<{ exitCode: number; stdout: string; stderr: string; isStdoutTruncated?: boolean }>

type RunInit = Parameters<GitRun>[1]
type RunResult = Awaited<ReturnType<GitRun>>

export type Snapshot = { commit: string; tree: string }
export type ApplyResult = { applied: string[] } | { conflicts: string[] }

// A commit needs an author and a committer; a fixed one keeps the snapshot working where the person set no git identity.
const IDENTITY = ['-c', 'user.name=dag-workflow', '-c', 'user.email=dag-workflow@localhost']

// git merge-file exits with the number of conflicts, capped at 127, and with 255 on an error such as a binary file.
const MERGE_FILE_MAX_CONFLICTS = 127

function commandError(argv: readonly string[], result: RunResult): Error {
  const line = result.stderr.split('\n').find(text => text.trim() !== '')?.trim() ?? '(no error output)'
  return new Error(`${argv.join(' ')} failed with exit code ${result.exitCode}: ${line}`)
}

// Runs a command that has to succeed and returns its stdout. Every caller either parses that stdout or expects none, and the
// host keeps only its first 4 MiB, so cut output fails as well.
async function must(run: GitRun, argv: readonly string[], init: RunInit): Promise<string> {
  const result = await run(argv, init)
  if (result.exitCode !== 0) throw commandError(argv, result)
  if (result.isStdoutTruncated) throw new Error(`${argv.join(' ')} printed more than the host keeps, so its output was cut off`)
  return result.stdout
}

// The absolute git dir of the working tree at `cwd`; in a linked worktree that is its own folder under .git/worktrees/.
// The paths below join a repository path onto `cwd`, so `cwd` has to be the top level: from a subfolder they would name
// other files.
async function gitDir(run: GitRun, cwd: string): Promise<string> {
  const [dir = '', prefix = ''] = (await must(run, ['git', 'rev-parse', '--absolute-git-dir', '--show-prefix'], { cwd })).split('\n')
  if (prefix !== '') throw new Error(`${cwd} is not the top level of its git working tree (it is the subfolder ${prefix})`)
  return dir
}

// A new folder under the git dir for one call's scratch files, removed afterwards whatever happens. mktemp keeps calls that
// run at the same time apart, and the git dir keeps the files out of every working tree, where `git add -A` would take them.
async function withTemp<T>(run: GitRun, cwd: string, body: (temp: string) => Promise<T>): Promise<T> {
  const temp = (await must(run, ['mktemp', '-d', `${await gitDir(run, cwd)}/dag-tmp.XXXXXX`], { cwd })).trim()
  try {
    return await body(temp)
  } finally {
    await must(run, ['rm', '-rf', temp], { cwd })
  }
}

// The tree of the files at `cwd` as they are now, staged or not, tracked or not, built in a temporary index so the person's
// own index never changes. read-tree HEAD first keeps tracked files that a .gitignore pattern also matches. An exclude
// pathspec on `add` fails when the excluded folder is gitignored, so node worktrees and linked folders are removed from the
// temporary index afterwards instead; in a worktree a linked folder is a symlink, which a `node_modules/` pattern misses.
// `add -A` records a nested worktree as a gitlink, and `rm --cached` refuses to drop one whose checkout has edits or untracked
// files ("staged content different from both the file and the HEAD"), which a running node's worktree always has; -f is
// safe because only the temporary index changes.
export async function workingTree(run: GitRun, cwd: string, linked: readonly string[]): Promise<string> {
  return withTemp(run, cwd, async temp => {
    const init = { cwd, env: { GIT_INDEX_FILE: `${temp}/index` } }
    await must(run, ['git', 'read-tree', 'HEAD'], init)
    await must(run, ['git', 'add', '-A'], init)
    await must(run, ['git', 'rm', '--cached', '-r', '-f', '-q', '--ignore-unmatch', '--', WORKTREES_DIR, ...linked], init)
    return (await must(run, ['git', 'write-tree'], init)).trim()
  })
}

// The main working tree at `root` as an unreferenced commit on top of HEAD, so a worktree can check it out.
export async function snapshot(run: GitRun, root: string, linked: readonly string[]): Promise<Snapshot> {
  const tree = await workingTree(run, root, linked)
  const commit = (await must(run, ['git', ...IDENTITY, 'commit-tree', tree, '-p', 'HEAD', '-m', 'dag snapshot'], { cwd: root })).trim()
  return { commit, tree }
}

// A detached worktree at `commit` in <root>/.claude/worktrees/<name>, where Claude Code 2.1.308 raised no permission prompt
// for a node's edits. Each linked folder that exists in `root` becomes a symlink in it, so the node's tools find their
// dependencies without a fresh install. Returns the worktree's path.
export async function createWorktree(run: GitRun, root: string, name: string, commit: string, linked: readonly string[]): Promise<string> {
  const path = `${root}/${WORKTREES_DIR}/${name}`
  await must(run, ['git', 'worktree', 'add', '-q', '--detach', path, commit], { cwd: root })
  for (const folder of linked) {
    const source = `${root}/${folder}`
    if ((await run(['test', '-e', source], { cwd: root })).exitCode === 0) await must(run, ['ln', '-s', source, `${path}/${folder}`], { cwd: root })
  }
  return path
}

// The blob `tree` holds at `path`, or undefined when the path is absent there.
async function blobId(run: GitRun, cwd: string, tree: string, path: string): Promise<string | undefined> {
  const result = await run(['git', 'rev-parse', '-q', '--verify', `${tree}:${path}`], { cwd })
  return result.exitCode === 0 ? result.stdout.trim() : undefined
}

// The blob id the main tree's file at `path` would get, or undefined when nothing is there.
async function fileId(run: GitRun, root: string, path: string): Promise<string | undefined> {
  const file = `${root}/${path}`
  if ((await run(['test', '-e', file], { cwd: root })).exitCode !== 0) return undefined
  return (await must(run, ['git', 'hash-object', '--', file], { cwd: root })).trim()
}

// Merges the node's change to one file into a copy of the main tree's file. Returns the merged copy, or undefined when the
// edits overlap. git merge-file merges edits one unchanged line apart; adjacent or same-line edits conflict.
async function mergedCopy(run: GitRun, temp: string, copy: string, current: string, base: string, node: string): Promise<string | undefined> {
  await must(run, ['cp', current, copy], { cwd: temp })
  // unpack-file writes the blob to a new .merge_file_XXXXXX in its cwd and prints that name.
  const baseFile = `${temp}/${(await must(run, ['git', 'unpack-file', base], { cwd: temp })).trim()}`
  const argv = ['git', 'merge-file', copy, baseFile, node]
  const result = await run(argv, { cwd: temp })
  if (result.exitCode === 0) return copy
  if (result.exitCode <= MERGE_FILE_MAX_CONFLICTS) return undefined
  throw commandError(argv, result)
}

function nulList(stdout: string): string[] {
  return stdout.split('\0').filter(path => path !== '')
}

// `git diff --numstat -z` prints `<added>\t<deleted>\t<path>\0`, with `-` for both counts when either side is binary.
function binaryPaths(numstat: string): Set<string> {
  const binary = '-\t-\t'
  return new Set(nulList(numstat).filter(entry => entry.startsWith(binary)).map(entry => entry.slice(binary.length)))
}

// One file the node's change writes into the main tree: copied from `source`, or deleted when there is none.
type Write = { path: string; source?: string }

// Takes the node's change from `baseTree` (the snapshot it started from) to `nodeTree` into the main tree at `root`, deciding
// each changed file with fileAction against what the main tree holds now. Every file is decided first, merged copies
// included, and only when none conflicts are they written, so a conflict leaves `root` as it was. File content never passes
// through stdout, which the host cuts and decodes as text: files move with cp, and git unpack-file writes the merge base.
export async function applyNode(run: GitRun, root: string, worktree: string, baseTree: string, nodeTree: string): Promise<ApplyResult> {
  const changed = nulList(await must(run, ['git', 'diff', '--name-only', '--no-renames', '-z', baseTree, nodeTree], { cwd: root }))
  const binary = binaryPaths(await must(run, ['git', 'diff', '--numstat', '--no-renames', '-z', baseTree, nodeTree], { cwd: root }))
  return withTemp(run, root, async temp => {
    const writes: Write[] = []
    const conflicts: string[] = []
    for (const [index, path] of changed.entries()) {
      const base = await blobId(run, root, baseTree, path)
      const node = await blobId(run, root, nodeTree, path)
      const action = fileAction({ base, current: await fileId(run, root, path), node })
      if (action === 'take') writes.push({ path, source: `${worktree}/${path}` })
      else if (action === 'delete') writes.push({ path })
      else if (action === 'conflict' || (action === 'merge' && binary.has(path))) conflicts.push(path)
      else if (action === 'merge') {
        const merged = await mergedCopy(run, temp, `${temp}/${index}`, `${root}/${path}`, `${baseTree}:${path}`, `${worktree}/${path}`)
        if (merged === undefined) conflicts.push(path)
        else writes.push({ path, source: merged })
      }
    }
    if (conflicts.length > 0) return { conflicts }
    await writeChanges(run, root, writes)
    return { applied: writes.map(entry => entry.path) }
  })
}

// Deletions go first, so a node that turned a file into a folder of the same name can then create the folder.
async function writeChanges(run: GitRun, root: string, writes: readonly Write[]): Promise<void> {
  for (const { path, source } of writes) {
    if (source === undefined) await must(run, ['rm', '-f', `${root}/${path}`], { cwd: root })
  }
  const parents = new Set(writes.flatMap(({ path, source }) => source !== undefined && path.includes('/') ? [`${root}/${path.slice(0, path.lastIndexOf('/'))}`] : []))
  if (parents.size > 0) await must(run, ['mkdir', '-p', ...parents], { cwd: root })
  for (const { path, source } of writes) {
    if (source !== undefined) await must(run, ['cp', source, `${root}/${path}`], { cwd: root })
  }
}

// prune also drops the records of node worktrees whose folders went away some other way.
export async function removeWorktree(run: GitRun, root: string, path: string): Promise<void> {
  await must(run, ['git', 'worktree', 'remove', '--force', path], { cwd: root })
  await must(run, ['git', 'worktree', 'prune'], { cwd: root })
}

// The plugin's worktrees of the repository at `root`: directly under its .claude/worktrees/ and named by worktreeName. The
// folder check keeps a clean-up away from the main checkout and from worktrees made elsewhere, even when the project folder
// itself is called dag-something. git prints resolved paths, so the folder comes from git (--show-toplevel) too.
export async function listWorktrees(run: GitRun, root: string): Promise<string[]> {
  const parent = `${(await must(run, ['git', 'rev-parse', '--show-toplevel'], { cwd: root })).trim()}/${WORKTREES_DIR}/`
  const porcelain = await must(run, ['git', 'worktree', 'list', '--porcelain'], { cwd: root })
  return porcelain.split('\n').flatMap(line => {
    const path = line.startsWith('worktree ') ? line.slice('worktree '.length) : ''
    const name = path.startsWith(parent) ? path.slice(parent.length) : ''
    return !name.includes('/') && isNodeWorktree(name) ? [path] : []
  })
}
