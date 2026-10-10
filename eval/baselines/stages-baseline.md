# Eval baseline after review and commit stages
Date: 2026-10-10
Plugin HEAD: 2df5ffe
Tracked changes: 1
Runner: bun eval/run.ts in 4 shards of 2 scenarios run one after the other, --concurrency 1 --timeout-min 9 --keep each, model sonnet

Distinct shapes: 4 (single, fan-out/fan-in, chain, diamond). Distinct producer shapes: 5 (single, parallel, fan-out/fan-in, chain, diamond). Scenarios matching their expected shape: 7/8.

Verification: 36/36 nodes verified, 0 failed, 0 missing; automatic retries: 0; start/amend refusals: 0 verification_required, 0 invalid_verification.

| scenario | expected | runs | shape | nodes | depth | layer widths | fan-in nodes | verify node | warnings | categories | status | outcome check | skill before start | refusals (planning/tools) | AskUserQuestion calls | verify refusals (required/invalid) | verified/total nodes | auto retries | unfinished nodes | time |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| single-edit | single | 1 | single (producers: single) | 1 | 1 | 1 | 0 | false | 0 | quickx1 | completed | PASS | true | 0/1 | 0 | 0/0 | 1/1 | 0 | - | 42s |
| parallel-files | parallel | 1 | fan-out/fan-in (producers: parallel) | 4 | 2 | 3-1 | 1 | true | 0 | quickx2 writingx1 unspecified-lowx1 | completed | PASS | true | 0/0 | 0 | 0/0 | 4/4 | 0 | - | 238s |
| map-reduce-docs | fan-out/fan-in | 1 | fan-out/fan-in (producers: fan-out/fan-in) | 8 | 3 | 6-1-1 | 2 | true | 0 | quickx7 unspecified-lowx1 | completed | PASS | true | 0/1 | 0 | 0/0 | 8/8 | 0 | - | 385s |
| pipeline-stats | chain | 1 | chain (producers: chain) | 4 | 4 | 1-1-1-1 | 1 | true | 0 | quickx3 unspecified-lowx1 | completed | PASS | true | 0/1 | 0 | 0/0 | 4/4 | 0 | - | 273s |
| diamond-app | diamond | 1 | diamond (producers: diamond) | 6 | 5 | 1-2-1-1-1 | 3 | true | 0 | quickx5 unspecified-lowx1 | completed | PASS | true | 0/1 | 0 | 0/0 | 6/6 | 0 | - | 331s |
| debug-fix | chain | 1 | single (producers: single) | 1 | 1 | 1 | 0 | false | 0 | quickx1 | completed | PASS | true | 0/1 | 0 | 0/0 | 1/1 | 0 | - | 38s |
| wide-harvest | fan-out/fan-in | 1 | fan-out/fan-in (producers: fan-out/fan-in) | 7 | 3 | 5-1-1 | 2 | true | 0 | quickx6 unspecified-lowx1 | completed | PASS | true | 0/2 | 0 | 0/0 | 7/7 | 0 | - | 407s |
| research-write | fan-out/fan-in | 1 | fan-out/fan-in (producers: fan-out/fan-in) | 5 | 3 | 3-1-1 | 2 | true | 0 | quickx3 writingx1 unspecified-lowx1 | completed | PASS | true | 0/1 | 0 | 0/0 | 5/5 | 0 | - | 447s |

## Compared with rerun-baseline

eval/baselines/rerun-baseline.md (plugin HEAD 632f6f6) ran each scenario under --timeout-min 4 and this run (plugin HEAD 2df5ffe) under --timeout-min 9, so a row that finished only thanks to the longer limit is not a planning improvement. "now within 4 min" is yes when this run took 240 seconds or less. "comparable" is yes only when both runs settled (run status completed or failed, and timedOut false). The rerun timedOut values come from eval/results/20261008095603.json, 20261008095618.json, 20261008095633.json and 20261008095648.json.

