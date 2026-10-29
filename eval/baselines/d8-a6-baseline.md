# D8 shape baseline and A6 deferred-tool measurement
Date: 2026-10-28
Plugin HEAD: e7aa5c4 (D8); e7aa5c4 plus one uncommitted change in hooks/register.ts (A6), since reverted
Change under test: D8 is the baseline, no change. A6 registers the dag tool with `isDeferred: false`, so its schema sits in the prompt from the start instead of behind ToolSearch.
Runner: `bun eval/run.ts --repeat 2 --enforcement strict --concurrency 4 --timeout-min 9`, model sonnet; the A6 run followed the D8 run right after with the same command.
Results: eval/results/20261028094339 (D8), eval/results/20261028094828 (A6), each `.md` and `.json`.
Comparability: this is the first baseline under the P14 scoring rules (strict direct scenarios match a one-node run; counters deduplicated by tool_use id; refusals by tool and reason; per-scenario repeats), so earlier baselines are not directly comparable on those columns.

## D8 baseline
Samples matching their expected shape: 13/16 (2 samples for each of 8 scenarios).

Verification: 64/64 nodes verified, 0 failed, 0 missing; automatic retries: 0; start/amend refusals: 0 verification_required, 0 invalid_verification. All 16 runs completed and all outcome checks PASS; skill before start on all 16.

### Across repeats

| scenario | matched/samples | shapes seen | seconds (min-median-max) |
| --- | --- | --- | --- |
| single-edit | 2/2 | single | 40-43-46 |
| parallel-files | 2/2 | fan-out/fan-in | 49-54-58 |
| map-reduce-docs | 2/2 | fan-out/fan-in | 78-86-93 |
| pipeline-stats | 2/2 | chain, diamond | 79-93-106 |
| diamond-app | 0/2 | fan-out, fan-out/fan-in | 76-79-82 |
| debug-fix | 2/2 | single | 35-43-50 |
| wide-harvest | 1/2 | fan-out/fan-in, single | 57-74-91 |
| research-write | 2/2 | fan-out/fan-in | 68-79-89 |

### Misses

- diamond-app #1 (expected diamond): fan-out, 3 nodes, layer widths 1-2, no fan-in (producers: single).
- diamond-app #2 (expected diamond): fan-out/fan-in, 7 nodes, layer widths 4-1-2, depth 3 (producers: fan-out/fan-in).
- wide-harvest #2 (expected fan-out/fan-in): single, 1 node (producers: single). The other sample was a 6-node fan-out/fan-in (producers: parallel).

pipeline-stats #2 ran as a 5-node diamond (layer widths 1-1-1-2) whose producers form a chain, and the scorer counts it as matched.

## A6: dag tool not deferred
Samples matching their expected shape: 15/16.

Verification: 73/73 nodes verified, 0 failed, 0 missing; automatic retries: 0; start/amend refusals: 0 verification_required, 0 invalid_verification. All 16 runs completed and all outcome checks PASS; skill before start on all 16.

### Across repeats

| scenario | matched/samples | shapes seen | seconds (min-median-max) |
| --- | --- | --- | --- |
| single-edit | 2/2 | single | 29-40-51 |
| parallel-files | 2/2 | fan-out/fan-in | 63-72-80 |
| map-reduce-docs | 2/2 | fan-out/fan-in | 82-88-94 |
| pipeline-stats | 2/2 | chain, diamond | 79-86-92 |
| diamond-app | 1/2 | fan-out, diamond | 103-113-123 |
| debug-fix | 2/2 | single | 38-46-54 |
| wide-harvest | 2/2 | fan-out/fan-in | 124-139-153 |
| research-write | 2/2 | fan-out/fan-in | 81-82-83 |

Misses: diamond-app #1 (fan-out, 3 nodes, widths 1-2, producers: single). pipeline-stats #2 ran as a 5-node diamond (layer widths 1-1-1-2) whose producers form a chain, and the scorer counts it as matched.

### Median seconds per scenario, D8 against A6

| scenario | D8 median s | A6 median s | A6 minus D8 |
| --- | --- | --- | --- |
| single-edit | 43 | 40 | -3 |
| parallel-files | 54 | 72 | +18 |
| map-reduce-docs | 86 | 88 | +2 |
| pipeline-stats | 93 | 86 | -7 |
| diamond-app | 79 | 113 | +34 |
| debug-fix | 43 | 46 | +3 |
| wide-harvest | 74 | 139 | +65 |
| research-write | 79 | 82 | +3 |

### Transcript metrics

Source: main-session transcripts under ~/.claude/projects/-private-tmp-dag-shapes-<stamp>-*, read with a scratchpad script (a6metrics.py, not committed). Per sample: ToolSearch tool_use blocks (deduplicated by tool_use id); seconds from the first user row to the first dag `start`; assistant messages; input tokens (input + cache read + cache creation) per message and in total, deduplicated by message id. Sidechain rows are excluded.

| metric | D8 | A6 |
| --- | --- | --- |
| ToolSearch calls, total over 16 sessions | 2 | 0 |
| median seconds to first dag start | 24.0 | 25.0 |
| median input tokens per message | 55113.5 | 58209.5 |
| median input tokens per session | 553557.0 | 549684.5 |

D8 (20261028094339), 16 sessions:

