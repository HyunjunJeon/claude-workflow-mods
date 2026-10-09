# Eval re-run audit
| scenario | cells compared | mismatches | verdict |
| --- | --- | --- | --- |
| single-edit | 21 | 0 | PASS |
| parallel-files | 21 | 0 | PASS |
| map-reduce-docs | 21 | 0 | PASS |
| pipeline-stats | 21 | 0 | PASS |
| diamond-app | 21 | 0 | PASS |
| debug-fix | 21 | 0 | PASS |
| wide-harvest | 21 | 0 | PASS |
| research-write | 21 | 0 | PASS |

Rows compared: 8/8
Cells compared: 168/168
Summary lines: PASS
Shard coverage: PASS

Method: each row was recomputed from eval/results/<stamp>.json twice, once with a copy of the row template in the markdown function of eval/run.ts and once with an independent field-by-field builder that counts verified nodes and retries from nodeVerification instead of verificationTotals. Both runs compared all 21 cells of every row with eval/baselines/rerun-baseline.md and found 0 mismatches. The shard-file rows also equal the JSON rows (0 mismatches) and the baseline rows (0 mismatches), and the 8 baseline rows equal the 8 rows the runner itself wrote to eval/results/<stamp>.md. The two summary lines (Distinct shapes, Distinct producer shapes, Scenarios matching their expected shape; Verification) equal the recomputed lines under both expressions. The Sources section equals the shard headers. The four stamps (20261008095603, 20261008095618, 20261008095633, 20261008095648) are distinct, each shard names an existing Results JSON and Results MD whose stamp matches, each shard command equals the options stored in its JSON (concurrency 1, timeout 4 min, model sonnet, the --only pair), and each scenario id appears exactly once across the four shards in the required pairing. Header facts: Plugin HEAD 632f6f6 equals git HEAD and tracked changes are 0.

Re-run measurements (not audit failures): 6/8 scenarios match their expected shape; 24/33 nodes verified. Outcome check FAIL: pipeline-stats (report.md missing, its report node failed on a blocked Write) and research-write (sorting.md missing, timed out at 240s). Shape differs from expected: debug-fix (single, expected chain) and wide-harvest (single, expected fan-out/fan-in); pipeline-stats shows diamond and matches only through its producer shape chain. Timed out (timedOut=true, 240s): map-reduce-docs and research-write. AskUserQuestion calls: 0 in all 8 scenarios.

Baseline audit: PASS