| scenario | rerun status | now status | rerun outcome | now outcome | rerun shape | now shape | rerun time | now time | now within 4 min | comparable |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| single-edit | completed (timedOut false) | completed (timedOut false) | PASS | PASS | single (producers: single) | single (producers: single) | 91s | 42s | yes | yes |
| parallel-files | completed (timedOut false) | completed (timedOut false) | PASS | PASS | fan-out/fan-in (producers: parallel) | fan-out/fan-in (producers: parallel) | 136s | 238s | yes | yes |
| map-reduce-docs | running (timedOut true) | completed (timedOut false) | PASS | PASS | fan-out/fan-in (producers: fan-out/fan-in) | fan-out/fan-in (producers: fan-out/fan-in) | 240s | 385s | no | no: rerun unfinished |
| pipeline-stats | failed (timedOut false) | completed (timedOut false) | FAIL | PASS | diamond (producers: chain) | chain (producers: chain) | 147s | 273s | no | yes |
| diamond-app | running (timedOut false) | completed (timedOut false) | PASS | PASS | diamond (producers: diamond) | diamond (producers: diamond) | 155s | 331s | no | no: rerun unfinished |
| debug-fix | completed (timedOut false) | completed (timedOut false) | PASS | PASS | single (producers: single) | single (producers: single) | 84s | 38s | yes | yes |
| wide-harvest | completed (timedOut false) | completed (timedOut false) | PASS | PASS | single (producers: single) | fan-out/fan-in (producers: fan-out/fan-in) | 198s | 407s | no | yes |
| research-write | running (timedOut true) | completed (timedOut false) | FAIL | PASS | fan-out/fan-in (producers: fan-out/fan-in) | fan-out/fan-in (producers: fan-out/fan-in) | 240s | 447s | no | no: rerun unfinished |

Comparable rows (both runs settled):

- single-edit: outcome unchanged (PASS); shape unchanged (single (producers: single)); nodes 1 to 1; time 91s to 42s.
- parallel-files: outcome unchanged (PASS); shape unchanged (fan-out/fan-in (producers: parallel)); nodes 4 to 4; time 136s to 238s.
- pipeline-stats: outcome changed (FAIL to PASS); shape changed (diamond (producers: chain) to chain (producers: chain)); nodes 5 to 4; time 147s to 273s.
- debug-fix: outcome unchanged (PASS); shape unchanged (single (producers: single)); nodes 1 to 1; time 84s to 38s.
- wide-harvest: outcome unchanged (PASS); shape changed (single (producers: single) to fan-out/fan-in (producers: fan-out/fan-in)); nodes 1 to 7; time 198s to 407s.

Notes on these rows:

- Comparable rows that ran past 240 s now: pipeline-stats (273s), wide-harvest (407s). Their now result needed the 9 minute limit, so a change against the rerun in those rows is not by itself a planning difference.
- wide-harvest: the fixture itself changed between the two runs (24 files in the rerun, 450 files now, commit 50f0005), so the shape change is a different input and not a like-for-like change. The like-for-like comparison is in the next section.
- pipeline-stats and diamond-app: the rerun rows list review-spec and review-standards among their nodes (pipeline-stats 5 nodes, both skipped after report failed; diamond-app 7 nodes, both still scheduled); this run has no review-spec, review-standards or commit node in any of the 8 scenarios.
- debug-fix is the one scenario that does not match its expected shape (chain) in this run; the rerun row is also a single node.
- parallel-files took 238s, 2s under the 4 minute line.
- The four shards overlapped in time in this run (their first stamps are 3s apart) and in the rerun (15s apart); inside a shard the two scenarios ran one after the other.

Not comparable (named only, no verdict on them):

- map-reduce-docs: no: rerun unfinished. Rerun running (timedOut true), outcome PASS, 240s, 8 nodes; now completed (timedOut false), outcome PASS, 385s, 8 nodes.
- diamond-app: no: rerun unfinished. Rerun running (timedOut false), outcome PASS, 155s, 7 nodes; now completed (timedOut false), outcome PASS, 331s, 6 nodes.
- research-write: no: rerun unfinished. Rerun running (timedOut true), outcome FAIL, 240s, 6 nodes; now completed (timedOut false), outcome PASS, 447s, 5 nodes.

