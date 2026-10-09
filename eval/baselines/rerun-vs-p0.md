# Eval re-run vs P0 baseline

## Summary
P0: 6/8 shapes, 27/31 nodes verified
Re-run: 6/8 shapes, 24/33 nodes verified
Plugin HEAD: P0 5f5377d, re-run 632f6f6

The P0 file reads as the fixed measurement (6/8 shapes, 27/31 nodes verified). Both runs have 0 failed and 0 missing verifications, 0 automatic retries and 0 start/amend refusals. The same six scenarios match their expected shape in both runs (single-edit, parallel-files, map-reduce-docs, pipeline-stats through its producer shape chain, diamond-app, research-write); debug-fix and wide-harvest miss in both. The lower re-run verified ratio comes from more nodes left unfinished (running, scheduled, pending or skipped), not from failed checks.

## Per scenario
| scenario | expected | P0 shape | re-run shape | P0 verified/total | re-run verified/total | re-run AskUserQuestion calls | P0 time | re-run time |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| single-edit | single | single (producers: single) | single (producers: single) | 1/1 | 1/1 | 0 | 52s | 91s |
| parallel-files | parallel | fan-out/fan-in (producers: parallel) | fan-out/fan-in (producers: parallel) | 4/4 | 4/4 | 0 | 95s | 136s |
| map-reduce-docs | fan-out/fan-in | fan-out/fan-in (producers: fan-out/fan-in) | fan-out/fan-in (producers: fan-out/fan-in) | 8/8 | 7/8 | 0 | 212s | 240s |
| pipeline-stats | chain | chain (producers: chain) | diamond (producers: chain) | 2/4 | 2/5 | 0 | 122s | 147s |
| diamond-app | diamond | diamond (producers: diamond) | diamond (producers: diamond) | 6/6 | 5/7 | 0 | 131s | 155s |
| debug-fix | chain | single (producers: single) | single (producers: single) | 0/1 | 1/1 | 0 | 132s | 84s |
| wide-harvest | fan-out/fan-in | chain (producers: single) | single (producers: single) | 2/2 | 1/1 | 0 | 111s | 198s |
| research-write | fan-out/fan-in | fan-out/fan-in (producers: fan-out/fan-in) | fan-out/fan-in (producers: fan-out/fan-in) | 4/5 | 3/6 | 0 | 198s | 240s |

## Targets
- wide-harvest now reaches fan-out/fan-in: NO - expected fan-out/fan-in; P0 shape was chain (producers: single) with 2 nodes, depth 2, layer widths 1-1; the re-run shape is single (producers: single) with 1 node, depth 1, layer width 1, so neither the shape nor the producer shape equals fan-out/fan-in in either run, and the re-run is a step further from it (status completed in both, outcome check PASS in both)
- debug-fix now reaches chain: NO - expected chain; P0 shape was single (producers: single) with 1 node, depth 1, layer width 1; the re-run shape is single (producers: single) with 1 node, depth 1, layer width 1, so neither the shape nor the producer shape equals chain in either run (the re-run status is completed with 1/1 verified, where P0 ended running with fix-average:running and 0/1 verified)
- pipeline-stats still fails on report.md (B7): YES - the report node failed in both runs and the Write tool refused the file name report.md; P0 shape chain (producers: chain), 4 nodes, layer widths 1-1-1-1, status failed, outcome check FAIL, unfinished nodes report:failed (Write tool refused the filename report.md) and audit:skipped, 2/4 verified; re-run shape diamond (producers: chain), 5 nodes, layer widths 1-1-1-2, status failed, outcome check FAIL, unfinished nodes report:failed (Write tool blocked creating report.md) plus review-spec:skipped and review-standards:skipped because dependency report ended as failed, 2/5 verified
- a run still ends with status running (B6): YES - the re-run has 3 scenarios whose status cell is running: map-reduce-docs (unfinished verify-docs:running, 7/8 verified, 240s), diamond-app (unfinished review-spec:scheduled and review-standards:scheduled, 5/7 verified, 155s) and research-write (unfinished checker:running, assemble:pending and audit:pending, 3/6 verified, 240s); P0 had 2 running scenarios, debug-fix (fix-average:running, 0/1 verified) and research-write (audit:scheduled, 4/5 verified), so the problem remains and the count rose from 2 to 3
- every AskUserQuestion count is 0: YES - the re-run counts are single-edit 0, parallel-files 0, map-reduce-docs 0, pipeline-stats 0, diamond-app 0, debug-fix 0, wide-harvest 0, research-write 0 (all 8 are 0); the P0 baseline has no AskUserQuestion calls column, so it has no value to compare against (the column was added after P0)
