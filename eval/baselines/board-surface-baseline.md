# Eval baseline after the board-surface split (P11)
Date: 2026-10-15
Plugin HEAD: 40f4d62 plus the eval/run.ts MAIN_TOOLS change below
Change under test: skills/planning doctrine no longer draws the proposed DAG on a plan board before `start` (commit
1205e19), and the plugin no longer draws a result board at settle (40f4d62). Board use now comes from the per-prompt
surface judgment under enforcement auto, which a non-interactive session never asks.
Runner: bun eval/run.ts in 4 shards of 2 scenarios run one after the other, --concurrency 1 --timeout-min 9 --keep --enforcement strict each, model sonnet
Harness note: `mcp__dag-workflow__board` was removed from MAIN_TOOLS (it was added for plan-graph-baseline.md). Nothing in a
headless DAG turn asks for a board now, so an allowed board tool could only add calls the shape eval does not measure.

Distinct shapes: 3 (single, fan-out/fan-in, diamond). Distinct producer shapes: 5 (single, parallel, fan-out/fan-in, chain, diamond). Scenarios matching their expected shape: 6/8 (per shard 1/2, 2/2, 1/2, 2/2; the two misses are the `direct` scenarios, which strict always runs as a one-node DAG).

Verification: 36/36 nodes verified, 0 failed, 0 missing; automatic retries: 0; start/amend refusals: 0 verification_required, 0 invalid_verification. All 8 runs completed; all 8 outcome checks PASS; skill before start on all 8; AskUserQuestion calls: 0.

| scenario | expected | shape | nodes | depth | layer widths | fan-in | verify node | warnings | categories | status | outcome | skill before start | refusals (planning/tools) | verified/total | time |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| single-edit | direct | single (producers: single) | 1 | 1 | 1 | 0 | false | 0 | trivialx1 | completed | PASS | true | 0/2 | 1/1 | 42s |
| parallel-files | parallel | fan-out/fan-in (producers: parallel) | 4 | 2 | 3-1 | 1 | true | 0 | trivialx2 writingx1 standardx1 | completed | PASS | true | 0/0 | 4/4 | 148s |
| map-reduce-docs | fan-out/fan-in | fan-out/fan-in (producers: fan-out/fan-in) | 8 | 3 | 6-1-1 | 2 | true | 0 | trivialx7 standardx1 | completed | PASS | true | 0/0 | 8/8 | 212s |
| pipeline-stats | chain | diamond (producers: chain) | 5 | 4 | 1-1-1-2 | 2 | true | 0 | trivialx2 writingx1 standardx2 | completed | PASS | true | 0/1 | 5/5 | 163s |
| diamond-app | diamond | diamond (producers: diamond) | 7 | 5 | 1-2-1-1-2 | 4 | true | 0 | trivialx5 standardx2 | completed | PASS | true | 0/2 | 7/7 | 286s |
| debug-fix | direct | single (producers: single) | 1 | 1 | 1 | 0 | false | 0 | trivialx1 | completed | PASS | true | 0/2 | 1/1 | 46s |
| wide-harvest | fan-out/fan-in | fan-out/fan-in (producers: fan-out/fan-in) | 5 | 3 | 3-1-1 | 2 | true | 0 | trivialx4 standardx1 | completed | PASS | true | 0/4 | 5/5 | 211s |
| research-write | fan-out/fan-in | fan-out/fan-in (producers: fan-out/fan-in) | 5 | 3 | 3-1-1 | 1 | true | 0 | trivialx3 writingx1 standardx1 | completed | PASS | true | 0/1 | 5/5 | 372s |

## Deltas against eval/baselines/plan-graph-baseline.md (plugin HEAD 6737ddd, same shard recipe and timeout)

| scenario | baseline shape → now | baseline status → now | note |
| --- | --- | --- | --- |
| single-edit | single → single | completed → completed | unchanged |
| parallel-files | fan-out/fan-in (parallel) → same | completed → completed | unchanged |
| map-reduce-docs | fan-out/fan-in 8 nodes → same | completed → completed | unchanged |
| pipeline-stats | chain 4 nodes → diamond 5 nodes (producers: chain) | completed → completed | producer chain unchanged; the verification layer is two parallel reviewers instead of one, so the whole graph reads as a diamond |
| diamond-app | fan-out 3 nodes → diamond 7 nodes (producers: diamond) | completed → completed | back to the expected diamond, as in stages-baseline.md (6 nodes); the plan-graph run's 3-node fan-out was model judgment, not the doctrine |
| debug-fix | single → single | completed → completed | unchanged |
| wide-harvest | fan-out/fan-in 5 nodes → same | completed → completed | unchanged |
| research-write | fan-out/fan-in 5 nodes → same | completed → completed | unchanged |

Expected-shape matches: 5/8 → 6/8 (diamond-app). plan-graph-baseline.md states 6/8, but its own shard files report 1/2, 2/2, 0/2, 2/2 = 5/8.
Wall time over the 8 scenarios: 1410s → 1480s.

## Doctrine evidence (what removing the plan-board step changed)
- Board tool calls per session: 0 in all 8 (plan-graph-baseline: 2-4 in every session). No session loaded the board tool through ToolSearch either, so no denied board attempt hides behind the narrower MAIN_TOOLS. The only `mcp__dag-workflow__board` strings in the transcripts are the deferred-tool listing.
- The order is now `Skill planning` → (optional `start dryRun` → `start preview_id`) → run, with no board step between planning and start.
- diamond-app and research-write each made the dryRun → preview_id pair; every other session made one `start`.
- Harness note: the transcript's `starts` count reads 2 for single-edit, map-reduce-docs, pipeline-stats, debug-fix and wide-harvest, but each of those sessions has one distinct `start` tool_use id; the host wrote the same tool_use row twice, and readTranscript counts rows, not ids. The tool refusals column has the same
  overcount where a result row repeats: single-edit, diamond-app and debug-fix each show 2 but hold one distinct erroring
  tool_use id. Shape, nodes, depth and verified/total come from the run checkpoints and are not affected.

## Sources
- shard-1: eval/results/20261015131959.json — single-edit, parallel-files
- shard-2: eval/results/20261015132310.json — map-reduce-docs, pipeline-stats
- shard-3: eval/results/20261015132924.json — diamond-app, debug-fix
- shard-4: eval/results/20261015133457.json — wide-harvest, research-write