## Compared with wide-harvest-450

This run's wide-harvest (fixture of 450 files): fan-out/fan-in (producers: fan-out/fan-in), 7 nodes, outcome PASS, 407s, against eval/baselines/wide-harvest-450.md (stamp 20261009084217, plugin HEAD 4e4ad25 plus uncommitted changes): fan-out/fan-in (producers: fan-out/fan-in), 8 nodes, outcome PASS, 517s; shape and outcome are the same, 1 node fewer and the run took 110s less.

## Stage and check grammar use

| scenario | runs | user nodes (count and ids) | definition.review | definition.commit | review/commit node ids present | user-node checks (file count / command count) | file text fields used (of contains, absent, matches, lastLine, equals) | command expect used (exit, stdout, stderr or none) | absolute check paths | previews / real starts |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| single-edit | 1 | 1: rename-x | absent | absent | none | 1 / 1 | equals | exit, stdout | none | 0 / 1 |
| parallel-files | 1 | 4: license, editorconfig, contributing, verify-files | absent | absent | none | 27 / 3 | contains, absent, matches, lastLine | stdout | 1 path (2 file checks): /tmp/dag-notes/project-files-license-editorconfig-contributing-1/verify-notes.md | 0 / 1 |
| map-reduce-docs | 1 | 8: fix-config, fix-faq, fix-install, fix-intro, fix-support, fix-usage, changes, verify-docs | absent | absent | none | 15 / 1 | contains, matches, lastLine, equals | exit | 1 path (2 file checks): /tmp/dag-docs-spelling-1/verify-notes.md | 0 / 1 |
| pipeline-stats | 1 | 4: gen, stats, report-draft, verify-pipeline | absent | absent | none | 11 / 4 | contains, matches, lastLine | none | 1 path (2 file checks): /tmp/dag-review/pipeline-stats-1/verify-notes.md | 0 / 1 |
| diamond-app | 1 | 6: settings, greeter, repeater, main, asserts, verify-app | absent | absent | none | 11 / 5 | contains, absent, lastLine | stdout | 1 path (3 file checks): /tmp/dag-review/diamond-app-1/verify-app-notes.md | 1 / 1 |
| debug-fix | 1 | 1: fix-average | absent | absent | none | 3 / 1 | contains, absent | exit, stdout | none | 0 / 1 |
| wide-harvest | 1 | 7: count-1, count-2, count-3, count-4, count-5, assemble, verify-report | absent | absent | none | 22 / 13 | contains, matches, lastLine | stdout | 6 paths (18 file checks): /tmp/dag-todo-report-1/todo-batch-1.md, /tmp/dag-todo-report-1/todo-batch-2.md, /tmp/dag-todo-report-1/todo-batch-3.md, /tmp/dag-todo-report-1/todo-batch-4.md, /tmp/dag-todo-report-1/todo-batch-5.md, /tmp/dag-todo-report-1/verify-report-notes.md | 1 / 1 |
| research-write | 1 | 5: sec-bubble, sec-merge, sec-quick, assemble, verify-doc | absent | absent | none | 15 / 5 | contains, absent, matches, lastLine | stdout | 4 paths (9 file checks): /tmp/dag-sorting-1/bubble.md, /tmp/dag-sorting-1/merge.md, /tmp/dag-sorting-1/quick.md, /tmp/dag-sorting-1/verify-notes.md | 1 / 1 |

Reading notes: "user nodes" are the nodes of the run file's definition minus review-spec, review-standards and commit (none of those existed in any run, so every node is a user node). Check counts are taken from the final definition in the run file; the planner's start and amend definitions of map-reduce-docs and pipeline-stats carry the same counts. The absolute-paths column counts file checks only; command argv carries absolute paths only in wide-harvest (10 arguments on the todo-batch files), and research-write embeds its notes paths inside python -c source, not as argv entries. Previews are start calls with input.dryRun true, real starts are the other start calls; amend calls are not starts. Tallies over the 8 runs: file text fields: contains 7 of 8, absent 4 of 8, matches 5 of 8, lastLine 6 of 8, equals 2 of 8. command expect: exit 3 of 8, stdout 6 of 8, stderr 0 of 8.

