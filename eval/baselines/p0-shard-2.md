# P0 eval baseline shard 2
Date: 2026-10-08
Plugin HEAD: 5f5377d
Tracked changes: 0
Scenarios: map-reduce-docs, pipeline-stats
Stamp: 20261008065918
Results JSON: eval/results/20261008065918.json
Results MD: eval/results/20261008065918.md
Command: bun eval/run.ts --only map-reduce-docs,pipeline-stats --concurrency 1 --timeout-min 4

| scenario | expected | runs | shape | nodes | depth | layer widths | fan-in nodes | verify node | warnings | categories | status | outcome check | skill before start | refusals (planning/tools) | verify refusals (required/invalid) | verified/total nodes | auto retries | unfinished nodes | time |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| map-reduce-docs | fan-out/fan-in | 1 | fan-out/fan-in (producers: fan-out/fan-in) | 8 | 3 | 6-1-1 | 2 | true | 0 | quickx7 unspecified-lowx1 | completed | PASS | true | 0/1 | 0/0 | 8/8 | 0 | - | 212s |
| pipeline-stats | chain | 1 | chain (producers: chain) | 4 | 4 | 1-1-1-1 | 1 | true | 4 | quickx2 writingx1 unspecified-lowx1 | failed | FAIL | true | 0/0 | 0/0 | 2/4 | 0 | report:failed (Write tool refused the filename report.md, and only an agent); audit:skipped (Skipped: dependency "report" ended as failed.) | 122s |
