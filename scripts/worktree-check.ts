import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { LINKED_DEFAULT, worktreeName } from '../hooks/engine/isolation.ts'
import { applyNode, createWorktree, listWorktrees, removeWorktree, snapshot, workingTree, type ApplyResult, type GitRun, type Snapshot } from '../hooks/engine/worktree.ts'

// Runs hooks/engine/worktree.ts against real git in a throwaway repository and prints one PASS or FAIL line per scenario.
// The unit tests (tests/worktree.test.ts) fake git, so only this script shows the recipe holds on the git that is installed.
// Usage: bun scripts/worktree-check.ts   (no arguments; the last line is `worktree check: all passed` only when every
// scenario passed, and the exit code is 1 otherwise). The repository lives under the system temp folder and is removed.

// Large enough for any git output these scenarios produce; the host's own limit (4 MiB) is what worktree.ts guards against.
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

const run: GitRun = async (argv, init) => {
  const [command = '', ...args] = argv
  const child = spawnSync(command, args, { cwd: init.cwd, env: { ...process.env, ...init.env }, input: init.stdin, encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES })
  return { exitCode: child.status ?? 1, stdout: child.stdout ?? '', stderr: child.error ? String(child.error) : child.stderr }
}

// The script's own git calls, for setting up and inspecting the repository; they fail loudly.
function git(cwd: string, ...args: string[]): string {
  const child = spawnSync('git', ['-c', 'user.name=check', '-c', 'user.email=check@localhost', ...args], { cwd, encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES })
  if (child.status !== 0) throw new Error(`git ${args.join(' ')}: ${(child.stderr || String(child.error)).trim()}`)
  return child.stdout
}

function check(holds: boolean, why: string): void {
  if (!holds) throw new Error(why)
}

function put(file: string, content: string | Uint8Array): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

function treeFiles(cwd: string, tree: string): string[] {
  return git(cwd, 'ls-tree', '-r', '-z', '--name-only', tree).split('\0').filter(path => path !== '')
}

// What the person's index holds: staged content and the staged difference from HEAD. The bytes of .git/index can change
// without its content changing (seen in the spike), so the content is what is compared.
function indexState(cwd: string): string {
  return git(cwd, 'ls-files', '-s') + git(cwd, 'diff', '--cached', '--name-status')
}

const LINES = Array.from({ length: 300 }, (_, index) => `line ${index + 1}`)

function editLine(file: string, line: number, text: string): void {
  const lines = readFileSync(file, 'utf8').split('\n')
  lines[line - 1] = text
  writeFileSync(file, lines.join('\n'))
}

function show(result: ApplyResult): string {
  return JSON.stringify(result)
}

const LOGO = Uint8Array.from({ length: 256 }, (_, index) => index)
const LOGO_BY_NODE = Uint8Array.from({ length: 300 }, (_, index) => (index * 7) % 256)
const LOGO_BY_SIBLING = Uint8Array.from({ length: 200 }, (_, index) => (index * 3) % 256)
const ADDED = 'added/새 파일.txt'

const root = mkdtempSync(join(realpathSync(tmpdir()), 'worktree-check-'))
const results: boolean[] = []

async function scenario(name: string, body: () => Promise<void>): Promise<void> {
  try {
    await body()
    console.log(`PASS ${name}`)
    results.push(true)
  } catch (error) {
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
    results.push(false)
  }
}

async function nodeWorktree(snap: Snapshot, id: string): Promise<string> {
  return createWorktree(run, root, worktreeName('check', id, 1), snap.commit, LINKED_DEFAULT)
}

async function applyFrom(worktree: string, snap: Snapshot): Promise<ApplyResult> {
  return applyNode(run, root, worktree, snap.tree, await workingTree(run, worktree, LINKED_DEFAULT))
}