Rules applied: a one-node run stays one node with its own VERIFY step and needs no review pair; a run with two or more nodes whose producers add or edit code (source, tests, configuration or build files) ends with the review-spec and review-standards pair, preferably declared through definition.review; documentation, research and data runs end with one verification node and no review pair; a commit stage is never expected, because no scenario prompt asks for a commit and the fixtures are not git repositories.

Git check, run for all 8 folders (quoted for diamond-app): `git -C /tmp/dag-shapes/20261010112610/diamond-app rev-parse --git-dir` printed `fatal: not a git repository (or any of the parent directories): .git` and exited 128; the other 7 folders printed the same line and exit code.

- single-edit: a one-file code edit (rename a local variable in counter.py). Expected under the rules: one node with its own VERIFY step, no review pair, no commit. The planner started one node, rename-x (writes counter.py), with 2 checks: a file `equals` on the whole expected file text and a command `python3 -I counter.py` with expect exit 0 and stdout equals 3; no definition.review, no definition.commit, no preview, 1 real start. fit.
- parallel-files: three independent small project files (LICENSE, .editorconfig, CONTRIBUTING.md). Expected under the rules: three parallel producers, then the review-spec and review-standards pair, because .editorconfig is a configuration file; no commit. The planner ran license, editorconfig and contributing in parallel and ended with one verify-files node (27 file and 3 command checks, 2 of the file checks on the absolute notes file /tmp/dag-notes/project-files-license-editorconfig-contributing-1/verify-notes.md); no definition.review, no definition.commit, no preview, 1 real start. Its closing text: "This isn't a git repo, so nothing is committed." misfit: .editorconfig is a configuration file, so the pair was due and a single verify-files node ended the run. This is the one borderline call (the file is five static lines, checked with text fields rather than by running anything), and the trigger file is named here so an auditor can disagree on the record.
- map-reduce-docs: spelling fixes across six markdown files plus a docs/CHANGES.md list (documentation). Expected under the rules: fan-out over the six files, one aggregator, one verification node, no review pair, no commit. The planner started fix-config, fix-faq, fix-install, fix-intro, fix-support and fix-usage in parallel, then changes, then verify-docs depending on all seven (15 file and 1 command check; the command is a grep with expect exit 1, so a left-over misspelling fails the check); one accepted amend re-ran changes and verify-docs with the same node set; no definition.review, no definition.commit, no preview, 1 real start. fit.
- pipeline-stats: writes and runs two Python scripts (gen.py, stats.py), then a markdown table; a code-producing chain. Expected under the rules: the chain gen, stats, report, then the review-spec and review-standards pair (preferably through definition.review); no commit. The planner built the chain gen, stats, report-draft and ended with one verify-pipeline node (11 file and 4 command checks, no command expect); report-draft writes table-draft-notes.md and the main session wrote report.md itself after the run, which is consistent with the doctrine's rule against REPORT*.md names for subagents. There were 3 amend calls (one refused with amend_running_node; one snapshot showed the run as failed before the last accepted amend) and no preview, 1 real start; no definition.review, no definition.commit. misfit: gen.py and stats.py are source files, so the pair was due; the planner ended on one verification node as for a data run.
- diamond-app: a tiny Python app, four source files plus test_app.py (code). Expected under the rules: a diamond (settings, then greeter and repeater in parallel, then main, then the test file) ending with the review-spec and review-standards pair; no commit. The planner built exactly that diamond with 6 nodes (settings, greeter, repeater, main, asserts, verify-app; asserts loads dag-workflow:testing), 11 file and 5 command checks, and ended with the single verify-app node. It previewed once (dryRun true, warnings [], no write conflicts) and started the identical definition; no definition.review, no definition.commit. Its closing text: "No git: the directory isn't a git repo, so there was no code review node and no commit." misfit: five producers write source and tests, so the pair was due. The planner tied review to git, yet the doctrine declares review and commit as separate fields (see the finding on the generated review prompt below).
- debug-fix: diagnose and fix one failing function (mathutil.average) without touching the test. Expected under the rules: one node with its own VERIFY step, no review pair, no commit (eval/scenarios.ts labels it chain, the rule for one-node runs wins here and the eval row still passed). The planner started one node, fix-average (writes mathutil.py, load_skills dag-workflow:debugging), with 4 checks (3 file checks with contains and absent, 1 command `python3 test_mathutil.py` with expect exit 0 and stdout contains OK); no definition.review, no definition.commit, no preview, 1 real start. Its closing text: "Nothing is committed, because the directory isn't a git repo." fit.
- wide-harvest: count TODO comments in 450 files and write a report (data). Expected under the rules: fan-out over at least three batches, one aggregator, one verification node, no review pair, no commit. The planner started count-1 to count-5 (90 files each, notes under /tmp/dag-todo-report-1/), assemble and verify-report (22 file and 13 command checks, 18 of the file checks on 6 absolute paths); it previewed once (dryRun true, warnings [], unchecked_writes listing count-1 to count-5) and started the identical definition without adding writes; no definition.review, no definition.commit, 1 real start. fit.
- research-write: write sorting.md comparing three sorting algorithms with Python snippets (documentation and research). Expected under the rules: three section producers, one assembler, one verification node, no review pair, no commit. The planner started sec-bubble, sec-merge and sec-quick (notes under /tmp/dag-sorting-1/), assemble and verify-doc (15 file and 5 command checks; the commands exec the Python blocks of the document in a fresh python3 -I interpreter, test each sort on 108 cases and require the last stdout line ok); it previewed once (dryRun true, warnings []) and then edited verify-doc's prompt before the real start, removing the stray text "/tmp/.. no:"; no definition.review, no definition.commit, 1 real start. fit.

