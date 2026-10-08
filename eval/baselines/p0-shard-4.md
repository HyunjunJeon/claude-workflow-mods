# P0 eval baseline shard 4
Date: 2026-10-08
Plugin HEAD: 5f5377d
Tracked changes: 0
Scenarios: wide-harvest, research-write
Stamp: 20261008065948
Results JSON: eval/results/20261008065948.json
Results MD: eval/results/20261008065948.md
Command: bun eval/run.ts --only wide-harvest,research-write --concurrency 1 --timeout-min 4

| scenario | expected | runs | shape | nodes | depth | layer widths | fan-in nodes | verify node | warnings | categories | status | outcome check | skill before start | refusals (planning/tools) | verify refusals (required/invalid) | verified/total nodes | auto retries | unfinished nodes | time |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| wide-harvest | fan-out/fan-in | 1 | chain (producers: single) | 2 | 2 | 1-1 | 0 | true | 0 | quickx1 unspecified-lowx1 | completed | PASS | true | 0/1 | 0/0 | 2/2 | 0 | - | 111s |
| research-write | fan-out/fan-in | 1 | fan-out/fan-in (producers: fan-out/fan-in) | 5 | 3 | 3-1-1 | 2 | true | 0 | quickx3 writingx1 unspecified-lowx1 | running | PASS | true | 0/0 | 0/0 | 4/5 | 0 | audit:scheduled | 198s |