try {
  console.log(git(root, 'version').trim())
  git(root, 'init', '-q')
  put(join(root, 'big.txt'), LINES.join('\n') + '\n')
  put(join(root, 'a.txt'), 'committed\n')
  put(join(root, 'other.txt'), 'other\n')
  put(join(root, 'gone.txt'), 'gone\n')
  put(join(root, 'logo.bin'), LOGO)
  put(join(root, '.gitignore'), 'node_modules/\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'init')
  // The main tree as a person leaves it mid-work: an unstaged edit, a staged new file, an untracked file and an installed
  // dependency folder that .gitignore hides.
  put(join(root, 'a.txt'), 'modified\n')
  put(join(root, 'staged.txt'), 'staged\n')
  git(root, 'add', 'staged.txt')
  put(join(root, 'untracked.txt'), 'untracked\n')
  put(join(root, 'node_modules/pkg/index.js'), 'module.exports = 1\n')

  let snap: Snapshot = { commit: '', tree: '' }
  const worktrees: string[] = []

  await scenario('1 snapshot holds a modified tracked file and an untracked file, and the index is unchanged', async () => {
    const before = indexState(root)
    snap = await snapshot(run, root, LINKED_DEFAULT)
    check(indexState(root) === before, `the index changed:\n${before}---\n${indexState(root)}`)
    const files = treeFiles(root, snap.tree)
    check(files.includes('untracked.txt') && files.includes('staged.txt'), `untracked.txt or staged.txt missing from ${files.join(', ')}`)
    check(git(root, 'show', `${snap.commit}:a.txt`) === 'modified\n', 'a.txt in the snapshot is not the modified text')
    check(git(root, 'rev-parse', `${snap.commit}^`) === git(root, 'rev-parse', 'HEAD'), 'the snapshot commit is not on top of HEAD')
    check(git(root, 'rev-parse', `${snap.commit}^{tree}`).trim() === snap.tree, 'the snapshot commit does not hold the snapshot tree')
  })

  await scenario('2 two siblings from one snapshot edit lines 10 and 12 of one 300-line file and both apply', async () => {
    const a = await nodeWorktree(snap, 'a')
    const b = await nodeWorktree(snap, 'b')
    worktrees.push(a, b)
    check(readFileSync(join(a, 'a.txt'), 'utf8') === 'modified\n' && existsSync(join(a, 'untracked.txt')), 'the worktree does not hold the snapshot files')
    editLine(join(a, 'big.txt'), 10, 'line 10 by a')
    editLine(join(b, 'big.txt'), 12, 'line 12 by b')
    const first = await applyFrom(a, snap)
    check(show(first) === show({ applied: ['big.txt'] }), `a: ${show(first)}`)
    const second = await applyFrom(b, snap)
    check(show(second) === show({ applied: ['big.txt'] }), `b: ${show(second)}`)
    const expected = LINES.map((line, index) => index === 9 ? 'line 10 by a' : index === 11 ? 'line 12 by b' : line).join('\n') + '\n'
    check(readFileSync(join(root, 'big.txt'), 'utf8') === expected, 'big.txt in the main tree does not hold both edits')
  })

  await scenario('3 a sibling editing the line an applied node changed gets a conflict naming the file, and its clean file is not written', async () => {
    const c = await nodeWorktree(snap, 'c')
    worktrees.push(c)
    editLine(join(c, 'big.txt'), 10, 'line 10 by c')
    put(join(c, 'other.txt'), 'other by c\n')
    const big = readFileSync(join(root, 'big.txt'), 'utf8')
    const result = await applyFrom(c, snap)
    check(show(result) === show({ conflicts: ['big.txt'] }), `c: ${show(result)}`)
    check(readFileSync(join(root, 'other.txt'), 'utf8') === 'other\n', 'other.txt was written although the node conflicted')
    check(readFileSync(join(root, 'big.txt'), 'utf8') === big, 'big.txt changed although it conflicted')
  })

  await scenario('4 a node that adds one file and deletes another applies both', async () => {
    const d = await nodeWorktree(snap, 'd')
    worktrees.push(d)
    put(join(d, ADDED), 'new\n')
    rmSync(join(d, 'gone.txt'))
    const result = await applyFrom(d, snap)
    check(show(result) === show({ applied: [ADDED, 'gone.txt'] }), `d: ${show(result)}`)
    check(readFileSync(join(root, ADDED), 'utf8') === 'new\n', `${ADDED} is not in the main tree`)
    check(!existsSync(join(root, 'gone.txt')), 'gone.txt is still in the main tree')
  })

  await scenario('5 a binary file changed only by the node is taken byte for byte', async () => {
    const e = await nodeWorktree(snap, 'e')
    worktrees.push(e)
    put(join(e, 'logo.bin'), LOGO_BY_NODE)
    const result = await applyFrom(e, snap)
    check(show(result) === show({ applied: ['logo.bin'] }), `e: ${show(result)}`)
    check(Buffer.compare(readFileSync(join(root, 'logo.bin')), LOGO_BY_NODE) === 0, 'logo.bin in the main tree differs from the node bytes')
  })

  await scenario('6 a gitignored node_modules is linked into the worktree, left out of the node tree, and the snapshot did not fail', async () => {
    const [a = ''] = worktrees
    const link = join(a, 'node_modules')
    check(lstatSync(link).isSymbolicLink() && readlinkSync(link) === join(root, 'node_modules'), `${link} is not a symlink to the main node_modules`)
    check(!existsSync(join(a, '.venv')), '.venv was linked although the main tree has none')
    const files = treeFiles(a, await workingTree(run, a, LINKED_DEFAULT))
    check(!files.some(path => path.startsWith('node_modules')), 'node_modules is in the node tree')
    check(!treeFiles(root, snap.tree).some(path => path.startsWith('node_modules')), 'node_modules is in the snapshot')
  })

  await scenario('7 a leftover nested worktree under .claude/worktrees/ is not in the snapshot', async () => {
    const leftover = join(root, '.claude/worktrees/leftover')
    git(root, 'worktree', 'add', '-q', '--detach', leftover, 'HEAD')
    put(join(leftover, 'stray.txt'), 'stray\n')
    put(join(root, '.claude/worktrees/notes.txt'), 'notes\n')
    const later = await snapshot(run, root, LINKED_DEFAULT)
    const inside = treeFiles(root, later.tree).filter(path => path.startsWith('.claude/'))
    check(inside.length === 0, `the snapshot holds ${inside.join(', ')}`)
    check(treeFiles(root, later.tree).includes(ADDED), 'the later snapshot misses a file applied earlier')
  })

  await scenario('8 removeWorktree leaves git worktree list without it and keeps the linked folder', async () => {
    const [a = ''] = worktrees
    const listed = await listWorktrees(run, root)
    check(show([...listed].sort()) === show([...worktrees].sort()), `listWorktrees gave ${show(listed)}`)
    await removeWorktree(run, root, a)
    check(!git(root, 'worktree', 'list', '--porcelain').includes(`worktree ${a}\n`), `${a} is still in git worktree list`)
    check(!existsSync(a), `${a} still exists`)
    check(readFileSync(join(root, 'node_modules/pkg/index.js'), 'utf8') === 'module.exports = 1\n', 'removing the worktree touched the linked node_modules')
    check(!(await listWorktrees(run, root)).includes(a), 'listWorktrees still lists the removed worktree')
  })

  await scenario('9 a binary file changed by the node and by the main tree conflicts and is not written', async () => {
    const f = await nodeWorktree(snap, 'f')
    put(join(f, 'logo.bin'), LOGO_BY_SIBLING)
    const result = await applyFrom(f, snap)
    check(show(result) === show({ conflicts: ['logo.bin'] }), `f: ${show(result)}`)
    check(Buffer.compare(readFileSync(join(root, 'logo.bin')), LOGO_BY_NODE) === 0, 'logo.bin in the main tree changed')
  })
} finally {
  rmSync(root, { recursive: true, force: true })
}

const failed = results.filter(passed => !passed).length
console.log(failed === 0 ? 'worktree check: all passed' : `worktree check: ${failed} of ${results.length} failed`)
process.exit(failed === 0 ? 0 : 1)
