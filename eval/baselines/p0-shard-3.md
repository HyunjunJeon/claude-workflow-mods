# P0 eval baseline shard 3
Date: 2026-10-08
Plugin HEAD: 5f5377d
Tracked changes: 0
Scenarios: diamond-app, debug-fix
Stamp: 20261008065933
Results JSON: eval/results/20261008065933.json
Results MD: eval/results/20261008065933.md
Command: bun eval/run.ts --only diamond-app,debug-fix --concurrency 1 --timeout-min 4

| scenario | expected | runs | shape | nodes | depth | layer widths | fan-in nodes | verify node | warnings | categories | status | outcome check | skill before start | refusals (planning/tools) | verify refusals (required/invalid) | verified/total nodes | auto retries | unfinished nodes | time |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| diamond-app | diamond | 1 | diamond (producers: diamond) | 6 | 5 | 1-2-1-1-1 | 3 | true | 0 | quickx5 unspecified-lowx1 | completed | PASS | true | 0/0 | 0/0 | 6/6 | 0 | - | 131s |
| debug-fix | chain | 1 | single (producers: single) | 1 | 1 | 1 | 0 | false | 0 | quickx1 | running | PASS | true | 0/1 | 0/0 | 0/1 | 0 | fix-average:running | 132s |
