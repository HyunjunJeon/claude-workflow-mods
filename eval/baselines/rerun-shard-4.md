# Eval re-run shard 4
Date: 2026-10-08
Plugin HEAD: 632f6f6
Tracked changes: 0
Scenarios: wide-harvest, research-write
Stamp: 20261008095648
Results JSON: eval/results/20261008095648.json
Results MD: eval/results/20261008095648.md
Command: bun eval/run.ts --only wide-harvest,research-write --concurrency 1 --timeout-min 4

| scenario | expected | runs | shape | nodes | depth | layer widths | fan-in nodes | verify node | warnings | categories | status | outcome check | skill before start | refusals (planning/tools) | AskUserQuestion calls | verify refusals (required/invalid) | verified/total nodes | auto retries | unfinished nodes | time |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| wide-harvest | fan-out/fan-in | 1 | single (producers: single) | 1 | 1 | 1 | 0 | false | 0 | quickx1 | completed | PASS | true | 0/2 | 0 | 0/0 | 1/1 | 0 | - | 198s |
| research-write | fan-out/fan-in | 1 | fan-out/fan-in (producers: fan-out/fan-in) | 6 | 3 | 4-1-1 | 2 | true | 0 | quickx4 writingx1 unspecified-lowx1 | running | FAIL | true | 0/1 | 0 | 0/0 | 3/6 | 0 | checker:running; assemble:pending; audit:pending | 240s |
