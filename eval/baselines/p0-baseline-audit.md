# P0 baseline audit
| scenario | cells compared | mismatches | verdict |
| --- | --- | --- | --- |
| single-edit | 20 | 0 | PASS |
| parallel-files | 20 | 0 | PASS |
| map-reduce-docs | 20 | 0 | PASS |
| pipeline-stats | 20 | 0 | PASS |
| diamond-app | 20 | 0 | PASS |
| debug-fix | 20 | 0 | PASS |
| wide-harvest | 20 | 0 | PASS |
| research-write | 20 | 0 | PASS |

Rows compared: 8/8
Cells compared: 160/160
Summary lines: PASS
Shard coverage: PASS

Method: each row was recomputed from eval/results/<stamp>.json twice, once with a hand-written renderer and once by running the markdown function from eval/run.ts itself. Both runs compared every cell with eval/baselines/p0-baseline.md and with the shard file row, and both found 0 mismatches. The two summary lines (Distinct shapes, Distinct producer shapes, Scenarios matching their expected shape; Verification) equal the recomputed lines. The four stamps are distinct, each shard names an existing Results JSON and Results MD, each shard command equals the options stored in its JSON, each scenario id appears exactly once across the shards, and the Sources section equals the shard headers. Header facts: Plugin HEAD 5f5377d equals git HEAD and tracked changes are 0.

Baseline audit: PASS
