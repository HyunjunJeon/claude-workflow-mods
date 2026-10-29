import { expect, test } from 'claude-code/testing'
import { applyNode, createWorktree, listWorktrees, snapshot, type GitRun } from '../hooks/engine/worktree.ts'

// worktree.ts runs every command through an injected GitRun, the host's process boundary. These tests fake that boundary;
// scripts/worktree-check.ts runs the same code against real git.

type Answer = { exitCode?: number; stdout?: string; stderr?: string; isStdoutTruncated?: boolean }
type Call = { line: string; argv: readonly string[]; env?: Record<string, string> }

// Records every call and answers from a table keyed by the start of the command line; the first matching row wins and any
// other command succeeds with no output.
function fakeGit(table: Array<[prefix: string, answer: Answer]>): { run: GitRun; calls: Call[] } {
  const calls: Call[] = []
  const run: GitRun = async (argv, init) => {
    const line = argv.join(' ')
    calls.push({ line, argv, env: init.env })
    const answer = table.find(([prefix]) => line.startsWith(prefix))?.[1] ?? {}
    return { exitCode: answer.exitCode ?? 0, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '', isStdoutTruncated: answer.isStdoutTruncated }
  }
  return { run, calls }
}

const TEMP = '/work/.git/dag-tmp.abc123'
const TEMP_INDEX = `${TEMP}/index`
const WORKTREE = '/work/.claude/worktrees/dag-run-build-1'

const GIT_DIR_ROWS: Array<[string, Answer]> = [
  ['git rev-parse --absolute-git-dir --show-prefix', { stdout: '/work/.git\n\n' }],
  ['mktemp -d /work/.git/dag-tmp.XXXXXX', { stdout: `${TEMP}\n` }],
]

const SNAPSHOT_ROWS: Array<[string, Answer]> = [
  ...GIT_DIR_ROWS,
  ['git write-tree', { stdout: 'tree1\n' }],
  ['git -c user.name=dag-workflow -c user.email=dag-workflow@localhost commit-tree tree1 -p HEAD', { stdout: 'commit1\n' }],
]

// git subcommands that read or write the index named by GIT_INDEX_FILE (or the real one without it).
const INDEX_COMMANDS = new Set(['add', 'rm', 'mv', 'read-tree', 'write-tree', 'update-index', 'checkout', 'checkout-index', 'reset', 'restore', 'switch', 'stash', 'commit', 'merge', 'apply'])

function subcommand(argv: readonly string[]): string | undefined {
  let at = 1
  while (argv[at] === '-c') at += 2
  return argv[at]
}

// A change of two files: a.txt changed only by the node (taken), b.txt changed by the node and the main tree (merged).
function twoFileRows(mergeExit: number): Array<[string, Answer]> {
  return [
    ['git diff --name-only --no-renames -z base node', { stdout: 'a.txt\0b.txt\0' }],
    ['git diff --numstat --no-renames -z base node', { stdout: '1\t1\ta.txt\x001\t1\tb.txt\0' }],
    ...GIT_DIR_ROWS,
    ['git rev-parse -q --verify base:a.txt', { stdout: 'a0\n' }],
    ['git rev-parse -q --verify node:a.txt', { stdout: 'a1\n' }],
    ['git hash-object -- /work/a.txt', { stdout: 'a0\n' }],
    ['git rev-parse -q --verify base:b.txt', { stdout: 'b0\n' }],
    ['git rev-parse -q --verify node:b.txt', { stdout: 'b1\n' }],
    ['git hash-object -- /work/b.txt', { stdout: 'b2\n' }],
    ['git unpack-file base:b.txt', { stdout: '.merge_file_q1w2e3\n' }],
    ['git merge-file', { exitCode: mergeExit, stderr: mergeExit === 0 ? '' : 'warning: conflicts' }],
  ]
}

// The commands that change the main tree at /work, by their target (the last argument). Scratch files under its git dir do
// not count, and neither does a main-tree file read as a cp source.
function mainTreeWrites(calls: readonly Call[]): string[] {
  return calls.filter(({ argv }) => {
    const target = argv[argv.length - 1] ?? ''
    return ['cp', 'rm', 'mkdir', 'ln', 'mv'].includes(argv[0] ?? '') && target.startsWith('/work/') && !target.startsWith('/work/.git/')
  }).map(call => call.line)
}

