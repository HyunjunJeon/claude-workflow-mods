# wide-harvest at 450 files, eval baseline
Date: 2026-10-09
Plugin HEAD: 4e4ad25 plus uncommitted working-tree changes (450-file fixture in eval/scenarios.ts, tests/policy.test.ts, README.md)
Scenario: wide-harvest
Stamp: 20261009084217
Results JSON: eval/results/20261009084217.json
Results MD: eval/results/20261009084217.md
Command: bun eval/run.ts --only wide-harvest --concurrency 1 --timeout-min 9
Fixture: 450 Python files (src/mod_001.py to src/mod_450.py) holding 675 TODO comments in total; the check requires 675 and mod_450 in todo-report.md. 450 files is above the planning doctrine's 200-item ceiling per quick node, so a plan that follows it needs at least three batches and a fan-in.

## 450-file result (measured, copied verbatim from eval/results/20261009084217.md)

| scenario | expected | runs | shape | nodes | depth | layer widths | fan-in nodes | verify node | warnings | categories | status | outcome check | skill before start | refusals (planning/tools) | AskUserQuestion calls | verify refusals (required/invalid) | verified/total nodes | auto retries | unfinished nodes | time |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| wide-harvest | fan-out/fan-in | 1 | fan-out/fan-in (producers: fan-out/fan-in) | 8 | 3 | 6-1-1 | 2 | true | 0 | quickx7 unspecified-lowx1 | completed | PASS | true | 0/4 | 0 | 0/0 | 8/8 | 0 | - | 517s |

## For comparison

### 150-file run (copied verbatim from eval/baselines/wide-harvest-150.md, stamp 20261009080416)

| scenario | expected | runs | shape | nodes | depth | layer widths | fan-in nodes | verify node | warnings | categories | status | outcome check | skill before start | refusals (planning/tools) | AskUserQuestion calls | verify refusals (required/invalid) | verified/total nodes | auto retries | unfinished nodes | time |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| wide-harvest | fan-out/fan-in | 1 | single (producers: single) | 1 | 1 | 1 | 0 | false | 0 | quickx1 | completed | PASS | true | 0/2 | 0 | 0/0 | 1/1 | 0 | - | 218s |

### 24-file run (latest, copied from eval/baselines/rerun-baseline.md line 19, stamp 20261008095648)

| scenario | expected | runs | shape | nodes | depth | layer widths | fan-in nodes | verify node | warnings | categories | status | outcome check | skill before start | refusals (planning/tools) | AskUserQuestion calls | verify refusals (required/invalid) | verified/total nodes | auto retries | unfinished nodes | time |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| wide-harvest | fan-out/fan-in | 1 | single (producers: single) | 1 | 1 | 1 | 0 | false | 0 | quickx1 | completed | PASS | true | 0/2 | 0 | 0/0 | 1/1 | 0 | - | 198s |
