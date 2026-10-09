# Eval re-run baseline
Date: 2026-10-08
Plugin HEAD: 632f6f6
Tracked changes: 0
Runner: bun eval/run.ts in 4 shards of 2 scenarios, --concurrency 1 --timeout-min 4 each, model sonnet

Distinct shapes: 3 (single, fan-out/fan-in, diamond). Distinct producer shapes: 5 (single, parallel, fan-out/fan-in, chain, diamond). Scenarios matching their expected shape: 6/8.

Verification: 24/33 nodes verified, 0 failed, 0 missing; automatic retries: 0; start/amend refusals: 0 verification_required, 0 invalid_verification.

| scenario | expected | runs | shape | nodes | depth | layer widths | fan-in nodes | verify node | warnings | categories | status | outcome check | skill before start | refusals (planning/tools) | AskUserQuestion calls | verify refusals (required/invalid) | verified/total nodes | auto retries | unfinished nodes | time |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| single-edit | single | 1 | single (producers: single) | 1 | 1 | 1 | 0 | false | 0 | quickx1 | completed | PASS | true | 0/1 | 0 | 0/0 | 1/1 | 0 | - | 91s |
| parallel-files | parallel | 1 | fan-out/fan-in (producers: parallel) | 4 | 2 | 3-1 | 1 | true | 0 | quickx3 unspecified-lowx1 | completed | PASS | true | 0/0 | 0 | 0/0 | 4/4 | 0 | - | 136s |
| map-reduce-docs | fan-out/fan-in | 1 | fan-out/fan-in (producers: fan-out/fan-in) | 8 | 3 | 6-1-1 | 2 | true | 0 | quickx7 unspecified-lowx1 | running | PASS | true | 0/2 | 0 | 0/0 | 7/8 | 0 | verify-docs:running | 240s |
| pipeline-stats | chain | 1 | diamond (producers: chain) | 5 | 4 | 1-1-1-2 | 2 | true | 4 | quickx3 unspecified-lowx2 | failed | FAIL | true | 0/0 | 0 | 0/0 | 2/5 | 0 | report:failed (Write tool blocked creating report.md (harness refuses subag); review-spec:skipped (Skipped: dependency "report" ended as failed.); review-standards:skipped (Skipped: dependency "report" ended as failed.) | 147s |
| diamond-app | diamond | 1 | diamond (producers: diamond) | 7 | 5 | 1-2-1-1-2 | 3 | true | 0 | quickx5 unspecified-lowx2 | running | PASS | true | 0/0 | 0 | 0/0 | 5/7 | 0 | review-spec:scheduled; review-standards:scheduled | 155s |
| debug-fix | chain | 1 | single (producers: single) | 1 | 1 | 1 | 0 | false | 0 | quickx1 | completed | PASS | true | 0/1 | 0 | 0/0 | 1/1 | 0 | - | 84s |
| wide-harvest | fan-out/fan-in | 1 | single (producers: single) | 1 | 1 | 1 | 0 | false | 0 | quickx1 | completed | PASS | true | 0/2 | 0 | 0/0 | 1/1 | 0 | - | 198s |
| research-write | fan-out/fan-in | 1 | fan-out/fan-in (producers: fan-out/fan-in) | 6 | 3 | 4-1-1 | 2 | true | 0 | quickx4 writingx1 unspecified-lowx1 | running | FAIL | true | 0/1 | 0 | 0/0 | 3/6 | 0 | checker:running; assemble:pending; audit:pending | 240s |

## Sources
- shard-1: Stamp 20261008095603, eval/results/20261008095603.json, scenarios single-edit, parallel-files
- shard-2: Stamp 20261008095618, eval/results/20261008095618.json, scenarios map-reduce-docs, pipeline-stats
- shard-3: Stamp 20261008095633, eval/results/20261008095633.json, scenarios diamond-app, debug-fix
- shard-4: Stamp 20261008095648, eval/results/20261008095648.json, scenarios wide-harvest, research-write