test('the snapshot builds its tree in a temporary index under the git dir', async () => {
  const { run, calls } = fakeGit(SNAPSHOT_ROWS)
  expect(await snapshot(run, '/work', ['node_modules'])).toEqual({ commit: 'commit1', tree: 'tree1' })
  const indexCalls = calls.filter(({ argv }) => argv[0] === 'git' && INDEX_COMMANDS.has(subcommand(argv) ?? ''))
  expect(indexCalls.map(call => [call.line, call.env?.GIT_INDEX_FILE])).toEqual([
    ['git read-tree HEAD', TEMP_INDEX],
    ['git add -A', TEMP_INDEX],
    ['git rm --cached -r -f -q --ignore-unmatch -- .claude/worktrees node_modules', TEMP_INDEX],
    ['git write-tree', TEMP_INDEX],
  ])
})

test('the snapshot never runs a git command that touches an index without GIT_INDEX_FILE', async () => {
  const { run, calls } = fakeGit(SNAPSHOT_ROWS)
  await snapshot(run, '/work', ['node_modules', '.venv'])
  const unguarded = calls.filter(({ argv, env }) => argv[0] === 'git' && env?.GIT_INDEX_FILE === undefined && INDEX_COMMANDS.has(subcommand(argv) ?? ''))
  expect(unguarded.map(call => call.line)).toEqual([])
})

test('the snapshot removes its temporary folder', async () => {
  const { run, calls } = fakeGit(SNAPSHOT_ROWS)
  await snapshot(run, '/work', [])
  expect(calls.map(call => call.line)).toContain(`rm -rf ${TEMP}`)
})

test('a failed git command throws with the command and the first stderr line, and the temporary folder is still removed', async () => {
  const { run, calls } = fakeGit([['git add -A', { exitCode: 128, stderr: 'fatal: unable to index file x\nhint: more\n' }], ...SNAPSHOT_ROWS])
  await expect(snapshot(run, '/work', [])).rejects.toThrow('git add -A failed with exit code 128: fatal: unable to index file x')
  expect(calls.map(call => call.line)).toContain(`rm -rf ${TEMP}`)
})

test('a root inside a subfolder of its repository is refused before anything is written', async () => {
  const { run, calls } = fakeGit([['git rev-parse --absolute-git-dir --show-prefix', { stdout: '/work/.git\nsub/\n' }]])
  await expect(snapshot(run, '/work/sub', [])).rejects.toThrow('/work/sub is not the top level of its git working tree (it is the subfolder sub/)')
  expect(calls.map(call => call.line)).toEqual(['git rev-parse --absolute-git-dir --show-prefix'])
})

test('applyNode writes nothing to the main tree when one of two changed files conflicts', async () => {
  const { run, calls } = fakeGit(twoFileRows(1))
  expect(await applyNode(run, '/work', WORKTREE, 'base', 'node')).toEqual({ conflicts: ['b.txt'] })
  expect(mainTreeWrites(calls)).toEqual([])
  expect(calls.map(call => call.line)).toContain(`rm -rf ${TEMP}`)
})

test('applyNode writes both files when neither conflicts: the node file taken, the merged copy for the other', async () => {
  const { run, calls } = fakeGit(twoFileRows(0))
  expect(await applyNode(run, '/work', WORKTREE, 'base', 'node')).toEqual({ applied: ['a.txt', 'b.txt'] })
  expect(mainTreeWrites(calls)).toEqual([`cp ${WORKTREE}/a.txt /work/a.txt`, `cp ${TEMP}/1 /work/b.txt`])
})

test('applyNode merges a copy of the main file with the base blob and the node file', async () => {
  const { run, calls } = fakeGit(twoFileRows(0))
  await applyNode(run, '/work', WORKTREE, 'base', 'node')
  expect(calls.filter(({ argv }) => argv[1] === 'merge-file').map(call => call.line)).toEqual([`git merge-file ${TEMP}/1 ${TEMP}/.merge_file_q1w2e3 ${WORKTREE}/b.txt`])
})

