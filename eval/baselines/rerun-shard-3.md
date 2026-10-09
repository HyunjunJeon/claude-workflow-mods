# Eval re-run shard 3
Date: 2026-10-08
Plugin HEAD: 632f6f6
Tracked changes: 0
Scenarios: diamond-app, debug-fix
Stamp: 20261008095633
Results JSON: eval/results/20261008095633.json
Results MD: eval/results/20261008095633.md
Command: bun eval/run.ts --only diamond-app,debug-fix --concurrency 1 --timeout-min 4

| scenario | expected | runs | shape | nodes | depth | layer widths | fan-in nodes | verify node | warnings | categories | status | outcome check | skill before start | refusals (planning/tools) | AskUserQuestion calls | verify refusals (required/invalid) | verified/total nodes | auto retries | unfinished nodes | time |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| diamond-app | diamond | 1 | diamond (producers: diamond) | 7 | 5 | 1-2-1-1-2 | 3 | true | 0 | quickx5 unspecified-lowx2 | running | PASS | true | 0/0 | 0 | 0/0 | 5/7 | 0 | review-spec:scheduled; review-standards:scheduled | 155s |
| debug-fix | chain | 1 | single (producers: single) | 1 | 1 | 1 | 0 | false | 0 | quickx1 | completed | PASS | true | 0/1 | 0 | 0/0 | 1/1 | 0 | - | 84s |
