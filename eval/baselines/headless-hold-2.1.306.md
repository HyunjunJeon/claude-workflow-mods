# Headless `/dag run` hold on Claude Code 2.1.306
Date: 2026-10-22
Plugin: HEAD ca68be0, loaded with `--plugin-dir` from this checkout (clean tree).
Why: the 2.1.299 changelog fixed "a mod that submits a prompt at the end of every turn keeping a headless run going past --max-turns, --max-budget-usd, an interrupt, or the end of the host's conversation", and 2.1.304 fixed "a plugin keeping a headless run going past --max-turns, Stop, or ended input by spawning subagents or re-running a finished one". Both describe the keep-alive in `openHeldTurn` and `keepSessionUp`. The 2026-10-19 measurement (5 of 14 `/dag run` sessions closed as the first node ended) recorded no host version and predates `openHeldTurn`.
Runner: a scratch script, not part of eval/. Each trial is a fresh `git init` folder holding a 3-node chain (`a` -> `b` -> `verify-chain`, trivial nodes that each write one line to a.txt, b.txt, c.txt, checked with `equals`), run as
`claude -p "/dag run chain.yaml" --plugin-dir <repo> --model sonnet --output-format stream-json --verbose --allowedTools mcp__dag-workflow__dag Skill Read Write Edit Bash TaskStop ToolSearch LSP --settings <pluginConfigs: session_learning false, jev_enabled false, trajectory_log false>`, 12 min timeout.
No `--max-turns`, `--max-budget-usd` or interrupt was used, so these runs show the keep-alive path, not the limits the two fixes enforce.

## Short chain (each node about 10 s), 10 trials, 2 at a time

| result | count |
| --- | --- |
| run `completed`, all 3 nodes completed, 3 files correct | 10/10 |
| process exit 0, no timeout | 10/10 |
| "no session is bound" in output | 0 |
| `headless session` warning on stderr | 0 |

Wall time 46-56 s (mean 49 s). Every session ended after 6 turns: the `/dag run` output, the reply to the run-started prompt, one reply per node keep-alive (2 or 3), and the reply to the settle summary. Plugin-submitted prompts are not echoed as `user` events in stream-json; the turns show only as `result` events. The process exited 10-20 s after the last node finished (the settle turn).

## Middle node over 60 s, 3 trials at once

Node b was told to run `sleep 75` first. Claude Code's Bash tool refuses a standalone `sleep 75` ("Blocked: standalone sleep 75. To wait for a condition, use Monitor with an until-loop"), so the length of b depended on the worker's workaround.

| trial | b duration | b attempts | run | wall |
| --- | --- | --- | --- | --- |
| 1 | 18 s (gave up on the wait) | 1 | completed | 72 s |
| 2 | 105 s | 1 | completed | 145 s |
| 3 | 93 s | 2 (attempt 1 failed on the refused sleep; the headless main turn retried it) | completed | 180 s |

Trials 2 and 3 held the main turn through a node longer than 60 s and still completed, with no `headless session` warning on stderr.

## Reading

On 2.1.306 the keep-alive keeps a plain headless `/dag run` up until the run settles (13/13 runs completed, 2 of them through a node longer than 60 s). The 2.1.299 and 2.1.304 fixes do not stop it when no turn, budget or interrupt limit is set. Not measured: runs with `--max-turns` or `--max-budget-usd`, where the host is now expected to end the session early, and prompt-planned runs (eval/run.ts covers those).
