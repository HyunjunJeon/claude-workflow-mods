# Eval re-run shard 1
Date: 2026-10-08
Plugin HEAD: 632f6f6
Tracked changes: 0
Scenarios: single-edit, parallel-files
Stamp: 20261008095603
Results JSON: eval/results/20261008095603.json
Results MD: eval/results/20261008095603.md
Command: bun eval/run.ts --only single-edit,parallel-files --concurrency 1 --timeout-min 4

| scenario | expected | runs | shape | nodes | depth | layer widths | fan-in nodes | verify node | warnings | categories | status | outcome check | skill before start | refusals (planning/tools) | AskUserQuestion calls | verify refusals (required/invalid) | verified/total nodes | auto retries | unfinished nodes | time |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| single-edit | single | 1 | single (producers: single) | 1 | 1 | 1 | 0 | false | 0 | quickx1 | completed | PASS | true | 0/1 | 0 | 0/0 | 1/1 | 0 | - | 91s |
| parallel-files | parallel | 1 | fan-out/fan-in (producers: parallel) | 4 | 2 | 3-1 | 1 | true | 0 | quickx3 unspecified-lowx1 | completed | PASS | true | 0/0 | 0 | 0/0 | 4/4 | 0 | - | 136s |
