# Node worktree isolation spike on Claude Code 2.1.308
Date: 2026-10-23
Plugin: HEAD 2526d6b; the plugin itself was not loaded (`enabledPlugins` false), so nothing here depends on its hooks.
Why: step 0 of the node worktree isolation plan ("dag-workflow 실행 계획: worktree 격리 · Workflows 공존", 2026-10-23). It
picks how a node gets its own git worktree before any plugin code changes: A = host isolation (`isolation: 'worktree'` on
an agent the plugin registers), B = the plugin makes the worktree and runs the node there through the spawn `cwd`,
C = the plugin makes the worktree and hands it to the host through the `WorktreeCreate` hook.
Runner: a throwaway probe plugin (scratchpad, not part of this repo) loaded with `--plugin-dir`. It registers the slash
command `/wtprobe-go`, an agent `wtprobe:iso` with `isolation: 'worktree'`, and observing hooks on `agent.spawn`,
`classic.WorktreeCreate`, `classic.WorktreeRemove`, `classic.PermissionRequest` and `turn.complete`. Each probe is
`claude -p "/wtprobe-go ..." --plugin-dir <probe> --model sonnet --output-format json` in a scratch repo with one commit,
a modified tracked file (`a.txt`) and an untracked file (`uncommitted.txt`). The spawned agent runs plain git and `ls`
commands, writes `probe-edit.txt` in its working directory, and tries one Write outside its worktree.

## Answers

| # | Question | Result |
| --- | --- | --- |
| 1 | Where does host isolation start? | At HEAD. The worktree was `.claude/worktrees/agent-<agentId>` on a new branch `worktree-agent-<agentId>`; `a.txt` held the committed text and `uncommitted.txt` was missing. The worktree and branch were still there after the agent ended (no `WorktreeRemove`). A compound Bash command that redirected to a file outside the worktree was refused by the host ("can't verify ... stays inside its worktree"). |
| 2 | Can the plugin choose the worktree through `WorktreeCreate`? | Yes. The hook fired inside the spawn with `name: agent-<agentId>` (before the spawn returned the id); answering `{ worktreePath }` with a plugin-made snapshot worktree made the isolated agent run there, and it saw the modified `a.txt` and `uncommitted.txt`. |
| 3 | Does `$.agent.spawn({ cwd })` run the agent in that folder? | No. With `cwd` set to a worktree, the agent's `pwd` was the session folder and it wrote `probe-edit.txt` into the main checkout, with and without an `agent.spawn` hook registered; the `agent.spawn` hook input carried no `cwd`. Rewriting the spawn in the `agent.spawn` hook, `next({ ...e, cwd })`, did run the agent in the worktree. |
| 4 | Where should node worktrees live? | Inside the project. Under `--permission-mode acceptEdits` a worktree in `.claude/worktrees/` raised no permission request for Bash reads or edits inside it; a worktree outside the project raised one for `ls -a`, `cat a.txt` and the Write inside the worktree. A Write outside the project raised one in both cases. |
| 5 | What do snapshot, create, apply and remove cost? | Table below: about 0.2 s per node in this repo, about 0.4 s in a 2,000-file repo with 20,000 ignored files. |
| 6 | Can a node's change be applied without touching the person's index? | Yes, with plain `git apply` (working tree only) or `git merge-file`; the staged content (`git ls-files -s`, `git diff --cached`) was the same after every apply. `git apply --3way` is unusable: it needs the index to match the working tree and reported a conflict in every case below. |

## Cost per node, median of 5 (max in brackets), ms

| Repo | Snapshot | `worktree add` | Apply | `worktree remove --force` |
| --- | --- | --- | --- | --- |
| clone of this repo at 2526d6b (228 tracked files, 13 MB .git), one modified and one untracked file | 55 (60) | 38 (39) | 80 (82) | 18 (18) |
| synthetic: 2,000 tracked files, `node_modules/` with 20,000 ignored files, linked into the worktree | 81 (87) | 112 (120) | 145 (147) | 77 (79) |

Snapshot = with a temporary `GIT_INDEX_FILE`: `read-tree HEAD`, `add -A`, `rm --cached -r --ignore-unmatch -- .claude/worktrees <linked dependency folders>`, `write-tree`, `commit-tree -p HEAD`. Apply = the node worktree's tree made the same way, then `git diff --binary <snapshot tree> <node tree> | git apply` in the main checkout.

## Sibling edits to one 300-line file, applied after sibling A

| Lines changed by A and B | plain `git apply` | `git apply --3way` | `git merge-file` |
| --- | --- | --- | --- |
| 10 and 200 | applied | conflict | clean |
| 10 and 14 | applied | conflict | clean |
| 10 and 12 | refused | conflict | clean |
| 10 and 11 | refused | conflict | 1 conflict |
| 10 and 10 | refused | conflict | 1 conflict |

A refused plain apply left the file unchanged. `git merge-file -p <main file> <snapshot file> <node file>` merges changes separated by one unchanged line and reports only adjacent or same-line edits as conflicts.

## Pitfalls found

- `git add -A -- . ':(exclude)node_modules'` fails ("paths are ignored by one of your .gitignore files") when the excluded folder is ignored; remove such paths from the temporary index with `git rm --cached --ignore-unmatch` instead of excluding them.
- A symlink named `node_modules` is not matched by the ignore pattern `node_modules/` (it is not a directory to git), so a linked dependency folder shows as untracked in the worktree and must be dropped from the node's tree by name.
- `git add -A` in the main checkout would also pick up the node worktrees under `.claude/worktrees/`; they are dropped the same way.

## Reading

- A is out: host isolation starts from HEAD, so a node would not see uncommitted work or the results its dependencies applied.
- C works, but the isolation is a property of the agent definition: every isolated node would run as a plugin-registered agent with the plugin's own system prompt instead of `general-purpose` or the node's `agent`, and the `WorktreeCreate` hook fires for every isolated agent in the session, so the plugin would have to tell its own spawns from the person's. Its gain is the host's Bash boundary check.
- B works when the `cwd` is set in the plugin's `agent.spawn` hook, keeps every agent type and system prompt, and needs no global hook. It has no host boundary, so the plugin refuses an isolated node's Edit or Write outside its worktree in `tool.call`. Recommended: B, with `git merge-file` per changed file for the apply (all files merged before any is written; a conflict fails the node).
- Side finding: `startNode` passes `cwd: rootOf(run)` as a `$.agent.spawn` argument, which 2.1.308 ignores (question 3). A run in a git worktree still works while the session itself is in that worktree, because the agent inherits the session folder, but not after the session leaves it. The same `agent.spawn` rewrite fixes it.
- Not measured: an interactive session, Windows, and the host's own clean-up of a `WorktreeCreate` path.
