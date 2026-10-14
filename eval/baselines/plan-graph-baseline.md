# Eval baseline after the plan-graph doctrine (P6)
Date: 2026-10-14
Plugin HEAD: 6737ddd plus the eval/run.ts MAIN_TOOLS change below
Change under test: skills/planning doctrine — before `start` (and before a shape-changing `amend`) the model draws the
proposed definition as one `flow` block on the session's plan board (`Plan: <run name>`), so a held run's approval
board shows the graph being approved. Should-not-gate: a refused or missing board tool starts anyway.
Runner: bun eval/run.ts in 4 shards of 2 scenarios run one after the other, --concurrency 1 --timeout-min 9 --keep --enforcement strict each, model sonnet
Harness note: `mcp__dag-workflow__board` was added to MAIN_TOOLS for this run — without it the doctrine could only exercise its "start without the board" fallback, since an unlisted tool is denied in a headless session.

Distinct shapes: 3 (single, fan-out/fan-in, fan-out). Distinct producer shapes: 4 (single, parallel, fan-out/fan-in, chain). Scenarios matching their expected shape: 6/8 (baseline 7/8 — see deltas).

Verification: 36/36 nodes verified, 0 failed, 0 missing; automatic retries: 0; start/amend refusals: 0 verification_required, 0 invalid_verification. All 8 runs completed; all 8 outcome checks PASS; skill before start on all 8; the board tool was called in all 8 sessions (list → create → flow insert → start).

| scenario | expected | shape | nodes | depth | layer widths | fan-in | verify node | warnings | categories | status | outcome | skill before start | refusals (planning/tools) | verified/total | time |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| single-edit | direct | single (producers: single) | 1 | 1 | 1 | 0 | false | 0 | trivialx1 | completed | PASS | true | 0/2 | 1/1 | 50s |
| parallel-files | parallel | fan-out/fan-in (producers: parallel) | 4 | 2 | 3-1 | 1 | true | 0 | trivialx2 writingx1 standardx1 | completed | PASS | true | 0/1 | 4/4 | 173s |
| map-reduce-docs | fan-out/fan-in | fan-out/fan-in (producers: fan-out/fan-in) | 8 | 3 | 6-1-1 | 2 | true | 0 | trivialx7 standardx1 | completed | PASS | true | 0/1 | 8/8 | 203s |
| pipeline-stats | chain | chain (producers: chain) | 4 | 4 | 1-1-1-1 | 1 | true | 0 | trivialx3 standardx1 | completed | PASS | true | 0/0 | 4/4 | 247s |
| diamond-app | diamond | fan-out (producers: single) | 3 | 2 | 1-2 | 0 | true | 1 | trivialx1 standardx2 | completed | PASS | true | 0/1 | 3/3 | 124s |
| debug-fix | direct | single (producers: single) | 1 | 1 | 1 | 0 | false | 0 | trivialx1 | completed | PASS | true | 0/1 | 1/1 | 48s |
| wide-harvest | fan-out/fan-in | fan-out/fan-in (producers: fan-out/fan-in) | 5 | 3 | 3-1-1 | 2 | true | 0 | trivialx4 standardx1 | completed | PASS | true | 0/6 | 5/5 | 257s |
| research-write | fan-out/fan-in | fan-out/fan-in (producers: fan-out/fan-in) | 5 | 3 | 3-1-1 | 1 | true | 0 | trivialx2 standardx2 writingx1 | completed | PASS | true | 0/1 | 5/5 | 308s |

## Deltas against eval/baselines/stages-baseline.md (plugin HEAD 2df5ffe, same shard recipe and timeout, pre-rename categories)

| scenario | baseline shape → now | baseline status → now | note |
| --- | --- | --- | --- |
| single-edit | single → single | completed → completed | unchanged |
| parallel-files | fan-out/fan-in (parallel) → same | completed → completed | unchanged, faster |
| map-reduce-docs | fan-out/fan-in → same | completed → completed | unchanged, ~2x faster |
| pipeline-stats | chain → chain | completed → completed | unchanged |
| diamond-app | diamond 6 nodes → fan-out 3 nodes (one producer writes the app, then the two reviews run in parallel) | completed → completed | shape simpler — model judgment, not the doctrine: the doctrine adds a board draw, it does not bias topology; the 1 warning is the standard three-files lint on the single producer |
| debug-fix | single → single | completed → completed | unchanged |
| wide-harvest | fan-out/fan-in 7 nodes → same shape, 5 nodes | completed → completed | unchanged shape family, fewer lanes |
| research-write | fan-out/fan-in 5 nodes → same | completed → completed | unchanged |

## Doctrine evidence (what the P6 text bought)
- Board tool calls per scenario: single-edit 2, parallel-files 4, map-reduce-docs 2, pipeline-stats 3, diamond-app 2, debug-fix 2, wide-harvest 2, research-write 3 — every session drew the plan board before starting.
- research-write's `starts: 2` is the dryRun → preview_id confirm pair, not two real starts.
- The observed order matches the doctrine: `board list` → `create "Plan: <name>"` → one `flow` insert (flow node per definition node, edge per dependsOn) → `dag start`.
- Tool denials (the second refusals column) are main-conversation Bash write refusals under strict, unrelated to the change.

## Sources
- shard-1: eval/results/20261014023837.json — single-edit, parallel-files
- shard-2: eval/results/20261014024253.json — map-reduce-docs, pipeline-stats
- shard-3: eval/results/20261014025207.json — diamond-app, debug-fix
- shard-4: eval/results/20261014025905.json — wide-harvest, research-write