Zero of the 8 planners declared definition.review or definition.commit, and none hand-wrote review-spec, review-standards or commit nodes. The commit absence is correct for all 8. The review pair was due in 3 runs (parallel-files by its .editorconfig, pipeline-stats, diamond-app) and appeared in none, so 5 of 8 runs fit and 3 are misfits. diamond-app's closing text links the missing review node to the missing git repository; parallel-files and debug-fix link only the missing commit to it.

The generated review prompts begin their change section with "THE CHANGE: it is uncommitted in the working tree. Run git rev-parse HEAD, git status --porcelain, git diff and git diff --cached" (hooks/engine/stages.ts, changeBlock). In these non-git fixtures those commands would fail with exit 128, so the expected pair could not run as generated here (not executed by this node). The 3 misfits are therefore a mix of planner choice and eval design: the fixtures cannot host the generated review.

Previews: 3 of 8 planners previewed (diamond-app, wide-harvest, research-write), once each, all with warnings [] and followed by one real start; the other 5 started cold. wide-harvest's preview listed count-1 to count-5 under unchecked_writes and the planner started anyway with an identical definition; research-write changed verify-doc's prompt between preview and start. The preview output carries no prompt text (it lists per node: wave, category, model, agent, dependencies, check count, writes and load_skills).

## Sources
- single-edit: eval/results/20261010113334.json
- parallel-files: eval/results/20261010113237.json
- map-reduce-docs: eval/results/20261010112607.json
- pipeline-stats: eval/results/20261010113155.json
- diamond-app: eval/results/20261010112610.json
- debug-fix: eval/results/20261010113301.json
- wide-harvest: eval/results/20261010112601.json
- research-write: eval/results/20261010112604.json
Fixture folders kept under /tmp/dag-shapes/ (every shard ran with --keep): 20261010113334 (single-edit), 20261010113237 (parallel-files), 20261010112607 (map-reduce-docs), 20261010113155 (pipeline-stats), 20261010112610 (diamond-app), 20261010113301 (debug-fix), 20261010112601 (wide-harvest), 20261010112604 (research-write).
