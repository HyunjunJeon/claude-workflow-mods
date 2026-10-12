# Speed fixes: control against treatment
Date: 2026-10-12
Control: plugin HEAD d7fcfc8, exported with `git archive` and run with this change's eval/run.ts (for `--enforcement`). Stamp 20261012051014; results copied to eval/results/20261012051014.{md,json}.
Treatment: d7fcfc8 plus the uncommitted speed fixes (start refuses checks that cannot pass, check-defect skips automatic recovery, start {preview_id}, audit budget). Stamps 20261012050550 and 20261012051017.
Earlier reference: stamp 20261010120527 (eval/baselines/git-fixtures-rerun.md), plugin HEAD 1cdaa65, run under strict.
Runner, every batch: `bun eval/run.ts --only parallel-files,pipeline-stats,diamond-app --concurrency 3 --timeout-min 15 --keep --enforcement strict`, model sonnet. Control and the second treatment batch ran at the same time; their stamps are 3 s apart.
Timings come from the session transcripts, not the runner's time column. Advisor (claude-fable-5-1) calls are made by the harness, not the plugin. Their length varies from 0 to 90 s per node, so the "net" columns subtract them.

## Final audit node (review-spec, or the hand-written verify/audit node)

| batch | node | wall s | advisor s | net s | output tokens |
| --- | --- | --- | --- | --- | --- |
| 20261010120527 | diamond-app review-spec | 155 | 72 | 82 | 12239 |
| 20261010120527 | parallel-files review-spec | 191 | 72 | 119 | 17319 |
| 20261010120527 | pipeline-stats review-spec | 174 | 90 | 83 | 12142 |
| control 20261012051014 | parallel-files verify-files | 135 | 53 | 82 | 12199 |
| control 20261012051014 | pipeline-stats verify-pipeline | 100 | 39 | 61 | 9075 |
| treatment 20261012050550 | diamond-app review-spec | 40 | 0 | 40 | 6235 |
| treatment 20261012050550 | parallel-files audit | 113 | 59 | 54 | 8090 |
| treatment 20261012050550 | pipeline-stats review-spec | 93 | 46 | 47 | 6810 |
| treatment 20261012051017 | diamond-app review-spec | 34 | 0 | 34 | 5217 |
| treatment 20261012051017 | parallel-files verify-audit | 26 | 0 | 26 | 3814 |
| treatment 20261012051017 | pipeline-stats review-spec | 110 | 49 | 61 | 9151 |

Mean net time: 95 s in 20261010120527 and 72 s in the control, against 44 s in the treatment (6 nodes). Mean output tokens: 13900 and 10637, against 6553. The control's diamond-app ran as one node with no audit, so it has no row.

## dryRun followed by start

| batch | scenario | dry run, then start | gap |
| --- | --- | --- | --- |
| 20261010120527 | diamond-app | dry 9177 B, start 9161 B | 18.0 s |
| 20261010120527 | pipeline-stats | dry 6467 B, start 6443 B | 13.8 s |
| treatment 20261012050550 | diamond-app | dry 7789 B, start {preview_id} 56 B | 1.6 s |
| treatment 20261012050550 | pipeline-stats | dry 6157 B, start 6134 B | 14.0 s |

The treatment pipeline-stats planner sent its definition again because the dry run returned a lint warning it had to fix, so preview_id did not apply there. No other run used a dry run.

## Whole run

| scenario | control s (nodes) | treatment s (nodes) |
| --- | --- | --- |
| parallel-files | 208 (4) | 189 (4), 92 (4) |
| pipeline-stats | 225 (4, no review pair) | 216 (5, review pair), 217 (5, review pair) |
| diamond-app | 171 (1 node, one automatic retry) | 212 (6, review pair), 110 (3, review pair) |

The whole-run times are not like for like. The planner chose a different shape in almost every run, with a review pair in 4 of 6 treatment runs and none of the 3 control runs. Advisor calls also differ. The 20261010120527 runs (mean 358 s) used older plugin code and hit one `\A` check defect, so the drop from them is not all due to these fixes.

## Not exercised

No run in the three batches was refused at start or hit a check-defect: invalid_verification 0, check-defect 0. The one automatic retry was the control's diamond-app, caused by an over-specific `contains` check, which is an ordinary implementation failure. These two fixes are covered by tests only. In the 36 earlier DAG sessions (2026-10-07 to 2026-10-10), 3 hit this class (a `\A` regex twice, rg missing from PATH once), at 100-140 s each.
