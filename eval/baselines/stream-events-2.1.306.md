# Node stream events on Claude Code 2.1.306
Date: 2026-10-22
Plugin: HEAD 91f1683, loaded with `--plugin-dir` from this checkout (clean tree).
Why: `pollTranscripts` (hooks/register.ts) reads a running node's transcript with `$.session.messages({ agentId })` every 2 s when the node has no stream activity yet, and the outside review of 2026-10-22 asked whether nodes started after the first wave get any stream events (the 2.1.299 changelog: "Changed the `turn.start` mod hook to also hear subagents' and teammates' turns"). The poll has been in the plugin since its first commit (2716d4c) as a fallback; no earlier measurement of missing streams was recorded.
Runner: a scratch script, not part of eval/. Each trial is a fresh `git init` folder holding a 4-node DAG (`a1` and `a2` in parallel, then `b` after both, then `verify-c`; trivial nodes that each Read the definition and Write one line), run as
`claude -p "/dag run fan.yaml" --plugin-dir <repo> --model sonnet --debug-file <trial>/debug.txt --allowedTools ... --settings <pluginConfigs: session_learning false, jev_enabled false, trajectory_log false>`.
The plugin's debug lines `agent <id> (<run>/<node>) seen via <source>` (seenAgent, once per agent and source) give the first sighting of each node's agent per host event.

## Result, 3 trials

| trial | run | wall | nodes first seen via turn.step | nodes seen via transcript poll |
| --- | --- | --- | --- | --- |
| 1 | completed | 82 s | 4/4 | 0 |
| 2 | completed | 71 s | 4/4 | 0 |
| 3 | completed | 76 s | 4/4 | 0 |

Every node's order was turn.step, then tool.call, then turn.complete. The nodes started from completions (`b`, `verify-c`) were seen via turn.step 0.1-0.2 s after the node before them ended, for example trial 2: `a2` turn.complete 07:21:33.479, `b` turn.step 07:21:33.662.

## Reading

On 2.1.306 every node agent, in the first wave or started later from a completion, streams through `turn.step` from its first turn, so `pollTranscripts` never reads a transcript: it skips an agent whose activity came from the stream. The poll stays as the fallback for hosts that do not raise `turn.step` for subagents; the plugin supports Claude Code from 2.1.287, and 2.1.287-2.1.298 were not measured. Removing it needs that measurement or a higher minimum version. Not measured: an interactive session (the probe is headless).