test('a binary file changed by the node and the main tree is a conflict', async () => {
  const { run } = fakeGit([
    ['git diff --name-only --no-renames -z base node', { stdout: 'logo.png\0' }],
    ['git diff --numstat --no-renames -z base node', { stdout: '-\t-\tlogo.png\0' }],
    ...GIT_DIR_ROWS,
    ['git rev-parse -q --verify base:logo.png', { stdout: 'p0\n' }],
    ['git rev-parse -q --verify node:logo.png', { stdout: 'p1\n' }],
    ['git hash-object -- /work/logo.png', { stdout: 'p2\n' }],
  ])
  expect(await applyNode(run, '/work', WORKTREE, 'base', 'node')).toEqual({ conflicts: ['logo.png'] })
})

test('a git merge-file error is thrown, not counted as a conflict', async () => {
  const { run } = fakeGit([['git merge-file', { exitCode: 255, stderr: 'error: Cannot merge binary files: x\n' }], ...twoFileRows(0)])
  await expect(applyNode(run, '/work', WORKTREE, 'base', 'node')).rejects.toThrow('failed with exit code 255: error: Cannot merge binary files: x')
})

test('a new file in a new folder, with a space and Hangul in its name, gets its folder made and is copied', async () => {
  const path = 'docs/새 문서.md'
  const { run, calls } = fakeGit([
    ['git diff --name-only --no-renames -z base node', { stdout: `${path}\0gone.txt\0` }],
    ...GIT_DIR_ROWS,
    [`git rev-parse -q --verify node:${path}`, { stdout: 'n1\n' }],
    [`test -e /work/${path}`, { exitCode: 1 }],
    ['git rev-parse -q --verify base:gone.txt', { stdout: 'g0\n' }],
    ['git rev-parse -q --verify node:gone.txt', { exitCode: 1 }],
    ['git hash-object -- /work/gone.txt', { stdout: 'g0\n' }],
    ['git rev-parse -q --verify', { exitCode: 1 }],
  ])
  expect(await applyNode(run, '/work', WORKTREE, 'base', 'node')).toEqual({ applied: [path, 'gone.txt'] })
  expect(mainTreeWrites(calls)).toEqual(['rm -f /work/gone.txt', 'mkdir -p /work/docs', `cp ${WORKTREE}/${path} /work/${path}`])
})

test('a truncated stdout throws instead of reading a cut list of changed files', async () => {
  const { run, calls } = fakeGit([['git diff --name-only', { stdout: 'a.txt\0', isStdoutTruncated: true }], ...twoFileRows(0)])
  await expect(applyNode(run, '/work', WORKTREE, 'base', 'node')).rejects.toThrow('git diff --name-only --no-renames -z base node printed more than the host keeps')
  expect(mainTreeWrites(calls)).toEqual([])
})

test('createWorktree links each dependency folder that exists in the main tree and skips the others', async () => {
  const { run, calls } = fakeGit([['test -e /work/.venv', { exitCode: 1 }]])
  expect(await createWorktree(run, '/work', 'dag-run-build-1', 'commit1', ['node_modules', '.venv'])).toBe(WORKTREE)
  expect(calls.filter(({ argv }) => argv[0] !== 'test').map(call => call.line)).toEqual([
    `git worktree add -q --detach ${WORKTREE} commit1`,
    `ln -s /work/node_modules ${WORKTREE}/node_modules`,
  ])
})

test('listWorktrees keeps only node worktrees directly under the project .claude/worktrees, even in a dag- named project', async () => {
  const root = '/srv/dag-site'
  const porcelain = [
    `worktree ${root}`, 'HEAD 1111', 'branch refs/heads/main', '',
    `worktree ${root}/.claude/worktrees/dag-run-a-1`, 'HEAD 2222', 'detached', '',
    `worktree ${root}/.claude/worktrees/mine`, 'HEAD 3333', 'detached', '',
    `worktree ${root}/.claude/worktrees/dag-run-a-1/.claude/worktrees/dag-run-b-1`, 'HEAD 4444', 'detached', '',
    'worktree /elsewhere/dag-run-c-1', 'HEAD 5555', 'detached', '',
  ].join('\n')
  const { run } = fakeGit([['git rev-parse --show-toplevel', { stdout: `${root}\n` }], ['git worktree list --porcelain', { stdout: porcelain }]])
  expect(await listWorktrees(run, root)).toEqual([`${root}/.claude/worktrees/dag-run-a-1`])
})
