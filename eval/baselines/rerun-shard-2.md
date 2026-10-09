# Eval re-run shard 2
Date: 2026-10-08
Plugin HEAD: 632f6f6
Tracked changes: 0
Scenarios: map-reduce-docs, pipeline-stats
Stamp: 20261008095618
Results JSON: eval/results/20261008095618.json
Results MD: eval/results/20261008095618.md
Command: bun eval/run.ts --only map-reduce-docs,pipeline-stats --concurrency 1 --timeout-min 4

| scenario | expected | runs | shape | nodes | depth | layer widths | fan-in nodes | verify node | warnings | categories | status | outcome check | skill before start | refusals (planning/tools) | AskUserQuestion calls | verify refusals (required/invalid) | verified/total nodes | auto retries | unfinished nodes | time |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| map-reduce-docs | fan-out/fan-in | 1 | fan-out/fan-in (producers: fan-out/fan-in) | 8 | 3 | 6-1-1 | 2 | true | 0 | quickx7 unspecified-lowx1 | running | PASS | true | 0/2 | 0 | 0/0 | 7/8 | 0 | verify-docs:running | 240s |
| pipeline-stats | chain | 1 | diamond (producers: chain) | 5 | 4 | 1-1-1-2 | 2 | true | 4 | quickx3 unspecified-lowx2 | failed | FAIL | true | 0/0 | 0 | 0/0 | 2/5 | 0 | report:failed (Write tool blocked creating report.md (harness refuses subag); review-spec:skipped (Skipped: dependency "report" ended as failed.); review-standards:skipped (Skipped: dependency "report" ended as failed.) | 147s |
