# P0 eval baseline
Date: 2026-10-08
Plugin HEAD: 5f5377d
Tracked changes: 0
Runner: bun eval/run.ts in 4 shards of 2 scenarios, --concurrency 1 --timeout-min 4 each, model sonnet

Distinct shapes: 4 (single, fan-out/fan-in, chain, diamond). Distinct producer shapes: 5 (single, parallel, fan-out/fan-in, chain, diamond). Scenarios matching their expected shape: 6/8.

Verification: 27/31 nodes verified, 0 failed, 0 missing; automatic retries: 0; start/amend refusals: 0 verification_required, 0 invalid_verification.

| scenario | expected | runs | shape | nodes | depth | layer widths | fan-in nodes | verify node | warnings | categories | status | outcome check | skill before start | refusals (planning/tools) | verify refusals (required/invalid) | verified/total nodes | auto retries | unfinished nodes | time |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| single-edit | single | 1 | single (producers: single) | 1 | 1 | 1 | 0 | false | 0 | quickx1 | completed | PASS | true | 0/1 | 0/0 | 1/1 | 0 | - | 52s |
| parallel-files | parallel | 1 | fan-out/fan-in (producers: parallel) | 4 | 2 | 3-1 | 1 | true | 0 | quickx2 writingx1 unspecified-lowx1 | completed | PASS | true | 0/0 | 0/0 | 4/4 | 0 | - | 95s |
| map-reduce-docs | fan-out/fan-in | 1 | fan-out/fan-in (producers: fan-out/fan-in) | 8 | 3 | 6-1-1 | 2 | true | 0 | quickx7 unspecified-lowx1 | completed | PASS | true | 0/1 | 0/0 | 8/8 | 0 | - | 212s |
| pipeline-stats | chain | 1 | chain (producers: chain) | 4 | 4 | 1-1-1-1 | 1 | true | 4 | quickx2 writingx1 unspecified-lowx1 | failed | FAIL | true | 0/0 | 0/0 | 2/4 | 0 | report:failed (Write tool refused the filename report.md, and only an agent); audit:skipped (Skipped: dependency "report" ended as failed.) | 122s |
| diamond-app | diamond | 1 | diamond (producers: diamond) | 6 | 5 | 1-2-1-1-1 | 3 | true | 0 | quickx5 unspecified-lowx1 | completed | PASS | true | 0/0 | 0/0 | 6/6 | 0 | - | 131s |
| debug-fix | chain | 1 | single (producers: single) | 1 | 1 | 1 | 0 | false | 0 | quickx1 | running | PASS | true | 0/1 | 0/0 | 0/1 | 0 | fix-average:running | 132s |
| wide-harvest | fan-out/fan-in | 1 | chain (producers: single) | 2 | 2 | 1-1 | 0 | true | 0 | quickx1 unspecified-lowx1 | completed | PASS | true | 0/1 | 0/0 | 2/2 | 0 | - | 111s |
| research-write | fan-out/fan-in | 1 | fan-out/fan-in (producers: fan-out/fan-in) | 5 | 3 | 3-1-1 | 2 | true | 0 | quickx3 writingx1 unspecified-lowx1 | running | PASS | true | 0/0 | 0/0 | 4/5 | 0 | audit:scheduled | 198s |

## Sources
- shard-1: Stamp 20261008065903, eval/results/20261008065903.json, scenarios single-edit, parallel-files
- shard-2: Stamp 20261008065918, eval/results/20261008065918.json, scenarios map-reduce-docs, pipeline-stats
- shard-3: Stamp 20261008065933, eval/results/20261008065933.json, scenarios diamond-app, debug-fix
- shard-4: Stamp 20261008065948, eval/results/20261008065948.json, scenarios wide-harvest, research-write