| sample | ToolSearch | s to first start | assistant msgs | input tokens/msg | input tokens total |
| --- | --- | --- | --- | --- | --- |
| debug-fix-1 | 0 | 18 | 7 | 50977 | 356839 |
| debug-fix-2 | 0 | 13 | 7 | 50846 | 355920 |
| diamond-app-1 | 0 | 15 | 10 | 54622 | 546217 |
| diamond-app-2 | 0 | 24 | 13 | 58568 | 761385 |
| map-reduce-docs-1 | 0 | 29 | 12 | 58642 | 703708 |
| map-reduce-docs-2 | 0 | 29 | 14 | 58917 | 824842 |
| parallel-files-1 | 0 | 24 | 8 | 53523 | 428187 |
| parallel-files-2 | 0 | 23 | 8 | 53181 | 425445 |
| pipeline-stats-1 | 0 | 24 | 11 | 58063 | 638695 |
| pipeline-stats-2 | 1 | 26 | 11 | 59270 | 651969 |
| research-write-1 | 0 | 26 | 9 | 54867 | 493807 |
| research-write-2 | 0 | 21 | 10 | 56090 | 560897 |
| single-edit-1 | 0 | 20 | 7 | 50435 | 353046 |
| single-edit-2 | 0 | 16 | 8 | 51600 | 412796 |
| wide-harvest-1 | 1 | 28 | 18 | 66069 | 1189246 |
| wide-harvest-2 | 0 | 26 | 11 | 55360 | 608962 |

A6 (20261028094828), 16 sessions:

| sample | ToolSearch | s to first start | assistant msgs | input tokens/msg | input tokens total |
| --- | --- | --- | --- | --- | --- |
| debug-fix-1 | 0 | 23 | 8 | 51075 | 408599 |
| debug-fix-2 | 0 | 14 | 7 | 53911 | 377377 |
| diamond-app-1 | 0 | 17 | 10 | 57460 | 574598 |
| diamond-app-2 | 0 | 25 | 13 | 62418 | 811435 |
| map-reduce-docs-1 | 0 | 36 | 12 | 60590 | 727074 |
| map-reduce-docs-2 | 0 | 31 | 12 | 60708 | 728500 |
| parallel-files-1 | 0 | 23 | 9 | 57748 | 519733 |
| parallel-files-2 | 0 | 30 | 9 | 57791 | 520121 |
| pipeline-stats-1 | 0 | 25 | 11 | 58943 | 648378 |
| pipeline-stats-2 | 0 | 21 | 12 | 60012 | 720140 |
| research-write-1 | 0 | 27 | 9 | 58308 | 524771 |
| research-write-2 | 0 | 27 | 9 | 58111 | 523001 |
| single-edit-1 | 0 | 11 | 8 | 54773 | 438186 |
| single-edit-2 | 0 | 17 | 8 | 54782 | 438256 |
| wide-harvest-1 | 0 | 39 | 18 | 73751 | 1327515 |
| wide-harvest-2 | 0 | 48 | 18 | 66733 | 1201202 |

### Refusals by reason

Every refusal in both runs is a main-conversation Bash denial (planning refusals 0 in all samples). Total D8: 19; A6: 24.

| reason (this Bash command is not read-only: ...) | D8 | A6 |
| --- | --- | --- |
| python3 is not on the read-only command list | 6 | 7 |
| command substitution can run anything | 4 | 2 |
| process substitution can run anything | 2 | 3 |
| xargs is not on the read-only command list | 2 | 2 |
| find with -exec/-delete can change files | 2 | 2 |
| awk is not on the read-only command list | 1 | 2 |
| output redirection writes files | 0 | 2 |
| md5 is not on the read-only command list | 0 | 2 |
| export is not on the read-only command list | 1 | 0 |
| paste is not on the read-only command list | 1 | 0 |
| cksum is not on the read-only command list | 0 | 1 |
| grep is not on the read-only command list | 0 | 1 |
| total | 19 | 24 |

## Reading

- Shape match went from 13/16 (D8) to 15/16 (A6); the extra matches are diamond-app #2 (diamond instead of fan-out/fan-in) and wide-harvest #2 (fan-out/fan-in instead of a single node).
- ToolSearch calls went from 2 (pipeline-stats-2, wide-harvest-1) to 0; median seconds to first dag start moved from 24.0 to 25.0, and median input tokens per message from 55113.5 to 58209.5, while median input tokens per session moved from 553557.0 to 549684.5.
- Median scenario seconds were higher under A6 in 5 of 8 scenarios, most in wide-harvest (74 to 139) and diamond-app (79 to 113), where A6 also produced larger DAGs (wide-harvest 7 and 8 nodes against 6 and 1; diamond-app 3 and 8 against 3 and 7); verified nodes rose from 64 to 73.
- Refusals were 19 in D8 and 24 in A6, almost all read-only Bash denials (python3, xargs, awk, command and process substitution, find -exec); neither run had a planning refusal.
- Limits: two samples per scenario, so a one-sample shape change moves a scenario from 2/2 to 1/2; shape differences at n=2 are within the planner noise eval/baselines/speed-fixes-ab.md describes.
- Limits: the two runs ran back to back at concurrency 4, so wall time includes load from the sibling samples and the machine, and the seconds columns (including the A6 increases) are not isolated from it.
