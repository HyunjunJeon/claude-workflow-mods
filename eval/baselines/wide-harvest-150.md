# wide-harvest at 150 files, eval baseline
Date: 2026-10-09
Plugin HEAD: 4e4ad25 plus uncommitted working-tree changes (150-file fixture in eval/scenarios.ts, tests/policy.test.ts, README.md)
Scenario: wide-harvest
Stamp: 20261009080416
Results JSON: eval/results/20261009080416.json
Results MD: eval/results/20261009080416.md
Command: bun eval/run.ts --only wide-harvest --concurrency 1 --timeout-min 9
Fixture: 150 Python files (src/mod_001.py to src/mod_150.py) holding 225 TODO comments in total; the check requires 225 and mod_150 in todo-report.md.

## 150-file result (measured, copied verbatim from eval/results/20261009080416.md)

| scenario | expected | runs | shape | nodes | depth | layer widths | fan-in nodes | verify node | warnings | categories | status | outcome check | skill before start | refusals (planning/tools) | AskUserQuestion calls | verify refusals (required/invalid) | verified/total nodes | auto retries | unfinished nodes | time |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| wide-harvest | fan-out/fan-in | 1 | single (producers: single) | 1 | 1 | 1 | 0 | false | 0 | quickx1 | completed | PASS | true | 0/2 | 0 | 0/0 | 1/1 | 0 | - | 218s |

## 24-file baseline (p0, copied from eval/baselines/p0-baseline.md)
The p0 table predates the "AskUserQuestion calls" column, so its columns differ by that one.

| scenario | expected | runs | shape | nodes | depth | layer widths | fan-in nodes | verify node | warnings | categories | status | outcome check | skill before start | refusals (planning/tools) | verify refusals (required/invalid) | verified/total nodes | auto retries | unfinished nodes | time |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| wide-harvest | fan-out/fan-in | 1 | chain (producers: single) | 2 | 2 | 1-1 | 0 | true | 0 | quickx1 unspecified-lowx1 | completed | PASS | true | 0/1 | 0/0 | 2/2 | 0 | - | 111s |
